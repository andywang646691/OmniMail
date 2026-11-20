import { validEmail } from '../../shared/http/api-helpers'
import type { Env } from '../../app/types'

export type SesConfig = {
  region: string
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  from?: string
  configurationSetName?: string
}

type DomainConfigs = {
  valid: boolean
  values: Map<string, SesConfig>
}

const REGION_PATTERN = /^[a-z]{2}(?:-[a-z]+)+-\d$/
const CONFIGURATION_SET_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function validRegion(value: string): boolean {
  return REGION_PATTERN.test(value) && value.length <= 32
}

function validSender(value: string): boolean {
  if (validEmail(value)) return true
  // SES v2 accepts "Display Name <address>" for FromEmailAddress.
  const match = /^[^\r\n<>]{1,120}<([^<>\s@]+@[^<>\s@]+)>$/.exec(value.trim())
  return Boolean(match && validEmail(match[1]))
}

function validCredential(value: string, maxLength: number): boolean {
  return value.length > 0 && value.length <= maxLength && !/[\s\u0000-\u001f]/.test(value)
}

function readEntry(value: unknown): SesConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as {
    region?: unknown
    accessKeyId?: unknown
    accesskeyid?: unknown
    secretAccessKey?: unknown
    secretaccesskey?: unknown
    sessionToken?: unknown
    from?: unknown
    configurationSetName?: unknown
  }
  const region = clean(candidate.region)
  const accessKeyId = clean(candidate.accessKeyId ?? candidate.accesskeyid)
  const secretAccessKey = clean(candidate.secretAccessKey ?? candidate.secretaccesskey)
  const sessionToken = clean(candidate.sessionToken)
  const from = clean(candidate.from)
  const configurationSetName = clean(candidate.configurationSetName)
  if (!validRegion(region) || !validCredential(accessKeyId, 128)
    || !validCredential(secretAccessKey, 256)) {
    return null
  }
  if (candidate.from !== undefined && (typeof candidate.from !== 'string' || !validSender(from))) {
    return null
  }
  if (sessionToken && !validCredential(sessionToken, 2048)) return null
  if (configurationSetName && !CONFIGURATION_SET_PATTERN.test(configurationSetName)) return null
  return {
    region,
    accessKeyId,
    secretAccessKey,
    sessionToken: sessionToken || undefined,
    from: from || undefined,
    configurationSetName: configurationSetName || undefined,
  }
}

function domainConfigs(env: Env): DomainConfigs {
  const raw = env.SES_DOMAIN_CONFIGS?.trim()
  if (!raw) return { valid: true, values: new Map() }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { valid: false, values: new Map() }
    }
    const configs = new Map<string, SesConfig>()
    for (const [domain, value] of Object.entries(parsed)) {
      const normalizedDomain = domain.trim().toLowerCase()
      const entry = readEntry(value)
      if (!normalizedDomain || !entry) return { valid: false, values: new Map() }
      configs.set(normalizedDomain, entry)
    }
    return { valid: true, values: configs }
  } catch {
    return { valid: false, values: new Map() }
  }
}

export function sesDomainConfigIsInvalid(env: Env): boolean {
  return !domainConfigs(env).valid
}

export function sesConfigForAddress(env: Env, address: string): SesConfig | null {
  const separator = address.lastIndexOf('@')
  if (separator <= 0) return null
  const domain = address.slice(separator + 1).trim().toLowerCase()
  const parsed = domainConfigs(env)
  if (!parsed.valid) return null
  return parsed.values.get(domain) ?? null
}

/**
 * Global SES credentials are optional. A partially configured global account is
 * treated as invalid so a half-written secret fails loudly instead of silently
 * falling back to another provider.
 */
export function sesGlobalConfig(env: Env): SesConfig | null {
  const region = clean(env.SES_REGION)
  const accessKeyId = clean(env.SES_ACCESS_KEY_ID)
  const secretAccessKey = clean(env.SES_SECRET_ACCESS_KEY)
  const sessionToken = clean(env.SES_SESSION_TOKEN)
  const from = clean(env.SES_FROM)
  const configurationSetName = clean(env.SES_CONFIGURATION_SET)
  if (!region && !accessKeyId && !secretAccessKey) return null
  if (!validRegion(region) || !validCredential(accessKeyId, 128)
    || !validCredential(secretAccessKey, 256)) {
    return null
  }
  if (from && !validSender(from)) return null
  if (sessionToken && !validCredential(sessionToken, 2048)) return null
  if (configurationSetName && !CONFIGURATION_SET_PATTERN.test(configurationSetName)) return null
  return {
    region,
    accessKeyId,
    secretAccessKey,
    sessionToken: sessionToken || undefined,
    from: from || undefined,
    configurationSetName: configurationSetName || undefined,
  }
}

export function sesGlobalConfigIsInvalid(env: Env): boolean {
  const present = Boolean(
    clean(env.SES_REGION) || clean(env.SES_ACCESS_KEY_ID) || clean(env.SES_SECRET_ACCESS_KEY)
    || clean(env.SES_SESSION_TOKEN) || clean(env.SES_FROM) || clean(env.SES_CONFIGURATION_SET),
  )
  return present && sesGlobalConfig(env) === null
}

export function hasSesConfig(env: Env): boolean {
  return !sesDomainConfigIsInvalid(env)
    && (domainConfigs(env).values.size > 0 || sesGlobalConfig(env) !== null)
}
