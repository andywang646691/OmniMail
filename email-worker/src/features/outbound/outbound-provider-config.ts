import { hasResendConfig, resendConfigForAddress, resendDomainConfigIsInvalid } from './resend-config'
import {
  hasSendflareConfig,
  sendflareDomainConfigForAddress,
  sendflareDomainConfigIsInvalid,
  sendflareGlobalConfig,
  sendflareGlobalConfigIsInvalid,
} from './sendflare-config'
import {
  hasSesConfig,
  sesConfigForAddress,
  sesDomainConfigIsInvalid,
  sesGlobalConfig,
  sesGlobalConfigIsInvalid,
} from './ses-config'
import type { SesConfig } from './ses-config'
import type { Env } from '../../app/types'

export type OutboundProviderConfig =
  | { provider: 'resend'; apiKey: string; from?: string }
  | { provider: 'sendflare'; apiKey: string; from?: string }
  | ({ provider: 'ses' } & SesConfig)

export function outboundProviderConfigError(env: Env): string | null {
  if (resendDomainConfigIsInvalid(env)) return 'RESEND_DOMAIN_CONFIGS 格式无效。'
  if (sendflareDomainConfigIsInvalid(env)) return 'SENDFLARE_DOMAIN_CONFIGS 格式无效。'
  if (sendflareGlobalConfigIsInvalid(env)) return 'SENDFLARE_FROM 必须是有效邮箱地址。'
  if (sesDomainConfigIsInvalid(env)) return 'SES_DOMAIN_CONFIGS 格式无效。'
  if (sesGlobalConfigIsInvalid(env)) {
    return 'SES_REGION、SES_ACCESS_KEY_ID 与 SES_SECRET_ACCESS_KEY 必须同时配置且格式有效。'
  }
  return null
}

/**
 * Provider precedence for one sender address: SendFlare domain account,
 * Resend domain account, SES domain account, then the global SendFlare or SES
 * account. Domain-level configuration always wins so a shared account can back
 * every other domain.
 */
export function outboundProviderForAddress(
  env: Env,
  address: string,
): OutboundProviderConfig | null {
  if (outboundProviderConfigError(env)) return null
  const sendflareDomain = sendflareDomainConfigForAddress(env, address)
  if (sendflareDomain) return { provider: 'sendflare', ...sendflareDomain }
  const resend = resendConfigForAddress(env, address)
  if (resend) return { provider: 'resend', ...resend }
  const sesDomain = sesConfigForAddress(env, address)
  if (sesDomain) return { provider: 'ses', ...sesDomain }
  const sendflareGlobal = sendflareGlobalConfig(env)
  if (sendflareGlobal) return { provider: 'sendflare', ...sendflareGlobal }
  const sesGlobal = sesGlobalConfig(env)
  return sesGlobal ? { provider: 'ses', ...sesGlobal } : null
}

export function hasOutboundProviderConfig(env: Env): boolean {
  return !outboundProviderConfigError(env)
    && (hasResendConfig(env) || hasSendflareConfig(env) || hasSesConfig(env))
}
