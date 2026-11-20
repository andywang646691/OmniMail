import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  checkIdentity,
  createIdentity,
  dkimRecords,
  identityStatus,
  identityVerified,
  main,
  sesOnboard,
} from './ses-onboard.mjs'

const credentials = { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'c2VjcmV0LWV4YW1wbGU' }
const tokens = ['token1', 'token2', 'token3']

type Call = { url: string; method: string; body: string }

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function fakeHttp(handlers: {
  identity?: Array<unknown>
  createStatus?: number
  createBody?: unknown
  dnsRecords?: Array<Record<string, unknown>>
}) {
  const calls: Call[] = []
  const identityResponses = handlers.identity ?? []
  let identityIndex = 0
  const http = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    calls.push({ url, method, body: String(init?.body ?? '') })
    if (url === 'https://email.us-east-1.amazonaws.com/v2/email/identities') {
      return json(handlers.createStatus ?? 200, handlers.createBody ?? {
        DkimAttributes: { Tokens: tokens, Status: 'NOT_STARTED' },
      })
    }
    if (url.startsWith('https://email.us-east-1.amazonaws.com/v2/email/identities/')) {
      const response = identityResponses[Math.min(identityIndex, identityResponses.length - 1)]
      identityIndex += 1
      return response instanceof Response ? response : json(200, response)
    }
    if (url.includes('/zones?name=')) {
      return json(200, { success: true, result: [{ id: 'zone1', name: 'example.com' }] })
    }
    if (url.includes('/dns_records?per_page=')) {
      return json(200, { success: true, result: handlers.dnsRecords ?? [] })
    }
    if (url.endsWith('/dns_records')) {
      return json(200, { success: true, result: { id: 'record1' } })
    }
    return json(404, { success: false, errors: [{ message: `unexpected ${url}` }] })
  })
  return { http, calls }
}

const verifiedIdentity = {
  VerifiedForSendingStatus: true,
  DkimAttributes: { Status: 'SUCCESS', Tokens: tokens },
}

afterEach(() => vi.unstubAllGlobals())

describe('Amazon SES onboarding', () => {
  it('builds the three Easy DKIM CNAME records', () => {
    expect(dkimRecords('example.com', tokens)).toEqual([
      { type: 'CNAME', name: 'token1._domainkey.example.com', content: 'token1.dkim.amazonses.com', ttl: 1, proxied: false },
      { type: 'CNAME', name: 'token2._domainkey.example.com', content: 'token2.dkim.amazonses.com', ttl: 1, proxied: false },
      { type: 'CNAME', name: 'token3._domainkey.example.com', content: 'token3.dkim.amazonses.com', ttl: 1, proxied: false },
    ])
    expect(() => dkimRecords('example.com', ['only-one'])).toThrow(/DKIM token/)
    expect(() => dkimRecords('bad domain!', tokens)).toThrow(/域名不合法/)
  })

  it('treats a SUCCESS DKIM status as verified', () => {
    expect(identityVerified({ status: 200, body: verifiedIdentity })).toBe(true)
    expect(identityVerified({ status: 200, body: { VerifiedForSendingStatus: true } })).toBe(false)
    expect(identityVerified({ status: 500, body: {} })).toBe(false)
    expect(identityStatus(null)).toBe('暂无响应')
  })

  it('writes DKIM records and reports verified', async () => {
    const { http, calls } = fakeHttp({
      identity: [
        { VerifiedForSendingStatus: false, DkimAttributes: { Status: 'PENDING', Tokens: tokens } },
        verifiedIdentity,
      ],
    })
    const directory = mkdtempSync(join(tmpdir(), 'ses-onboard-'))
    try {
      const out = join(directory, 'config.json')
      const result = await sesOnboard({
        domain: 'example.com',
        credentials,
        cfToken: 'cf-token',
        from: 'support@example.com',
        out,
        http,
        sleepImpl: async () => {},
        log: () => {},
      })

      expect(result.status).toBe('verified')
      expect(result.created).toBe(3)
      expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/dns_records'))).toHaveLength(3)
      const config = JSON.parse(readFileSync(out, 'utf8'))
      expect(config).toEqual({
        'example.com': {
          region: 'us-east-1',
          accessKeyId: 'AKIAEXAMPLE',
          secretAccessKey: 'c2VjcmV0LWV4YW1wbGU',
          from: 'support@example.com',
        },
      })
      expect(statSync(out).mode & 0o777).toBe(0o600)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('skips DKIM records that already exist', async () => {
    const { http, calls } = fakeHttp({
      identity: [verifiedIdentity],
      dnsRecords: [
        { type: 'CNAME', name: 'token1._domainkey.example.com', content: 'token1.dkim.amazonses.com' },
      ],
    })
    const result = await sesOnboard({
      domain: 'example.com',
      credentials,
      cfToken: 'cf-token',
      http,
      sleepImpl: async () => {},
      log: () => {},
    })

    expect(result.status).toBe('verified')
    expect(result.created).toBe(2)
    expect(result.skipped).toBe(1)
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/dns_records'))).toHaveLength(2)
  })

  it('falls back to GetEmailIdentity when the identity already exists', async () => {
    const { http } = fakeHttp({
      createStatus: 409,
      createBody: { message: 'AlreadyExists' },
      identity: [verifiedIdentity],
    })

    await expect(createIdentity({
      domain: 'example.com', region: 'us-east-1', credentials, http,
    })).resolves.toEqual({ tokens, status: 'existing' })
  })

  it('stops before writing DNS in dry-run mode', async () => {
    const { http, calls } = fakeHttp({ identity: [verifiedIdentity] })
    const result = await sesOnboard({
      domain: 'example.com',
      credentials,
      cfToken: 'cf-token',
      dryRun: true,
      http,
      log: () => {},
    })

    expect(result.status).toBe('dry-run')
    expect(result.records).toHaveLength(3)
    expect(calls.some((call) => call.method === 'POST' && call.url.endsWith('/dns_records'))).toBe(false)
  })

  it('reports pending when SES has not verified in time', async () => {
    const { http } = fakeHttp({
      identity: [{ VerifiedForSendingStatus: false, DkimAttributes: { Status: 'PENDING', Tokens: tokens } }],
    })
    const result = await sesOnboard({
      domain: 'example.com',
      credentials,
      cfToken: 'cf-token',
      timeoutMs: 0,
      http,
      log: () => {},
    })

    expect(result.status).toBe('pending')
  })

  it('runs the CLI entry point with exit codes 0 and 3', async () => {
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIAEXAMPLE')
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'c2VjcmV0LWV4YW1wbGU')
    vi.stubEnv('CLOUDFLARE_API_TOKEN', 'cf-token')
    const pending = vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url === 'https://email.us-east-1.amazonaws.com/v2/email/identities') {
        return json(200, { DkimAttributes: { Tokens: tokens, Status: 'NOT_STARTED' } })
      }
      if (url.includes('/v2/email/identities/')) {
        return json(200, {
          VerifiedForSendingStatus: false,
          DkimAttributes: { Status: 'PENDING', Tokens: tokens },
        })
      }
      if (url.includes('/zones?name=')) {
        return json(200, { success: true, result: [{ id: 'zone1', name: 'example.com' }] })
      }
      if (url.includes('/dns_records?per_page=')) {
        return json(200, { success: true, result: [] })
      }
      if (url.endsWith('/dns_records')) {
        return json(200, { success: true, result: { id: 'record1' } })
      }
      return json(404, { success: false, errors: [{ message: url }] })
    })
    vi.stubGlobal('fetch', pending)

    await expect(main(['example.com', '--dry-run'])).resolves.toBe(0)
    await expect(main(['example.com', '--no-wait'])).resolves.toBe(3)
    await expect(main([])).resolves.toBe(1)
  })

  it('checks an identity without touching DNS or Cloudflare', async () => {
    const verified = fakeHttp({ identity: [verifiedIdentity] })
    await expect(checkIdentity({
      domain: 'example.com', region: 'us-east-1', credentials, http: verified.http,
    })).resolves.toMatchObject({ exists: true, verified: true, dkimStatus: 'SUCCESS' })
    expect(verified.calls.every((call) => !call.url.includes('api.cloudflare.com'))).toBe(true)

    const pending = fakeHttp({
      identity: [{ VerifiedForSendingStatus: false, DkimAttributes: { Status: 'PENDING', Tokens: tokens } }],
    })
    await expect(checkIdentity({
      domain: 'example.com', region: 'us-east-1', credentials, http: pending.http,
    })).resolves.toMatchObject({ exists: true, verified: false, dkimStatus: 'PENDING' })

    const missing = vi.fn(async () => json(404, { message: 'Not found' }))
    await expect(checkIdentity({
      domain: 'example.com', region: 'us-east-1', credentials, http: missing,
    })).resolves.toMatchObject({ exists: false, verified: false })
  })

  it('requires AWS credentials and a Cloudflare token', async () => {
    await expect(sesOnboard({
      domain: 'example.com', credentials: {}, cfToken: 'x', log: () => {},
    })).rejects.toThrow(/AWS 访问密钥/)
    await expect(sesOnboard({
      domain: 'example.com', credentials, cfToken: '', log: () => {},
    })).rejects.toThrow(/Cloudflare API Token/)
  })
})
