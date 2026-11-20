const textEncoder = new TextEncoder()

export type AwsCredentials = {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
}

export type AwsSignatureInput = {
  method: string
  host: string
  path: string
  query?: Record<string, string>
  region: string
  service: string
  credentials: AwsCredentials
  payload: string
  headers?: Record<string, string>
  now?: Date
  contentSha256Header?: boolean
}

export type SignedAwsRequest = {
  url: string
  headers: Record<string, string>
}

function toHex(value: ArrayBuffer): string {
  return Array.from(new Uint8Array(value))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

export async function sha256Hex(value: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', textEncoder.encode(value)))
}

async function hmacSha256(key: BufferSource, value: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return crypto.subtle.sign('HMAC', cryptoKey, textEncoder.encode(value))
}

async function signingKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Promise<ArrayBuffer> {
  const dateKey = await hmacSha256(textEncoder.encode(`AWS4${secretAccessKey}`), dateStamp)
  const regionKey = await hmacSha256(dateKey, region)
  const serviceKey = await hmacSha256(regionKey, service)
  return hmacSha256(serviceKey, 'aws4_request')
}

function amzDate(now: Date): string {
  return now.toISOString().replace(/[:-]|\.\d{3}/g, '')
}

function normalizeHeaderValue(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

function canonicalQueryString(query: Record<string, string>): string {
  return Object.keys(query)
    .sort()
    .map((name) => `${encodeURIComponent(name)}=${encodeURIComponent(query[name])}`)
    .join('&')
}

/**
 * Builds an AWS Signature Version 4 Authorization header for an HTTPS request.
 * The service signs the payload hash but only sends x-amz-content-sha256 when asked,
 * because SES accepts the request without that header.
 */
export async function signAwsRequest(input: AwsSignatureInput): Promise<SignedAwsRequest> {
  const now = input.now ?? new Date()
  const timestamp = amzDate(now)
  const dateStamp = timestamp.slice(0, 8)
  const payloadHash = await sha256Hex(input.payload)
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    headers[name.toLowerCase()] = normalizeHeaderValue(value)
  }
  headers.host = input.host
  headers['x-amz-date'] = timestamp
  if (input.contentSha256Header) headers['x-amz-content-sha256'] = payloadHash
  if (input.credentials.sessionToken) {
    headers['x-amz-security-token'] = input.credentials.sessionToken
  }
  const headerNames = Object.keys(headers).sort()
  const canonicalHeaders = headerNames
    .map((name) => `${name}:${headers[name]}\n`)
    .join('')
  const signedHeaders = headerNames.join(';')
  const canonicalRequest = [
    input.method.toUpperCase(),
    input.path,
    canonicalQueryString(input.query ?? {}),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n')
  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    timestamp,
    scope,
    await sha256Hex(canonicalRequest),
  ].join('\n')
  const key = await signingKey(
    input.credentials.secretAccessKey,
    dateStamp,
    input.region,
    input.service,
  )
  const signature = toHex(await hmacSha256(key, stringToSign))
  const query = canonicalQueryString(input.query ?? {})
  const requestHeaders: Record<string, string> = { ...headers }
  delete requestHeaders.host
  requestHeaders.authorization = `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  return {
    url: `https://${input.host}${input.path}${query ? `?${query}` : ''}`,
    headers: requestHeaders,
  }
}
