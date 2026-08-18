import { describe, expect, it } from '@effect/vitest'
import { OAuthAccessToken } from '@yolk-sdk/agent/oauth'
import {
  XAiGrokTokenBrokerResponse,
  makeXAiGrokAuthorizationUrl,
  makeXAiGrokBrokerRequest,
  parseXAiGrokAuthorizationCode,
  toXAiGrokOAuthAccessToken,
  xAiGrokAuthorizationHeaders,
  xAiGrokClientId,
  xAiGrokProviderId,
  xAiGrokRedirectUri,
  xAiGrokScopes
} from '../../../src/providers/xai/grok.ts'

describe('xAI Grok subscription OAuth helpers', () => {
  it('builds a PKCE authorization URL for the registered loopback callback', () => {
    const url = new URL(
      makeXAiGrokAuthorizationUrl({
        codeChallenge: 'challenge',
        state: 'state',
        nonce: 'nonce',
        referrer: 'yolk-sdk'
      })
    )

    expect(url.origin + url.pathname).toBe('https://auth.x.ai/oauth2/authorize')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: xAiGrokClientId,
      redirect_uri: xAiGrokRedirectUri,
      scope: xAiGrokScopes,
      code_challenge: 'challenge',
      code_challenge_method: 'S256',
      state: 'state',
      plan: 'generic',
      nonce: 'nonce',
      referrer: 'yolk-sdk'
    })
  })

  it('parses callback URLs, query strings, and bare authorization codes', () => {
    expect(
      parseXAiGrokAuthorizationCode('http://127.0.0.1:56121/callback?code=code-1&state=state-1')
    ).toEqual({ code: 'code-1', state: 'state-1' })
    expect(parseXAiGrokAuthorizationCode('code=code-2&state=state-2')).toEqual({
      code: 'code-2',
      state: 'state-2'
    })
    expect(parseXAiGrokAuthorizationCode(' code-3 ')).toEqual({ code: 'code-3' })
    expect(
      parseXAiGrokAuthorizationCode('https://attacker.example/callback?code=code-4&state=state-4')
    ).toBeUndefined()
    expect(parseXAiGrokAuthorizationCode('  ')).toBeUndefined()
  })

  it('builds provider-scoped broker requests and access tokens', () => {
    expect(
      makeXAiGrokBrokerRequest({
        subjectId: 'subject',
        minTtlSeconds: 300,
        forceRefresh: true
      })
    ).toEqual({
      provider: xAiGrokProviderId,
      subjectId: 'subject',
      minTtlSeconds: 300,
      forceRefresh: true
    })

    expect(
      toXAiGrokOAuthAccessToken(
        new XAiGrokTokenBrokerResponse({
          accessToken: 'access',
          expiresAt: 1_000,
          accountId: 'account'
        })
      )
    ).toEqual({
      provider: xAiGrokProviderId,
      accessToken: 'access',
      expiresAt: 1_000,
      accountId: 'account'
    })
  })

  it('sets the subscription proxy authentication and model-routing headers', () => {
    const token = new OAuthAccessToken({
      provider: xAiGrokProviderId,
      accessToken: 'access',
      expiresAt: 1_000
    })

    expect(xAiGrokAuthorizationHeaders(token, 'grok-build')).toEqual({
      authorization: 'Bearer access',
      'X-XAI-Token-Auth': 'xai-grok-cli',
      'x-grok-model-override': 'grok-build'
    })
  })
})
