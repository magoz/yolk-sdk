import { Effect, Encoding, Layer, Predicate, Stream } from 'effect'
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

// A multi-byte character ("é" = 0xC3 0xA9) split across network chunks.
const splitSource = encoder.encode('data: café\n\n')

const splitChunks = [splitSource.slice(0, 10), splitSource.slice(10)]

const emptyChunkStream = [
  encoder.encode('data: {"text":"a"}\n\n'),
  new Uint8Array(),
  encoder.encode('data: [DONE]\n\n')
]

// Not valid UTF-8: a PDF-like header followed by raw high bytes.
const binaryDocument = new Uint8Array([
  ...encoder.encode('%PDF-1.7\n'),
  0xff,
  0xfe,
  0x00,
  0x80,
  0xc3
])

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
      return HttpClientResponse.fromWeb(
        request,
        new Response(chunkedBody(splitChunks), { headers: { 'content-type': 'text/event-stream' } })
      )
    }

    if (request.url.endsWith('/empty')) {
      return HttpClientResponse.fromWeb(
        request,
        new Response(chunkedBody(emptyChunkStream), {
          headers: { 'content-type': 'text/event-stream' }
        })
      )
    }

    if (request.url.endsWith('/document')) {
      return HttpClientResponse.fromWeb(
        request,
        new Response(binaryDocument, { headers: { 'content-type': 'application/pdf' } })
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

const collectBytes = (response: HttpClientResponse.HttpClientResponse) =>
  response.stream.pipe(
    Stream.map(bytes => Array.from(bytes)),
    Stream.runCollect,
    Effect.map(chunks => Array.from(chunks))
  )

// Record a streamed POST through the fake upstream, then replay it: returns the
// recorded exchange, the bytes the live caller received, and the replayed bytes.
const recordAndReplayChunks = (path: string) =>
  Effect.gen(function* () {
    const { client, recorder } = yield* makeRecordingHttpClient(fakeUpstream)

    const received = yield* collectBytes(
      yield* client.execute(HttpClientRequest.post(`${base}${path}`))
    )

    const [recorded] = yield* recorder.drain

    if (recorded === undefined) {
      return expect.fail('no exchange recorded')
    }

    const fixture = yield* makeWireFixture({
      id: 'example.bytes',
      caseId: 'example.bytes',
      evidence: 'verified',
      recordedAt: '2026-09-29',
      account: 'synthetic',
      endpoint: `${base}${path}`,
      exchanges: [recorded]
    })

    const replayed = yield* Effect.gen(function* () {
      const replayClient = yield* HttpClient.HttpClient

      return yield* collectBytes(
        yield* replayClient.execute(HttpClientRequest.post(`${base}${path}`))
      )
    }).pipe(Effect.provide(ReplayHttpClient.layer([fixture])))

    return { recorded, received, replayed }
  })

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
        requestHeaders: ['x-custom', 'authorization', 'x-figma-token', 'private-token', 'x-*'],
        responseHeaders: ['set-cookie', 'x-request-*']
      })

      const response = yield* client.execute(
        syntheticRequest('/stream').pipe(
          HttpClientRequest.setHeaders({
            'x-figma-token': 'synthetic-figma',
            'private-token': 'synthetic-private',
            'x-auth-token': 'synthetic-auth',
            'x-service-key': 'synthetic-service'
          })
        )
      )

      yield* response.stream.pipe(Stream.runDrain)

      const [exchange] = yield* recorder.drain

      expect(exchange?.request.headers).toEqual({ 'x-custom': 'dropped' })
      expect(exchange?.response.headers).toEqual({ 'x-request-id': 'synthetic-request' })
    })
  )

  it.effect('replays a multi-byte character split across chunks byte for byte', () =>
    Effect.gen(function* () {
      const { recorded, received, replayed } = yield* recordAndReplayChunks('/split')

      expect(recorded.response).toEqual({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        chunks: [
          { base64: Encoding.encodeBase64(splitChunks[0] ?? new Uint8Array()) },
          { base64: Encoding.encodeBase64(splitChunks[1] ?? new Uint8Array()) }
        ]
      })
      expect(received).toEqual(splitChunks.map(bytes => Array.from(bytes)))
      expect(replayed).toEqual(received)
    })
  )

  it.effect('preserves an empty chunk as "" and replays it as an empty Uint8Array', () =>
    Effect.gen(function* () {
      const { recorded, received, replayed } = yield* recordAndReplayChunks('/empty')

      expect(recorded.response).toMatchObject({
        chunks: ['data: {"text":"a"}\n\n', '', 'data: [DONE]\n\n']
      })
      expect(received).toEqual(emptyChunkStream.map(bytes => Array.from(bytes)))
      expect(replayed).toEqual(received)
    })
  )

  it.effect('records a non-UTF-8 whole body as bodyBase64 and replays the exact bytes', () =>
    Effect.gen(function* () {
      const { client, recorder } = yield* makeRecordingHttpClient(fakeUpstream)
      const live = yield* client.execute(HttpClientRequest.get(`${base}/document`))

      expect(Array.from(new Uint8Array(yield* live.arrayBuffer))).toEqual(
        Array.from(binaryDocument)
      )

      const [recorded] = yield* recorder.drain

      expect(recorded?.response).toEqual({
        status: 200,
        headers: { 'content-type': 'application/pdf' },
        bodyBase64: Encoding.encodeBase64(binaryDocument)
      })

      const fixture = yield* makeWireFixture({
        id: 'example.document',
        caseId: 'example.document',
        evidence: 'verified',
        recordedAt: '2026-09-29',
        account: 'synthetic',
        endpoint: `${base}/document`,
        exchanges: recorded === undefined ? [] : [recorded]
      })

      const replayed = yield* Effect.gen(function* () {
        const replayClient = yield* HttpClient.HttpClient
        const response = yield* replayClient.execute(HttpClientRequest.get(`${base}/document`))

        return new Uint8Array(yield* response.arrayBuffer)
      }).pipe(Effect.provide(ReplayHttpClient.layer([fixture])))

      expect(Array.from(replayed)).toEqual(Array.from(binaryDocument))
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

  it.effect('a request pending across a drain never settles an entry reserved after it', () =>
    Effect.gen(function* () {
      const { client, recorder } = yield* makeRecordingHttpClient(fakeUpstream)

      // Reserve streamed A, then drain while A is still unread.
      const first = yield* client.execute(syntheticRequest('/stream'))
      const firstDrain = yield* recorder.drain.pipe(Effect.flip)

      expect(firstDrain.requests).toEqual([`POST ${base}/stream`])

      // Reserve B (left unread), then finish reading A.
      const second = yield* client.execute(HttpClientRequest.post(`${base}/split`))

      yield* first.stream.pipe(Stream.runDrain)

      // A was dropped by the first drain: it must not replace B, and B is still unread.
      const secondDrain = yield* recorder.drain.pipe(Effect.flip)

      expect(secondDrain.requests).toEqual([`POST ${base}/split`])

      yield* second.stream.pipe(Stream.runDrain)

      expect(yield* recorder.drain).toEqual([])
    })
  )

  it.effect('a later drain holds only exchanges reserved after the previous drain', () =>
    Effect.gen(function* () {
      const { client, recorder } = yield* makeRecordingHttpClient(fakeUpstream)
      const first = yield* client.execute(syntheticRequest('/stream'))

      yield* recorder.drain.pipe(Effect.flip)

      const second = yield* client.execute(HttpClientRequest.post(`${base}/split`))

      yield* first.stream.pipe(Stream.runDrain)
      yield* second.stream.pipe(Stream.runDrain)

      const exchanges = yield* recorder.drain

      expect(exchanges.map(exchange => exchange.request.url)).toEqual([`${base}/split`])
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
