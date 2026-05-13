import { describe, expect, it } from 'vitest'
import { TokenBrokerResponse } from '@yolk/oauth'
import { anthropicClaudeProviderId, anthropicClaudeRefreshBufferMs } from '@yolk/anthropic'
import {
  anthropicTokenRefreshBufferMs,
  anthropicTokenToProviderToken,
  isAnthropicTokenFresh,
  makeAnthropicTokenBrokerRequest
} from '../src/anthropic-token-broker.ts'

describe('Cloudflare Anthropic token broker helpers', () => {
  it('requests broker tokens with provider, subject, and minimum TTL', () => {
    expect(makeAnthropicTokenBrokerRequest('user_1')).toEqual({
      provider: anthropicClaudeProviderId,
      subjectId: 'user_1',
      minTtlSeconds: anthropicClaudeRefreshBufferMs / 1000,
      forceRefresh: undefined
    })
  })

  it('checks cached token freshness with shared Anthropic buffer', () => {
    const fresh = new TokenBrokerResponse({
      provider: anthropicClaudeProviderId,
      accessToken: 'access',
      expiresAt: 1_000 + anthropicTokenRefreshBufferMs + 1
    })
    const stale = new TokenBrokerResponse({
      provider: anthropicClaudeProviderId,
      accessToken: 'access',
      expiresAt: 1_000 + anthropicTokenRefreshBufferMs
    })

    expect(isAnthropicTokenFresh(fresh, 1_000)).toBe(true)
    expect(isAnthropicTokenFresh(stale, 1_000)).toBe(false)
  })

  it('maps broker tokens to provider tokens without refresh token leakage', () => {
    const brokerToken = new TokenBrokerResponse({
      provider: anthropicClaudeProviderId,
      accessToken: 'access',
      expiresAt: 123
    })

    expect(anthropicTokenToProviderToken(brokerToken)).toEqual({
      type: 'oauth',
      access: 'access',
      refresh: '',
      expires: 123
    })
  })
})
