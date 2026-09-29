import { Effect } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import {
  decodeWireFixture,
  fixtureAgeDays,
  isFixtureStale,
  scanFixtureForSecrets,
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
})
