import { Effect, Layer } from 'effect'
import { TestClock } from 'effect/testing'
import { HttpClient, HttpClientResponse, type HttpClientRequest } from 'effect/unstable/http'
import { describe, expect, it } from '@effect/vitest'
import {
  ANTHROPIC_CLAUDE_CLIENT_ID,
  ANTHROPIC_CLAUDE_REDIRECT_URI,
  ANTHROPIC_CLAUDE_TOKEN_ENDPOINT,
  AnthropicClaudeOAuth,
  makeAnthropicClaudeOAuthLayer
} from './live-layer'

type CapturedRequest = {
  readonly request: HttpClientRequest.HttpClientRequest
}

type ResponseSpec = {
  readonly body: unknown
  readonly status?: number
  readonly contentType?: string
}

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

describe('AnthropicClaudeOAuth', () => {
  it.effect('exchanges authorization code with JSON request', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      const before = 1_000_000
      yield* TestClock.setTime(before)
      const layer = makeAnthropicClaudeOAuthLayer(
        makeHttpClientLayer(
          [
            {
              body: {
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
        const oauth = yield* AnthropicClaudeOAuth
        return yield* oauth.exchangeAuthorizationCode({
          authorizationCode: 'code_1#state_1',
          codeVerifier: 'verifier_1',
          expectedState: 'state_1'
        })
      }).pipe(Effect.provide(layer))

      const request = firstRequest(requests)
      const body = JSON.parse(readBodyText(request))
      expect(request.url).toBe(ANTHROPIC_CLAUDE_TOKEN_ENDPOINT)
      expect(body).toMatchObject({
        grant_type: 'authorization_code',
        client_id: ANTHROPIC_CLAUDE_CLIENT_ID,
        code: 'code_1',
        state: 'state_1',
        redirect_uri: ANTHROPIC_CLAUDE_REDIRECT_URI,
        code_verifier: 'verifier_1'
      })
      expect(result).toMatchObject({
        type: 'oauth',
        access: 'access_1',
        refresh: 'refresh_1'
      })
      expect(result.expires).toBeGreaterThan(before)
    })
  )

  it.effect('rejects authorization state mismatches before request', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      const layer = makeAnthropicClaudeOAuthLayer(makeHttpClientLayer([], requests))

      const error = yield* Effect.gen(function* () {
        const oauth = yield* AnthropicClaudeOAuth
        return yield* oauth.exchangeAuthorizationCode({
          authorizationCode: 'code_1#wrong_state',
          codeVerifier: 'verifier_1',
          expectedState: 'state_1'
        })
      }).pipe(Effect.provide(layer), Effect.flip)

      expect(requests).toEqual([])
      expect(error).toMatchObject({ _tag: 'AnthropicClaudeOAuthError' })
      expect(error.message).toContain('state mismatch')
    })
  )

  it.effect('refreshes token and preserves refresh token when omitted', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      const layer = makeAnthropicClaudeOAuthLayer(
        makeHttpClientLayer(
          [
            {
              body: {
                access_token: 'access_2',
                expires_in: 60
              }
            }
          ],
          requests
        )
      )

      const result = yield* Effect.gen(function* () {
        const oauth = yield* AnthropicClaudeOAuth
        return yield* oauth.refreshToken('refresh_old')
      }).pipe(Effect.provide(layer))

      const request = firstRequest(requests)
      const body = JSON.parse(readBodyText(request))
      expect(request.url).toBe(ANTHROPIC_CLAUDE_TOKEN_ENDPOINT)
      expect(body).toMatchObject({
        grant_type: 'refresh_token',
        refresh_token: 'refresh_old',
        client_id: ANTHROPIC_CLAUDE_CLIENT_ID
      })
      expect(result).toMatchObject({
        type: 'oauth',
        access: 'access_2',
        refresh: 'refresh_old'
      })
    })
  )

  it.effect('fails non-OK responses', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      const layer = makeAnthropicClaudeOAuthLayer(
        makeHttpClientLayer([{ status: 500, body: 'bad', contentType: 'text/plain' }], requests)
      )

      const error = yield* Effect.gen(function* () {
        const oauth = yield* AnthropicClaudeOAuth
        return yield* oauth.refreshToken('refresh_old')
      }).pipe(Effect.provide(layer), Effect.flip)

      expect(error).toMatchObject({ _tag: 'AnthropicClaudeOAuthError', status: 500 })
      expect(error.message).toContain('Anthropic Claude token refresh failed: 500 bad')
    })
  )
})
