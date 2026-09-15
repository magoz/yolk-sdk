import { Effect, Layer, Option, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
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
  OpenAiCodexDevicePollResult,
  OpenAiCodexOAuth,
  extractAccountId,
  makeOpenAiCodexOAuthLayer
} from './live-layer'
import {
  OpenAiCodexAccountIdClaimSchema,
  OpenAiCodexAuthClaimSchema,
  OpenAiCodexOrganizationsClaimSchema,
  OpenAiCodexOrganizationIdClaimSchema
} from './schemas'

type CapturedRequest = {
  readonly request: HttpClientRequest.HttpClientRequest
}

type ResponseSpec = {
  readonly body: unknown
  readonly status?: number
  readonly contentType?: string
}

const isJson = Schema.is(Schema.Json)

const jwtWithPayload = (payload: Schema.Json) => {
  if (!isJson(payload)) {
    throw new TypeError('JSON fixture requires a finite JSON value')
  }

  return ['header', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'signature'].join(
    '.'
  )
}

const jwtWithRawPayload = (rawJson: string) =>
  ['header', Buffer.from(rawJson).toString('base64url'), 'signature'].join('.')

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

        const body = Predicate.isString(spec.body) ? spec.body : JSON.stringify(spec.body)

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

  if (!Predicate.isTagged(body, 'Uint8Array')) {
    expect.fail('Expected text body')
  }

  return new TextDecoder().decode(body.body)
}

describe('OpenAiCodexOAuth', () => {
  it('claim schemas ignore inherited getters and admit own string claims', () => {
    class InheritedClaims {
      get chatgpt_account_id() {
        throw new Error('Inherited account claim must not be read')
      }

      get ['https://api.openai.com/auth']() {
        throw new Error('Inherited auth claim must not be read')
      }

      get organizations() {
        throw new Error('Inherited organizations claim must not be read')
      }

      get id() {
        throw new Error('Inherited organization id must not be read')
      }
    }

    const inherited = new InheritedClaims()
    expect(Schema.decodeUnknownOption(OpenAiCodexAccountIdClaimSchema)(inherited)).toEqual(
      Option.none()
    )
    expect(Schema.decodeUnknownOption(OpenAiCodexAuthClaimSchema)(inherited)).toEqual(Option.none())
    expect(Schema.decodeUnknownOption(OpenAiCodexOrganizationsClaimSchema)(inherited)).toEqual(
      Option.none()
    )
    expect(Schema.decodeUnknownOption(OpenAiCodexOrganizationIdClaimSchema)(inherited)).toEqual(
      Option.none()
    )
    expect(
      Schema.decodeUnknownOption(OpenAiCodexAccountIdClaimSchema)({ chatgpt_account_id: '' })
    ).toEqual(Option.some({ chatgpt_account_id: '' }))
    expect(Schema.decodeUnknownOption(OpenAiCodexOrganizationIdClaimSchema)({ id: 'own' })).toEqual(
      Option.some({ id: 'own' })
    )
    expect(
      Schema.decodeUnknownOption(OpenAiCodexAuthClaimSchema)({
        'https://api.openai.com/auth': inherited
      })
    ).toEqual(Option.none())
  })

  it('extracts own claims in direct, nested and first-valid-organization order', () => {
    expect(
      extractAccountId(
        jwtWithRawPayload(
          '{"chatgpt_account_id":"direct","https://api.openai.com/auth":false,"organizations":null}'
        )
      )
    ).toBe('direct')
    expect(
      extractAccountId(
        jwtWithRawPayload(
          '{"chatgpt_account_id":"","https://api.openai.com/auth":{"chatgpt_account_id":"nested"}}'
        )
      )
    ).toBe('')
    expect(
      extractAccountId(
        jwtWithRawPayload(
          '{"chatgpt_account_id":1,"https://api.openai.com/auth":{"chatgpt_account_id":"nested"},"organizations":[{"id":"org"}]}'
        )
      )
    ).toBe('nested')
    expect(
      extractAccountId(
        jwtWithRawPayload(
          '{"https://api.openai.com/auth":{"chatgpt_account_id":""},"organizations":[{"id":"org"}]}'
        )
      )
    ).toBe('')
    expect(
      extractAccountId(
        jwtWithRawPayload(
          '{"chatgpt_account_id":false,"https://api.openai.com/auth":{"chatgpt_account_id":null},"organizations":[null,false,0,[],{"id":2},{"id":""},{"id":"later"}]}'
        )
      )
    ).toBe('')
    expect(
      extractAccountId(jwtWithRawPayload('{"organizations":[{"id":"first"},{"id":"second"}]}'))
    ).toBe('first')
  })

  it('keeps valid claims when unrelated raw JSON numbers overflow', () => {
    expect(extractAccountId(jwtWithRawPayload('{"chatgpt_account_id":"direct","n":1e999}'))).toBe(
      'direct'
    )
    expect(
      extractAccountId(
        jwtWithRawPayload(
          '{"chatgpt_account_id":1e999,"https://api.openai.com/auth":{"chatgpt_account_id":"nested","n":1e999}}'
        )
      )
    ).toBe('nested')
    expect(
      extractAccountId(jwtWithRawPayload('{"organizations":[1e999,{"id":"org","n":1e999}]}'))
    ).toBe('org')
    expect(extractAccountId(jwtWithRawPayload('{"n":1e999}'))).toBeUndefined()
  })

  it('ignores invalid claims, arrays and own __proto__ data without accepting malformed tokens', () => {
    for (const raw of [
      '{',
      'null',
      'false',
      '0',
      '"text"',
      '{}',
      '{"chatgpt_account_id":null}',
      '{"chatgpt_account_id":false}',
      '{"chatgpt_account_id":0}',
      '[{"chatgpt_account_id":"not-a-claim-list"}]',
      '{"__proto__":{"chatgpt_account_id":"not-inherited"}}',
      '{"https://api.openai.com/auth":{"__proto__":{"chatgpt_account_id":"not-inherited"}}}',
      '{"organizations":[{"__proto__":{"id":"not-inherited"}}]}'
    ]) {
      expect(extractAccountId(jwtWithRawPayload(raw))).toBeUndefined()
    }

    for (const token of ['', 'a', 'a.b', 'a.b.c.d', 'a..c', 'a.!.c']) {
      expect(extractAccountId(token)).toBeUndefined()
    }
  })

  it.effect('keeps an empty id-token account claim ahead of access-token and current IDs', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      const access = jwtWithRawPayload('{"chatgpt_account_id":"access"}')

      const layer = makeOpenAiCodexOAuthLayer(
        makeHttpClientLayer(
          [
            {
              body: {
                id_token: jwtWithRawPayload('{"chatgpt_account_id":""}'),
                access_token: access
              }
            }
          ],
          requests
        )
      )

      const result = yield* Effect.gen(function* () {
        const oauth = yield* OpenAiCodexOAuth

        return yield* oauth.refreshToken('refresh_old', 'current')
      }).pipe(Effect.provide(layer))

      expect(result.accountId).toBe('')
      expect(result.access).toBe(access)
      expect(result.refresh).toBe('refresh_old')
      expect(requests).toHaveLength(1)
    })
  )

  it.effect(
    'falls back from malformed id-token claims to access-token claims before current ID',
    () =>
      Effect.gen(function* () {
        const requests: Array<CapturedRequest> = []
        const access = jwtWithRawPayload('{"organizations":[{"id":"access-org"}]}')

        const layer = makeOpenAiCodexOAuthLayer(
          makeHttpClientLayer(
            [
              {
                body: {
                  id_token: jwtWithRawPayload('{'),
                  access_token: access
                }
              }
            ],
            requests
          )
        )

        const result = yield* Effect.gen(function* () {
          const oauth = yield* OpenAiCodexOAuth

          return yield* oauth.refreshToken('refresh_old', 'current')
        }).pipe(Effect.provide(layer))

        expect(result.accountId).toBe('access-org')
        expect(result.access).toBe(access)
        expect(requests).toHaveLength(1)
      })
  )

  it('rejects non-finite JSON JWT fixtures before encoding', () => {
    expect(() => jwtWithPayload(Infinity)).toThrow('JSON fixture requires a finite JSON value')
    expect(() => jwtWithPayload({ n: Infinity })).toThrow(
      'JSON fixture requires a finite JSON value'
    )
  })

  it('preserves raw JWT fixture framing and null or falsy payload bytes', () => {
    expect(jwtWithPayload({ chatgpt_account_id: 'acct_1' })).toBe(
      'header.eyJjaGF0Z3B0X2FjY291bnRfaWQiOiJhY2N0XzEifQ.signature'
    )
    expect(jwtWithPayload(null)).toBe('header.bnVsbA.signature')
    expect(jwtWithPayload(false)).toBe('header.ZmFsc2U.signature')
    expect(jwtWithPayload(0)).toBe('header.MA.signature')
  })

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
      expect(result).toEqual(OpenAiCodexDevicePollResult.Pending())
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

  it.effect('refreshes token when response omits refresh and id tokens', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []

      const layer = makeOpenAiCodexOAuthLayer(
        makeHttpClientLayer(
          [
            {
              body: {
                access_token: 'access_3',
                expires_in: 60
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

      expect(result).toMatchObject({
        type: 'oauth',
        access: 'access_3',
        refresh: 'refresh_old',
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

      expect(Predicate.isTagged(error, 'OpenAiCodexOAuthError')).toBe(true)
      expect(error).toMatchObject({ status: 500 })
      expect(error.message).toContain('OpenAI Codex device authorization failed: 500 bad')
    })
  )
})
