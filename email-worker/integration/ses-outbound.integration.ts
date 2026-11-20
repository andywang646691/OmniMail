import { env } from 'cloudflare:workers'
import { applyD1Migrations } from 'cloudflare:test'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Env, MailQueueJob, SessionUser } from '../src/app/types'
import { consumeEmailQueue } from '../src/app/handlers/mail'
import { sendOutboundMessage } from '../src/features/outbound/outbound-message'

const owner = {
  id: 'ses-owner',
  email: 'owner@example.com',
  displayName: 'Owner',
  role: 'super_admin',
  mailboxLimit: 10,
  storageQuotaBytes: 1024 * 1024 * 1024,
  storageUsedBytes: 0,
  canCreateMailboxes: true,
  canReply: true,
  canTranslate: true,
  temporaryExpiresAt: null,
} as SessionUser

const sesAccount = {
  region: 'us-east-1',
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'c2VjcmV0LWV4YW1wbGU',
  from: 'Support <support@example.com>',
}

function sesEnv(): Env {
  return {
    ...env,
    SES_DOMAIN_CONFIGS: JSON.stringify({ 'example.com': sesAccount }),
  } as unknown as Env
}

function outboundBatch(body: MailQueueJob, attempts = 1) {
  const ack = vi.fn()
  const retry = vi.fn()
  const batch = {
    queue: 'omnimail-mail',
    messages: [{ id: 'message-1', timestamp: new Date(), body, attempts, ack, retry }],
  } as unknown as MessageBatch<MailQueueJob>
  return { batch, ack, retry }
}

async function queueMessage(
  appEnv: Env,
  idempotencyKey: string,
  recipient: string,
): Promise<string> {
  const queued = await sendOutboundMessage(appEnv, owner, {
    mailboxAddress: 'owner@example.com',
    recipients: [recipient],
    subject: 'SES 集成测试',
    text: 'Hello from SES',
    idempotencyKey,
    auditAction: 'message.send',
    auditDetail: { source: 'integration' },
  }, '127.0.0.1')
  expect(queued.status).toBe(202)
  const created = await queued.json<{ message: { id: string } }>()
  return created.message.id
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
  await env.DB.prepare(
    `INSERT INTO users (id, email, display_name, password_hash, role, can_reply, mailbox_limit, can_create_mailboxes)
     VALUES ('ses-owner', 'owner@example.com', 'Owner', 'test', 'super_admin', 1, 10, 1)`,
  ).run()
  await env.DB.prepare("INSERT INTO domains (name) VALUES ('example.com')").run()
  await env.DB.prepare(
    `INSERT INTO mailboxes (address, user_id, is_primary, is_active)
     VALUES ('owner@example.com', 'ses-owner', 1, 1)`,
  ).run()
})

afterEach(() => vi.unstubAllGlobals())

describe('Amazon SES outbound delivery', () => {
  it('delivers a queued message through the SES provider and records the result', async () => {
    const ses = vi.fn(async () => Response.json({ MessageId: 'ses-integration-1' }))
    vi.stubGlobal('fetch', ses)
    const appEnv = sesEnv()
    const messageId = await queueMessage(appEnv, 'ses_integration_1', 'friend@example.net')

    const { batch, ack, retry } = outboundBatch({
      kind: 'outbound',
      messageId,
      userId: owner.id,
      ip: '127.0.0.1',
      auditAction: 'message.send',
      auditDetail: { source: 'integration' },
    })
    await consumeEmailQueue(batch, appEnv)

    expect(ack).toHaveBeenCalled()
    expect(retry).not.toHaveBeenCalled()
    const row = await env.DB.prepare(
      'SELECT status, provider_id, delivery_status FROM messages WHERE id = ?',
    ).bind(messageId).first<{
      status: string
      provider_id: string
      delivery_status: string
    }>()
    expect(row).toEqual({
      status: 'sent',
      provider_id: 'ses:ses-integration-1',
      delivery_status: 'sent',
    })

    const [url, request] = ses.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://email.us-east-1.amazonaws.com/v2/email/outbound-emails')
    const body = JSON.parse(String(request.body)) as {
      FromEmailAddress: string
      Destination: { ToAddresses: string[] }
      Content: { Raw: { Data: string } }
    }
    expect(body.FromEmailAddress).toBe('Support <support@example.com>')
    expect(body.Destination.ToAddresses).toEqual(['friend@example.net'])
    // Raw MIME is pure ASCII: bodies are base64 and non-ASCII subjects use RFC 2047 words.
    const raw = atob(body.Content.Raw.Data)
    expect(raw).toContain('Subject: =?UTF-8?B?')
    expect(raw).toContain('Reply-To: owner@example.com')
  })

  it('marks a non-retryable SES rejection as failed without retrying', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(
      { message: 'Email address is not verified.' },
      { status: 400 },
    )))
    const appEnv = sesEnv()
    const messageId = await queueMessage(appEnv, 'ses_integration_2', 'stranger@example.net')

    const { batch, ack, retry } = outboundBatch({
      kind: 'outbound',
      messageId,
      userId: owner.id,
      ip: '127.0.0.1',
      auditAction: 'message.send',
      auditDetail: {},
    })
    await consumeEmailQueue(batch, appEnv)

    expect(ack).toHaveBeenCalled()
    expect(retry).not.toHaveBeenCalled()
    const row = await env.DB.prepare(
      'SELECT status, processing_error FROM messages WHERE id = ?',
    ).bind(messageId).first<{ status: string; processing_error: string }>()
    expect(row?.status).toBe('failed')
    expect(row?.processing_error).toContain('not verified')
  })
})
