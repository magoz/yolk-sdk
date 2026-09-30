import { ConfigProvider, Effect, Exit, Layer, Stream } from 'effect'
import {
  HttpBody,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse
} from 'effect/unstable/http'
import { describe, expect, it } from '@effect/vitest'
import {
  EmulatedHttpClient,
  EmulatorEnvironmentRefused,
  EmulatorRoute,
  EmulatorRouteInvalid,
  InProcessHttpClient
} from '../src/router.ts'

const gatewayOrigin = 'https://ai-gateway.vercel.sh'

const envLayer = (env: Record<string, string>) =>
  ConfigProvider.layer(ConfigProvider.fromUnknown(env))

const testEnv = envLayer({ NODE_ENV: 'test' })

/** A config source that cannot be read at all (not merely missing NODE_ENV). */
const unreadableEnv = ConfigProvider.layer(
  ConfigProvider.make(() =>
    Effect.fail(new ConfigProvider.SourceError({ message: 'synthetic unreadable config source' }))
  )
)

/** Underlying "real" client that records every URL it is asked to send. */
const recordingClientLayer = (seen: Array<string>) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) =>
      Effect.sync(() => {
        seen.push(url.toString())

        return HttpClientResponse.fromWeb(request, new Response('underlying'))
      })
    )
  )

const emulated = (
  routes: ReadonlyArray<ReturnType<typeof EmulatorRoute.url>>,
  seen: Array<string>,
  env = testEnv
) =>
  EmulatedHttpClient.layer(routes).pipe(
    Layer.provide(recordingClientLayer(seen)),
    Layer.provide(env)
  )

const asHttpClientError = (error: unknown): HttpClientError.HttpClientError => {
  if (!HttpClientError.isHttpClientError(error)) {
    throw new Error('expected an HttpClientError')
  }

  return error
}

const execute = (request: HttpClientRequest.HttpClientRequest) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient

    return yield* client.execute(request)
  })

describe('EmulatedHttpClient', () => {
  it.effect('rewrites a routed origin to the loopback base URL, keeping path and query', () =>
    Effect.gen(function* () {
      const seen: Array<string> = []

      const response = yield* execute(
        HttpClientRequest.post(`${gatewayOrigin}/v1/chat/completions?b=2&a=1`).pipe(
          HttpClientRequest.setUrlParam('extra', 'x')
        )
      ).pipe(
        Effect.provide(emulated([EmulatorRoute.url(gatewayOrigin, 'http://127.0.0.1:4010')], seen))
      )

      expect(response.status).toBe(200)
      expect(seen).toEqual(['http://127.0.0.1:4010/v1/chat/completions?b=2&a=1&extra=x'])
    })
  )

  it.effect('prefixes the base URL path', () =>
    Effect.gen(function* () {
      const seen: Array<string> = []

      yield* execute(HttpClientRequest.get(`${gatewayOrigin}/v1/models`)).pipe(
        Effect.provide(
          emulated([EmulatorRoute.url(gatewayOrigin, 'http://localhost:4010/gateway/')], seen)
        )
      )

      expect(seen).toEqual(['http://localhost:4010/gateway/v1/models'])
    })
  )

  it.effect('fails closed on unknown origins with an error naming only the origin', () =>
    Effect.gen(function* () {
      const seen: Array<string> = []

      const error = yield* execute(
        HttpClientRequest.post('https://api.example.test/v1/secret-path?token=abc').pipe(
          HttpClientRequest.bearerToken('synthetic-credential')
        )
      ).pipe(
        Effect.provide(emulated([EmulatorRoute.url(gatewayOrigin, 'http://127.0.0.1:4010')], seen)),
        Effect.flip
      )

      const httpError = asHttpClientError(error)

      expect(seen).toEqual([])
      expect(httpError.reason._tag).toBe('TransportError')
      expect(httpError.message).toContain('https://api.example.test')
      expect(httpError.message).not.toContain('secret-path')
      expect(httpError.message).not.toContain('token')
      expect(httpError.message).not.toContain('synthetic-credential')
    })
  )

  it.effect('accepts every loopback form and rejects non-loopback base URLs at build time', () =>
    Effect.gen(function* () {
      for (const baseUrl of [
        'http://127.0.0.1:1',
        'http://127.10.20.30:1',
        'https://localhost',
        'http://LOCALHOST:8080',
        'http://[::1]:9'
      ]) {
        const exit = yield* Layer.build(
          emulated([EmulatorRoute.url(gatewayOrigin, baseUrl)], [])
        ).pipe(Effect.scoped, Effect.exit)

        expect(Exit.isSuccess(exit), baseUrl).toBe(true)
      }

      for (const baseUrl of [
        'http://10.0.0.1:1',
        'http://192.168.1.10',
        'http://api.example.test',
        'http://127.0.0.1.example.test',
        'http://localhost.evil.test',
        // IPv4-mapped IPv6 loopback is rejected on purpose; only `::1` is accepted for IPv6.
        'http://[::ffff:127.0.0.1]:1',
        'ftp://127.0.0.1',
        'http://[::2]',
        'http://user:pass@127.0.0.1',
        'not a url'
      ]) {
        const error = yield* Layer.build(
          emulated([EmulatorRoute.url(gatewayOrigin, baseUrl)], [])
        ).pipe(Effect.scoped, Effect.flip)

        expect(error, baseUrl).toBeInstanceOf(EmulatorRouteInvalid)
      }
    })
  )

  it.effect('rejects malformed origins and duplicate origins', () =>
    Effect.gen(function* () {
      const base = 'http://127.0.0.1:1'

      for (const routes of [
        [EmulatorRoute.url('ai-gateway.vercel.sh', base)],
        [EmulatorRoute.url(`${gatewayOrigin}/v1`, base)],
        [EmulatorRoute.url('ftp://ai-gateway.vercel.sh', base)],
        [EmulatorRoute.url(gatewayOrigin, base), EmulatorRoute.url(`${gatewayOrigin}/`, base)]
      ]) {
        const error = yield* Layer.build(emulated(routes, [])).pipe(Effect.scoped, Effect.flip)

        expect(error).toBeInstanceOf(EmulatorRouteInvalid)
      }
    })
  )

  it.effect('refuses to build when NODE_ENV is production and allows it missing', () =>
    Effect.gen(function* () {
      const routes = [EmulatorRoute.url(gatewayOrigin, 'http://127.0.0.1:1')]

      for (const value of ['production', ' Production ']) {
        const error = yield* Layer.build(emulated(routes, [], envLayer({ NODE_ENV: value }))).pipe(
          Effect.scoped,
          Effect.flip
        )

        expect(error).toBeInstanceOf(EmulatorEnvironmentRefused)
        expect(error.message).toContain('production')
      }

      for (const env of [envLayer({}), envLayer({ NODE_ENV: 'development' })]) {
        const exit = yield* Layer.build(emulated(routes, [], env)).pipe(Effect.scoped, Effect.exit)

        expect(Exit.isSuccess(exit)).toBe(true)
      }
    })
  )

  it.effect('refuses to build when NODE_ENV cannot be read', () =>
    Effect.gen(function* () {
      const routes = [EmulatorRoute.url(gatewayOrigin, 'http://127.0.0.1:1')]

      const error = yield* Layer.build(emulated(routes, [], unreadableEnv)).pipe(
        Effect.scoped,
        Effect.flip
      )

      expect(error).toBeInstanceOf(EmulatorEnvironmentRefused)
      expect(error).toMatchObject({ reason: 'unreadable' })
    })
  )
})

describe('route target kinds', () => {
  const handler = () => Promise.resolve(new Response())

  it.effect('EmulatedHttpClient rejects a handler target with EmulatorRouteInvalid', () =>
    Effect.gen(function* () {
      const error = yield* Layer.build(
        EmulatedHttpClient.layer([
          // @ts-expect-error A handler target is not accepted by the Emulated layer.
          EmulatorRoute.handler(gatewayOrigin, handler)
        ]).pipe(Layer.provide(recordingClientLayer([])), Layer.provide(testEnv))
      ).pipe(Effect.scoped, Effect.flip)

      expect(error).toBeInstanceOf(EmulatorRouteInvalid)
      expect(error.message).toContain('needs a url target')
    })
  )

  it.effect('InProcessHttpClient rejects a url target with EmulatorRouteInvalid', () =>
    Effect.gen(function* () {
      const error = yield* Layer.build(
        InProcessHttpClient.layer([
          // @ts-expect-error A url target is not accepted by the InProcess layer.
          EmulatorRoute.url(gatewayOrigin, 'http://127.0.0.1:1')
        ]).pipe(Layer.provide(testEnv))
      ).pipe(Effect.scoped, Effect.flip)

      expect(error).toBeInstanceOf(EmulatorRouteInvalid)
      expect(error.message).toContain('needs a handler target')
    })
  )
})

type SeenRequest = {
  readonly method: string
  readonly url: string
  readonly headers: Record<string, string>
  readonly body: string
}

const echoHandler = (seen: Array<SeenRequest>) => async (request: Request) => {
  seen.push({
    method: request.method,
    url: request.url,
    headers: Object.fromEntries(request.headers.entries()),
    body: await request.text()
  })

  return new Response('{"ok":true}', {
    status: 201,
    headers: { 'content-type': 'application/json', 'x-emulator': 'yes' }
  })
}

const inProcess = (seen: Array<SeenRequest>, env = testEnv) =>
  InProcessHttpClient.layer([EmulatorRoute.handler(gatewayOrigin, echoHandler(seen))]).pipe(
    Layer.provide(env)
  )

describe('InProcessHttpClient', () => {
  it.effect(
    'builds a web Request (method, URL, headers, Uint8Array body) and returns fromWeb',
    () =>
      Effect.gen(function* () {
        const seen: Array<SeenRequest> = []

        const response = yield* execute(
          HttpClientRequest.post(`${gatewayOrigin}/v1/chat/completions?a=1`).pipe(
            HttpClientRequest.setHeader('x-probe', 'value'),
            HttpClientRequest.bodyText('{"model":"m"}', 'application/json')
          )
        ).pipe(Effect.provide(inProcess(seen)))

        expect(response.status).toBe(201)
        expect(response.headers['x-emulator']).toBe('yes')
        expect(yield* response.json).toEqual({ ok: true })
        expect(seen).toEqual([
          {
            method: 'POST',
            url: `${gatewayOrigin}/v1/chat/completions?a=1`,
            headers: expect.objectContaining({
              'content-type': 'application/json',
              'x-probe': 'value'
            }),
            body: '{"model":"m"}'
          }
        ])
      })
  )

  it.effect('passes Empty and string Raw bodies', () =>
    Effect.gen(function* () {
      const seen: Array<SeenRequest> = []

      yield* execute(HttpClientRequest.get(`${gatewayOrigin}/v1/models`)).pipe(
        Effect.provide(inProcess(seen))
      )
      yield* execute(
        HttpClientRequest.put(`${gatewayOrigin}/v1/raw`).pipe(
          HttpClientRequest.setBody(HttpBody.raw('raw text', { contentType: 'text/plain' }))
        )
      ).pipe(Effect.provide(inProcess(seen)))

      expect(seen.map(entry => [entry.method, entry.body])).toEqual([
        ['GET', ''],
        ['PUT', 'raw text']
      ])
    })
  )

  it.effect('fails other body kinds with a typed EncodeError without calling the handler', () =>
    Effect.gen(function* () {
      const seen: Array<SeenRequest> = []

      for (const request of [
        HttpClientRequest.post(`${gatewayOrigin}/v1/stream`).pipe(
          HttpClientRequest.bodyStream(Stream.make(new TextEncoder().encode('x')))
        ),
        HttpClientRequest.post(`${gatewayOrigin}/v1/form`).pipe(
          HttpClientRequest.bodyFormData(new FormData())
        )
      ]) {
        const error = yield* execute(request).pipe(Effect.provide(inProcess(seen)), Effect.flip)

        expect(asHttpClientError(error).reason._tag).toBe('EncodeError')
      }

      expect(seen).toEqual([])
    })
  )

  it.effect('fails closed on unknown origins, naming only the origin', () =>
    Effect.gen(function* () {
      const seen: Array<SeenRequest> = []

      const error = yield* execute(
        HttpClientRequest.get('http://api.example.test/private?q=1')
      ).pipe(Effect.provide(inProcess(seen)), Effect.flip)

      expect(seen).toEqual([])
      expect(asHttpClientError(error).reason._tag).toBe('TransportError')
      expect(error.message).toContain('http://api.example.test')
      expect(error.message).not.toContain('private')
    })
  )

  it.effect('reports a rejecting handler as a TransportError', () =>
    Effect.gen(function* () {
      const error = yield* execute(HttpClientRequest.get(`${gatewayOrigin}/v1/models`)).pipe(
        Effect.provide(
          InProcessHttpClient.layer([
            EmulatorRoute.handler(gatewayOrigin, () => Promise.reject(new Error('boom')))
          ]).pipe(Layer.provide(testEnv))
        ),
        Effect.flip
      )

      expect(asHttpClientError(error).reason._tag).toBe('TransportError')
    })
  )

  it.effect(
    'refuses production or unreadable NODE_ENV, and rejects duplicate or malformed origins',
    () =>
      Effect.gen(function* () {
        const refused = yield* Layer.build(
          inProcess([], envLayer({ NODE_ENV: 'production' }))
        ).pipe(Effect.scoped, Effect.flip)

        expect(refused).toBeInstanceOf(EmulatorEnvironmentRefused)

        const unreadable = yield* Layer.build(inProcess([], unreadableEnv)).pipe(
          Effect.scoped,
          Effect.flip
        )

        expect(unreadable).toMatchObject({
          _tag: 'EmulatorEnvironmentRefused',
          reason: 'unreadable'
        })

        const handler = () => Promise.resolve(new Response())

        for (const routes of [
          [
            { origin: gatewayOrigin, target: { kind: 'handler' as const, fetch: handler } },
            EmulatorRoute.handler(gatewayOrigin, handler)
          ],
          [EmulatorRoute.handler('not an origin', handler)]
        ]) {
          const error = yield* Layer.build(
            InProcessHttpClient.layer(routes).pipe(Layer.provide(testEnv))
          ).pipe(Effect.scoped, Effect.flip)

          expect(error).toBeInstanceOf(EmulatorRouteInvalid)
        }
      })
  )
})
