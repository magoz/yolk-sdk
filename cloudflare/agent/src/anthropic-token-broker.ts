import {
  anthropicClaudeRefreshBufferMs,
  makeAnthropicClaudeBrokerRequest,
  toAnthropicClaudeOAuthAccessToken
} from '@yolk-sdk/agent/providers/anthropic/claude'
import type { TokenBrokerResponse } from '@yolk-sdk/agent/oauth'

export const anthropicTokenRefreshBufferMs = anthropicClaudeRefreshBufferMs

export const makeAnthropicTokenBrokerRequest = (userId: string) =>
  makeAnthropicClaudeBrokerRequest({
    subjectId: userId,
    minTtlSeconds: anthropicTokenRefreshBufferMs / 1000
  })

export const isAnthropicTokenFresh = (token: TokenBrokerResponse, nowMs: number) =>
  token.expiresAt > nowMs + anthropicTokenRefreshBufferMs

export const anthropicTokenToProviderToken = toAnthropicClaudeOAuthAccessToken
