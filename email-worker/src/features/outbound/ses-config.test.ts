import { describe, expect, it } from 'vitest'
import {
  hasSesConfig,
  sesConfigForAddress,
  sesDomainConfigIsInvalid,
  sesGlobalConfig,
  sesGlobalConfigIsInvalid,
} from './ses-config'
import type { Env } from '../../app/types'

const entry = {
  region: 'us-east-1',
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'c2VjcmV0LWV4YW1wbGU',
}

describe('Amazon SES configuration', () => {
  it('selects the credential set for each configured domain', () => {
    const env = {
      SES_DOMAIN_CONFIGS: JSON.stringify({
        ' Example.com ': { ...entry, from: 'Support <support@example.com>' },
        'another.example': { ...entry, region: 'eu-west-1', configurationSetName: 'omnimail' },
      }),
    } as Env

    expect(sesConfigForAddress(env, 'Owner@Example.COM')).toEqual({
      region: 'us-east-1',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'c2VjcmV0LWV4YW1wbGU',
      sessionToken: undefined,
      from: 'Support <support@example.com>',
      configurationSetName: undefined,
    })
    expect(sesConfigForAddress(env, 'owner@another.example')).toMatchObject({
      region: 'eu-west-1',
      configurationSetName: 'omnimail',
    })
    expect(sesConfigForAddress(env, 'owner@unknown.example')).toBeNull()
    expect(hasSesConfig(env)).toBe(true)
  })

  it('accepts a global account for every domain', () => {
    const env = {
      SES_REGION: 'us-east-1',
      SES_ACCESS_KEY_ID: 'AKIAEXAMPLE',
      SES_SECRET_ACCESS_KEY: 'c2VjcmV0LWV4YW1wbGU',
    } as Env

    expect(sesGlobalConfig(env)).toMatchObject({ region: 'us-east-1' })
    expect(sesGlobalConfigIsInvalid(env)).toBe(false)
    expect(hasSesConfig(env)).toBe(true)
  })

  it('fails loudly when the global account is only half configured', () => {
    const env = {
      SES_REGION: 'us-east-1',
      SES_ACCESS_KEY_ID: 'AKIAEXAMPLE',
    } as Env

    expect(sesGlobalConfig(env)).toBeNull()
    expect(sesGlobalConfigIsInvalid(env)).toBe(true)
    expect(hasSesConfig(env)).toBe(false)
  })

  it('rejects malformed domain configuration', () => {
    expect(sesDomainConfigIsInvalid({ SES_DOMAIN_CONFIGS: '{invalid' } as Env)).toBe(true)
    expect(sesDomainConfigIsInvalid({
      SES_DOMAIN_CONFIGS: JSON.stringify({ 'example.com': { region: 'us-east-1' } }),
    } as Env)).toBe(true)
    expect(sesDomainConfigIsInvalid({
      SES_DOMAIN_CONFIGS: JSON.stringify({ 'example.com': { ...entry, region: 'invalid' } }),
    } as Env)).toBe(true)
    expect(sesDomainConfigIsInvalid({
      SES_DOMAIN_CONFIGS: JSON.stringify({ 'example.com': { ...entry, from: 'not-an-email' } }),
    } as Env)).toBe(true)
    expect(sesDomainConfigIsInvalid({
      SES_DOMAIN_CONFIGS: JSON.stringify({ 'example.com': { ...entry, configurationSetName: 'bad set' } }),
    } as Env)).toBe(true)
  })

  it('rejects a global sender that is not a usable address', () => {
    const env = {
      SES_REGION: 'us-east-1',
      SES_ACCESS_KEY_ID: 'AKIAEXAMPLE',
      SES_SECRET_ACCESS_KEY: 'c2VjcmV0LWV4YW1wbGU',
      SES_FROM: 'OmniMail <support@example.com',
    } as Env

    expect(sesGlobalConfigIsInvalid(env)).toBe(true)
    expect(hasSesConfig(env)).toBe(false)
  })
})
