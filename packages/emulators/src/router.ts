/**
 * Effect `HttpClient` routing to emulators.
 *
 * Hosts pick a transport by swapping `HttpClient` layers: `EmulatedHttpClient`
 * rewrites real origins to loopback emulator processes over the host's own
 * client, and `InProcessHttpClient` calls emulator fetch handlers directly.
 * Both fail closed on unknown origins and refuse to build when `NODE_ENV` is
 * `production`. The route check runs at the send step, so every request that
 * is actually sent (including redirect follow-ups and requests a host changes
 * with `HttpClient.mapRequest` on top) goes through the route table. Replay
 * lives in `@yolk-sdk/conformance/replay`; live traffic is the host's own
 * client.
 *
 * @experimental
 */
import { Config, Data, Effect, Layer, Match, Option, Predicate } from 'effect'
import {
  FetchHttpClient,
  Headers as HttpHeaders,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse
} from 'effect/unstable/http'

/** A fetch handler, such as the one returned by an emulator factory. */
export type EmulatorFetch = (request: Request) => Promise<Response>

/** A loopback emulator process (http or https on 127.0.0.0/8, `::1`, or `localhost`). */
export type EmulatorUrlTarget = {
  readonly kind: 'url'
  readonly baseUrl: string
}

/** An emulator fetch handler called in-process. */
export type EmulatorHandlerTarget = {
  readonly kind: 'handler'
  readonly fetch: EmulatorFetch
}

export type EmulatorTarget = EmulatorUrlTarget | EmulatorHandlerTarget

/**
 * Maps one real origin (for example `https://ai-gateway.vercel.sh`) to an
 * emulator target. Path and query of each request are kept.
 */
export type EmulatorRoute<T extends EmulatorTarget = EmulatorTarget> = {
  readonly origin: string
  readonly target: T
}

export const EmulatorRoute = {
  /** Route an origin to a loopback emulator process. */
  url: (origin: string, baseUrl: string): EmulatorRoute<EmulatorUrlTarget> => ({
    origin,
    target: { kind: 'url', baseUrl }
  }),
  /** Route an origin to an in-process emulator fetch handler. */
  handler: (origin: string, fetch: EmulatorFetch): EmulatorRoute<EmulatorHandlerTarget> => ({
    origin,
    target: { kind: 'handler', fetch }
  })
} as const

/** A route table that cannot be used: bad origin, duplicate origin, wrong target, or non-loopback base URL. */
export class EmulatorRouteInvalid extends Data.TaggedError('EmulatorRouteInvalid')<{
  readonly reason: string
}> {
  override get message(): string {
    return `Invalid emulator route: ${this.reason}`
  }
}

/** The router refused to build: `NODE_ENV` is `production`, or it could not be read. */
export class EmulatorEnvironmentRefused extends Data.TaggedError('EmulatorEnvironmentRefused')<{
  readonly reason: 'production' | 'unreadable'
}> {
  override get message(): string {
    return this.reason === 'production'
      ? 'Emulator routing refuses to run when NODE_ENV is production'
      : 'Emulator routing could not read NODE_ENV'
  }
}

export type EmulatorRouterError = EmulatorRouteInvalid | EmulatorEnvironmentRefused

/**
 * Fails when `NODE_ENV` is `production`. A missing `NODE_ENV` is allowed; an
 * unreadable one fails closed.
 */
const refuseProductionEnvironment: Effect.Effect<void, EmulatorEnvironmentRefused> = Effect.gen(
  function* () {
    const nodeEnv = yield* Config.option(Config.String('NODE_ENV'))

    return Option.getOrUndefined(nodeEnv)
  }
).pipe(
  Effect.mapError(() => new EmulatorEnvironmentRefused({ reason: 'unreadable' })),
  Effect.flatMap(nodeEnv =>
    nodeEnv?.trim().toLowerCase() === 'production'
      ? Effect.fail(new EmulatorEnvironmentRefused({ reason: 'production' }))
      : Effect.void
  )
)

const ipv4LoopbackPattern = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/

/**
 * True for `http:`/`https:` URLs whose host is loopback: `localhost`, `::1`,
 * or an IPv4 address in 127.0.0.0/8 (after WHATWG URL normalization).
 * IPv4-mapped IPv6 forms such as `[::ffff:127.0.0.1]` are rejected: the
 * allowlist stays minimal, and `127.0.0.1` says the same thing.
 */
const isLoopbackUrl = (input: string): boolean => {
  if (!URL.canParse(input)) {
    return false
  }

  const url = new URL(input)

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return false
  }

  const host = url.hostname.toLowerCase()

  return host === 'localhost' || host === '[::1]' || ipv4LoopbackPattern.test(host)
}

const validOrigin = (origin: string): string | EmulatorRouteInvalid => {
  if (!URL.canParse(origin)) {
    return new EmulatorRouteInvalid({ reason: 'a route origin is not an absolute URL' })
  }

  const url = new URL(origin)

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return new EmulatorRouteInvalid({ reason: `origin ${url.origin} must be http or https` })
  }

  if (
    url.username !== '' ||
    url.password !== '' ||
    (url.pathname !== '/' && url.pathname !== '') ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    return new EmulatorRouteInvalid({
      reason: `origin ${url.origin} must be a bare origin without credentials, path, query, or hash`
    })
  }

  return url.origin
}

const validBaseUrl = (origin: string, baseUrl: string): URL | EmulatorRouteInvalid => {
  if (!isLoopbackUrl(baseUrl)) {
    return new EmulatorRouteInvalid({
      reason: `the base URL for ${origin} must be http(s) on loopback (127.0.0.0/8, ::1, or localhost)`
    })
  }

  const url = new URL(baseUrl)

  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    return new EmulatorRouteInvalid({
      reason: `the base URL for ${origin} must not carry credentials, a query, or a hash`
    })
  }

  return url
}

type RouteTable<A> = ReadonlyMap<string, A>

const buildTable = <T extends EmulatorTarget, A>(
  routes: ReadonlyArray<EmulatorRoute<T>>,
  kind: T['kind'],
  resolve: (origin: string, target: T) => A | EmulatorRouteInvalid
): Effect.Effect<RouteTable<A>, EmulatorRouteInvalid> =>
  Effect.gen(function* () {
    const table = new Map<string, A>()

    for (const route of routes) {
      const origin = validOrigin(route.origin)

      if (origin instanceof EmulatorRouteInvalid) {
        return yield* Effect.fail(origin)
      }

      if (route.target.kind !== kind) {
        return yield* Effect.fail(
          new EmulatorRouteInvalid({ reason: `the route for ${origin} needs a ${kind} target` })
        )
      }

      if (table.has(origin)) {
        return yield* Effect.fail(
          new EmulatorRouteInvalid({ reason: `duplicate route for ${origin}` })
        )
      }

      const resolved = resolve(origin, route.target)

      if (resolved instanceof EmulatorRouteInvalid) {
        return yield* Effect.fail(resolved)
      }

      table.set(origin, resolved)
    }

    return table
  })

const requestOrigin = (url: string): string | undefined =>
  URL.canParse(url) ? new URL(url).origin : undefined

/**
 * Fail-closed error for a request whose origin has no route. The attached
 * request carries only the method and origin (no path, query, headers, or
 * body), so the message never leaks more than the origin.
 */
const unroutedOriginError = (
  request: HttpClientRequest.HttpClientRequest,
  origin: string | undefined
) => {
  const label = origin ?? 'unparseable-origin'

  return new HttpClientError.HttpClientError({
    reason: new HttpClientError.TransportError({
      request: HttpClientRequest.make(request.method)(origin ?? ''),
      description: `no emulator route for origin ${label}`
    })
  })
}

const joinPaths = (basePath: string, requestPath: string): string => {
  const prefix = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath

  return `${prefix}${requestPath.startsWith('/') ? requestPath : `/${requestPath}`}`
}

const rewriteToBase = (requestUrl: string, base: URL): string => {
  const source = new URL(requestUrl)
  const target = new URL(base.toString())

  target.pathname = joinPaths(base.pathname, source.pathname)
  target.search = source.search
  target.hash = source.hash

  return target.toString()
}

/**
 * Merge `RequestInit` values (later wins; `headers` are merged, not replaced).
 */
/** Name/value pairs of any `HeadersInit` shape (web `Headers`, pair list, or record). */
const requestInitHeaderPairs = (headers: HeadersInit): ReadonlyArray<readonly [string, string]> => {
  if (headers instanceof Headers) return [...headers.entries()]

  if (Array.isArray(headers)) {
    return headers.flatMap(pair => {
      const [name, value] = pair

      return name === undefined || value === undefined ? [] : [[name, value] as const]
    })
  }

  return Object.entries(headers)
}

const mergeRequestInit = (
  ...inits: ReadonlyArray<globalThis.RequestInit | undefined>
): globalThis.RequestInit => {
  const merged: globalThis.RequestInit = {}
  // Effect's `Headers.fromInput` never throws (unlike web `Headers`), so an invalid host default
  // surfaces from fetch as a typed transport error instead of a defect here.
  let headers = HttpHeaders.empty

  for (const init of inits) {
    if (init === undefined) continue

    Object.assign(merged, init)

    if (init.headers !== undefined) {
      headers = HttpHeaders.merge(
        headers,
        HttpHeaders.fromInput(requestInitHeaderPairs(init.headers))
      )
    }
  }

  return Object.keys(headers).length === 0 ? merged : { ...merged, headers: { ...headers } }
}

/**
 * Run `effect` with native fetch told not to follow redirects
 * (`redirect: 'manual'`). The `RequestInit` supplied here replaces the one the
 * underlying `FetchHttpClient` layer captured when it was built (Effect merges
 * the request-time context over the captured one), so the defaults visible
 * where the emulated layer is built and where the request runs are merged in
 * and only `redirect` is overridden. Only the `FetchHttpClient` transport reads
 * this service.
 */
const withManualRedirects =
  (buildInit: globalThis.RequestInit | undefined) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.flatMap(Effect.serviceOption(FetchHttpClient.RequestInit), init =>
      Effect.provideService(
        effect,
        FetchHttpClient.RequestInit,
        mergeRequestInit(buildInit, Option.getOrUndefined(init), { redirect: 'manual' })
      )
    )

export const EmulatedHttpClient = {
  /**
   * `HttpClient` that rewrites each routed origin to its loopback emulator
   * base URL (keeping path and query) and sends it through the host's real
   * `HttpClient` underneath. Requests to any other origin fail closed with an
   * `HttpClientError` that names only the origin.
   *
   * The check and rewrite run at the send step (the client's postprocess), so
   * redirect follow-ups (`HttpClient.followRedirects` on top) and requests
   * changed by a host's `HttpClient.mapRequest` are routed or refused too.
   * With `FetchHttpClient` underneath, requests are sent with
   * `redirect: 'manual'`: a 3xx from an emulator comes back to the caller as
   * a 3xx and native fetch never follows it. Other `RequestInit` defaults are
   * kept when they are provided where this layer is built or where the request
   * runs; defaults provided only to the underlying `FetchHttpClient.layer`
   * itself are replaced, so provide them around the whole client stack. Put
   * `HttpClient.followRedirects` on top of this layer, never underneath it: a
   * redirect loop below the route check sends follow-ups without it. Any
   * other underlying client must not follow redirects by itself, because a
   * redirect it follows internally never passes through the route table.
   *
   * Building fails with `EmulatorRouteInvalid` when a route is malformed,
   * duplicated, not a `url` target, or not on loopback, and with
   * `EmulatorEnvironmentRefused` when `NODE_ENV` is `production` or cannot be read.
   */
  layer: (
    routes: ReadonlyArray<EmulatorRoute<EmulatorUrlTarget>>
  ): Layer.Layer<HttpClient.HttpClient, EmulatorRouterError, HttpClient.HttpClient> =>
    Layer.effect(
      HttpClient.HttpClient,
      Effect.gen(function* () {
        yield* refuseProductionEnvironment

        const table = yield* buildTable(routes, 'url', (origin, target: EmulatorUrlTarget) =>
          validBaseUrl(origin, target.baseUrl)
        )

        const underlying = yield* HttpClient.HttpClient

        // `RequestInit` defaults visible where this layer is built (for example provided around the
        // whole client stack) are kept for routed requests.
        const manualRedirects = withManualRedirects(
          Option.getOrUndefined(yield* Effect.serviceOption(FetchHttpClient.RequestInit))
        )

        const route = (request: HttpClientRequest.HttpClientRequest) => {
          const origin = requestOrigin(request.url)
          const base = origin === undefined ? undefined : table.get(origin)

          return base === undefined
            ? Effect.fail(unroutedOriginError(request, origin))
            : Effect.succeed(HttpClientRequest.setUrl(request, rewriteToBase(request.url, base)))
        }

        // Route in postprocess, not preprocess: every request sent goes through postprocess, while
        // `followRedirects` skips preprocess for follow-ups and `mapRequest` runs after it.
        return HttpClient.makeWith(
          request => manualRedirects(underlying.postprocess(Effect.flatMap(request, route))),
          underlying.preprocess
        )
      })
    )
} as const

/** Error for a request body the in-process client cannot hand to a fetch handler. */
const unsupportedBodyError = (request: HttpClientRequest.HttpClientRequest, kind: string) =>
  new HttpClientError.HttpClientError({
    reason: new HttpClientError.EncodeError({
      request,
      description: `in-process emulators accept only Empty, Uint8Array, and string Raw bodies (got ${kind})`
    })
  })

const webRequestBody = (
  request: HttpClientRequest.HttpClientRequest
): Effect.Effect<BodyInit | undefined, HttpClientError.HttpClientError> => {
  const body = request.body

  return Match.value(body).pipe(
    Match.tagsExhaustive({
      Empty: () => Effect.succeed(undefined),
      // Copy into an ArrayBuffer-backed view, as `Request` requires.
      Uint8Array: ({ body: bytes }) => Effect.succeed<BodyInit>(new Uint8Array(bytes)),
      Raw: ({ body: raw }) =>
        Predicate.isString(raw)
          ? Effect.succeed<BodyInit>(raw)
          : Effect.fail(unsupportedBodyError(request, 'non-string Raw')),
      FormData: () => Effect.fail(unsupportedBodyError(request, 'FormData')),
      Stream: () => Effect.fail(unsupportedBodyError(request, 'Stream'))
    })
  )
}

const headerEntries = (headers: Readonly<Record<string, string>>): Array<[string, string]> =>
  Object.entries(headers)

export const InProcessHttpClient = {
  /**
   * `HttpClient` that turns each request to a routed origin into a web
   * `Request` (method, URL, headers, and an Empty, Uint8Array, or string Raw
   * body) and calls that route's fetch handler directly; the web `Response`
   * comes back through `HttpClientResponse.fromWeb`. Other body kinds fail
   * with an `HttpClientError` (`EncodeError`). Unknown origins fail closed
   * with an `HttpClientError` that names only the origin.
   *
   * Building fails with `EmulatorRouteInvalid` for malformed, duplicated, or
   * non-`handler` routes and with `EmulatorEnvironmentRefused` when
   * `NODE_ENV` is `production` or cannot be read.
   */
  layer: (
    routes: ReadonlyArray<EmulatorRoute<EmulatorHandlerTarget>>
  ): Layer.Layer<HttpClient.HttpClient, EmulatorRouterError> =>
    Layer.effect(
      HttpClient.HttpClient,
      Effect.gen(function* () {
        yield* refuseProductionEnvironment

        const table = yield* buildTable(
          routes,
          'handler',
          (_origin, target: EmulatorHandlerTarget) => target.fetch
        )

        return HttpClient.make((request, url, signal) =>
          Effect.gen(function* () {
            const handler = table.get(url.origin)

            if (handler === undefined) {
              return yield* Effect.fail(unroutedOriginError(request, url.origin))
            }

            const body = yield* webRequestBody(request)

            const webRequest = yield* Effect.try({
              try: () => {
                const init: RequestInit = {
                  method: request.method,
                  headers: headerEntries(request.headers),
                  signal
                }

                if (body !== undefined) {
                  init.body = body
                }

                return new Request(url.toString(), init)
              },
              catch: cause =>
                new HttpClientError.HttpClientError({
                  reason: new HttpClientError.EncodeError({
                    request,
                    cause,
                    description: 'could not build a web Request for the in-process emulator'
                  })
                })
            })

            const response = yield* Effect.tryPromise({
              try: () => handler(webRequest),
              catch: cause =>
                new HttpClientError.HttpClientError({
                  reason: new HttpClientError.TransportError({
                    request,
                    cause,
                    description: 'the in-process emulator handler failed'
                  })
                })
            })

            return HttpClientResponse.fromWeb(request, response)
          })
        )
      })
    )
} as const
