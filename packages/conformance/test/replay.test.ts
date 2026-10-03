import { Deferred, Effect, Fiber, Predicate, Ref, Stream } from 'effect'
import * as Base64 from 'effect/encoding/Base64'
import { HttpClient, HttpClientRequest } from 'effect/http'
import { describe, expect, it } from '@effect/vitest'
import type { WireFixture } from '../src/fixture.ts'
import {
  ReplayHttpClient,
  ReplayLedger,
  WireFault,
  WireReplayInvalid,
  WireTransportFault,
  type ReplayHttpClientOptions
} from '../src/replay.ts'

const base = 'https://api.example.test/v1'

const itemsFixture: WireFixture = {
  id: 'example.items.crud',
  caseId: 'example.items.crud',
  evidence: 'unverified',
  recordedAt: '2026-09-01',
  account: 'synthetic',
  endpoint: `${base}/items`,
  exchanges: [
    {
      request: { method: 'POST', url: `${base}/items`, body: { name: 'first' } },
      response: { status: 201, headers: { 'content-type': 'application/json' }, body: '{"id":1}' }
    },
    {
      request: { method: 'PATCH', url: `${base}/items/1`, body: { name: 'renamed' } },
      response: { status: 200, headers: {}, body: '{"id":1,"name":"renamed"}' }
    },
    {
      request: { method: 'GET', url: `${base}/items/1?b=2&a=1` },
      response: { status: 200, headers: {}, body: '{"id":1,"name":"renamed","read":1}' }
    },
    {
      request: { method: 'GET', url: `${base}/items/1?a=1&b=2` },
      response: { status: 200, headers: {}, body: '{"id":1,"name":"renamed","read":2}' }
    }
  ]
}

const streamChunks = [
  'data: {"text":"Hel',
  'lo"}\n\ndata: {"text":" there"}\n\n',
  'data: {"done":true}\n\n',
  'data: [DONE]\n\n'
]

const streamFixture: WireFixture = {
  id: 'example.stream',
  caseId: 'example.stream',
  evidence: 'unverified',
  recordedAt: '2026-09-01',
  account: 'synthetic',
  endpoint: `${base}/stream`,
  exchanges: [
    {
      request: { method: 'POST', url: `${base}/stream` },
      response: {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        chunks: streamChunks
      }
    },
    {
      request: { method: 'POST', url: `${base}/stream` },
      response: {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        chunks: ['data: second\n\n']
      }
    }
  ]
}

const bytesFixture: WireFixture = {
  id: 'example.bytes',
  caseId: 'example.bytes',
  evidence: 'unverified',
  recordedAt: '2026-09-01',
  account: 'synthetic',
  endpoint: `${base}/bytes`,
  exchanges: [
    {
      request: { method: 'GET', url: `${base}/bytes` },
      response: {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        // "é" (0xC3 0xA9) split across two chunks, plus an empty chunk
        chunks: ['data: caf', { base64: 'ww==' }, '', { base64: 'qQoK' }]
      }
    },
    {
      request: { method: 'GET', url: `${base}/document` },
      response: {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
        bodyBase64: Base64.encode(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0xff]))
      }
    }
  ]
}

const withReplay =
  (fixtures: ReadonlyArray<WireFixture>, options: ReplayHttpClientOptions = {}) =>
  <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient | ReplayLedger>) =>
    effect.pipe(Effect.provide(ReplayHttpClient.layer(fixtures, options)))

const postJson = (url: string, body: unknown) =>
  HttpClientRequest.post(url).pipe(HttpClientRequest.bodyJsonUnsafe(body))

const readChunks = (request: HttpClientRequest.HttpClientRequest) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const response = yield* client.execute(request)
    const decoder = new TextDecoder()

    return yield* response.stream.pipe(
      Stream.map(bytes => decoder.decode(bytes)),
      Stream.runCollect
    )
  })

describe('ReplayHttpClient matching', () => {
  it.effect('consumes exchanges once, in recorded order per method and normalized URL', () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient

      const readBack = (params: Record<string, string>) =>
        client
          .execute(
            HttpClientRequest.get(`${base}/items/1`).pipe(HttpClientRequest.setUrlParams(params))
          )
          .pipe(Effect.flatMap(response => response.text))

      // Out-of-order arrival across different keys still matches per key.
      const firstRead = yield* readBack({ a: '1', b: '2' })
      const created = yield* client.execute(postJson(`${base}/items`, { name: 'first' }))

      const updated = yield* client.execute(
        HttpClientRequest.patch(`${base}/items/1`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ name: 'renamed' })
        )
      )

      const secondRead = yield* readBack({ b: '2', a: '1' })

      expect(created.status).toBe(201)
      expect(yield* created.json).toEqual({ id: 1 })
      expect(yield* updated.text).toBe('{"id":1,"name":"renamed"}')
      expect(firstRead).toBe('{"id":1,"name":"renamed","read":1}')
      expect(secondRead).toBe('{"id":1,"name":"renamed","read":2}')

      const ledger = yield* ReplayLedger
      const entries = yield* ledger.entries

      expect(entries.map(entry => [entry.method, entry.url, entry.attempt, entry.match])).toEqual([
        [
          'GET',
          `${base}/items/1?a=1&b=2`,
          1,
          { outcome: 'matched', fixtureId: 'example.items.crud', exchangeIndex: 2 }
        ],
        [
          'POST',
          `${base}/items`,
          1,
          { outcome: 'matched', fixtureId: 'example.items.crud', exchangeIndex: 0 }
        ],
        [
          'PATCH',
          `${base}/items/1`,
          1,
          { outcome: 'matched', fixtureId: 'example.items.crud', exchangeIndex: 1 }
        ],
        [
          'GET',
          `${base}/items/1?a=1&b=2`,
          2,
          { outcome: 'matched', fixtureId: 'example.items.crud', exchangeIndex: 3 }
        ]
      ])
      expect(yield* ledger.remaining).toEqual([])
    }).pipe(withReplay([itemsFixture]))
  )

  it.effect('fails closed with a typed error naming method and URL, and records the request', () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient

      yield* client.execute(postJson(`${base}/items`, { name: 'first' }))

      const error = yield* client
        .execute(
          postJson(`${base}/items`, { name: 'again' }).pipe(
            HttpClientRequest.setHeaders({
              authorization: 'Bearer synthetic-secret',
              'x-api-key': 'synthetic-key',
              'x-figma-token': 'synthetic-figma',
              'private-token': 'synthetic-private',
              'x-ratelimit-remaining-tokens': '9',
              'x-trace': 'kept'
            })
          )
        )
        .pipe(Effect.flip)

      expect(error._tag).toBe('HttpClientError')
      expect(Predicate.isTagged(error.reason, 'TransportError')).toBe(true)
      expect(error.message).toContain(`POST ${base}/items`)
      expect(error.message).not.toContain('synthetic-secret')
      expect(error.message).not.toContain('again')

      const ledger = yield* ReplayLedger
      const entries = yield* ledger.entries
      const unmatched = entries[1]

      expect(unmatched?.match).toEqual({ outcome: 'unmatched' })
      expect(unmatched?.attempt).toBe(2)
      expect(unmatched?.bodyJson).toEqual({ name: 'again' })
      expect(unmatched?.bodyText).toBe('{"name":"again"}')
      expect(unmatched?.headers).toMatchObject({
        authorization: '<redacted>',
        'x-api-key': '<redacted>',
        'x-figma-token': '<redacted>',
        'private-token': '<redacted>',
        'x-ratelimit-remaining-tokens': '9',
        'x-trace': 'kept',
        'content-type': 'application/json'
      })
      expect(yield* ledger.remaining).toEqual([
        { fixtureId: 'example.items.crud', exchangeIndex: 1 },
        { fixtureId: 'example.items.crud', exchangeIndex: 2 },
        { fixtureId: 'example.items.crud', exchangeIndex: 3 }
      ])
    }).pipe(withReplay([itemsFixture]))
  )

  it.effect('builds fresh state per layer build', () =>
    Effect.gen(function* () {
      const layer = ReplayHttpClient.layer([itemsFixture])

      const create = Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient

        return (yield* client.execute(postJson(`${base}/items`, { name: 'first' }))).status
      })

      expect(yield* create.pipe(Effect.provide(layer))).toBe(201)
      expect(yield* create.pipe(Effect.provide(layer))).toBe(201)
    })
  )
})

describe('ReplayHttpClient streaming', () => {
  it.effect('emits exactly one Uint8Array per recorded chunk', () =>
    Effect.gen(function* () {
      const chunks = yield* readChunks(HttpClientRequest.post(`${base}/stream`))

      expect(chunks).toEqual(streamChunks)

      const second = yield* readChunks(HttpClientRequest.post(`${base}/stream`))

      expect(second).toEqual(['data: second\n\n'])
    }).pipe(withReplay([streamFixture]))
  )

  it.effect('delivers chunks progressively before the stream ends', () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>()
      const firstSeen = yield* Deferred.make<string>()
      const ended = yield* Ref.make(false)

      const program = Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(HttpClientRequest.post(`${base}/stream`))
        const decoder = new TextDecoder()

        const consumer = yield* response.stream.pipe(
          Stream.map(bytes => decoder.decode(bytes)),
          Stream.tap(text => Deferred.succeed(firstSeen, text)),
          Stream.onEnd(Ref.set(ended, true)),
          Stream.runCollect,
          Effect.forkChild
        )

        expect(yield* Deferred.await(firstSeen)).toBe(streamChunks[0])
        expect(yield* Ref.get(ended)).toBe(false)

        yield* Deferred.succeed(release, undefined)

        expect(yield* Fiber.join(consumer)).toEqual(streamChunks)
        expect(yield* Ref.get(ended)).toBe(true)
      })

      yield* program.pipe(
        withReplay([streamFixture], {
          faults: [WireFault.HoldAfterChunks({ chunks: 1, release: Deferred.await(release) })]
        })
      )
    })
  )
})

describe('ReplayHttpClient faults', () => {
  it.effect(
    'StatusOnAttempt answers without consuming, so the next attempt gets the recording',
    () =>
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient

        const failed = yield* client.execute(postJson(`${base}/items`, { name: 'first' }))

        expect(failed.status).toBe(500)
        expect(yield* failed.text).toBe('{"error":"synthetic"}')

        const limited = yield* client.execute(postJson(`${base}/items`, { name: 'first' }))

        expect(limited.status).toBe(429)
        expect(limited.headers['retry-after']).toBe('7')

        const recorded = yield* client.execute(postJson(`${base}/items`, { name: 'first' }))

        expect(recorded.status).toBe(201)

        const entries = yield* (yield* ReplayLedger).entries

        expect(entries.map(entry => [entry.attempt, entry.match.outcome, entry.fault])).toEqual([
          [1, 'injected', 'StatusOnAttempt'],
          [2, 'injected', 'StatusOnAttempt'],
          [3, 'matched', undefined]
        ])
      }).pipe(
        withReplay([itemsFixture], {
          faults: [
            WireFault.StatusOnAttempt({ attempt: 1, status: 500, body: '{"error":"synthetic"}' }),
            WireFault.StatusOnAttempt({
              match: { method: 'post', url: `${base}/items*` },
              attempt: 2,
              status: 429,
              headers: { 'retry-after': '7' }
            }),
            WireFault.StatusOnAttempt({ match: { method: 'GET' }, attempt: 3, status: 503 })
          ]
        })
      )
  )

  it.effect('FailAfterChunks emits N chunks and then fails the body stream', () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const response = yield* client.execute(HttpClientRequest.post(`${base}/stream`))
      const seen: Array<string> = []
      const decoder = new TextDecoder()

      const error = yield* response.stream.pipe(
        Stream.runForEach(bytes => Effect.sync(() => seen.push(decoder.decode(bytes)))),
        Effect.flip
      )

      expect(seen).toEqual(streamChunks.slice(0, 2))
      expect(error._tag).toBe('HttpClientError')
      expect(Predicate.isTagged(error.reason, 'DecodeError')).toBe(true)
      expect(error.cause).toBeInstanceOf(WireTransportFault)

      const entries = yield* (yield* ReplayLedger).entries

      expect(entries[0]?.fault).toBe('FailAfterChunks')

      // attempt-scoped: the second attempt streams normally
      expect(yield* readChunks(HttpClientRequest.post(`${base}/stream`))).toEqual([
        'data: second\n\n'
      ])
    }).pipe(
      withReplay([streamFixture], {
        faults: [WireFault.FailAfterChunks({ attempt: 1, chunks: 2 })]
      })
    )
  )

  it.effect('TruncateAfterChunks ends the body cleanly after N chunks', () =>
    Effect.gen(function* () {
      expect(yield* readChunks(HttpClientRequest.post(`${base}/stream`))).toEqual(
        streamChunks.slice(0, 1)
      )

      // No attempt filter: the fault also matches attempt 2, whose recording has
      // only one chunk, so the truncation cannot apply and the request fails.
      const error = yield* readChunks(HttpClientRequest.post(`${base}/stream`)).pipe(Effect.flip)

      expect(error.cause).toBeInstanceOf(WireReplayInvalid)
    }).pipe(
      withReplay([streamFixture], {
        faults: [WireFault.TruncateAfterChunks({ match: { url: `${base}/stream` }, chunks: 1 })]
      })
    )
  )

  it.effect('ignores faults whose match filter does not apply', () =>
    Effect.gen(function* () {
      expect(yield* readChunks(HttpClientRequest.post(`${base}/stream`))).toEqual(streamChunks)

      const entries = yield* (yield* ReplayLedger).entries

      expect(entries[0]?.fault).toBeUndefined()
    }).pipe(
      withReplay([streamFixture], {
        faults: [
          WireFault.TruncateAfterChunks({ match: { url: `${base}/other*` }, chunks: 1 }),
          WireFault.FailAfterChunks({ match: { method: 'GET' }, chunks: 1 }),
          WireFault.StatusOnAttempt({ match: { url: `${base}/items` }, attempt: 1, status: 500 })
        ]
      })
    )
  )
})

describe('ReplayHttpClient bytes', () => {
  it.effect('emits the exact recorded bytes per chunk, including base64 and empty chunks', () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const response = yield* client.execute(HttpClientRequest.get(`${base}/bytes`))

      const chunks = yield* response.stream.pipe(
        Stream.map(bytes => Array.from(bytes)),
        Stream.runCollect
      )

      expect(Array.from(chunks)).toEqual([
        Array.from(new TextEncoder().encode('data: caf')),
        [0xc3],
        [],
        [0xa9, 0x0a, 0x0a]
      ])

      const document = yield* client.execute(HttpClientRequest.get(`${base}/document`))

      expect(Array.from(new Uint8Array(yield* document.arrayBuffer))).toEqual([
        0x25, 0x50, 0x44, 0x46, 0x2d, 0xff
      ])
    }).pipe(withReplay([bytesFixture]))
  )

  it.effect('fails a recording with invalid base64 as an invalid replay', () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const error = yield* client.execute(HttpClientRequest.get(`${base}/bytes`)).pipe(Effect.flip)

      expect(error.cause).toBeInstanceOf(WireReplayInvalid)

      const ledger = yield* ReplayLedger

      expect((yield* ledger.entries)[0]?.match).toMatchObject({ outcome: 'invalid' })
      expect(yield* ledger.remaining).toEqual([{ fixtureId: 'example.bytes', exchangeIndex: 0 }])
    }).pipe(
      withReplay([
        {
          ...bytesFixture,
          exchanges: [
            {
              request: { method: 'GET', url: `${base}/bytes` },
              response: { status: 200, headers: {}, chunks: [{ base64: '***' }] }
            }
          ]
        }
      ])
    )
  )

  it.effect('produces replayed chunks only when the consumer pulls', () =>
    Effect.gen(function* () {
      // The release effect runs when the replay stream produces past chunk 2,
      // so it marks how far production has gone.
      const producedPastTwo = yield* Ref.make(false)

      const program = Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(HttpClientRequest.post(`${base}/stream`))
        const decoder = new TextDecoder()

        const firstTwo = yield* response.stream.pipe(
          Stream.take(2),
          Stream.map(bytes => decoder.decode(bytes)),
          Stream.runCollect
        )

        expect(Array.from(firstTwo)).toEqual(streamChunks.slice(0, 2))
        expect(yield* Ref.get(producedPastTwo)).toBe(false)
      })

      yield* program.pipe(
        withReplay([streamFixture], {
          faults: [
            WireFault.HoldAfterChunks({ chunks: 2, release: Ref.set(producedPastTwo, true) })
          ]
        })
      )

      // Control: reading the whole body does produce past chunk 2.
      const readAll = Effect.gen(function* () {
        expect(yield* readChunks(HttpClientRequest.post(`${base}/stream`))).toEqual(streamChunks)
        expect(yield* Ref.get(producedPastTwo)).toBe(true)
      })

      yield* readAll.pipe(
        withReplay([streamFixture], {
          faults: [
            WireFault.HoldAfterChunks({ chunks: 2, release: Ref.set(producedPastTwo, true) })
          ]
        })
      )
    })
  )
})

describe('ReplayHttpClient hold cancellation', () => {
  it.effect('interrupting a held consumer interrupts the release effect', () =>
    Effect.gen(function* () {
      const releaseStarted = yield* Deferred.make<void>()
      const releaseInterrupted = yield* Deferred.make<void>()

      const release = Deferred.succeed(releaseStarted, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Deferred.succeed(releaseInterrupted, undefined))
      )

      const program = Effect.gen(function* () {
        const consumer = yield* readChunks(HttpClientRequest.post(`${base}/stream`)).pipe(
          Effect.forkChild
        )

        yield* Deferred.await(releaseStarted)
        yield* Fiber.interrupt(consumer)
        yield* Deferred.await(releaseInterrupted)
      })

      yield* program.pipe(
        withReplay([streamFixture], {
          faults: [WireFault.HoldAfterChunks({ chunks: 1, release })]
        })
      )

      expect(yield* Deferred.isDone(releaseInterrupted)).toBe(true)
    })
  )
})

describe('ReplayHttpClient fail-closed faults', () => {
  it.effect('an unfiltered status fault never answers an unknown request', () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient

      const error = yield* client
        .execute(HttpClientRequest.get(`${base}/unknown`))
        .pipe(Effect.flip)

      expect(error.message).toContain('replay has no remaining recorded exchange')

      const entries = yield* (yield* ReplayLedger).entries

      expect(entries.map(entry => [entry.url, entry.match, entry.fault])).toEqual([
        [`${base}/unknown`, { outcome: 'unmatched' }, undefined]
      ])
    }).pipe(
      withReplay([itemsFixture], {
        faults: [WireFault.StatusOnAttempt({ attempt: 1, status: 500 })]
      })
    )
  )

  it.effect('a matching status fault never answers an exhausted request', () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient

      yield* client.execute(postJson(`${base}/items`, { name: 'first' }))

      const error = yield* client
        .execute(postJson(`${base}/items`, { name: 'again' }))
        .pipe(Effect.flip)

      expect(error.message).toContain('replay has no remaining recorded exchange')

      const entries = yield* (yield* ReplayLedger).entries

      expect(entries.map(entry => [entry.attempt, entry.match.outcome, entry.fault])).toEqual([
        [1, 'matched', undefined],
        [2, 'unmatched', undefined]
      ])
    }).pipe(
      withReplay([itemsFixture], {
        faults: [
          WireFault.StatusOnAttempt({
            match: { method: 'POST', url: `${base}/items` },
            attempt: 2,
            status: 503
          })
        ]
      })
    )
  )
})

describe('ReplayHttpClient chunk faults that cannot apply', () => {
  const expectInvalid = (request: HttpClientRequest.HttpClientRequest) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const error = yield* client.execute(request).pipe(Effect.flip)

      expect(error._tag).toBe('HttpClientError')
      expect(Predicate.isTagged(error.reason, 'TransportError')).toBe(true)
      expect(error.cause).toBeInstanceOf(WireReplayInvalid)

      const ledger = yield* ReplayLedger
      const [entry] = yield* ledger.entries

      expect(entry?.match.outcome).toBe('invalid')
      expect(entry?.fault).toBeUndefined()

      return { remaining: yield* ledger.remaining }
    })

  it.effect('fails a chunk fault matched against a whole-body response', () =>
    Effect.gen(function* () {
      const { remaining } = yield* expectInvalid(postJson(`${base}/items`, { name: 'first' }))

      expect(remaining).toContainEqual({ fixtureId: 'example.items.crud', exchangeIndex: 0 })
    }).pipe(
      withReplay([itemsFixture], {
        faults: [WireFault.TruncateAfterChunks({ match: { url: `${base}/items` }, chunks: 0 })]
      })
    )
  )

  it.effect('fails TruncateAfterChunks at or beyond the recorded chunk count', () =>
    expectInvalid(HttpClientRequest.post(`${base}/stream`)).pipe(
      withReplay([streamFixture], {
        faults: [WireFault.TruncateAfterChunks({ chunks: streamChunks.length })]
      })
    )
  )

  it.effect('fails HoldAfterChunks at or beyond the recorded chunk count', () =>
    expectInvalid(HttpClientRequest.post(`${base}/stream`)).pipe(
      withReplay([streamFixture], {
        faults: [
          WireFault.HoldAfterChunks({ chunks: streamChunks.length + 1, release: Effect.void })
        ]
      })
    )
  )

  it.effect('fails FailAfterChunks beyond the recorded chunk count', () =>
    expectInvalid(HttpClientRequest.post(`${base}/stream`)).pipe(
      withReplay([streamFixture], {
        faults: [WireFault.FailAfterChunks({ chunks: streamChunks.length + 1 })]
      })
    )
  )

  it.effect('allows FailAfterChunks at exactly the recorded chunk count', () =>
    Effect.gen(function* () {
      const error = yield* readChunks(HttpClientRequest.post(`${base}/stream`)).pipe(Effect.flip)

      expect(error.cause).toBeInstanceOf(WireTransportFault)
      expect((yield* (yield* ReplayLedger).entries)[0]?.fault).toBe('FailAfterChunks')
    }).pipe(
      withReplay([streamFixture], {
        faults: [WireFault.FailAfterChunks({ chunks: streamChunks.length })]
      })
    )
  )
})
