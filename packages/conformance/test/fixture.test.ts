import { Effect, Encoding } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import {
  decodeWireFixture,
  fixtureAgeDays,
  isFixtureStale,
  scanFixtureForSecrets,
  syntheticPortCredentialParams,
  type FixtureSecretIssue,
  type WireExchange,
  type WireFixture
} from '../src/fixture.ts'

const cleanFixture: WireFixture = {
  id: 'example.stream.text',
  caseId: 'example.stream.text',
  evidence: 'unverified',
  recordedAt: '2026-09-01',
  account: 'synthetic',
  endpoint: 'https://api.example.test/v1/chat',
  model: 'example/model-small',
  note: 'Synthetic placeholder about task-manager tokens and max_tokens limits.',
  exchanges: [
    {
      request: {
        method: 'POST',
        url: 'https://api.example.test/v1/chat?page=2',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: { model: 'example/model-small', max_tokens: 16, stream: true, token_budget: 'low' }
      },
      response: {
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'x-ratelimit-remaining': '9' },
        chunks: ['data: {"text":"Hello"}\n\n', 'data: [DONE]\n\n']
      }
    }
  ]
}

describe('wire fixture schema', () => {
  it.effect('decodes a valid fixture and preserves both response shapes', () =>
    Effect.gen(function* () {
      const decoded = yield* decodeWireFixture({
        ...cleanFixture,
        exchanges: [
          ...cleanFixture.exchanges,
          {
            request: { method: 'GET', url: 'https://api.example.test/v1/models' },
            response: { status: 404, headers: {}, body: '{"error":"missing"}' }
          }
        ]
      })

      expect(decoded.exchanges).toHaveLength(2)
      expect(decoded.exchanges[0]?.response).toHaveProperty('chunks')
      expect(decoded.exchanges[1]?.response).toHaveProperty('body', '{"error":"missing"}')
    })
  )

  it.effect('decodes base64 chunks and bodyBase64 bodies', () =>
    Effect.gen(function* () {
      const decoded = yield* decodeWireFixture({
        ...cleanFixture,
        exchanges: [
          {
            request: { method: 'GET', url: 'https://api.example.test/v1/stream' },
            response: { status: 200, headers: {}, chunks: ['data: caf', { base64: 'ww==' }, ''] }
          },
          {
            request: { method: 'GET', url: 'https://api.example.test/v1/document' },
            response: { status: 200, headers: {}, bodyBase64: 'JVBERi3/' }
          }
        ]
      })

      expect(decoded.exchanges[0]?.response).toMatchObject({
        chunks: ['data: caf', { base64: 'ww==' }, '']
      })
      expect(decoded.exchanges[1]?.response).toEqual({
        status: 200,
        headers: {},
        bodyBase64: 'JVBERi3/'
      })
    })
  )

  it.effect('requires exactly one of body, bodyBase64, or chunks', () =>
    Effect.gen(function* () {
      const request = { method: 'GET', url: 'https://api.example.test/v1/document' }

      const responses: ReadonlyArray<unknown> = [
        { status: 200, headers: {}, body: '', bodyBase64: 'JVBERi3/' },
        { status: 200, headers: {}, body: '', chunks: [] },
        { status: 200, headers: {}, bodyBase64: 'JVBERi3/', chunks: [] },
        { status: 200, headers: {} },
        { status: 200, headers: {}, bodyBase64: 'not base64!' },
        { status: 200, headers: {}, chunks: [{ base64: 'not base64!' }] }
      ]

      for (const response of responses) {
        const error = yield* decodeWireFixture({
          ...cleanFixture,
          exchanges: [{ request, response }]
        }).pipe(Effect.flip)

        expect(error._tag).toBe('SchemaError')
      }
    })
  )

  it.effect('rejects empty exchanges, malformed dates, evidence, and statuses', () =>
    Effect.gen(function* () {
      const invalid: ReadonlyArray<unknown> = [
        { ...cleanFixture, exchanges: [] },
        { ...cleanFixture, recordedAt: '2026-9-1' },
        { ...cleanFixture, evidence: 'guessed' },
        {
          ...cleanFixture,
          exchanges: [
            {
              request: { method: 'GET', url: 'https://api.example.test' },
              response: { status: 42, headers: {}, body: '' }
            }
          ]
        }
      ]

      for (const input of invalid) {
        const error = yield* decodeWireFixture(input).pipe(Effect.flip)

        expect(error._tag).toBe('SchemaError')
      }
    })
  )
})

describe('fixture staleness', () => {
  it('counts whole UTC days since the recording date', () => {
    expect(fixtureAgeDays(cleanFixture, new Date('2026-09-01T23:59:59Z'))).toBe(0)
    expect(fixtureAgeDays(cleanFixture, new Date('2026-10-01T00:00:00Z'))).toBe(30)
  })

  it('is stale strictly after the maximum age and when the date is unreadable', () => {
    expect(isFixtureStale(cleanFixture, new Date('2026-10-01T12:00:00Z'))).toBe(false)
    expect(isFixtureStale(cleanFixture, new Date('2026-10-02T00:00:00Z'))).toBe(true)
    expect(isFixtureStale(cleanFixture, new Date('2026-09-05T00:00:00Z'), 3)).toBe(true)
    expect(isFixtureStale({ recordedAt: 'yesterday' }, new Date('2026-09-05T00:00:00Z'))).toBe(true)
  })
})

describe('scanFixtureForSecrets', () => {
  it('returns no issues for a clean synthetic fixture', () => {
    expect(scanFixtureForSecrets(cleanFixture)).toEqual([])
  })

  it('flags credential headers, tokens, keys, query params, and credential fields without echoing them', () => {
    const syntheticKey = ['sk', 'synthetic0000000000000000'].join('-')

    const syntheticJwt = [
      'eyJhbGciOiJub25lIn0',
      'eyJzdWIiOiJzeW50aGV0aWMifQ',
      'c2lnbmF0dXJlMDAw'
    ].join('.')

    const leaky: WireFixture = {
      ...cleanFixture,
      endpoint: 'https://api.example.test/v1/chat?api_key=synthetic-value',
      exchanges: [
        {
          request: {
            method: 'POST',
            url: 'https://api.example.test/v1/chat?token=synthetic-value',
            headers: { authorization: 'Bearer synthetic-token-value', 'x-api-key': 'x' },
            body: { messages: [{ content: syntheticKey }], client_secret: 'synthetic' }
          },
          response: {
            status: 200,
            headers: { 'set-cookie': 'session=synthetic', 'content-type': 'text/event-stream' },
            chunks: ['data: {"ok":true}\n\n', `data: {"echo":"Bearer ${syntheticJwt}"}\n\n`]
          }
        },
        {
          request: { method: 'GET', url: 'https://api.example.test/v1/me' },
          response: { status: 200, headers: {}, body: `{"token":"${syntheticJwt}"}` }
        }
      ]
    }

    const issues = scanFixtureForSecrets(leaky)

    expect(issues).toEqual(
      expect.arrayContaining([
        { kind: 'credential_query_param', location: 'endpoint' },
        { kind: 'credential_query_param', location: 'exchanges[0].request.url' },
        { kind: 'credential_header', location: 'exchanges[0].request.headers.authorization' },
        { kind: 'bearer_token', location: 'exchanges[0].request.headers.authorization' },
        { kind: 'credential_header', location: 'exchanges[0].request.headers.x-api-key' },
        { kind: 'api_key', location: 'exchanges[0].request.body.messages[0].content' },
        { kind: 'credential_field', location: 'exchanges[0].request.body.client_secret' },
        { kind: 'credential_header', location: 'exchanges[0].response.headers.set-cookie' },
        { kind: 'bearer_token', location: 'exchanges[0].response.chunks[1]' },
        { kind: 'api_key', location: 'exchanges[0].response.chunks[1]' },
        { kind: 'api_key', location: 'exchanges[1].response.body' }
      ])
    )
    expect(issues.some(issue => issue.location.includes('chunks[0]'))).toBe(false)
    expect(JSON.stringify(issues)).not.toContain('synthetic-token-value')
    expect(JSON.stringify(issues)).not.toContain(syntheticKey)
  })

  const syntheticKey = ['sk', 'synthetic0000000000000000'].join('-')

  const withExchange = (exchange: WireExchange): WireFixture => ({
    ...cleanFixture,
    exchanges: [exchange]
  })

  const getRequest = { method: 'GET', url: 'https://api.example.test/v1/me' }

  const noSecretValues = (issues: ReadonlyArray<FixtureSecretIssue>) => {
    const serialized = JSON.stringify(issues)

    for (const value of ['opaque-synthetic', 'synthetic-refresh', syntheticKey, 'synthetic-pw']) {
      expect(serialized).not.toContain(value)
    }
  }

  it('flags opaque credential fields in a JSON response body', () => {
    const issues = scanFixtureForSecrets(
      withExchange({
        request: getRequest,
        response: {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: '{"access_token":"opaque-synthetic","refresh_token":"synthetic-refresh","expires_in":3600,"token_type":"bearer"}'
        }
      })
    )

    expect(issues).toEqual([
      { kind: 'credential_field', location: 'exchanges[0].response.body.access_token' },
      { kind: 'credential_field', location: 'exchanges[0].response.body.refresh_token' }
    ])
    noSecretValues(issues)
  })

  it('flags credential fields inside SSE data payloads of a stream', () => {
    const issues = scanFixtureForSecrets(
      withExchange({
        request: getRequest,
        response: {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
          chunks: [
            'data: {"ok":true}\n\n',
            'data: {"session":{"apiKey":"opaque-',
            'synthetic"}}\n\n'
          ]
        }
      })
    )

    expect(issues).toEqual([
      {
        kind: 'credential_field',
        location: 'exchanges[0].response.chunks.events[1].session.apiKey'
      }
    ])
    noSecretValues(issues)
  })

  it('flags credential fields in SSE framed with CRLF or bare CR line endings', () => {
    for (const eol of ['\r\n', '\r']) {
      const issues = scanFixtureForSecrets(
        withExchange({
          request: getRequest,
          response: {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
            chunks: [
              `data: {"ok":true}${eol}${eol}data: {"access_token":"opaque-`,
              `synthetic"}${eol}${eol}data: [DONE]${eol}${eol}`
            ]
          }
        })
      )

      expect(issues).toEqual([
        {
          kind: 'credential_field',
          location: 'exchanges[0].response.chunks.events[1].access_token'
        }
      ])
      noSecretValues(issues)
    }
  })

  it('flags a key split across stream chunks in the reassembled stream', () => {
    const issues = scanFixtureForSecrets(
      withExchange({
        request: getRequest,
        response: {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
          chunks: [`data: ${syntheticKey.slice(0, 10)}`, `${syntheticKey.slice(10)}\n\n`]
        }
      })
    )

    expect(issues).toEqual([{ kind: 'api_key', location: 'exchanges[0].response.chunks' }])
    noSecretValues(issues)
  })

  it('scans the decodable text of base64 chunks and bodyBase64 bodies', () => {
    const encoded = Encoding.encodeBase64(`{"password":"synthetic-pw","key":"${syntheticKey}"}`)

    const stream = scanFixtureForSecrets(
      withExchange({
        request: getRequest,
        response: { status: 200, headers: {}, chunks: [{ base64: encoded }] }
      })
    )

    expect(stream).toEqual(
      expect.arrayContaining([
        { kind: 'api_key', location: 'exchanges[0].response.chunks[0]' },
        { kind: 'credential_field', location: 'exchanges[0].response.chunks.password' }
      ])
    )

    const body = scanFixtureForSecrets(
      withExchange({
        request: getRequest,
        response: { status: 200, headers: {}, bodyBase64: encoded }
      })
    )

    expect(body).toEqual(
      expect.arrayContaining([
        { kind: 'api_key', location: 'exchanges[0].response.bodyBase64' },
        { kind: 'credential_field', location: 'exchanges[0].response.bodyBase64.password' }
      ])
    )
    noSecretValues([...stream, ...body])
  })

  it('flags credential parameters in form-encoded request and response bodies', () => {
    const issues = scanFixtureForSecrets(
      withExchange({
        request: {
          method: 'POST',
          url: 'https://auth.example.test/oauth/token',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: 'grant_type=refresh_token&refresh_token=synthetic-refresh&client_secret=opaque-synthetic'
        },
        response: {
          status: 200,
          headers: {},
          body: 'access_token=opaque-synthetic&scope=repo'
        }
      })
    )

    expect(issues).toEqual([
      { kind: 'credential_query_param', location: 'exchanges[0].request.body' },
      { kind: 'credential_query_param', location: 'exchanges[0].response.body' }
    ])
    noSecretValues(issues)
  })

  it('exempts nothing in credential parameters, not even the port placeholders', () => {
    const url = (query: string) => ({
      request: { method: 'PUT', url: `https://storage.example.test/bucket/key.txt?${query}` },
      response: { status: 200, headers: {}, body: '' }
    })

    for (const query of [
      `X-Amz-Signature=${syntheticPortCredentialParams['x-amz-signature']}`,
      `X-Amz-Credential=${encodeURIComponent(syntheticPortCredentialParams['x-amz-credential'])}`,
      'X-Amz-Signature=yolk-synthetic-signature0123abcdef',
      'password=yolk-synthetic-Hunter2!'
    ]) {
      expect(scanFixtureForSecrets(withExchange(url(query))), query).toEqual([
        { kind: 'credential_query_param', location: 'exchanges[0].request.url' }
      ])
    }
  })

  it('flags a live parameter that follows a placeholder in the same JSON body', () => {
    const body = JSON.stringify({
      a: `https://h.example.test/b?X-Amz-Signature=${syntheticPortCredentialParams['x-amz-signature']}`,
      b: 'https://h.example.test/c?token=GHSAT0AAAALIVE0000000000'
    })

    expect(
      scanFixtureForSecrets(
        withExchange({ request: getRequest, response: { status: 200, headers: {}, body } })
      )
    ).toEqual([{ kind: 'credential_query_param', location: 'exchanges[0].response.body' }])
  })

  it('scans fixture metadata strings with the token patterns', () => {
    const issues = scanFixtureForSecrets({
      ...cleanFixture,
      id: `example.${syntheticKey}`,
      caseId: 'example.case',
      account: `Bearer ${'opaque-synthetic'}`,
      model: syntheticKey,
      note: `recorded with ${syntheticKey}`
    })

    expect(issues).toEqual([
      { kind: 'api_key', location: 'id' },
      { kind: 'bearer_token', location: 'account' },
      { kind: 'api_key', location: 'model' },
      { kind: 'api_key', location: 'note' }
    ])
    noSecretValues(issues)
  })

  it('flags token and key bearing headers but not content, retry, or rate-limit headers', () => {
    const issues = scanFixtureForSecrets(
      withExchange({
        request: {
          ...getRequest,
          headers: {
            'x-auth-token': 'opaque-synthetic',
            'private-token': 'opaque-synthetic',
            'x-figma-token': 'opaque-synthetic',
            'x-service-token': 'opaque-synthetic',
            'x-service-key': 'opaque-synthetic',
            'content-type': 'application/json',
            accept: 'application/json'
          }
        },
        response: {
          status: 429,
          headers: {
            'content-type': 'application/json',
            'retry-after': '3',
            'x-ratelimit-remaining-tokens': '100',
            'x-ratelimit-limit-tokens': '1000',
            'anthropic-ratelimit-input-tokens-remaining': '10',
            'ratelimit-reset': '5'
          },
          body: '{}'
        }
      })
    )

    expect(issues).toEqual(
      ['x-auth-token', 'private-token', 'x-figma-token', 'x-service-token', 'x-service-key'].map(
        name => ({ kind: 'credential_header', location: `exchanges[0].request.headers.${name}` })
      )
    )
    noSecretValues(issues)
  })

  it('does not flag usage counters, plural token fields, or non-string credential fields', () => {
    const usage = {
      max_tokens: 64,
      max_completion_tokens: 64,
      max_output_tokens: 64,
      prompt_tokens: 14,
      completion_tokens: 6,
      total_tokens: 20,
      reasoning_tokens: 4,
      completion_tokens_details: { reasoning_tokens: 4 },
      tokens: 'many',
      token_budget: 'low',
      token: '',
      password: 5,
      secret: null
    }

    const issues = scanFixtureForSecrets(
      withExchange({
        request: { method: 'POST', url: 'https://api.example.test/v1/chat', body: usage },
        response: {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
          chunks: [`data: ${JSON.stringify({ usage })}\n\n`, 'data: [DONE]\n\n']
        }
      })
    )

    expect(issues).toEqual([])
  })
})
