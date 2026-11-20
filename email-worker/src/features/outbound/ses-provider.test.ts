import { afterEach, describe, expect, it, vi } from 'vitest'
import { deliverWithSes } from './ses-provider'
import type { DeliveryPayload } from './outbound-http-provider'
import type { SesConfig } from './ses-config'

const config: SesConfig = {
  region: 'us-east-1',
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'c2VjcmV0LWV4YW1wbGU',
}

const payload: DeliveryPayload = {
  from: 'Owner <owner@example.com>',
  to: ['first@example.net', 'second@example.net'],
  replyTo: 'owner@example.com',
  subject: 'Hello',
  text: 'Message body',
  html: '<p>Message body</p>',
  idempotencyKey: 'request_ses',
  headers: { References: '<original@example.net>' },
  attachments: [{ filename: 'note.txt', contentType: 'text/plain', content: 'aGVsbG8=' }],
}

afterEach(() => vi.unstubAllGlobals())

describe('Amazon SES delivery', () => {
  it('posts signed raw MIME to the SES v2 endpoint', async () => {
    const ses = vi.fn(async () => Response.json({ MessageId: 'ses-message-1' }))
    vi.stubGlobal('fetch', ses)

    await expect(deliverWithSes(config, payload)).resolves.toBe('ses:ses-message-1')

    const [url, request] = ses.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://email.us-east-1.amazonaws.com/v2/email/outbound-emails')
    expect(request.method).toBe('POST')
    const headers = request.headers as Record<string, string>
    expect(headers.authorization).toContain('AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE/')
    expect(headers.authorization).toContain('/us-east-1/ses/aws4_request')
    expect(headers['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/)
    const body = JSON.parse(String(request.body)) as {
      FromEmailAddress: string
      Destination: { ToAddresses: string[] }
      ReplyToAddresses: string[]
      Content: { Raw: { Data: string } }
    }
    expect(body.FromEmailAddress).toBe('Owner <owner@example.com>')
    expect(body.Destination.ToAddresses).toEqual(['first@example.net', 'second@example.net'])
    expect(body.ReplyToAddresses).toEqual(['owner@example.com'])
    const raw = Buffer.from(body.Content.Raw.Data, 'base64').toString('utf8')
    expect(raw).toContain('Subject: Hello')
    expect(raw).toContain('References: <original@example.net>')
    expect(raw).toContain('filename="note.txt"')
  })

  it('passes the configuration set when configured', async () => {
    const ses = vi.fn(async () => Response.json({ MessageId: 'ses-message-2' }))
    vi.stubGlobal('fetch', ses)

    await deliverWithSes({ ...config, configurationSetName: 'omnimail' }, payload)

    const body = JSON.parse(String((ses.mock.calls[0] as [string, RequestInit])[1].body))
    expect(body.ConfigurationSetName).toBe('omnimail')
  })

  it('fails fast on an unverified domain instead of retrying', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(
      { message: 'Email address is not verified.' },
      { status: 400 },
    )))

    await expect(deliverWithSes(config, payload)).rejects.toMatchObject({
      message: 'Amazon SES: Email address is not verified.',
      retryable: false,
      deliveryUncertain: false,
    })
  })

  it('marks network failures as uncertain because SES has no idempotency key', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new DOMException('timeout', 'TimeoutError')
    }))

    await expect(deliverWithSes(config, payload)).rejects.toMatchObject({
      retryable: false,
      deliveryUncertain: true,
    })
  })

  it('rejects messages that exceed the SES raw size limit before calling SES', async () => {
    const ses = vi.fn(async () => Response.json({ MessageId: 'unused' }))
    vi.stubGlobal('fetch', ses)

    await expect(deliverWithSes(config, {
      ...payload,
      attachments: [{
        filename: 'large.bin',
        contentType: 'application/octet-stream',
        content: 'A'.repeat(11 * 1024 * 1024),
      }],
    })).rejects.toMatchObject({ retryable: false, deliveryUncertain: false })
    expect(ses).not.toHaveBeenCalled()
  })

  it('treats throttling as retryable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(
      { message: 'Maximum sending rate exceeded.' },
      { status: 429 },
    )))

    await expect(deliverWithSes(config, payload)).rejects.toMatchObject({ retryable: true })
  })
})
