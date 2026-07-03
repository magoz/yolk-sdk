import { describe, expect, it } from 'vitest'
import {
  anthropicClaudeAuthorizeUrl,
  anthropicClaudeClientId,
  anthropicClaudeProviderId,
  anthropicClaudeRedirectUri,
  anthropicClaudeScopes,
  makeAnthropicClaudeAuthorizationUrl,
  makeAnthropicClaudeBrokerRequest,
  parseAnthropicClaudeAuthorizationCode
} from '../../../src/providers/anthropic/index.ts'

describe('Anthropic Claude OAuth helpers', () => {
  it('builds broker requests', () => {
    expect(
      makeAnthropicClaudeBrokerRequest({
        subjectId: 'user_1',
        minTtlSeconds: 300,
        forceRefresh: true
      })
    ).toEqual({
      provider: anthropicClaudeProviderId,
      subjectId: 'user_1',
      minTtlSeconds: 300,
      forceRefresh: true
    })
  })

  it('builds Claude authorization URLs', () => {
    const url = new URL(
      makeAnthropicClaudeAuthorizationUrl({ codeChallenge: 'challenge_1', state: 'state_1' })
    )

    expect(`${url.origin}${url.pathname}`).toBe(anthropicClaudeAuthorizeUrl)
    expect(url.searchParams.get('code')).toBe('true')
    expect(url.searchParams.get('client_id')).toBe(anthropicClaudeClientId)
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('redirect_uri')).toBe(anthropicClaudeRedirectUri)
    expect(url.searchParams.get('scope')).toBe(anthropicClaudeScopes)
    expect(url.searchParams.get('code_challenge')).toBe('challenge_1')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('state')).toBe('state_1')
  })

  it('parses manual code and state input', () => {
    expect(parseAnthropicClaudeAuthorizationCode(' code_1#state_1 ')).toEqual({
      code: 'code_1',
      state: 'state_1'
    })
  })

  it('parses callback URL input', () => {
    expect(
      parseAnthropicClaudeAuthorizationCode(
        'https://example.com/callback?code=code_2&state=state_2'
      )
    ).toEqual({ code: 'code_2', state: 'state_2' })
  })
})
