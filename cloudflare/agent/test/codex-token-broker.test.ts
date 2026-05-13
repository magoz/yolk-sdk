import { describe, expect, it } from 'vitest'
import { TokenBrokerResponse } from '@yolk/oauth'
import { openAiCodexProviderId, openAiCodexRefreshBufferMs } from '@yolk/openai'
import {
  codexTokenRefreshBufferMs,
  codexTokenToProviderToken,
  isCodexTokenFresh,
  makeCodexTokenBrokerRequest,
  makeDirectCodexProviderConfig
} from '../src/codex-token-broker.ts'

describe('Cloudflare Codex token broker helpers', () => {
  it('requests broker tokens with provider, subject, and minimum TTL', () => {
    expect(makeCodexTokenBrokerRequest('user_1')).toEqual({
      provider: openAiCodexProviderId,
      subjectId: 'user_1',
      minTtlSeconds: openAiCodexRefreshBufferMs / 1000,
      forceRefresh: undefined
    })
  })

  it('checks cached token freshness with shared Codex buffer', () => {
    const fresh = new TokenBrokerResponse({
      provider: openAiCodexProviderId,
      accessToken: 'access',
      expiresAt: 1_000 + codexTokenRefreshBufferMs + 1
    })
    const stale = new TokenBrokerResponse({
      provider: openAiCodexProviderId,
      accessToken: 'access',
      expiresAt: 1_000 + codexTokenRefreshBufferMs
    })

    expect(isCodexTokenFresh(fresh, 1_000)).toBe(true)
    expect(isCodexTokenFresh(stale, 1_000)).toBe(false)
  })

  it('maps broker tokens to direct Codex provider config only', () => {
    const brokerToken = new TokenBrokerResponse({
      provider: openAiCodexProviderId,
      accessToken: 'access',
      expiresAt: 123,
      accountId: 'account'
    })

    expect(codexTokenToProviderToken(brokerToken)).toEqual({
      type: 'oauth',
      access: 'access',
      refresh: '',
      expires: 123,
      accountId: 'account'
    })
    expect(makeDirectCodexProviderConfig(brokerToken)).toEqual({
      token: {
        type: 'oauth',
        access: 'access',
        refresh: '',
        expires: 123,
        accountId: 'account'
      }
    })
  })
})
