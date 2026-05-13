import * as Schema from 'effect/Schema'
import { OAuthAccessToken, TokenBrokerRequest, type TokenBrokerClient } from '@yolk/oauth'

export const anthropicClaudeProviderId = 'anthropic-claude'
export const anthropicClaudeClientId = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
export const anthropicClaudeAuthorizeUrl = 'https://claude.ai/oauth/authorize'
export const anthropicClaudeTokenEndpoint = 'https://console.anthropic.com/v1/oauth/token'
export const anthropicClaudeRedirectUri = 'https://console.anthropic.com/oauth/code/callback'
export const anthropicClaudeScopes = 'org:create_api_key user:profile user:inference'
export const anthropicClaudeOAuthUserAgent = 'claude-cli/2.1.2 (external, cli)'
export const anthropicClaudeRefreshBufferMs = 5 * 60 * 1000

export class AnthropicClaudeOAuthToken extends Schema.Class<AnthropicClaudeOAuthToken>(
  'AnthropicClaudeOAuthToken'
)({
  accessToken: Schema.String,
  refreshToken: Schema.String,
  expiresAt: Schema.Number,
  accountId: Schema.optional(Schema.String)
}) {}

export class AnthropicClaudeTokenBrokerResponse extends Schema.Class<AnthropicClaudeTokenBrokerResponse>(
  'AnthropicClaudeTokenBrokerResponse'
)({
  accessToken: Schema.String,
  expiresAt: Schema.Number,
  accountId: Schema.optional(Schema.String)
}) {}

export const toAnthropicClaudeOAuthAccessToken = (token: AnthropicClaudeTokenBrokerResponse) =>
  new OAuthAccessToken({
    provider: anthropicClaudeProviderId,
    accessToken: token.accessToken,
    expiresAt: token.expiresAt,
    accountId: token.accountId
  })

export const makeAnthropicClaudeBrokerRequest = (input: {
  readonly subjectId: string
  readonly minTtlSeconds?: number
  readonly forceRefresh?: boolean
}) =>
  new TokenBrokerRequest({
    provider: anthropicClaudeProviderId,
    subjectId: input.subjectId,
    minTtlSeconds: input.minTtlSeconds,
    forceRefresh: input.forceRefresh
  })

export const anthropicClaudeAuthorizationHeaders = (token: OAuthAccessToken) => ({
  authorization: `Bearer ${token.accessToken}`
})

export const makeAnthropicClaudeTokenBrokerClient = (broker: TokenBrokerClient) => ({
  getAccessToken: (input: {
    readonly subjectId: string
    readonly minTtlSeconds?: number
    readonly forceRefresh?: boolean
  }) => broker.getAccessToken(makeAnthropicClaudeBrokerRequest(input))
})

export const makeAnthropicClaudeAuthorizationUrl = (input: {
  readonly codeChallenge: string
  readonly state: string
}) => {
  const authUrl = new URL(anthropicClaudeAuthorizeUrl)
  authUrl.searchParams.set('code', 'true')
  authUrl.searchParams.set('client_id', anthropicClaudeClientId)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('redirect_uri', anthropicClaudeRedirectUri)
  authUrl.searchParams.set('scope', anthropicClaudeScopes)
  authUrl.searchParams.set('code_challenge', input.codeChallenge)
  authUrl.searchParams.set('code_challenge_method', 'S256')
  authUrl.searchParams.set('state', input.state)

  return authUrl.toString()
}

export type ParsedAnthropicClaudeAuthorizationCode = {
  readonly code: string
  readonly state: string
}

export const parseAnthropicClaudeAuthorizationCode = (
  value: string
): ParsedAnthropicClaudeAuthorizationCode | undefined => {
  const trimmed = value.trim()

  if (trimmed.length === 0) {
    return undefined
  }

  const parseFromUrl = () => {
    try {
      const url = new URL(trimmed)
      const code = url.searchParams.get('code') ?? undefined
      const state = url.searchParams.get('state') ?? undefined

      if (code === undefined || state === undefined) {
        return undefined
      }

      return { code, state }
    } catch {
      return undefined
    }
  }

  const fromUrl = parseFromUrl()

  if (fromUrl !== undefined) {
    return fromUrl
  }

  if (trimmed.includes('#')) {
    const [code, state] = trimmed.split('#', 2)

    if (code !== undefined && code.length > 0 && state !== undefined && state.length > 0) {
      return { code, state }
    }
  }

  if (trimmed.includes('code=')) {
    const params = new URLSearchParams(trimmed)
    const code = params.get('code') ?? undefined
    const state = params.get('state') ?? undefined

    if (code !== undefined && state !== undefined) {
      return { code, state }
    }
  }

  return undefined
}
