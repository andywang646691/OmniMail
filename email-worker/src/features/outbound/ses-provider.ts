import { signAwsRequest } from './aws-signature'
import { DELIVERY_UNCERTAIN_PREFIX, OutboundDeliveryError } from './outbound-errors'
import { buildRawMime, base64FromUtf8 } from './ses-mime'
import type { DeliveryPayload } from './outbound-http-provider'
import type { SesConfig } from './ses-config'

const SES_TIMEOUT_MS = 15_000
const SES_ATTACHMENT_TIMEOUT_MS = 60_000
/** Amazon SES rejects raw messages above 10 MB, measured after MIME/base64 expansion. */
const SES_MAX_RAW_BYTES = 10 * 1024 * 1024

function retryableStatus(status: number): boolean {
  // 429 covers SES throttling; 4xx rejections (unverified domain, paused account,
  // missing configuration set) must fail fast instead of burning queue retries.
  return status === 408 || status === 409 || status === 429 || status >= 500
}

type SesResponse = { MessageId?: string; message?: string; Message?: string }

async function readResponse(response: Response): Promise<{ text: string; parsed: SesResponse }> {
  const text = await response.text().catch(() => '')
  if (!text) return { text, parsed: {} }
  try {
    return { text, parsed: JSON.parse(text) as SesResponse }
  } catch {
    return { text, parsed: {} }
  }
}

function failureMessage(status: number, text: string, parsed: SesResponse): string {
  const message = parsed.message || parsed.Message
  if (message) return `Amazon SES: ${message}`
  if (text) return `Amazon SES returned ${status}: ${text.slice(0, 300)}`
  return `Amazon SES returned ${status}`
}

/**
 * Sends one message through the SES v2 HTTP API using raw MIME content.
 * Raw content is what makes attachments, In-Reply-To/References headers and
 * non-ASCII subjects behave the same as the Resend path.
 */
export async function deliverWithSes(
  config: SesConfig,
  payload: DeliveryPayload,
): Promise<string> {
  const raw = buildRawMime({
    from: payload.from,
    to: payload.to,
    replyTo: payload.replyTo,
    subject: payload.subject,
    text: payload.text,
    html: payload.html,
    headers: payload.headers,
    attachments: payload.attachments,
  })
  const rawBytes = new TextEncoder().encode(raw).length
  if (rawBytes > SES_MAX_RAW_BYTES) {
    throw new OutboundDeliveryError(
      `邮件经 MIME 编码后为 ${(rawBytes / 1024 / 1024).toFixed(1)} MB，超过 Amazon SES 的 10 MB 上限；请减少附件后再发送。`,
      false,
    )
  }
  const body = JSON.stringify({
    FromEmailAddress: payload.from,
    Destination: { ToAddresses: payload.to },
    ReplyToAddresses: [payload.replyTo],
    Content: { Raw: { Data: base64FromUtf8(raw) } },
    ...(config.configurationSetName
      ? { ConfigurationSetName: config.configurationSetName }
      : {}),
  })
  const host = `email.${config.region}.amazonaws.com`
  const signed = await signAwsRequest({
    method: 'POST',
    host,
    path: '/v2/email/outbound-emails',
    region: config.region,
    service: 'ses',
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      sessionToken: config.sessionToken,
    },
    payload: body,
    headers: { 'content-type': 'application/json' },
  })
  let response: Response
  try {
    response = await fetch(signed.url, {
      method: 'POST',
      headers: signed.headers,
      body,
      signal: AbortSignal.timeout(
        payload.attachments.length ? SES_ATTACHMENT_TIMEOUT_MS : SES_TIMEOUT_MS,
      ),
    })
  } catch (error) {
    // SES has no idempotency key, so an unknown outcome must not be retried blindly.
    throw new OutboundDeliveryError(
      `${DELIVERY_UNCERTAIN_PREFIX}${error instanceof Error ? error.message : 'Amazon SES request failed'}`,
      false,
      true,
    )
  }
  const { text, parsed } = await readResponse(response)
  if (!response.ok || !parsed.MessageId) {
    throw new OutboundDeliveryError(
      failureMessage(response.status, text, parsed),
      retryableStatus(response.status),
    )
  }
  return `ses:${parsed.MessageId}`
}
