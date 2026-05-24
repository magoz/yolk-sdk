import { openAiCodexRefreshBufferMs, makeOpenAiCodexBrokerRequest } from '@yolk-sdk/openai/codex'
import type { TokenBrokerResponse } from '@yolk-sdk/oauth'

export const codexTokenRefreshBufferMs = openAiCodexRefreshBufferMs

export const makeCodexTokenBrokerRequest = (userId: string) =>
  makeOpenAiCodexBrokerRequest({
    subjectId: userId,
    minTtlSeconds: codexTokenRefreshBufferMs / 1000
  })

export const isCodexTokenFresh = (token: TokenBrokerResponse, nowMs: number) =>
  token.expiresAt > nowMs + codexTokenRefreshBufferMs

export const codexTokenToProviderToken = (token: TokenBrokerResponse) => ({
  type: 'oauth' as const,
  access: token.accessToken,
  refresh: '',
  expires: token.expiresAt,
  accountId: token.accountId
})

export const makeDirectCodexProviderConfig = (token: TokenBrokerResponse) => ({
  token: codexTokenToProviderToken(token)
})
