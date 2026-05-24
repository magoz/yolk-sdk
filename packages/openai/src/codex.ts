import * as Schema from 'effect/Schema'
import { OAuthAccessToken, TokenBrokerRequest, type TokenBrokerClient } from '@yolk-sdk/oauth'

export const openAiCodexProviderId = 'openai-codex'
export const openAiCodexResponsesUrl = 'https://chatgpt.com/backend-api/codex/responses'
export const openAiCodexAuthIssuer = 'https://auth.openai.com'
export const openAiCodexClientId = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const openAiCodexDeviceAuthUserCodeUrl = `${openAiCodexAuthIssuer}/api/accounts/deviceauth/usercode`
export const openAiCodexDeviceAuthTokenUrl = `${openAiCodexAuthIssuer}/api/accounts/deviceauth/token`
export const openAiCodexDeviceAuthCallbackRedirect = `${openAiCodexAuthIssuer}/deviceauth/callback`
export const openAiCodexDeviceVerificationUrl = `${openAiCodexAuthIssuer}/codex/device`
export const openAiCodexTokenEndpoint = `${openAiCodexAuthIssuer}/oauth/token`
export const openAiCodexRefreshBufferMs = 5 * 60 * 1000

export class OpenAiCodexOAuthToken extends Schema.Class<OpenAiCodexOAuthToken>(
  'OpenAiCodexOAuthToken'
)({
  accessToken: Schema.String,
  refreshToken: Schema.String,
  expiresAt: Schema.Number,
  accountId: Schema.optional(Schema.String)
}) {}

export class OpenAiCodexTokenBrokerResponse extends Schema.Class<OpenAiCodexTokenBrokerResponse>(
  'OpenAiCodexTokenBrokerResponse'
)({
  accessToken: Schema.String,
  expiresAt: Schema.Number,
  accountId: Schema.optional(Schema.String)
}) {}

export const toOAuthAccessToken = (token: OpenAiCodexTokenBrokerResponse) =>
  new OAuthAccessToken({
    provider: openAiCodexProviderId,
    accessToken: token.accessToken,
    expiresAt: token.expiresAt,
    accountId: token.accountId
  })

export const toOpenAiCodexOAuthAccessToken = toOAuthAccessToken

export const makeOpenAiCodexBrokerRequest = (input: {
  readonly subjectId: string
  readonly minTtlSeconds?: number
  readonly forceRefresh?: boolean
}) =>
  new TokenBrokerRequest({
    provider: openAiCodexProviderId,
    subjectId: input.subjectId,
    minTtlSeconds: input.minTtlSeconds,
    forceRefresh: input.forceRefresh
  })

export const openAiCodexAuthorizationHeaders = (token: OAuthAccessToken) => {
  const baseHeaders = {
    authorization: `Bearer ${token.accessToken}`,
    originator: 'opencode'
  }

  if (token.accountId === undefined) {
    return baseHeaders
  }

  return {
    ...baseHeaders,
    'ChatGPT-Account-Id': token.accountId
  }
}

export const makeOpenAiCodexTokenBrokerClient = (broker: TokenBrokerClient) => ({
  getAccessToken: (input: {
    readonly subjectId: string
    readonly minTtlSeconds?: number
    readonly forceRefresh?: boolean
  }) => broker.getAccessToken(makeOpenAiCodexBrokerRequest(input))
})
