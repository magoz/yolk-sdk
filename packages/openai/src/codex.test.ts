import { describe, expect, it } from '@effect/vitest'
import { OAuthAccessToken } from '@yolk-sdk/oauth'
import { openAiCodexAuthorizationHeaders } from './codex.ts'

describe('OpenAI Codex OAuth helpers', () => {
  it('includes account id when available', () => {
    const headers = openAiCodexAuthorizationHeaders(
      new OAuthAccessToken({
        provider: 'openai-codex',
        accessToken: 'token',
        expiresAt: 123,
        accountId: 'account-1'
      })
    )

    expect(headers).toEqual({
      authorization: 'Bearer token',
      originator: 'opencode',
      'ChatGPT-Account-Id': 'account-1'
    })
  })
})
