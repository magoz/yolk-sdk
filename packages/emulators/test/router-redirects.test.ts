/**
 * Regression: a redirect from a loopback emulator must never carry a request past the route
 * table. Two loopback servers: a routed emulator that answers 307 with `Location` pointing at a
 * second, unrouted loopback server, which must receive nothing. Loopback sockets only.
 */
import { ConfigProvider, Effect, Layer } from 'effect'
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest
} from 'effect/unstable/http'
import { describe, expect, it } from '@effect/vitest'
import { serveFetchHandler } from '../src/node.ts'
import { EmulatedHttpClient, EmulatorRoute } from '../src/router.ts'

const realOrigin = 'https://ai-gateway.vercel.sh'

const testEnv = ConfigProvider.layer(ConfigProvider.fromUnknown({ NODE_ENV: 'test' }))

/** A routed emulator that redirects everything to an unrouted loopback server that records hits. */
const redirectingServers = Effect.gen(function* () {
  const unroutedHits: Array<string> = []

  const unrouted = yield* serveFetchHandler(async request => {
    unroutedHits.push(`${request.method} ${new URL(request.url).pathname}`)
    await request.text()

    return new Response('unrouted')
  })

  const routed = yield* serveFetchHandler(async request => {
    await request.text()

    return new Response(null, {
      status: 307,
      headers: { location: `${unrouted.url}/escaped` }
    })
  })

  return { unroutedHits, unroutedUrl: unrouted.url, routedUrl: routed.url }
})

const emulatedClient = (routedUrl: string) =>
  HttpClient.HttpClient.pipe(
    Effect.provide(
      EmulatedHttpClient.layer([EmulatorRoute.url(realOrigin, routedUrl)]).pipe(
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(testEnv)
      )
    )
  )

const secretPost = HttpClientRequest.post(`${realOrigin}/v1/chat/completions`).pipe(
  HttpClientRequest.bearerToken('synthetic-credential'),
  HttpClientRequest.bodyText('{"model":"synthetic/model"}', 'application/json')
)

const expectNoRouteError = (error: unknown) => {
  if (!HttpClientError.isHttpClientError(error)) {
    throw new Error('expected an HttpClientError')
  }

  expect(error.reason._tag).toBe('TransportError')
  expect(error.message).toContain('no emulator route')
}

describe('EmulatedHttpClient redirects', () => {
  it.effect('control: native fetch alone follows the 307 to the unrouted server', () =>
    Effect.gen(function* () {
      const { unroutedHits, routedUrl } = yield* redirectingServers

      const client = yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer))

      const response = yield* client.execute(
        HttpClientRequest.post(`${routedUrl}/v1/chat/completions`).pipe(
          HttpClientRequest.bodyText('{}', 'application/json')
        )
      )

      expect(response.status).toBe(200)
      expect(unroutedHits).toEqual(['POST /escaped'])
    }).pipe(Effect.scoped)
  )

  it.effect('returns the 3xx to the caller and never follows it natively', () =>
    Effect.gen(function* () {
      const { unroutedHits, unroutedUrl, routedUrl } = yield* redirectingServers

      const client = yield* emulatedClient(routedUrl)

      // A host default of `redirect: 'follow'` is overridden for routed requests.
      const response = yield* client
        .execute(secretPost)
        .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: 'follow' }))

      expect(response.status).toBe(307)
      expect(response.headers.location).toBe(`${unroutedUrl}/escaped`)
      expect(unroutedHits).toEqual([])
    }).pipe(Effect.scoped)
  )

  it.effect(
    'keeps RequestInit defaults provided around the stack while forcing manual redirects',
    () =>
      Effect.gen(function* () {
        const seen: Array<string | null> = []

        const echo = yield* serveFetchHandler(async request => {
          seen.push(request.headers.get('x-synthetic-default'))
          await request.text()

          return new Response(null, {
            status: 307,
            headers: { location: 'https://api.example.test/x' }
          })
        })

        const client = yield* HttpClient.HttpClient.pipe(
          Effect.provide(
            EmulatedHttpClient.layer([EmulatorRoute.url(realOrigin, echo.url)]).pipe(
              Layer.provide(FetchHttpClient.layer),
              Layer.provide(testEnv),
              Layer.provide(
                Layer.succeed(FetchHttpClient.RequestInit, {
                  headers: { 'x-synthetic-default': 'kept' },
                  redirect: 'follow'
                })
              )
            )
          )
        )

        const response = yield* client.execute(secretPost)

        expect(response.status).toBe(307)
        expect(seen).toEqual(['kept'])
      }).pipe(Effect.scoped)
  )

  it.effect('fails closed when followRedirects on top follows the 307 to an unrouted origin', () =>
    Effect.gen(function* () {
      const { unroutedHits, routedUrl } = yield* redirectingServers

      const client = HttpClient.followRedirects(yield* emulatedClient(routedUrl))
      const error = yield* client.execute(secretPost).pipe(Effect.flip)

      expectNoRouteError(error)
      expect(unroutedHits).toEqual([])
    }).pipe(Effect.scoped)
  )

  it.effect('fails closed when a host mapRequest changes the URL to an unrouted origin', () =>
    Effect.gen(function* () {
      const { unroutedHits, unroutedUrl, routedUrl } = yield* redirectingServers

      const base = yield* emulatedClient(routedUrl)

      for (const target of [`${unroutedUrl}/mapped`, 'https://api.example.test/mapped']) {
        const client = HttpClient.mapRequest(base, HttpClientRequest.setUrl(target))
        const error = yield* client.execute(secretPost).pipe(Effect.flip)

        expectNoRouteError(error)
      }

      expect(unroutedHits).toEqual([])
    }).pipe(Effect.scoped)
  )
})
