#!/usr/bin/env node
/**
 * 给一个域名开通「收信」：Cloudflare Email Routing 开启 + catch-all 指向 OmniMail Worker，
 * 并在 OmniMail D1 里登记域名与信箱。
 *
 *   node scripts/onboard-receive-domain.mjs <domain> [--mailbox support] [--json] [--dry-run]
 *
 * 环境变量：
 *   CLOUDFLARE_API_TOKEN   必需。需要 Zone:Read、Email Routing Rules:Read/Edit、DNS:Read、
 *                          Account D1:Read/Write（用 scripts/cf-token 的既有做法创建）。
 *   CLOUDFLARE_ACCOUNT_ID  必需。
 *   OMNIMAIL_D1_ID         可选，默认本部署的 omni-mail-db uuid。
 *   OMNIMAIL_WORKER        可选，默认 omni-mail。
 *   OMNIMAIL_OWNER_EMAIL   可选，默认站点主管理员邮箱（信箱与域名归属）。
 *
 * 退出码：0 已开通；2 域名在这个 Cloudflare 账号里找不到 zone；3 配置已写但
 *         Email Routing 还没 ready；1 其它错误。
 *
 * 可重复执行：已开启的 routing、已存在的 catch-all 规则与 D1 行都会跳过。
 */
import { parseArgs } from 'node:util'

const DEFAULT_D1_ID = '8f38947f-4bba-4805-80be-93482b27aa92'
const DEFAULT_WORKER = 'omni-mail'
const DEFAULT_OWNER = 'andywangzzm@gmail.com'
const CATCH_ALL_NAME = 'OmniMail catch-all'
const READY_TIMEOUT_MS = 60_000
const READY_INTERVAL_MS = 3_000

class OnboardError extends Error {
  constructor(message, exitCode = 1) {
    super(message)
    this.name = 'OnboardError'
    this.exitCode = exitCode
  }
}

export function validDomain(value) {
  const domain = String(value || '').trim().toLowerCase().replace(/\.$/, '')
  if (!domain || domain.length > 253 || domain.includes('@') || domain.includes('/')) return null
  const labels = domain.split('.')
  if (labels.length < 2) return null
  return labels.every((label) => (
    label.length > 0 && label.length <= 63
    && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)
  )) ? domain : null
}

export function validLocalPart(value) {
  const local = String(value || '').trim()
  return /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(local) ? local : null
}

async function cf({ token, method, path, body, http = fetch }) {
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
    throw new OnboardError(`Cloudflare ${method} ${path} 失败：${detail || response.status}`)
  }
  return parsed.result
}

export async function findZone({ token, domain, http = fetch }) {
  const zones = await cf({ token, method: 'GET', path: `/zones?name=${encodeURIComponent(domain)}`, http })
  const zone = (zones || []).find((item) => String(item.name).toLowerCase() === domain)
  if (!zone) {
    throw new OnboardError(
      `Cloudflare 账号里没有 ${domain} 这个 zone（域名不在该账号，或未接入 Cloudflare）。`,
      2,
    )
  }
  return zone
}

function catchAllMatches(rule, workerName) {
  const actions = rule?.actions || []
  return rule?.enabled === true
    && (rule.matchers || []).some((matcher) => matcher.type === 'all')
    && actions.length === 1
    && actions[0].type === 'worker'
    && Array.isArray(actions[0].value)
    && actions[0].value.includes(workerName)
}

async function waitForReady({ token, zoneId, http = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), timeoutMs = READY_TIMEOUT_MS, intervalMs = READY_INTERVAL_MS }) {
  const deadline = Date.now() + timeoutMs
  let routing = await cf({ token, method: 'GET', path: `/zones/${zoneId}/email/routing`, http })
  while (Date.now() < deadline) {
    if (routing?.enabled === true && routing?.status === 'ready') return routing
    await sleep(intervalMs)
    routing = await cf({ token, method: 'GET', path: `/zones/${zoneId}/email/routing`, http })
  }
  return routing
}

async function d1Query({ token, accountId, databaseId, sql, http = fetch }) {
  const result = await cf({
    token,
    method: 'POST',
    path: `/accounts/${accountId}/d1/database/${databaseId}/query`,
    body: { sql },
    http,
  })
  return result?.[0]?.results ?? result
}

function sqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

export function onboardingStatements({ domain, address, ownerEmail }) {
  const owner = `(SELECT id FROM users WHERE email=${sqlLiteral(ownerEmail)})`
  return {
    domain: `INSERT INTO domains (name, is_active, created_by)
      SELECT ${sqlLiteral(domain)}, 1, id FROM users WHERE email=${sqlLiteral(ownerEmail)}
      ON CONFLICT(name) DO UPDATE SET is_active=1, updated_at=unixepoch()`,
    mailbox: `INSERT INTO mailboxes (address, user_id, is_primary, is_active, is_hidden)
      SELECT ${sqlLiteral(address)}, id, 0, 1, 0 FROM users WHERE email=${sqlLiteral(ownerEmail)}
      ON CONFLICT(address) DO UPDATE SET is_active=1, is_hidden=0`,
    domainAudit: `INSERT INTO audit_logs (user_id, action, target_id, ip, detail_json)
      VALUES (${owner}, 'domain.create', ${sqlLiteral(domain)}, 'onboard-script', '{"source":"onboard-receive-domain"}')`,
    mailboxAudit: `INSERT INTO audit_logs (user_id, action, target_id, ip, detail_json)
      VALUES (${owner}, 'mailbox.create', ${sqlLiteral(address)}, 'onboard-script', '{"source":"onboard-receive-domain"}')`,
  }
}

export async function onboardReceiveDomain(input) {
  const {
    domain: rawDomain,
    mailboxLocalPart = 'support',
    token,
    accountId,
    databaseId = DEFAULT_D1_ID,
    workerName = DEFAULT_WORKER,
    ownerEmail = DEFAULT_OWNER,
    dryRun = false,
    http = fetch,
    log = console.log,
    sleep,
    skipReadyWait = false,
  } = input
  const domain = validDomain(rawDomain)
  if (!domain) throw new OnboardError(`域名不合法：${rawDomain}`)
  const localPart = validLocalPart(mailboxLocalPart)
  if (!localPart) throw new OnboardError(`信箱名不合法：${mailboxLocalPart}`)
  if (!token) throw new OnboardError('缺少 CLOUDFLARE_API_TOKEN。')
  if (!accountId) throw new OnboardError('缺少 CLOUDFLARE_ACCOUNT_ID。')
  const address = `${localPart}@${domain}`

  log(`1/5 解析 zone：${domain}`)
  const zone = await findZone({ token, domain, http })
  log(`     zone ${zone.name}（${zone.id}），状态 ${zone.status}`)

  log('2/5 检查 Email Routing')
  let routing = await cf({ token, method: 'GET', path: `/zones/${zone.id}/email/routing`, http })
  const wasEnabled = routing?.enabled === true
  if (!wasEnabled) {
    if (dryRun) {
      log('     [dry-run] 会开启 Email Routing 并自动写入 MX 与 SPF')
    } else {
      await cf({ token, method: 'POST', path: `/zones/${zone.id}/email/routing/enable`, http })
      log('     已开启 Email Routing（自动写入 MX route1/2/3.mx.cloudflare.net 与 SPF）')
    }
  } else {
    log(`     已经开启（status=${routing.status}），跳过`)
  }

  log('3/5 检查 catch-all 规则')
  const existingRule = await cf({ token, method: 'GET', path: `/zones/${zone.id}/email/routing/rules/catch_all`, http })
  const ruleOk = catchAllMatches(existingRule, workerName)
  if (ruleOk) {
    log(`     已指向 worker ${workerName}，跳过`)
  } else if (dryRun) {
    log(`     [dry-run] 会把 catch-all 指向 worker ${workerName}`)
  } else {
    await cf({
      token,
      method: 'PUT',
      path: `/zones/${zone.id}/email/routing/rules/catch_all`,
      body: {
        name: CATCH_ALL_NAME,
        enabled: true,
        matchers: [{ type: 'all' }],
        actions: [{ type: 'worker', value: [workerName] }],
      },
      http,
    })
    log(`     已把 catch-all 指向 worker ${workerName}`)
  }

  log('4/5 校验 MX 记录')
  const mx = await cf({ token, method: 'GET', path: `/zones/${zone.id}/dns_records?type=MX&per_page=50`, http })
  const mxHosts = (mx || []).map((record) => String(record.content).toLowerCase())
  const routingMx = mxHosts.filter((host) => /^route\d+\.mx\.cloudflare\.net$/.test(host))
  if (routingMx.length === 0) {
    log('     ⚠ 没看到 Cloudflare Email Routing 的 MX 记录；收信可能不会生效，请检查 zone 的 DNS')
  } else {
    log(`     MX 就绪：${routingMx.join(', ')}`)
  }

  log('5/5 登记 OmniMail 域名与信箱')
  const statements = onboardingStatements({ domain, address, ownerEmail })
  if (dryRun) {
    log(`     [dry-run] 会写入 domains(${domain})、mailboxes(${address})，按需补审计记录`)
  } else {
    // 先看是否已存在：已存在就只做幂等 upsert，不重复写审计日志。
    const existing = await d1Query({
      token,
      accountId,
      databaseId,
      sql: `SELECT
        EXISTS(SELECT 1 FROM domains WHERE name = ${sqlLiteral(domain)}) AS has_domain,
        EXISTS(SELECT 1 FROM mailboxes WHERE address = ${sqlLiteral(address)}) AS has_mailbox`,
      http,
    })
    const hasDomain = Number(existing?.[0]?.has_domain) === 1
    const hasMailbox = Number(existing?.[0]?.has_mailbox) === 1
    await d1Query({ token, accountId, databaseId, sql: statements.domain, http })
    await d1Query({ token, accountId, databaseId, sql: statements.mailbox, http })
    if (!hasDomain) {
      await d1Query({ token, accountId, databaseId, sql: statements.domainAudit, http })
    }
    if (!hasMailbox) {
      await d1Query({ token, accountId, databaseId, sql: statements.mailboxAudit, http })
    }
    log(`     已登记 ${domain} 与 ${address}（新建域名：${!hasDomain}，新建信箱：${!hasMailbox}）`)
  }

  let finalRouting = routing
  if (!dryRun && !skipReadyWait && !wasEnabled) {
    finalRouting = await waitForReady({ token, zoneId: zone.id, http, sleep })
  }
  const ready = finalRouting?.enabled === true && finalRouting?.status === 'ready'

  if (!dryRun) {
    const check = await d1Query({
      token,
      accountId,
      databaseId,
      sql: `SELECT d.name AS domain, m.address AS mailbox, m.is_active
              FROM domains d LEFT JOIN mailboxes m ON LOWER(SUBSTR(m.address, INSTR(m.address, '@') + 1)) = d.name
             WHERE d.name = ${sqlLiteral(domain)} AND m.address = ${sqlLiteral(address)}`,
      http,
    })
    const row = (check || [])[0]
    if (!row) throw new OnboardError(`写入后没查到 ${domain} / ${address}，请检查 D1 权限`)
    log(`     复核：${row.domain} / ${row.mailbox}（active=${row.is_active}）`)
  }

  return {
    domain,
    address,
    zone: zone.name,
    zoneId: zone.id,
    emailRouting: { wasEnabled, ready, status: finalRouting?.status ?? null },
    catchAll: dryRun ? 'planned' : (ruleOk ? 'unchanged' : 'updated'),
    mx: routingMx,
    dryRun,
  }
}

export async function main(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      mailbox: { type: 'string', default: 'support' },
      json: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      'no-wait': { type: 'boolean' },
      help: { type: 'boolean' },
    },
  })
  if (values.help || positionals.length !== 1) {
    console.log('用法：node scripts/onboard-receive-domain.mjs <domain> [--mailbox support] [--json] [--dry-run] [--no-wait]')
    return values.help ? 0 : 1
  }
  const result = await onboardReceiveDomain({
    domain: positionals[0],
    mailboxLocalPart: values.mailbox,
    token: process.env.CLOUDFLARE_API_TOKEN?.trim(),
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID?.trim(),
    databaseId: process.env.OMNIMAIL_D1_ID?.trim() || DEFAULT_D1_ID,
    workerName: process.env.OMNIMAIL_WORKER?.trim() || DEFAULT_WORKER,
    ownerEmail: process.env.OMNIMAIL_OWNER_EMAIL?.trim() || DEFAULT_OWNER,
    dryRun: values['dry-run'] === true,
    skipReadyWait: values['no-wait'] === true,
    log: (message) => {
      if (!values.json) console.log(message)
    },
  })
  if (values.json) console.log(JSON.stringify(result, null, 2))
  return result.emailRouting.ready || result.dryRun ? 0 : 3
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error(error instanceof OnboardError ? error.message : error)
    process.exit(error?.exitCode || 1)
  })
}
