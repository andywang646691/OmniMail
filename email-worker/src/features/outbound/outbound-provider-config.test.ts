import { describe, expect, it } from 'vitest'
import {
  hasOutboundProviderConfig,
  outboundProviderConfigError,
  outboundProviderForAddress,
} from './outbound-provider-config'
import type { Env } from '../../app/types'

const sesEntry = {
  region: 'us-east-1',
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'c2VjcmV0LWV4YW1wbGU',
}

describe('outbound provider configuration', () => {
  it('uses a domain-specific SendFlare account before existing Resend configuration', () => {
    const env = {
      RESEND_DOMAIN_CONFIGS: JSON.stringify({
        'other.example': { apiKey: 're_other' },
      }),
      SENDFLARE_DOMAIN_CONFIGS: JSON.stringify({
        ' Example.com ': { apiKey: ' sf_domain ', from: 'sender@example.com' },
      }),
    } as Env

    expect(outboundProviderForAddress(env, 'owner@EXAMPLE.COM')).toEqual({
      provider: 'sendflare', apiKey: 'sf_domain', from: 'sender@example.com',
    })
    expect(outboundProviderForAddress(env, 'owner@other.example')).toEqual({
      provider: 'resend', apiKey: 're_other', from: undefined,
    })
  })

  it('supports SendFlare as the global provider when Resend is absent', () => {
    const env = { SENDFLARE_API_KEY: 'sf_global' } as Env
    expect(hasOutboundProviderConfig(env)).toBe(true)
    expect(outboundProviderForAddress(env, 'owner@example.com')).toEqual({
      provider: 'sendflare', apiKey: 'sf_global', from: undefined,
    })
  })

  it('rejects malformed SendFlare domain configuration', () => {
    const env = {
      RESEND_DOMAIN_CONFIGS: JSON.stringify({
        'example.com': { apiKey: 're_example' },
      }),
      SENDFLARE_DOMAIN_CONFIGS: '{invalid',
    } as Env
    expect(outboundProviderConfigError(env)).toBe('SENDFLARE_DOMAIN_CONFIGS 格式无效。')
    expect(hasOutboundProviderConfig(env)).toBe(false)
    expect(outboundProviderForAddress(env, 'owner@example.com')).toBeNull()
  })

  it('falls back to SES for a domain that only has an SES account', () => {
    const env = {
      RESEND_DOMAIN_CONFIGS: JSON.stringify({
        'other.example': { apiKey: 're_other' },
      }),
      SES_DOMAIN_CONFIGS: JSON.stringify({
        'example.com': sesEntry,
      }),
    } as Env

    expect(outboundProviderForAddress(env, 'owner@example.com')).toEqual({
      provider: 'ses',
      ...sesEntry,
      sessionToken: undefined,
      from: undefined,
      configurationSetName: undefined,
    })
    expect(outboundProviderForAddress(env, 'owner@other.example')).toEqual({
      provider: 'resend', apiKey: 're_other', from: undefined,
    })
  })

  it('prefers a Resend domain account over SES for the same domain', () => {
    const env = {
      RESEND_DOMAIN_CONFIGS: JSON.stringify({
        'example.com': { apiKey: 're_example' },
      }),
      SES_DOMAIN_CONFIGS: JSON.stringify({ 'example.com': sesEntry }),
    } as Env

    expect(outboundProviderForAddress(env, 'owner@example.com')).toMatchObject({
      provider: 'resend', apiKey: 're_example',
    })
  })

  it('uses global SES credentials when no domain account matches', () => {
    const env = {
      SES_REGION: 'eu-central-1',
      SES_ACCESS_KEY_ID: 'AKIAEXAMPLE',
      SES_SECRET_ACCESS_KEY: 'c2VjcmV0LWV4YW1wbGU',
      SES_FROM: 'reply@example.com',
    } as Env

    expect(hasOutboundProviderConfig(env)).toBe(true)
    expect(outboundProviderForAddress(env, 'owner@example.com')).toMatchObject({
      provider: 'ses', region: 'eu-central-1', from: 'reply@example.com',
    })
  })

  it('reports a malformed SES configuration and stops provider selection', () => {
    const env = {
      RESEND_DOMAIN_CONFIGS: JSON.stringify({ 'example.com': { apiKey: 're_example' } }),
      SES_DOMAIN_CONFIGS: JSON.stringify({ 'example.com': { region: 'us-east-1' } }),
    } as Env

    expect(outboundProviderConfigError(env)).toBe('SES_DOMAIN_CONFIGS 格式无效。')
    expect(hasOutboundProviderConfig(env)).toBe(false)
    expect(outboundProviderForAddress(env, 'owner@example.com')).toBeNull()
  })

  it('rejects a SendFlare display-name sender', () => {
    const env = {
      SENDFLARE_API_KEY: 'sf_global',
      SENDFLARE_FROM: 'OmniMail <reply@example.com>',
    } as Env
    expect(outboundProviderConfigError(env)).toBe('SENDFLARE_FROM 必须是有效邮箱地址。')
    expect(outboundProviderForAddress(env, 'owner@example.com')).toBeNull()
  })
})
