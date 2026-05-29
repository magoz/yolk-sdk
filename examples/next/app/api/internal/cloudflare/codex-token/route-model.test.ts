import { Schema } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { anthropicClaudeProviderId } from '@yolk-sdk/anthropic/claude'
import { openAiCodexProviderId } from '@yolk-sdk/openai/codex'
import { propertyOptions } from '../../../../../../../test/property/options'
import {
  anthropicClaudeBrokerResponse,
  cloudflareBridgeSecretHeader,
  openAiCodexBrokerResponse,
  tokenBrokerMinTtlMs
} from './route-model'

const minTtlSecondsArbitrary = Schema.toArbitrary(Schema.Number)

describe('Cloudflare token broker route model', () => {
  it('uses the bridge secret header contract', () => {
    expect(cloudflareBridgeSecretHeader).toBe('x-yolk-cloudflare-secret')
  })

  it.prop(
    'maps requested minimum TTL seconds to non-negative milliseconds',
    [minTtlSecondsArbitrary],
    ([seconds]) => {
      const expected = Math.max(0, seconds) * 1000

      expect(tokenBrokerMinTtlMs(seconds)).toBe(expected)
    },
    propertyOptions
  )

  it('leaves omitted minimum TTL omitted', () => {
    expect(tokenBrokerMinTtlMs(undefined)).toBeUndefined()
  })

  it('returns OpenAI Codex broker response without refresh token material', () => {
    expect(
      openAiCodexBrokerResponse({
        access: 'access-token',
        expires: 123,
        accountId: 'account_1'
      })
    ).toEqual({
      provider: openAiCodexProviderId,
      accessToken: 'access-token',
      expiresAt: 123,
      accountId: 'account_1'
    })
  })

  it('returns Anthropic Claude broker response without account or refresh token material', () => {
    expect(
      anthropicClaudeBrokerResponse({
        access: 'access-token',
        expires: 456,
        accountId: 'account_ignored'
      })
    ).toEqual({
      provider: anthropicClaudeProviderId,
      accessToken: 'access-token',
      expiresAt: 456
    })
  })
})
