import { describe, expect, it, vi } from 'vitest'
import {
  findZone,
  main,
  onboardReceiveDomain,
  onboardingStatements,
  validDomain,
  validLocalPart,
} from './onboard-receive-domain.mjs'

const token = 'cf-token'
const accountId = 'acct-1'
const databaseId = 'db-1'
const zoneId = 'zone-1'

type Call = { method: string; url: string; body: string }

function json(status: number, result: unknown, success = true): Response {
  return new Response(JSON.stringify({ success, result }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function makeHttp(options: {
  zone?: boolean
  routingEnabled?: boolean
  routingReady?: boolean
  catchAllMatches?: boolean
  mx?: string[]
  exists?: boolean
} = {}) {
  const {
    zone = true,
    routingEnabled = false,
    routingReady = true,
    catchAllMatches = false,
    mx = ['route1.mx.cloudflare.net', 'route2.mx.cloudflare.net'],
    exists = false,
  } = options
  const calls: Call[] = []
  let enabledByCall = false
  const http = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    calls.push({ method, url, body: String(init?.body ?? '') })
    if (url.endsWith('/zones?name=example.com')) {
      return json(200, zone ? [{ id: zoneId, name: 'example.com', status: 'active' }] : [])
    }
    if (url.endsWith('/email/routing/enable')) {
      enabledByCall = true
      return json(200, { enabled: true, status: 'ready' })
    }
    if (url.endsWith('/email/routing/rules/catch_all')) {
      if (method === 'PUT') return json(200, { enabled: true, actions: [{ type: 'worker', value: ['omni-mail'] }] })
      return json(200, catchAllMatches
        ? { enabled: true, matchers: [{ type: 'all' }], actions: [{ type: 'worker', value: ['omni-mail'] }] }
        : { enabled: false, matchers: [{ type: 'all' }], actions: [{ type: 'drop' }] })
    }
    if (url.includes('/email/routing')) {
      const enabled = routingEnabled || enabledByCall
      return json(200, { enabled, status: enabled && routingReady ? 'ready' : 'unconfigured' })
    }
    if (url.includes('/dns_records?type=MX')) {
      return json(200, mx.map((content, index) => ({ type: 'MX', content, priority: index + 1 })))
    }
    if (url.includes('/d1/database/')) {
      const sql = String(init?.body ?? '')
      if (sql.includes('SELECT d.name AS domain')) {
        return json(200, [{ domain: 'example.com', mailbox: 'support@example.com', is_active: 1 }])
      }
      if (sql.includes('AS has_domain')) {
        return json(200, [{ has_domain: exists ? 1 : 0, has_mailbox: exists ? 1 : 0 }])
      }
      return json(200, [])
    }
    return json(404, null, false)
  })
  return { http, calls }
}

describe('receive-domain onboarding script', () => {
  it('validates domain and local part', () => {
    expect(validDomain('Example.COM.')).toBe('example.com')
    expect(validDomain('bad_domain')).toBeNull()
    expect(validDomain('a')).toBeNull()
    expect(validLocalPart('support')).toBe('support')
    expect(validLocalPart('bad local')).toBeNull()
  })

  it('escapes values in the D1 statements', () => {
    const statements = onboardingStatements({
      domain: "o'brien.example",
      address: "support@o'brien.example",
      ownerEmail: 'owner@example.com',
    })
    expect(statements.domain).toContain("'o''brien.example'")
    expect(statements.mailbox).toContain("'support@o''brien.example'")
    expect(statements.domainAudit).toContain('domain.create')
    expect(statements.mailboxAudit).toContain('mailbox.create')
  })

  it('enables routing, points catch-all at the worker and writes D1 rows', async () => {
    const { http, calls } = makeHttp()
    const result = await onboardReceiveDomain({
      domain: 'example.com',
      token,
      accountId,
      databaseId,
      http,
      log: () => {},
      sleep: async () => {},
    })

    expect(result).toMatchObject({
      domain: 'example.com',
      address: 'support@example.com',
      emailRouting: { wasEnabled: false, ready: true },
      catchAll: 'updated',
    })
    expect(calls.some((call) => call.method === 'POST' && call.url.endsWith('/email/routing/enable'))).toBe(true)
    const rulePut = calls.find((call) => call.method === 'PUT' && call.url.endsWith('/catch_all'))
    expect(JSON.parse(rulePut?.body ?? '{}')).toMatchObject({
      enabled: true,
      actions: [{ type: 'worker', value: ['omni-mail'] }],
    })
    const d1Calls = calls.filter((call) => call.url.includes('/d1/database/'))
    expect(d1Calls).toHaveLength(6)
    expect(d1Calls.filter((call) => call.body.includes('INSERT INTO domains'))).toHaveLength(1)
    expect(d1Calls.filter((call) => call.body.includes('INSERT INTO mailboxes'))).toHaveLength(1)
    expect(d1Calls.filter((call) => call.body.includes('INSERT INTO audit_logs'))).toHaveLength(2)
  })

  it('is idempotent when routing and catch-all are already configured', async () => {
    const { http, calls } = makeHttp({ routingEnabled: true, catchAllMatches: true })
    const result = await onboardReceiveDomain({
      domain: 'example.com',
      token,
      accountId,
      databaseId,
      http,
      log: () => {},
    })

    expect(result.emailRouting).toMatchObject({ wasEnabled: true, ready: true })
    expect(result.catchAll).toBe('unchanged')
    expect(calls.some((call) => call.url.endsWith('/email/routing/enable'))).toBe(false)
    expect(calls.some((call) => call.method === 'PUT')).toBe(false)
    const d1Calls = calls.filter((call) => call.url.includes('/d1/database/'))
    expect(d1Calls).toHaveLength(6)
    expect(d1Calls.filter((call) => call.body.includes('INSERT INTO audit_logs'))).toHaveLength(2)
  })

  it('skips audit rows when the domain and mailbox already exist', async () => {
    const { http, calls } = makeHttp({ routingEnabled: true, catchAllMatches: true, exists: true })
    await onboardReceiveDomain({
      domain: 'example.com',
      token,
      accountId,
      databaseId,
      http,
      log: () => {},
    })
    const d1Calls = calls.filter((call) => call.url.includes('/d1/database/'))
    expect(d1Calls.filter((call) => call.body.includes('INSERT INTO audit_logs'))).toHaveLength(0)
    expect(d1Calls.filter((call) => call.body.includes('INSERT INTO domains'))).toHaveLength(1)
  })

  it('fails with exit code 2 when the zone is missing', async () => {
    const { http } = makeHttp({ zone: false })
    await expect(findZone({ token, domain: 'example.com', http })).rejects.toMatchObject({
      exitCode: 2,
    })
  })

  it('writes nothing in dry-run mode', async () => {
    const { http, calls } = makeHttp()
    const result = await onboardReceiveDomain({
      domain: 'example.com',
      token,
      accountId,
      databaseId,
      dryRun: true,
      http,
      log: () => {},
    })

    expect(result.dryRun).toBe(true)
    expect(calls.some((call) => call.method !== 'GET')).toBe(false)
  })

  it('reports exit code 3 when routing does not become ready', async () => {
    const { http } = makeHttp({ routingReady: false })
    const result = await onboardReceiveDomain({
      domain: 'example.com',
      token,
      accountId,
      databaseId,
      http,
      log: () => {},
      sleep: async () => {},
      skipReadyWait: true,
    })
    expect(result.emailRouting.ready).toBe(false)
    expect(result.emailRouting.status).toBe('unconfigured')
  })

  it('runs the CLI with env credentials', async () => {
    vi.stubEnv('CLOUDFLARE_API_TOKEN', token)
    vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', accountId)
    const { http } = makeHttp({ routingEnabled: true, catchAllMatches: true })
    vi.stubGlobal('fetch', http)

    await expect(main(['example.com', '--json'])).resolves.toBe(0)
    await expect(main([])).resolves.toBe(1)
    vi.unstubAllEnvs()
  })
})
