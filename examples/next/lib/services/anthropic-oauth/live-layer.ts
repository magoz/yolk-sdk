import { Clock, Context, Effect, Layer } from 'effect'
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpClientError,
  type HttpClientResponse
} from 'effect/unstable/http'
import * as Schema from 'effect/Schema'
import {
  anthropicClaudeClientId,
  anthropicClaudeOAuthUserAgent,
  anthropicClaudeRedirectUri,
  anthropicClaudeRefreshBufferMs,
  anthropicClaudeTokenEndpoint,
  parseAnthropicClaudeAuthorizationCode
} from '@yolk-sdk/anthropic/claude'
import { AnthropicClaudeOAuthError } from './errors'
import {
  AnthropicClaudeTokenResponseSchema,
  type AnthropicClaudeOAuthToken,
  type AnthropicClaudeTokenResponse
} from './schemas'

export const ANTHROPIC_CLAUDE_CLIENT_ID = anthropicClaudeClientId
export const ANTHROPIC_CLAUDE_TOKEN_ENDPOINT = anthropicClaudeTokenEndpoint
export const ANTHROPIC_CLAUDE_REDIRECT_URI = anthropicClaudeRedirectUri
export const ANTHROPIC_CLAUDE_OAUTH_USER_AGENT = anthropicClaudeOAuthUserAgent
export const ANTHROPIC_CLAUDE_REFRESH_BUFFER_MS = anthropicClaudeRefreshBufferMs

const unknownToMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

const isOkStatus = (status: number) => status >= 200 && status < 300

const toRequestError = (operation: string) => (error: HttpClientError.HttpClientError) =>
  new AnthropicClaudeOAuthError({
    message: `Anthropic Claude ${operation} request failed: ${error.message}`,
    cause: error
  })

const readErrorBody = (response: HttpClientResponse.HttpClientResponse, operation: string) =>
  response.text.pipe(
    Effect.mapError(
      error =>
        new AnthropicClaudeOAuthError({
          message: `Could not read Anthropic Claude ${operation} error body: ${error.message}`,
          cause: error
        })
    )
  )

const failAnthropicResponse = (
  response: HttpClientResponse.HttpClientResponse,
  operation: string
) =>
  Effect.gen(function* () {
    const text = yield* readErrorBody(response, operation)
    return yield* Effect.fail(
      new AnthropicClaudeOAuthError({
        message: `Anthropic Claude ${operation} failed: ${response.status} ${text}`,
        status: response.status
      })
    )
  })

const parseResponseJson = (response: HttpClientResponse.HttpClientResponse, operation: string) =>
  response.json.pipe(
    Effect.mapError(
      error =>
        new AnthropicClaudeOAuthError({
          message: `Could not parse Anthropic Claude ${operation} JSON: ${error.message}`,
          cause: error
        })
    )
  )

const decodeJson = <S extends Schema.Top>(schema: S, value: unknown, operation: string) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(
      error =>
        new AnthropicClaudeOAuthError({
          message: `Invalid Anthropic Claude ${operation} response: ${unknownToMessage(error)}`,
          cause: error
        })
    )
  )

const toOAuthToken = (
  tokens: AnthropicClaudeTokenResponse,
  refreshToken: string,
  nowMs: number
): AnthropicClaudeOAuthToken => ({
  type: 'oauth',
  refresh: tokens.refresh_token ?? refreshToken,
  access: tokens.access_token,
  expires: nowMs + (tokens.expires_in ?? 3600) * 1000
})

export class AnthropicClaudeOAuth extends Context.Service<AnthropicClaudeOAuth>()(
  '@app/AnthropicClaudeOAuth',
  {
    make: Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient

      const execute = (request: HttpClientRequest.HttpClientRequest, operation: string) =>
        client.execute(request).pipe(Effect.mapError(toRequestError(operation)))

      const postJson = (url: string, body: unknown, operation: string) =>
        Effect.gen(function* () {
          const request = yield* HttpClientRequest.post(url).pipe(
            HttpClientRequest.setHeaders({
              accept: 'application/json, text/plain, */*',
              'content-type': 'application/json',
              'user-agent': ANTHROPIC_CLAUDE_OAUTH_USER_AGENT
            }),
            HttpClientRequest.bodyJson(body),
            Effect.mapError(
              error =>
                new AnthropicClaudeOAuthError({
                  message: `Could not serialize Anthropic Claude ${operation} request: ${unknownToMessage(error)}`,
                  cause: error
                })
            )
          )
          const response = yield* execute(request, operation)

          if (!isOkStatus(response.status)) {
            return yield* failAnthropicResponse(response, operation)
          }

          return yield* parseResponseJson(response, operation)
        })

      const exchangeAuthorizationCode = (input: {
        readonly authorizationCode: string
        readonly codeVerifier: string
        readonly expectedState: string
      }) =>
        Effect.gen(function* () {
          const parsed = parseAnthropicClaudeAuthorizationCode(input.authorizationCode)

          if (parsed === undefined) {
            return yield* new AnthropicClaudeOAuthError({
              message: 'Invalid Anthropic Claude authorization code. Expected callback URL or code#state.'
            })
          }

          if (parsed.state !== input.expectedState) {
            return yield* new AnthropicClaudeOAuthError({
              message: 'Anthropic Claude OAuth state mismatch'
            })
          }

          const json = yield* postJson(
            ANTHROPIC_CLAUDE_TOKEN_ENDPOINT,
            {
              grant_type: 'authorization_code',
              client_id: ANTHROPIC_CLAUDE_CLIENT_ID,
              code: parsed.code,
              state: parsed.state,
              redirect_uri: ANTHROPIC_CLAUDE_REDIRECT_URI,
              code_verifier: input.codeVerifier
            },
            'token exchange'
          )
          const tokens = yield* decodeJson(
            AnthropicClaudeTokenResponseSchema,
            json,
            'token exchange'
          )

          if (tokens.refresh_token === undefined) {
            return yield* new AnthropicClaudeOAuthError({
              message: 'Invalid Anthropic Claude token exchange response: missing refresh_token'
            })
          }

          const nowMs = yield* Clock.currentTimeMillis

          return toOAuthToken(tokens, tokens.refresh_token, nowMs)
        }).pipe(Effect.withSpan('AnthropicClaudeOAuth.exchangeAuthorizationCode'))

      const refreshToken = (refreshTokenValue: string) =>
        Effect.gen(function* () {
          const json = yield* postJson(
            ANTHROPIC_CLAUDE_TOKEN_ENDPOINT,
            {
              grant_type: 'refresh_token',
              refresh_token: refreshTokenValue,
              client_id: ANTHROPIC_CLAUDE_CLIENT_ID
            },
            'token refresh'
          )
          const tokens = yield* decodeJson(
            AnthropicClaudeTokenResponseSchema,
            json,
            'token refresh'
          )
          const nowMs = yield* Clock.currentTimeMillis

          return toOAuthToken(tokens, refreshTokenValue, nowMs)
        }).pipe(Effect.withSpan('AnthropicClaudeOAuth.refreshToken'))

      const needsRefresh = (
        token: AnthropicClaudeOAuthToken,
        minTtlMs = ANTHROPIC_CLAUDE_REFRESH_BUFFER_MS
      ) =>
        Effect.gen(function* () {
          const nowMs = yield* Clock.currentTimeMillis
          return !token.access || token.expires < nowMs + minTtlMs
        })

      return {
        exchangeAuthorizationCode,
        refreshToken,
        needsRefresh
      } as const
    })
  }
) {
  static layer = Layer.effect(this, this.make).pipe(Layer.provide(FetchHttpClient.layer))
}

export const makeAnthropicClaudeOAuthLayer = (
  httpClientLayer: Layer.Layer<HttpClient.HttpClient>
) => Layer.effect(AnthropicClaudeOAuth, AnthropicClaudeOAuth.make).pipe(Layer.provide(httpClientLayer))
