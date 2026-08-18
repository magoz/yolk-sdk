import { Result } from 'effect'
import * as Schema from 'effect/Schema'
import { OAuthAccessToken, TokenBrokerRequest, type TokenBrokerClient } from '@yolk-sdk/agent/oauth'

export const xAiGrokProviderId = 'xai-grok'
export const xAiGrokResponsesUrl = 'https://cli-chat-proxy.grok.com/v1/responses'
export const xAiGrokAuthIssuer = 'https://auth.x.ai'
export const xAiGrokClientId = 'b1a00492-073a-47ea-816f-4c329264a828'
export const xAiGrokAuthorizeUrl = `${xAiGrokAuthIssuer}/oauth2/authorize`
export const xAiGrokTokenEndpoint = `${xAiGrokAuthIssuer}/oauth2/token`
export const xAiGrokDeviceCodeEndpoint = `${xAiGrokAuthIssuer}/oauth2/device/code`
export const xAiGrokDeviceGrantType = 'urn:ietf:params:oauth:grant-type:device_code'
export const xAiGrokRedirectUri = 'http://127.0.0.1:56121/callback'
export const xAiGrokScopes = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'grok-cli:access',
  'api:access'
].join(' ')
export const xAiGrokRefreshBufferMs = 5 * 60 * 1000

export class XAiGrokOAuthToken extends Schema.Class<XAiGrokOAuthToken>('XAiGrokOAuthToken')({
  accessToken: Schema.String,
  refreshToken: Schema.String,
  expiresAt: Schema.Number,
  accountId: Schema.optional(Schema.String)
}) {}

export class XAiGrokTokenBrokerResponse extends Schema.Class<XAiGrokTokenBrokerResponse>(
  'XAiGrokTokenBrokerResponse'
)({
  accessToken: Schema.String,
  expiresAt: Schema.Number,
  accountId: Schema.optional(Schema.String)
}) {}

export const toXAiGrokOAuthAccessToken = (token: XAiGrokTokenBrokerResponse) =>
  new OAuthAccessToken({
    provider: xAiGrokProviderId,
    accessToken: token.accessToken,
    expiresAt: token.expiresAt,
    accountId: token.accountId
  })

export const makeXAiGrokBrokerRequest = (input: {
  readonly subjectId: string
  readonly minTtlSeconds?: number
  readonly forceRefresh?: boolean
}) =>
  new TokenBrokerRequest({
    provider: xAiGrokProviderId,
    subjectId: input.subjectId,
    minTtlSeconds: input.minTtlSeconds,
    forceRefresh: input.forceRefresh
  })

export const makeXAiGrokTokenBrokerClient = (broker: TokenBrokerClient) => ({
  getAccessToken: (input: {
    readonly subjectId: string
    readonly minTtlSeconds?: number
    readonly forceRefresh?: boolean
  }) => broker.getAccessToken(makeXAiGrokBrokerRequest(input))
})

export const xAiGrokAuthorizationHeaders = (token: OAuthAccessToken, model: string) => ({
  authorization: `Bearer ${token.accessToken}`,
  'X-XAI-Token-Auth': 'xai-grok-cli',
  'x-grok-model-override': model
})

export const makeXAiGrokAuthorizationUrl = (input: {
  readonly codeChallenge: string
  readonly state: string
  readonly nonce?: string
  readonly referrer?: string
}) => {
  const authUrl = new URL(xAiGrokAuthorizeUrl)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('client_id', xAiGrokClientId)
  authUrl.searchParams.set('redirect_uri', xAiGrokRedirectUri)
  authUrl.searchParams.set('scope', xAiGrokScopes)
  authUrl.searchParams.set('code_challenge', input.codeChallenge)
  authUrl.searchParams.set('code_challenge_method', 'S256')
  authUrl.searchParams.set('state', input.state)
  authUrl.searchParams.set('plan', 'generic')

  if (input.nonce !== undefined) {
    authUrl.searchParams.set('nonce', input.nonce)
  }

  if (input.referrer !== undefined) {
    authUrl.searchParams.set('referrer', input.referrer)
  }

  return authUrl.toString()
}

export type ParsedXAiGrokAuthorizationCode = {
  readonly code: string
  readonly state?: string
}

export const parseXAiGrokAuthorizationCode = (
  value: string
): ParsedXAiGrokAuthorizationCode | undefined => {
  const trimmed = value.trim()

  if (trimmed.length === 0) {
    return undefined
  }

  const fromUrl = Result.try(() => new URL(trimmed)).pipe(
    Result.match({
      onFailure: () => undefined,
      onSuccess: url => {
        const callback = new URL(xAiGrokRedirectUri)

        if (url.origin !== callback.origin || url.pathname !== callback.pathname) {
          return undefined
        }

        const codeParam = url.searchParams.get('code')
        const stateParam = url.searchParams.get('state')
        const code = codeParam === null || codeParam.length === 0 ? undefined : codeParam
        const state = stateParam === null || stateParam.length === 0 ? undefined : stateParam

        if (code === undefined) {
          return undefined
        }

        return state === undefined ? { code } : { code, state }
      }
    })
  )

  if (fromUrl !== undefined) {
    return fromUrl
  }

  if (trimmed.includes('://')) {
    return undefined
  }

  if (trimmed.includes('=')) {
    const params = new URLSearchParams(trimmed)
    const codeParam = params.get('code')
    const stateParam = params.get('state')
    const code = codeParam === null || codeParam.length === 0 ? undefined : codeParam
    const state = stateParam === null || stateParam.length === 0 ? undefined : stateParam

    if (code === undefined) {
      return undefined
    }

    return state === undefined ? { code } : { code, state }
  }

  return { code: trimmed }
}
