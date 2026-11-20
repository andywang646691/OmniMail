const textEncoder = new TextEncoder()

export type RawAttachment = {
  filename: string
  contentType?: string
  /** Base64 payload without line breaks. */
  content: string
}

export type RawMimeInput = {
  from: string
  to: string[]
  replyTo: string
  subject: string
  text: string
  html: string
  headers: Record<string, string>
  attachments: RawAttachment[]
  now?: Date
  messageIdDomain?: string
}

const CRLF = '\r\n'

function base64FromBytes(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize))
  }
  return btoa(binary)
}

export function base64FromUtf8(value: string): string {
  return base64FromBytes(textEncoder.encode(value))
}

function wrapBase64(value: string): string {
  const chunks: string[] = []
  for (let index = 0; index < value.length; index += 76) {
    chunks.push(value.slice(index, index + 76))
  }
  return chunks.join(CRLF)
}

function stripControl(value: string): string {
  return value.replace(/[\r\n\u0000]+/g, ' ').trim()
}

function isPrintableAscii(value: string): boolean {
  return /^[\u0020-\u007e]*$/.test(value)
}

/**
 * RFC 2047 encoded words are limited to 75 characters each, so long non-ASCII
 * subjects are split on code point boundaries instead of byte boundaries.
 */
function encodeHeaderText(value: string): string {
  const clean = stripControl(value)
  if (isPrintableAscii(clean)) return clean
  const words: string[] = []
  let chunk = ''
  for (const character of clean) {
    if (textEncoder.encode(chunk + character).length > 45 && chunk) {
      words.push(chunk)
      chunk = character
    } else {
      chunk += character
    }
  }
  if (chunk) words.push(chunk)
  return words.map((word) => `=?UTF-8?B?${base64FromUtf8(word)}?=`).join(`${CRLF} `)
}

function encodeParameter(value: string): { plain: string; extended?: string } {
  const clean = stripControl(value)
  if (isPrintableAscii(clean)) return { plain: clean.replace(/["\\]/g, '_') }
  return {
    plain: clean.replace(/[^\u0020-\u007e]|["\\]/g, '_'),
    extended: `UTF-8''${encodeURIComponent(clean).replace(/['()*]/g, (item) => (
      `%${item.charCodeAt(0).toString(16).toUpperCase()}`
    ))}`,
  }
}

function randomId(): string {
  return crypto.randomUUID().replace(/-/g, '')
}

function bodyPart(contentType: string, boundary: string, body: string): string[] {
  return [
    `--${boundary}`,
    `Content-Type: ${contentType}; charset=utf-8`,
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(base64FromUtf8(body)),
  ]
}

function attachmentPart(boundary: string, attachment: RawAttachment): string[] {
  const type = stripControl(attachment.contentType || 'application/octet-stream')
    || 'application/octet-stream'
  const name = encodeParameter(attachment.filename || 'attachment')
  const disposition = name.extended
    ? `Content-Disposition: attachment; filename="${name.plain}"; filename*=${name.extended}`
    : `Content-Disposition: attachment; filename="${name.plain}"`
  const nameParameter = name.extended
    ? `name="${name.plain}"; name*=${name.extended}`
    : `name="${name.plain}"`
  return [
    `--${boundary}`,
    `Content-Type: ${type}; ${nameParameter}`,
    'Content-Transfer-Encoding: base64',
    disposition,
    '',
    wrapBase64(attachment.content.replace(/\s+/g, '')),
  ]
}

/**
 * Builds the RFC 5322 message that SES sends as raw content. Text and HTML
 * bodies always travel as base64 so non-ASCII content and arbitrary line
 * lengths survive untouched.
 */
export function buildRawMime(input: RawMimeInput): string {
  const now = input.now ?? new Date()
  const domain = input.messageIdDomain
    || input.from.slice(input.from.lastIndexOf('@') + 1).replace(/[^\w.-]/g, '')
    || 'omnimail.invalid'
  const mixedBoundary = `omnimail_mixed_${randomId()}`
  const alternativeBoundary = `omnimail_alt_${randomId()}`
  const hasAttachments = input.attachments.length > 0
  const lines: string[] = [
    `From: ${stripControl(input.from)}`,
    `To: ${input.to.map(stripControl).join(', ')}`,
    `Reply-To: ${stripControl(input.replyTo)}`,
    `Subject: ${encodeHeaderText(input.subject)}`,
    `Date: ${now.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${randomId()}@${domain}>`,
    'MIME-Version: 1.0',
  ]
  for (const [name, value] of Object.entries(input.headers)) {
    const headerName = stripControl(name).replace(/[^\w-]/g, '')
    const headerValue = stripControl(value)
    if (headerName && headerValue) lines.push(`${headerName}: ${headerValue}`)
  }
  if (hasAttachments) {
    lines.push(`Content-Type: multipart/mixed; boundary="${mixedBoundary}"`, '')
    lines.push(
      `--${mixedBoundary}`,
      `Content-Type: multipart/alternative; boundary="${alternativeBoundary}"`,
      '',
    )
  } else {
    lines.push(`Content-Type: multipart/alternative; boundary="${alternativeBoundary}"`, '')
  }
  lines.push(...bodyPart('text/plain', alternativeBoundary, input.text))
  lines.push(...bodyPart('text/html', alternativeBoundary, input.html))
  lines.push(`--${alternativeBoundary}--`)
  if (hasAttachments) {
    for (const attachment of input.attachments) {
      lines.push(...attachmentPart(mixedBoundary, attachment))
    }
    lines.push(`--${mixedBoundary}--`)
  }
  return `${lines.join(CRLF)}${CRLF}`
}
