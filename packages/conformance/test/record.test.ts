import { Effect, Layer, Predicate, Stream } from 'effect'
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse
} from 'effect/unstable/http'
import { describe, expect, it } from '@effect/vitest'
import { scanFixtureForSecrets, type WireExchange } from '../src/fixture.ts'
import {
  makeRecordingHttpClient,
  makeWireFixture,
  WireRecorder,
  type WireFixtureInput
} from '../src/record.ts'
import { ReplayHttpClient } from '../src/replay.ts'

const base = 'https://api.example.test/v1'

const upstreamChunks = ['data: {"text":"Hel', 'lo"}\n\n', 'data: [DONE]\n\n']

const encoder = new TextEncoder()

const chunkedBody = (chunks: ReadonlyArray<Uint8Array>) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)

      controller.close()
    }
  })

// Fake host client: the conformance package never builds a network client.
const fakeUpstream = HttpClient.make(request =>
  Effect.sync(() => {
    if (request.url.endsWith('/stream')) {
      return HttpClientResponse.fromWeb(
        request,
        new Response(chunkedBody(upstreamChunks.map(chunk => encoder.encode(chunk))), {
          status: 200,
          headers: {
            'content-type': 'text/event-stream; charset=utf-8',
            'set-cookie': 'session=synthetic',
            'x-ratelimit-remaining-requests': '99',
            'x-request-id': 'synthetic-request'
          }
        })
      )
    }

    if (request.url.endsWith('/split')) {
      // A multi-byte character ("é" = 0xC3 0xA9) split across network chunks.
      const bytes = encoder.encode('data: café\n\n')

      return HttpClientResponse.fromWeb(
        request,
        new Response(chunkedBody([bytes.slice(0, 10), bytes.slice(10)]), {
          headers: { 'content-type': 'text/event-stream' }
        })
      )
    }

    return HttpClientResponse.fromWeb(
      request,
      new Response('{"error":{"code":"rate_limited"}}', {
        status: 429,
        headers: {
          'content-type': 'application/json',
          'retry-after': '3',
          'set-cookie': 'session=synthetic'
        }
      })
    )
  })
)

const syntheticRequest = (path: string) =>
  HttpClientRequest.post(`${base}${path}`).pipe(
    HttpClientRequest.setHeaders({
      authorization: 'Bearer synthetic-secret-value',
      accept: 'text/event-stream',
      'x-custom': 'dropped'
    }),
    HttpClientRequest.bodyJsonUnsafe({ model: 'example/model', stream: true })
  )

describe('recording HttpClient', () => {
  it.effect('tees streamed chunks without changing what the caller receives', () =>
    Effect.gen(function* () {
      const { client, recorder } = yield* makeRecordingHttpClient(fakeUpstream)
      const response = yield* client.execute(syntheticRequest('/stream'))
      const decoder = new TextDecoder()

      const received = yield* response.stream.pipe(
        Stream.map(bytes => decoder.decode(bytes)),
        Stream.runCollect
      )

      expect(received).toEqual(upstreamChunks)
      expect(response.status).toBe(200)
      expect(response.headers['set-cookie']).toBe('session=synthetic')
      expect(response.headers['x-request-id']).toBe('synthetic-request')

      const exchanges = yield* recorder.drain

      expect(exchanges).toEqual([
        {
          request: {
            method: 'POST',
            url: `${base}/stream`,
            headers: { accept: 'text/event-stream', 'content-type': 'application/json' },
            body: { model: 'example/model', stream: true }
          },
          response: {
            status: 200,
            headers: {
              'content-type': 'text/event-stream; charset=utf-8',
              'x-ratelimit-remaining-requests': '99'
            },
            chunks: upstreamChunks
          }
        }
      ])
      expect(yield* recorder.drain).toEqual([])
    })
  )

  it.effect('records whole bodies, keeps retry-after, and still lets the caller read them', () =>
    Effect.gen(function* () {
      const recorder = yield* WireRecorder
      const client = yield* HttpClient.HttpClient
      const response = yield* client.execute(syntheticRequest('/chat'))

      expect(response.status).toBe(429)
      expect(yield* response.json).toEqual({ error: { code: 'rate_limited' } })

      const [exchange] = yield* recorder.drain

      expect(exchange?.response).toEqual({
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '3' },
        body: '{"error":{"code":"rate_limited"}}'
      })
      expect(JSON.stringify(exchange)).not.toContain('synthetic-secret-value')
    }).pipe(
      Effect.provide(
        WireRecorder.layer().pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, fakeUpstream)))
      )
    )
  )

  it.effect('honors custom header allowlists but never records credentials', () =>
    Effect.gen(function* () {
      const { client, recorder } = yield* makeRecordingHttpClient(fakeUpstream, {
        requestHeaders: ['x-custom', 'authorization'],
        responseHeaders: ['set-cookie', 'x-request-*']
      })

      const response = yield* client.execute(syntheticRequest('/stream'))

      yield* response.stream.pipe(Stream.runDrain)

      const [exchange] = yield* recorder.drain

      expect(exchange?.request.headers).toEqual({ 'x-custom': 'dropped' })
      expect(exchange?.response.headers).toEqual({ 'x-request-id': 'synthetic-request' })
    })
  )

  it.effect('attributes a split multi-byte character to the chunk that completes it', () =>
    Effect.gen(function* () {
      const { client, recorder } = yield* makeRecordingHttpClient(fakeUpstream)
      const response = yield* client.execute(HttpClientRequest.post(`${base}/split`))

      yield* response.stream.pipe(Stream.runDrain)

      const [exchange] = yield* recorder.drain

      expect(exchange?.response).toMatchObject({ chunks: ['data: caf', 'é\n\n'] })
    })
  )

  it.effect('fails drain when a streamed body was not read to the end or the request failed', () =>
    Effect.gen(function* () {
      const { client, recorder } = yield* makeRecordingHttpClient(fakeUpstream)

      yield* client.execute(syntheticRequest('/stream'))

      const incomplete = yield* recorder.drain.pipe(Effect.flip)

      expect(incomplete._tag).toBe('WireRecordingIncomplete')
      expect(incomplete.requests).toEqual([`POST ${base}/stream`])

      const failing = yield* makeRecordingHttpClient(
        HttpClient.make(request =>
          Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({ request, description: 'offline' })
            })
          )
        )
      )

      yield* failing.client
        .execute(HttpClientRequest.get(`${base}/models?key=synthetic`))
        .pipe(Effect.flip)

      const failed = yield* failing.recorder.drain.pipe(Effect.flip)

      expect(failed.requests).toEqual([`GET ${base}/models`])
    })
  )

  it.effect('recorded exchanges replay to the same chunks', () =>
    Effect.gen(function* () {
      const { client, recorder } = yield* makeRecordingHttpClient(fakeUpstream)
      const live = yield* client.execute(syntheticRequest('/stream'))

      yield* live.stream.pipe(Stream.runDrain)

      const fixture = yield* makeWireFixture({
        id: 'example.recorded',
        caseId: 'example.recorded',
        evidence: 'verified',
        recordedAt: '2026-09-29',
        account: 'synthetic',
        endpoint: `${base}/stream`,
        exchanges: yield* recorder.drain
      })

      const decoder = new TextDecoder()

      const replayed = yield* Effect.gen(function* () {
        const replayClient = yield* HttpClient.HttpClient
        const response = yield* replayClient.execute(syntheticRequest('/stream'))

        return yield* response.stream.pipe(
          Stream.map(bytes => decoder.decode(bytes)),
          Stream.runCollect
        )
      }).pipe(Effect.provide(ReplayHttpClient.layer([fixture])))

      expect(replayed).toEqual(upstreamChunks)
    })
  )
})

describe('makeWireFixture', () => {
  const exchange: WireExchange = {
    request: { method: 'GET', url: `${base}/models` },
    response: { status: 200, headers: {}, body: '{"data":[]}' }
  }

  const input: WireFixtureInput = {
    id: 'example.models',
    caseId: 'example.models',
    evidence: 'unverified',
    recordedAt: '2026-09-29',
    account: 'synthetic',
    endpoint: `${base}/models`,
    exchanges: [exchange]
  }

  it.effect('returns a validated fixture when the scan is clean', () =>
    Effect.gen(function* () {
      const fixture = yield* makeWireFixture(input)

      expect(scanFixtureForSecrets(fixture)).toEqual([])
      expect(fixture.exchanges).toHaveLength(1)
    })
  )

  it.effect('fails with typed errors on secrets or invalid data', () =>
    Effect.gen(function* () {
      const secrets = yield* makeWireFixture({
        ...input,
        exchanges: [
          {
            ...exchange,
            request: { ...exchange.request, url: `${base}/models?api_key=synthetic` }
          }
        ]
      }).pipe(Effect.flip)

      expect(secrets._tag).toBe('WireFixtureSecretsFound')

      if (Predicate.isTagged(secrets, 'WireFixtureSecretsFound')) {
        expect(secrets.issues).toEqual([
          { kind: 'credential_query_param', location: 'exchanges[0].request.url' }
        ])
      }

      const empty = yield* makeWireFixture({ ...input, exchanges: [] }).pipe(Effect.flip)

      expect(empty._tag).toBe('WireFixtureInvalid')
    })
  )
})
