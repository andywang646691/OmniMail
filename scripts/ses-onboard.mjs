#!/usr/bin/env node
/**
 * 为一个域名开通 Amazon SES 发信，并把 SES_DOMAIN_CONFIGS 写入只读的本地文件。
 *
 *   node scripts/ses-onboard.mjs <domain> --region us-east-1 \
 *     --from support@<domain> [--configuration-set omnimail] \
 *     [--out ./ses-domain-config.json] [--no-wait] [--dry-run] [--json]
 *   node scripts/ses-onboard.mjs <domain> --check     # 只读：查身份/验证状态
 *
 * 凭证来源（按优先级）：
 *   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN 环境变量，
 *   或 --credentials <file>（内容为 { "accessKeyId", "secretAccessKey", "sessionToken"? }）。
 * Cloudflare 侧凭证：CLOUDFLARE_API_TOKEN 环境变量，或 --cf-token-file <file>。
 *
 * 流程：SES CreateEmailIdentity → 解析 3 条 DKIM CNAME → 写入对应 Cloudflare zone
 * （已存在则跳过）→ 轮询 GetEmailIdentity 直到 verified → 输出 Worker Secret 文件。
 *
 * 退出码：0 已验证；3 DNS 已写入但 SES 尚未验证完成；1 失败。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { signAwsRequest } from '../email-worker/src/features/outbound/aws-signature.ts'
import { isMainModule } from './wrangler-command.mjs'

const DEFAULT_REGION = 'us-east-1'
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
const DEFAULT_INTERVAL_MS = 15 * 1000
/** SES Easy DKIM 目标主机固定为 <token>.dkim.amazonses.com。 */
const DKIM_SUFFIX = 'dkim.amazonses.com'

class SesOnboardError extends Error {
  constructor(message, exitCode = 1) {
    super(message)
    this.name = 'SesOnboardError'
    this.exitCode = exitCode
  }
}

export function dkimRecords(domain, tokens) {
  if (!/^[a-z0-9.-]+$/.test(domain)) throw new SesOnboardError(`域名不合法：${domain}`)
  if (!Array.isArray(tokens) || tokens.length !== 3
    || tokens.some((token) => typeof token !== 'string' || !/^[A-Za-z0-9]+$/.test(token))) {
    throw new SesOnboardError('SES 返回的 DKIM token 数量或格式异常，已停止写入 DNS。')
  }
  return tokens.map((token) => ({
    type: 'CNAME',
    name: `${token}._domainkey.${domain}`,
    content: `${token}.${DKIM_SUFFIX}`,
    ttl: 1,
    proxied: false,
  }))
}

async function sesRequest({
  method, path, body, region, credentials, http = fetch,
}) {
  const payload = body ? JSON.stringify(body) : ''
  const signed = await signAwsRequest({
    method,
    host: `email.${region}.amazonaws.com`,
    path,
    region,
    service: 'ses',
    credentials,
    payload,
    headers: body ? { 'content-type': 'application/json' } : {},
  })
  const response = await http(signed.url, {
    method,
    headers: signed.headers,
    body: body ? payload : undefined,
  })
  const text = await response.text()
  let parsed = {}
  if (text) {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = { raw: text.slice(0, 300) }
    }
  }
  return { status: response.status, body: parsed }
}

function sesError(response) {
  const message = response.body?.message || response.body?.Message || response.body?.raw
  return message ? `${message}` : `HTTP ${response.status}`
}

export async function createIdentity({ domain, region, credentials, http = fetch }) {
  const created = await sesRequest({
    method: 'POST',
    path: '/v2/email/identities',
    body: { EmailIdentity: domain },
    region,
    credentials,
    http,
  })
  if (created.status === 200) {
    const tokens = created.body?.DkimAttributes?.Tokens
    if (Array.isArray(tokens) && tokens.length) return { tokens, status: 'created' }
  }
  const alreadyExists = created.status === 409
    || /already ?exists/i.test(JSON.stringify(created.body || {}))
  if (!alreadyExists) {
    throw new SesOnboardError(`创建 SES 身份失败：${sesError(created)}`)
  }
  const existing = await getIdentity({ domain, region, credentials, http })
  const existingTokens = existing.body?.DkimAttributes?.Tokens
  if (existing.status !== 200 || !Array.isArray(existingTokens) || !existingTokens.length) {
    throw new SesOnboardError(`读取已有 SES 身份失败：${sesError(existing)}`)
  }
  return { tokens: existingTokens, status: 'existing' }
}

export async function getIdentity({ domain, region, credentials, http = fetch }) {
  return sesRequest({
    method: 'GET',
    path: `/v2/email/identities/${encodeURIComponent(domain)}`,
    region,
    credentials,
    http,
  })
}

export async function checkIdentity({ domain, region, credentials, http = fetch }) {
  const response = await getIdentity({ domain, region, credentials, http })
  if (response.status === 404) {
    return { exists: false, verified: false, detail: 'SES 中不存在该身份' }
  }
  if (response.status !== 200) {
    throw new SesOnboardError(`读取 SES 身份失败：${sesError(response)}`)
  }
  return {
    exists: true,
    verified: identityVerified(response),
    detail: identityStatus(response),
    dkimStatus: response.body?.DkimAttributes?.Status,
    verifiedForSending: response.body?.VerifiedForSendingStatus === true,
  }
}

export function identityVerified(response) {
  return Boolean(
    response
    && response.status === 200
    && response.body?.VerifiedForSendingStatus === true
    && response.body?.DkimAttributes?.Status === 'SUCCESS',
  )
}

export function identityStatus(response) {
  if (!response) return '暂无响应'
  if (response.status !== 200) return `HTTP ${response.status}`
  const dkim = response.body?.DkimAttributes?.Status || 'UNKNOWN'
  return `dkim=${dkim}, 可发信=${response.body?.VerifiedForSendingStatus === true}`
}

async function cloudflareRequest({ token, method, path, body, http = fetch }) {
  const response = await http(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await response.text()
  let parsed = {}
  if (text) {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = { raw: text.slice(0, 300) }
    }
  }
  if (!response.ok || parsed.success === false) {
    const detail = (parsed.errors || []).map((item) => item?.message).filter(Boolean).join('; ')
    throw new SesOnboardError(`Cloudflare ${method} ${path} 失败：${detail || response.status}`)
  }
  return parsed
}

export async function resolveZone({ domain, token, http = fetch }) {
  const labels = domain.split('.')
  for (let index = 0; index <= labels.length - 2; index += 1) {
    const candidate = labels.slice(index).join('.')
    const result = await cloudflareRequest({
      token, method: 'GET', path: `/zones?name=${encodeURIComponent(candidate)}`, http,
    })
    const zone = (result.result || [])[0]
    if (zone) return zone
  }
  throw new SesOnboardError(`Cloudflare 中找不到 ${domain} 的可用 zone。`)
}

export async function ensureDkimRecords({ zoneId, records, token, http = fetch }) {
  const existing = await cloudflareRequest({
    token, method: 'GET', path: `/zones/${zoneId}/dns_records?per_page=100`, http,
  })
  const known = new Set((existing.result || []).map(
    (record) => `${record.type}|${record.name.toLowerCase()}|${String(record.content).toLowerCase()}`,
  ))
  const created = []
  const skipped = []
  for (const record of records) {
    const key = `${record.type}|${record.name.toLowerCase()}|${record.content.toLowerCase()}`
    if (known.has(key)) {
      skipped.push(record)
      continue
    }
    await cloudflareRequest({
      token, method: 'POST', path: `/zones/${zoneId}/dns_records`, body: record, http,
    })
    created.push(record)
  }
  return { created, skipped }
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

export async function waitForVerification({
  domain, region, credentials, timeoutMs = DEFAULT_TIMEOUT_MS,
  intervalMs = DEFAULT_INTERVAL_MS, http = fetch, sleepImpl = sleep, log = () => {},
}) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await getIdentity({ domain, region, credentials, http })
    if (identityVerified(last)) return last
    log(`  等待 SES 验证：${identityStatus(last)}`)
    await sleepImpl(intervalMs)
  }
  return last
}

export function sesDomainConfig({ domain, region, credentials, from, configurationSetName }) {
  const entry = {
    region,
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
  }
  if (credentials.sessionToken) entry.sessionToken = credentials.sessionToken
  if (from) entry.from = from
  if (configurationSetName) entry.configurationSetName = configurationSetName
  return { [domain]: entry }
}

export async function sesOnboard(input) {
  const {
    domain, region = DEFAULT_REGION, credentials, cfToken, from,
    configurationSetName, out, dryRun = false, wait = true,
    http = fetch, sleepImpl = sleep, log = console.log,
    timeoutMs = DEFAULT_TIMEOUT_MS, intervalMs = DEFAULT_INTERVAL_MS,
  } = input
  if (!credentials?.accessKeyId || !credentials?.secretAccessKey) {
    throw new SesOnboardError('缺少 AWS 访问密钥（AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY）。')
  }
  if (!cfToken) throw new SesOnboardError('缺少 Cloudflare API Token（CLOUDFLARE_API_TOKEN）。')

  log(`1/4 创建或读取 SES 身份 ${domain}（${region}）`)
  const identity = await createIdentity({ domain, region, credentials, http })
  const records = dkimRecords(domain, identity.tokens)
  log(`     DKIM token 已就绪（${identity.status}），需要 ${records.length} 条 CNAME`)

  log('2/4 定位 Cloudflare zone 并写入 DKIM 记录')
  const zone = await resolveZone({ domain, token: cfToken, http })
  if (dryRun) {
    log(`     --dry-run：将写入 ${zone.name}，记录如下`)
    for (const record of records) log(`     ${record.type} ${record.name} → ${record.content}`)
    return { domain, zone: zone.name, records, status: 'dry-run', written: false }
  }
  const dns = await ensureDkimRecords({ zoneId: zone.id, records, token: cfToken, http })
  log(`     新建 ${dns.created.length} 条，已存在 ${dns.skipped.length} 条`)

  log('3/4 等待 SES 验证')
  const final = wait
    ? await waitForVerification({
      domain, region, credentials, timeoutMs, intervalMs, http, sleepImpl, log,
    })
    : await getIdentity({ domain, region, credentials, http })
  const verified = identityVerified(final)

  log('4/4 准备 Worker Secret')
  const config = sesDomainConfig({ domain, region, credentials, from, configurationSetName })
  const json = JSON.stringify(config, null, 2)
  if (out) {
    writeFileSync(out, `${json}\n`, { mode: 0o600 })
    log(`     已写入 ${out}（0600）。设置 Secret：npx wrangler secret put SES_DOMAIN_CONFIGS < ${out}`)
  } else {
    log('     未指定 --out，未写出含密钥的文件；加 --out <file> 可生成可直接用于 wrangler 的 JSON。')
  }
  log(`     当前状态：${identityStatus(final)}`)
  return {
    domain,
    zone: zone.name,
    records,
    created: dns.created.length,
    skipped: dns.skipped.length,
    status: verified ? 'verified' : 'pending',
    config: out ? undefined : config,
  }
}

function credentialsFromFile(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  const accessKeyId = String(parsed.accessKeyId || parsed.AWS_ACCESS_KEY_ID || '').trim()
  const secretAccessKey = String(
    parsed.secretAccessKey || parsed.AWS_SECRET_ACCESS_KEY || '',
  ).trim()
  const sessionToken = String(
    parsed.sessionToken || parsed.AWS_SESSION_TOKEN || '',
  ).trim()
  return { accessKeyId, secretAccessKey, sessionToken: sessionToken || undefined }
}

export function credentialsFromEnv(env = process.env) {
  const accessKeyId = String(env.AWS_ACCESS_KEY_ID || '').trim()
  const secretAccessKey = String(env.AWS_SECRET_ACCESS_KEY || '').trim()
  if (!accessKeyId || !secretAccessKey) return null
  const sessionToken = String(env.AWS_SESSION_TOKEN || '').trim()
  return { accessKeyId, secretAccessKey, sessionToken: sessionToken || undefined }
}

export async function main(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      region: { type: 'string', default: DEFAULT_REGION },
      from: { type: 'string' },
      'configuration-set': { type: 'string' },
      credentials: { type: 'string' },
      'cf-token-file': { type: 'string' },
      out: { type: 'string' },
      check: { type: 'boolean' },
      'no-wait': { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      json: { type: 'boolean' },
      timeout: { type: 'string' },
      interval: { type: 'string' },
      help: { type: 'boolean' },
    },
  })
  if (values.help || positionals.length !== 1) {
    console.log('用法：node scripts/ses-onboard.mjs <domain> [--region us-east-1] [--from support@domain] '
      + '[--configuration-set name] [--out file] [--no-wait] [--dry-run] [--json] [--check]')
    return values.help ? 0 : 1
  }
  const credentials = values.credentials
    ? credentialsFromFile(values.credentials)
    : credentialsFromEnv()
  if (!credentials) throw new SesOnboardError('缺少 AWS 访问密钥。')
  const cfToken = process.env.CLOUDFLARE_API_TOKEN?.trim()
    || (values['cf-token-file']
      ? readFileSync(values['cf-token-file'], 'utf8').trim()
      : '')
  if (values.check) {
    const domain = positionals[0].trim().toLowerCase()
    const status = await checkIdentity({ domain, region: values.region, credentials })
    if (values.json) {
      console.log(JSON.stringify({ domain, ...status }, null, 2))
    } else {
      console.log(`${domain}: ${status.detail}${status.verified ? '（可用于发信）' : ''}`)
    }
    if (!status.exists) return 1
    return status.verified ? 0 : 3
  }
  const result = await sesOnboard({
    domain: positionals[0].trim().toLowerCase(),
    region: values.region,
    credentials,
    cfToken,
    from: values.from,
    configurationSetName: values['configuration-set'],
    out: values.out,
    dryRun: values['dry-run'] === true,
    wait: values['no-wait'] !== true,
    timeoutMs: values.timeout ? Number(values.timeout) * 1000 : DEFAULT_TIMEOUT_MS,
    intervalMs: values.interval ? Number(values.interval) * 1000 : DEFAULT_INTERVAL_MS,
    log: (message) => {
      if (!values.json) console.log(message)
    },
  })
  if (values.json) {
    console.log(JSON.stringify({ ...result, config: undefined }, null, 2))
  }
  return result.status === 'verified' || result.status === 'dry-run' ? 0 : 3
}

if (isMainModule(import.meta.url)) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error(error instanceof SesOnboardError ? error.message : error)
    process.exit(error?.exitCode || 1)
  })
}
