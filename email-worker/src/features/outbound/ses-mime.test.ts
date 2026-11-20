import { describe, expect, it } from 'vitest'
import { buildRawMime, base64FromUtf8 } from './ses-mime'

const now = new Date('2026-11-20T09:00:00Z')

function decodeBody(mime: string, marker: string): string {
  const index = mime.indexOf(marker)
  const rest = mime.slice(index)
  const bodyStart = rest.indexOf('\r\n\r\n') + 4
  const bodyEnd = rest.indexOf('\r\n--', bodyStart)
  const base64 = rest.slice(bodyStart, bodyEnd)
  return Buffer.from(base64, 'base64').toString('utf8')
}

describe('SES raw MIME builder', () => {
  it('builds a multipart/alternative message with both bodies', () => {
    const mime = buildRawMime({
      from: 'Owner <owner@example.com>',
      to: ['first@example.net', 'second@example.net'],
      replyTo: 'owner@example.com',
      subject: 'Hello',
      text: 'Plain body',
      html: '<p>HTML body</p>',
      headers: { 'In-Reply-To': '<original@example.net>' },
      attachments: [],
      now,
    })

    expect(mime).toContain('From: Owner <owner@example.com>')
    expect(mime).toContain('To: first@example.net, second@example.net')
    expect(mime).toContain('Reply-To: owner@example.com')
    expect(mime).toContain('Subject: Hello')
    expect(mime).toContain('In-Reply-To: <original@example.net>')
    expect(mime).toContain('Content-Type: multipart/alternative;')
    expect(mime).not.toContain('multipart/mixed')
    expect(decodeBody(mime, 'Content-Type: text/plain')).toBe('Plain body')
    expect(decodeBody(mime, 'Content-Type: text/html')).toBe('<p>HTML body</p>')
  })

  it('attaches files as multipart/mixed parts', () => {
    const mime = buildRawMime({
      from: 'owner@example.com',
      to: ['friend@example.net'],
      replyTo: 'owner@example.com',
      subject: 'Invoice',
      text: 'See attached',
      html: '<p>See attached</p>',
      headers: {},
      attachments: [{
        filename: 'invoice.pdf',
        contentType: 'application/pdf',
        content: base64FromUtf8('PDFDATA'),
      }],
      now,
    })

    expect(mime).toContain('Content-Type: multipart/mixed;')
    expect(mime).toContain('Content-Type: application/pdf; name="invoice.pdf"')
    expect(mime).toContain('Content-Disposition: attachment; filename="invoice.pdf"')
    expect(mime).toContain(Buffer.from('PDFDATA').toString('base64'))
  })

  it('encodes non-ASCII subjects as RFC 2047 words', () => {
    const mime = buildRawMime({
      from: 'owner@example.com',
      to: ['friend@example.net'],
      replyTo: 'owner@example.com',
      subject: '你的验证码是 123456',
      text: 'hi',
      html: '<p>hi</p>',
      headers: {},
      attachments: [],
      now,
    })

    const subjectLine = mime.split('\r\n').find((line) => line.startsWith('Subject:')) || ''
    expect(subjectLine).toContain('=?UTF-8?B?')
    expect(subjectLine).not.toContain('你的验证码')
  })

  it('strips header injection attempts from every header', () => {
    const mime = buildRawMime({
      from: 'owner@example.com\r\nBcc: victim@example.net',
      to: ['friend@example.net'],
      replyTo: 'owner@example.com',
      subject: 'Hi\r\nBcc: victim@example.net',
      text: 'body',
      html: '<p>body</p>',
      headers: { 'X-Custom': 'value\r\nBcc: victim@example.net' },
      attachments: [],
      now,
    })

    expect(mime).not.toMatch(/^Bcc:/m)
    expect(mime).toContain('From: owner@example.com Bcc: victim@example.net')
  })

  it('keeps long base64 lines within the SMTP-friendly width', () => {
    const mime = buildRawMime({
      from: 'owner@example.com',
      to: ['friend@example.net'],
      replyTo: 'owner@example.com',
      subject: 'Long body',
      text: 'x'.repeat(500),
      html: `<p>${'x'.repeat(500)}</p>`,
      headers: {},
      attachments: [],
      now,
    })

    for (const line of mime.split('\r\n')) {
      expect(line.length).toBeLessThanOrEqual(998)
    }
  })
})
