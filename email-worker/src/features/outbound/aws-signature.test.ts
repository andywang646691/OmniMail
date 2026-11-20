import { describe, expect, it } from 'vitest'
import { signAwsRequest, sha256Hex } from './aws-signature'

const credentials = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
}

describe('AWS Signature Version 4', () => {
  it('reproduces the documented get-vanilla signature', async () => {
    // Reference vector from the AWS Signature Version 4 test suite (get-vanilla).
    const signed = await signAwsRequest({
      method: 'GET',
      host: 'example.amazonaws.com',
      path: '/',
      region: 'us-east-1',
      service: 'service',
      credentials,
      payload: '',
      now: new Date('2015-08-30T12:36:00Z'),
    })

    expect(signed.headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, '
      + 'SignedHeaders=host;x-amz-date, '
      + 'Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    )
    expect(signed.url).toBe('https://example.amazonaws.com/')
  })

  it('signs a POST body the same way as the aws4 reference implementation', async () => {
    const payload = JSON.stringify({
      FromEmailAddress: 'a@b.c',
      Destination: { ToAddresses: ['d@e.f'] },
    })
    const signed = await signAwsRequest({
      method: 'POST',
      host: 'email.us-east-1.amazonaws.com',
      path: '/v2/email/outbound-emails',
      region: 'us-east-1',
      service: 'ses',
      credentials: {
        accessKeyId: 'AKIAEXAMPLEKEY123',
        secretAccessKey: 'c2VjcmV0LWV4YW1wbGUta2V5LWZvci10ZXN0aW5n',
      },
      payload,
      headers: {
        'content-type': 'application/json',
        'content-length': String(payload.length),
      },
      now: new Date('2026-11-20T09:30:00Z'),
    })

    expect(signed.headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAEXAMPLEKEY123/20261120/us-east-1/ses/aws4_request, '
      + 'SignedHeaders=content-length;content-type;host;x-amz-date, '
      + 'Signature=10f068fea2af3109b1fe4d2fb7ec1fc9e4634031d8842ee2677b41504c095e45',
    )
    expect(signed.headers['x-amz-date']).toBe('20261120T093000Z')
    expect(signed.headers.authorization).not.toContain('x-amz-content-sha256')
  })

  it('includes the session token in the signed headers when provided', async () => {
    const signed = await signAwsRequest({
      method: 'POST',
      host: 'email.eu-west-1.amazonaws.com',
      path: '/v2/email/outbound-emails',
      region: 'eu-west-1',
      service: 'ses',
      credentials: { ...credentials, sessionToken: 'session-token-value' },
      payload: '{}',
      now: new Date('2026-11-20T10:00:00Z'),
    })

    expect(signed.headers['x-amz-security-token']).toBe('session-token-value')
    expect(signed.headers.authorization).toContain(
      'SignedHeaders=host;x-amz-date;x-amz-security-token',
    )
  })

  it('hashes payloads deterministically', async () => {
    await expect(sha256Hex('')).resolves.toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
  })
})
