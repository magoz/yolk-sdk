import { anthropicClaudeRefreshBufferMs, makeAnthropicClaudeBrokerRequest } from '@yolk/anthropic'
import type { TokenBrokerResponse } from '@yolk/oauth'

export const anthropicTokenRefreshBufferMs = anthropicClaudeRefreshBufferMs

export const makeAnthropicTokenBrokerRequest = (userId: string) =>
  makeAnthropicClaudeBrokerRequest({
    subjectId: userId,
    minTtlSeconds: anthropicTokenRefreshBufferMs / 1000
  })

export const isAnthropicTokenFresh = (token: TokenBrokerResponse, nowMs: number) =>
  token.expiresAt > nowMs + anthropicTokenRefreshBufferMs

export const anthropicTokenToProviderToken = (token: TokenBrokerResponse) => ({
  type: 'oauth' as const,
  access: token.accessToken,
  refresh: '',
  expires: token.expiresAt
})
