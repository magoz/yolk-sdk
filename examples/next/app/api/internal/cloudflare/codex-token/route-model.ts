import { TokenBrokerResponse } from '@yolk-sdk/oauth'
import { openAiCodexProviderId } from '@yolk-sdk/openai/codex'
import { anthropicClaudeProviderId } from '@yolk-sdk/anthropic/claude'

export type AppOAuthToken = {
  readonly access: string
  readonly expires: number
  readonly accountId?: string
}

export const cloudflareBridgeSecretHeader = 'x-yolk-cloudflare-secret'

export const tokenBrokerMinTtlMs = (seconds: number | undefined) =>
  seconds === undefined ? undefined : Math.max(0, seconds) * 1000

export const openAiCodexBrokerResponse = (token: AppOAuthToken) =>
  new TokenBrokerResponse({
    provider: openAiCodexProviderId,
    accessToken: token.access,
    expiresAt: token.expires,
    accountId: token.accountId
  })

export const anthropicClaudeBrokerResponse = (token: AppOAuthToken) =>
  new TokenBrokerResponse({
    provider: anthropicClaudeProviderId,
    accessToken: token.access,
    expiresAt: token.expires
  })
