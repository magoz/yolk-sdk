import { Effect, Layer } from 'effect'
import { TestClock } from 'effect/testing'
import { HttpClient, HttpClientResponse, type HttpClientRequest } from 'effect/unstable/http'
import { describe, expect, it } from '@effect/vitest'
import {
  OPENAI_CODEX_CLIENT_ID,
  OPENAI_DEVICE_AUTH_CALLBACK_REDIRECT,
  OPENAI_DEVICE_AUTH_TOKEN_URL,
  OPENAI_DEVICE_AUTH_USERCODE_URL,
  OPENAI_DEVICE_VERIFICATION_URL,
  OPENAI_TOKEN_ENDPOINT,
  OpenAiCodexOAuth,
  makeOpenAiCodexOAuthLayer
} from './live-layer'

type CapturedRequest = {
  readonly request: HttpClientRequest.HttpClientRequest
}

type ResponseSpec = {
  readonly body: unknown
  readonly status?: number
  readonly contentType?: string
}

const jwtWithPayload = (payload: unknown) =>
  ['header', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'signature'].join('.')

const makeHttpClientLayer = (
  responses: ReadonlyArray<ResponseSpec>,
  requests: Array<CapturedRequest>
): Layer.Layer<HttpClient.HttpClient> => {
  const queue = [...responses]

  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(request =>
      Effect.sync(() => {
        requests.push({ request })

        const spec = queue.shift() ?? {
          status: 500,
          body: 'Unexpected test request',
          contentType: 'text/plain'
        }
        const body = typeof spec.body === 'string' ? spec.body : JSON.stringify(spec.body)

        return HttpClientResponse.fromWeb(
          request,
          new Response(body, {
            status: spec.status ?? 200,
            headers: { 'content-type': spec.contentType ?? 'application/json' }
          })
        )
      })
    )
  )
}

const firstRequest = (requests: ReadonlyArray<CapturedRequest>) => {
  const request = requests[0]?.request

  if (request === undefined) {
    expect.fail('Expected request')
  }

  return request
}

const readBodyText = (request: HttpClientRequest.HttpClientRequest) => {
  const body = request.body
  expect(body._tag).toBe('Uint8Array')

  if (body._tag !== 'Uint8Array') {
    expect.fail('Expected text body')
  }

  return new TextDecoder().decode(body.body)
}

describe('OpenAiCodexOAuth', () => {
  it.effect('starts device flow with JSON request', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      const layer = makeOpenAiCodexOAuthLayer(
        makeHttpClientLayer(
          [
            {
              body: {
                device_auth_id: 'device_1',
                user_code: 'user_1',
                interval: '2'
              }
            }
          ],
          requests
        )
      )

      const result = yield* Effect.gen(function* () {
        const oauth = yield* OpenAiCodexOAuth
        return yield* oauth.startDeviceFlow()
      }).pipe(Effect.provide(layer))

      const request = firstRequest(requests)
      expect(request.url).toBe(OPENAI_DEVICE_AUTH_USERCODE_URL)
      expect(JSON.parse(readBodyText(request))).toMatchObject({ client_id: OPENAI_CODEX_CLIENT_ID })
      expect(result).toEqual({
        userCode: 'user_1',
        verificationUrl: OPENAI_DEVICE_VERIFICATION_URL,
        deviceAuthId: 'device_1',
        interval: 2
      })
    })
  )

  it.effect('maps pending device poll status', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      const layer = makeOpenAiCodexOAuthLayer(
        makeHttpClientLayer([{ status: 403, body: 'pending', contentType: 'text/plain' }], requests)
      )

      const result = yield* Effect.gen(function* () {
        const oauth = yield* OpenAiCodexOAuth
        return yield* oauth.pollDeviceFlow({ deviceAuthId: 'device_1', userCode: 'user_1' })
      }).pipe(Effect.provide(layer))

      const request = firstRequest(requests)
      expect(request.url).toBe(OPENAI_DEVICE_AUTH_TOKEN_URL)
      expect(JSON.parse(readBodyText(request))).toMatchObject({
        device_auth_id: 'device_1',
        user_code: 'user_1'
      })
      expect(result).toEqual({ _tag: 'Pending' })
    })
  )

  it.effect('exchanges device token with form request', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      const before = 1_000_000
      yield* TestClock.setTime(before)
      const layer = makeOpenAiCodexOAuthLayer(
        makeHttpClientLayer(
          [
            {
              body: {
                id_token: jwtWithPayload({ chatgpt_account_id: 'acct_1' }),
                access_token: 'access_1',
                refresh_token: 'refresh_1',
                expires_in: 30
              }
            }
          ],
          requests
        )
      )

      const result = yield* Effect.gen(function* () {
        const oauth = yield* OpenAiCodexOAuth
        return yield* oauth.exchangeDeviceToken({
          authorization_code: 'code_1',
          code_verifier: 'verifier_1'
        })
      }).pipe(Effect.provide(layer))

      const request = firstRequest(requests)
      const params = new URLSearchParams(readBodyText(request))
      expect(request.url).toBe(OPENAI_TOKEN_ENDPOINT)
      expect(params.get('grant_type')).toBe('authorization_code')
      expect(params.get('code')).toBe('code_1')
      expect(params.get('redirect_uri')).toBe(OPENAI_DEVICE_AUTH_CALLBACK_REDIRECT)
      expect(params.get('client_id')).toBe(OPENAI_CODEX_CLIENT_ID)
      expect(params.get('code_verifier')).toBe('verifier_1')
      expect(result).toMatchObject({
        type: 'oauth',
        access: 'access_1',
        refresh: 'refresh_1',
        accountId: 'acct_1'
      })
      expect(result.expires).toBeGreaterThan(before)
    })
  )

  it.effect('refreshes token and preserves current account id', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      const layer = makeOpenAiCodexOAuthLayer(
        makeHttpClientLayer(
          [
            {
              body: {
                id_token: 'id_without_account',
                access_token: 'access_2',
                refresh_token: 'refresh_2'
              }
            }
          ],
          requests
        )
      )

      const result = yield* Effect.gen(function* () {
        const oauth = yield* OpenAiCodexOAuth
        return yield* oauth.refreshToken('refresh_old', 'acct_current')
      }).pipe(Effect.provide(layer))

      const request = firstRequest(requests)
      const params = new URLSearchParams(readBodyText(request))
      expect(request.url).toBe(OPENAI_TOKEN_ENDPOINT)
      expect(params.get('grant_type')).toBe('refresh_token')
      expect(params.get('refresh_token')).toBe('refresh_old')
      expect(params.get('client_id')).toBe(OPENAI_CODEX_CLIENT_ID)
      expect(result).toMatchObject({
        type: 'oauth',
        access: 'access_2',
        refresh: 'refresh_2',
        accountId: 'acct_current'
      })
    })
  )

  it.effect('fails non-OK device authorization responses', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      const layer = makeOpenAiCodexOAuthLayer(
        makeHttpClientLayer([{ status: 500, body: 'bad', contentType: 'text/plain' }], requests)
      )

      const error = yield* Effect.gen(function* () {
        const oauth = yield* OpenAiCodexOAuth
        return yield* oauth.startDeviceFlow()
      }).pipe(Effect.provide(layer), Effect.flip)

      expect(error).toMatchObject({ _tag: 'OpenAiCodexOAuthError', status: 500 })
      expect(error.message).toContain('OpenAI Codex device authorization failed: 500 bad')
    })
  )
})
