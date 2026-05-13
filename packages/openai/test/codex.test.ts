import { describe, expect, it } from 'vitest'
import { OAuthAccessToken } from '@yolk/oauth'
import {
  makeOpenAiCodexBrokerRequest,
  openAiCodexAuthorizationHeaders,
  openAiCodexProviderId
} from '../src/index.ts'

describe('Codex OAuth helpers', () => {
  it('builds provider-scoped broker requests', () => {
    expect(
      makeOpenAiCodexBrokerRequest({
        subjectId: 'subject',
        minTtlSeconds: 300,
        forceRefresh: true
      })
    ).toEqual({
      provider: openAiCodexProviderId,
      subjectId: 'subject',
      minTtlSeconds: 300,
      forceRefresh: true
    })
  })

  it('adds account header only when available', () => {
    const token = new OAuthAccessToken({
      provider: openAiCodexProviderId,
      accessToken: 'access',
      expiresAt: 1_000,
      accountId: 'account'
    })

    expect(openAiCodexAuthorizationHeaders(token)).toEqual({
      authorization: 'Bearer access',
      originator: 'opencode',
      'ChatGPT-Account-Id': 'account'
    })
  })
})
