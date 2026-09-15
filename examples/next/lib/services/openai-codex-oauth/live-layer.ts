import { Clock, Context, Data, Effect, Layer, Option } from 'effect'
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpClientError,
  type HttpClientResponse
} from 'effect/unstable/http'
import * as Schema from 'effect/Schema'
import {
  openAiCodexClientId,
  openAiCodexDeviceAuthCallbackRedirect,
  openAiCodexDeviceAuthTokenUrl,
  openAiCodexDeviceAuthUserCodeUrl,
  openAiCodexDeviceVerificationUrl,
  openAiCodexRefreshBufferMs,
  openAiCodexTokenEndpoint
} from '@yolk-sdk/agent/providers/openai/codex'
import { OpenAiCodexOAuthError } from './errors'
import {
  OpenAiCodexAccountIdClaimSchema,
  OpenAiCodexAuthClaimSchema,
  OpenAiCodexOrganizationsClaimSchema,
  OpenAiCodexOrganizationIdClaimSchema,
  OpenAiCodexDeviceAuthTokenResponseSchema,
  OpenAiCodexDeviceAuthUserCodeResponseSchema,
  OpenAiCodexTokenResponseSchema,
  type OpenAiCodexDeviceAuthTokenResponse,
  type OpenAiCodexJsonRequestBody,
  type OpenAiCodexOAuthToken,
  type OpenAiCodexTokenResponse
} from './schemas'

export type OpenAiCodexDevicePollResult =
  | { readonly _tag: 'Pending' }
  | { readonly _tag: 'Failed'; readonly message: string }
  | { readonly _tag: 'Authorized'; readonly deviceToken: OpenAiCodexDeviceAuthTokenResponse }

export const OpenAiCodexDevicePollResult = Data.taggedEnum<OpenAiCodexDevicePollResult>()

export const OPENAI_CODEX_CLIENT_ID = openAiCodexClientId

export const OPENAI_DEVICE_AUTH_USERCODE_URL = openAiCodexDeviceAuthUserCodeUrl

export const OPENAI_DEVICE_AUTH_TOKEN_URL = openAiCodexDeviceAuthTokenUrl

export const OPENAI_DEVICE_AUTH_CALLBACK_REDIRECT = openAiCodexDeviceAuthCallbackRedirect

export const OPENAI_DEVICE_VERIFICATION_URL = openAiCodexDeviceVerificationUrl

export const OPENAI_TOKEN_ENDPOINT = openAiCodexTokenEndpoint

export const OPENAI_CODEX_REFRESH_BUFFER_MS = openAiCodexRefreshBufferMs

export const extractAccountId = (token: string): string | undefined => {
  const parts = token.split('.')
  const encodedPayload = parts[1]

  const payload =
    parts.length !== 3 || encodedPayload === undefined
      ? undefined
      : Option.getOrUndefined(
          Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(
            Buffer.from(encodedPayload, 'base64url').toString()
          )
        )

  const direct = Schema.decodeUnknownOption(OpenAiCodexAccountIdClaimSchema)(payload)

  if (Option.isSome(direct)) {
    return direct.value.chatgpt_account_id
  }

  const auth = Schema.decodeUnknownOption(OpenAiCodexAuthClaimSchema)(payload)

  if (Option.isSome(auth)) {
    return auth.value['https://api.openai.com/auth'].chatgpt_account_id
  }

  const organizations = Schema.decodeUnknownOption(OpenAiCodexOrganizationsClaimSchema)(payload)

  if (Option.isSome(organizations)) {
    for (const organization of organizations.value.organizations) {
      const claim = Schema.decodeUnknownOption(OpenAiCodexOrganizationIdClaimSchema)(organization)

      if (Option.isSome(claim)) {
        return claim.value.id
      }
    }
  }

  return undefined
}

const extractAccountIdFromTokens = (tokens: OpenAiCodexTokenResponse): string | undefined =>
  (tokens.id_token === undefined ? undefined : extractAccountId(tokens.id_token)) ??
  extractAccountId(tokens.access_token)

const toOAuthToken = (
  tokens: OpenAiCodexTokenResponse,
  currentAccountId: string | undefined,
  refreshToken: string,
  nowMs: number
): OpenAiCodexOAuthToken => {
  const accountId = extractAccountIdFromTokens(tokens) ?? currentAccountId
  const expiresIn = tokens.expires_in ?? 3600

  const base: Omit<OpenAiCodexOAuthToken, 'accountId'> = {
    type: 'oauth',
    refresh: tokens.refresh_token ?? refreshToken,
    access: tokens.access_token,
    expires: nowMs + expiresIn * 1000
  }

  if (accountId === undefined) {
    return base
  }

  return { ...base, accountId }
}

const isOkStatus = (status: number) => status >= 200 && status < 300

const toRequestError = (operation: string) => (error: HttpClientError.HttpClientError) =>
  new OpenAiCodexOAuthError({
    message: `OpenAI Codex ${operation} request failed: ${error.message}`,
    cause: error
  })

const readErrorBody = (response: HttpClientResponse.HttpClientResponse, operation: string) =>
  response.text.pipe(
    Effect.mapError(
      error =>
        new OpenAiCodexOAuthError({
          message: `Could not read OpenAI Codex ${operation} error body: ${error.message}`,
          cause: error
        })
    )
  )

const failOpenAiResponse = (response: HttpClientResponse.HttpClientResponse, operation: string) =>
  Effect.gen(function* () {
    const text = yield* readErrorBody(response, operation)

    return yield* Effect.fail(
      new OpenAiCodexOAuthError({
        message: `OpenAI Codex ${operation} failed: ${response.status} ${text}`,
        status: response.status
      })
    )
  })

const parseResponseJson = <S extends Schema.Top>(
  response: HttpClientResponse.HttpClientResponse,
  schema: S,
  operation: string
) =>
  response.json.pipe(
    Effect.mapError(
      error =>
        new OpenAiCodexOAuthError({
          message: `Could not parse OpenAI Codex ${operation} JSON: ${error.message}`,
          cause: error
        })
    ),
    Effect.flatMap(value =>
      Schema.decodeUnknownEffect(schema)(value).pipe(
        Effect.mapError(
          error =>
            new OpenAiCodexOAuthError({
              message: `Invalid OpenAI Codex ${operation} response: ${error instanceof Error ? error.message : String(error)}`,
              cause: error
            })
        )
      )
    )
  )

export class OpenAiCodexOAuth extends Context.Service<OpenAiCodexOAuth>()('@app/OpenAiCodexOAuth', {
  make: Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient

    const execute = (request: HttpClientRequest.HttpClientRequest, operation: string) =>
      client.execute(request).pipe(Effect.mapError(toRequestError(operation)))

    const postJson = (url: string, body: OpenAiCodexJsonRequestBody, operation: string) =>
      Effect.gen(function* () {
        const request = yield* HttpClientRequest.post(url).pipe(
          HttpClientRequest.setHeaders({
            accept: 'application/json',
            'content-type': 'application/json'
          }),
          HttpClientRequest.bodyJson(body),
          Effect.mapError(
            error =>
              new OpenAiCodexOAuthError({
                message: `Could not serialize OpenAI Codex ${operation} request: ${error instanceof Error ? error.message : String(error)}`,
                cause: error
              })
          )
        )

        return yield* execute(request, operation)
      })

    const postForm = (url: string, body: URLSearchParams, operation: string) =>
      Effect.gen(function* () {
        const request = HttpClientRequest.post(url).pipe(
          HttpClientRequest.setHeaders({
            accept: 'application/json',
            'content-type': 'application/x-www-form-urlencoded'
          }),
          HttpClientRequest.bodyText(body.toString(), 'application/x-www-form-urlencoded')
        )

        const response = yield* execute(request, operation)

        if (!isOkStatus(response.status)) {
          return yield* failOpenAiResponse(response, operation)
        }

        return yield* parseResponseJson(response, OpenAiCodexTokenResponseSchema, operation)
      })

    const startDeviceFlow = () =>
      Effect.gen(function* () {
        const response = yield* postJson(
          OPENAI_DEVICE_AUTH_USERCODE_URL,
          { client_id: OPENAI_CODEX_CLIENT_ID },
          'device authorization'
        )

        if (!isOkStatus(response.status)) {
          return yield* failOpenAiResponse(response, 'device authorization')
        }

        const deviceAuth = yield* parseResponseJson(
          response,
          OpenAiCodexDeviceAuthUserCodeResponseSchema,
          'device authorization'
        )

        const interval = Math.max(Number.parseInt(deviceAuth.interval, 10) || 5, 1)

        return {
          userCode: deviceAuth.user_code,
          verificationUrl: OPENAI_DEVICE_VERIFICATION_URL,
          deviceAuthId: deviceAuth.device_auth_id,
          interval
        }
      }).pipe(Effect.withSpan('OpenAiCodexOAuth.startDeviceFlow'))

    const pollDeviceFlow = (input: { readonly deviceAuthId: string; readonly userCode: string }) =>
      Effect.gen(function* () {
        const response = yield* postJson(
          OPENAI_DEVICE_AUTH_TOKEN_URL,
          {
            device_auth_id: input.deviceAuthId,
            user_code: input.userCode
          },
          'device token poll'
        )

        if (response.status === 403 || response.status === 404) {
          return OpenAiCodexDevicePollResult.Pending()
        }

        if (!isOkStatus(response.status)) {
          const text = yield* readErrorBody(response, 'device token poll')

          return OpenAiCodexDevicePollResult.Failed({
            message: `Device authorization failed: ${response.status} ${text}`
          })
        }

        const deviceToken = yield* parseResponseJson(
          response,
          OpenAiCodexDeviceAuthTokenResponseSchema,
          'device token poll'
        )

        return OpenAiCodexDevicePollResult.Authorized({ deviceToken })
      }).pipe(Effect.withSpan('OpenAiCodexOAuth.pollDeviceFlow'))

    const exchangeDeviceToken = (deviceToken: OpenAiCodexDeviceAuthTokenResponse) =>
      Effect.gen(function* () {
        const tokens = yield* postForm(
          OPENAI_TOKEN_ENDPOINT,
          new URLSearchParams({
            grant_type: 'authorization_code',
            code: deviceToken.authorization_code,
            redirect_uri: OPENAI_DEVICE_AUTH_CALLBACK_REDIRECT,
            client_id: OPENAI_CODEX_CLIENT_ID,
            code_verifier: deviceToken.code_verifier
          }),
          'token exchange'
        )

        if (tokens.refresh_token === undefined) {
          return yield* new OpenAiCodexOAuthError({
            message: 'Invalid OpenAI Codex token exchange response: missing refresh_token'
          })
        }

        const nowMs = yield* Clock.currentTimeMillis

        return toOAuthToken(tokens, undefined, tokens.refresh_token, nowMs)
      }).pipe(Effect.withSpan('OpenAiCodexOAuth.exchangeDeviceToken'))

    const refreshToken = (refreshTokenValue: string, currentAccountId: string | undefined) =>
      Effect.gen(function* () {
        const tokens = yield* postForm(
          OPENAI_TOKEN_ENDPOINT,
          new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshTokenValue,
            client_id: OPENAI_CODEX_CLIENT_ID
          }),
          'token refresh'
        )

        const nowMs = yield* Clock.currentTimeMillis

        return toOAuthToken(tokens, currentAccountId, refreshTokenValue, nowMs)
      }).pipe(Effect.withSpan('OpenAiCodexOAuth.refreshToken'))

    const needsRefresh = (
      token: OpenAiCodexOAuthToken,
      minTtlMs = OPENAI_CODEX_REFRESH_BUFFER_MS
    ) =>
      Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis

        return !token.access || token.expires < nowMs + minTtlMs
      })

    return {
      startDeviceFlow,
      pollDeviceFlow,
      exchangeDeviceToken,
      refreshToken,
      needsRefresh
    } as const
  })
}) {
  static layer = Layer.effect(this, this.make).pipe(Layer.provide(FetchHttpClient.layer))
}

export const makeOpenAiCodexOAuthLayer = (httpClientLayer: Layer.Layer<HttpClient.HttpClient>) =>
  Layer.effect(OpenAiCodexOAuth, OpenAiCodexOAuth.make).pipe(Layer.provide(httpClientLayer))
