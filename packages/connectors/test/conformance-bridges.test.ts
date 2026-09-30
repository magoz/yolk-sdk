import { describe, expect, it } from '@effect/vitest'
import { Context, Effect, Layer, Option, Predicate } from 'effect'
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientResponse,
  type HttpClientRequest
} from 'effect/unstable/http'
import {
  ApiKeyCredential,
  ConnectorBinaryHttpClient,
  ConnectorBinaryWriteHttpClient,
  ConnectorHttpClient,
  ConnectorHttpRequest,
  CredentialResolver,
  CredentialSlot,
  OAuthCredential,
  makeCredentialBinding,
  makeIntegration,
  type ConnectorBinaryHttpRequest,
  type ConnectorBinaryUploadSessionRequest,
  type ConnectorBinaryWriteHttpRequest,
  type CredentialResolveRequest
} from '@yolk-sdk/connectors'
import {
  connectorBinaryHttpClientFromEffectHttpClientLayer,
  connectorBinaryWriteHttpClientFromEffectHttpClientLayer,
  connectorHttpClientFromEffectHttpClientLayer,
  connectorHttpClientsFromEffectHttpClientLayer,
  staticCredentialResolverLayer
} from '@yolk-sdk/connectors/conformance'

const secretUrl = 'https://api.example.test/v1/items/7?token=synthetic-query-secret'

type Seen = {
  readonly request: HttpClientRequest.HttpClientRequest
  readonly url: string
  readonly requestInit: globalThis.RequestInit | undefined
}

const fakeHttpClient = (seen: Array<Seen>, respond: () => Response) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url, _signal, fiber) => {
      seen.push({
        request,
        url: url.toString(),
        requestInit: Context.getOrUndefined(fiber.context, FetchHttpClient.RequestInit)
      })

      return Effect.succeed(HttpClientResponse.fromWeb(request, respond()))
    })
  )

const failingHttpClient = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make(request =>
    Effect.fail(
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({
          request,
          description: `connection reset while calling ${secretUrl} with Bearer synthetic-secret`
        })
      })
    )
  )
)

const sendText = (request: ConnectorHttpRequest) =>
  Effect.gen(function* () {
    const http = yield* ConnectorHttpClient

    return yield* http.request(request)
  })

const sendBytes = (request: ConnectorBinaryHttpRequest) =>
  Effect.gen(function* () {
    const http = yield* ConnectorBinaryHttpClient

    return yield* http.request(request)
  })

const resolveWith = (request: CredentialResolveRequest) =>
  Effect.gen(function* () {
    const resolver = yield* CredentialResolver

    return yield* resolver.resolve(request)
  })

const bodyText = (request: HttpClientRequest.HttpClientRequest): string | undefined => {
  const body = request.body

  return Predicate.isTagged(body, 'Uint8Array') ? new TextDecoder().decode(body.body) : undefined
}

describe('connectorHttpClientFromEffectHttpClientLayer', () => {
  it.effect('round-trips method, URL, headers, body, and response status/headers/body', () =>
    Effect.gen(function* () {
      const seen: Array<Seen> = []

      const layer = connectorHttpClientFromEffectHttpClientLayer.pipe(
        Layer.provide(
          fakeHttpClient(
            seen,
            () =>
              new Response('{"ok":true}', {
                status: 201,
                headers: { 'content-type': 'application/json', 'x-rate-limit-remaining': '3' }
              })
          )
        )
      )

      const response = yield* Effect.gen(function* () {
        const http = yield* ConnectorHttpClient

        return yield* http.request(
          ConnectorHttpRequest.make({
            method: 'PUT',
            url: 'https://api.example.test/v1/items/7',
            headers: {
              authorization: 'Bearer synthetic-token',
              accept: 'application/json',
              'content-type': 'application/json'
            },
            body: '{"name":"Example AB"}',
            redirect: 'manual',
            credentials: 'omit'
          })
        )
      }).pipe(Effect.provide(layer))

      expect(response).toMatchObject({
        status: 201,
        headers: { 'content-type': 'application/json', 'x-rate-limit-remaining': '3' },
        body: '{"ok":true}'
      })

      expect(seen).toHaveLength(1)
      const [request] = seen

      expect(request?.request.method).toBe('PUT')
      expect(request?.url).toBe('https://api.example.test/v1/items/7')
      expect(request?.request.headers).toEqual({
        authorization: 'Bearer synthetic-token',
        accept: 'application/json',
        'content-type': 'application/json',
        'content-length': '21'
      })
      expect(request && bodyText(request.request)).toBe('{"name":"Example AB"}')
      expect(request?.requestInit).toEqual({ redirect: 'manual', credentials: 'omit' })
    })
  )

  it.effect('sends no body or fetch options the request did not ask for', () =>
    Effect.gen(function* () {
      const seen: Array<Seen> = []

      const layer = connectorHttpClientFromEffectHttpClientLayer.pipe(
        Layer.provide(fakeHttpClient(seen, () => new Response('', { status: 404 })))
      )

      const response = yield* sendText(
        ConnectorHttpRequest.make({ method: 'GET', url: 'https://api.example.test/v1/items' })
      ).pipe(Effect.provide(layer))

      expect(response).toMatchObject({ status: 404, body: '' })
      expect(seen[0]?.request.body._tag).toBe('Empty')
      expect(seen[0]?.request.headers).toEqual({})
      expect(seen[0]?.requestInit).toEqual({})
    })
  )

  it.effect('passes redirect and credentials to fetch through FetchHttpClient', () =>
    Effect.gen(function* () {
      const inits: Array<globalThis.RequestInit | undefined> = []

      const fakeFetch: typeof globalThis.fetch = (_input, init) => {
        inits.push(init)

        return Promise.resolve(new Response('done', { status: 200 }))
      }

      const response = yield* sendText(
        ConnectorHttpRequest.make({
          method: 'POST',
          url: 'https://api.example.test/v1/items',
          headers: { 'content-type': 'application/json' },
          body: '{}',
          redirect: 'manual',
          credentials: 'omit'
        })
      ).pipe(
        Effect.provide(
          connectorHttpClientFromEffectHttpClientLayer.pipe(Layer.provide(FetchHttpClient.layer))
        ),
        Effect.provideService(FetchHttpClient.Fetch, fakeFetch)
      )

      expect(response.body).toBe('done')
      expect(inits[0]).toMatchObject({ method: 'POST', redirect: 'manual', credentials: 'omit' })
    })
  )

  it.effect('maps transport failures to transport_failed without URL, headers, or cause', () =>
    Effect.gen(function* () {
      const error = yield* sendText(
        ConnectorHttpRequest.make({
          method: 'GET',
          url: secretUrl,
          headers: { authorization: 'Bearer synthetic-secret' }
        })
      ).pipe(
        Effect.provide(
          connectorHttpClientFromEffectHttpClientLayer.pipe(Layer.provide(failingHttpClient))
        ),
        Effect.flip
      )

      expect(error).toMatchObject({ _tag: 'ConnectorError', cause: 'transport_failed' })
      expect(error.underlying).toBeUndefined()

      const serialized = `${error.message} ${JSON.stringify(error)}`

      expect(serialized).not.toContain('api.example.test')
      expect(serialized).not.toContain('synthetic-secret')
      expect(serialized).not.toContain('synthetic-query-secret')
    })
  )
})

const binaryRequest = (overrides: {
  readonly maxBytes: number
  readonly maxErrorBodyBytes: number
}) => ({
  method: 'GET' as const,
  url: 'https://files.example.test/v1/file.pdf',
  headers: { authorization: 'Bearer synthetic-token' },
  redirect: 'manual' as const,
  credentials: 'omit' as const,
  ...overrides
})

const binaryLayer = (status: number, bytes: Uint8Array<ArrayBuffer>, seen: Array<Seen> = []) =>
  connectorBinaryHttpClientFromEffectHttpClientLayer.pipe(
    Layer.provide(
      fakeHttpClient(
        seen,
        () => new Response(bytes, { status, headers: { 'content-type': 'application/pdf' } })
      )
    )
  )

const tenBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0, 128, 255, 10, 13])

describe('connectorBinaryHttpClientFromEffectHttpClientLayer', () => {
  it.effect('returns complete bytes for HTTP 200 within maxBytes with fetch semantics', () =>
    Effect.gen(function* () {
      const seen: Array<Seen> = []

      const response = yield* sendBytes(binaryRequest({ maxBytes: 10, maxErrorBodyBytes: 4 })).pipe(
        Effect.provide(binaryLayer(200, tenBytes, seen))
      )

      expect(response.status).toBe(200)
      expect(response.bodyComplete).toBe(true)
      expect(Array.from(response.bytes)).toEqual(Array.from(tenBytes))
      expect(response.headers).toMatchObject({ 'content-type': 'application/pdf' })
      expect(seen[0]?.request.method).toBe('GET')
      expect(seen[0]?.request.headers).toEqual({ authorization: 'Bearer synthetic-token' })
      expect(seen[0]?.requestInit).toEqual({ redirect: 'manual', credentials: 'omit' })
    })
  )

  it.effect('fails an oversize HTTP 200 with response_too_large instead of truncating', () =>
    Effect.gen(function* () {
      const error = yield* sendBytes(binaryRequest({ maxBytes: 9, maxErrorBodyBytes: 64 })).pipe(
        Effect.provide(binaryLayer(200, tenBytes)),
        Effect.flip
      )

      expect(error).toMatchObject({ _tag: 'ConnectorBinaryHttpError', code: 'response_too_large' })
    })
  )

  it.effect('truncates non-200 bodies at maxErrorBodyBytes with bodyComplete false', () =>
    Effect.gen(function* () {
      const truncated = yield* sendBytes(binaryRequest({ maxBytes: 1, maxErrorBodyBytes: 4 })).pipe(
        Effect.provide(binaryLayer(404, tenBytes))
      )

      expect(truncated.status).toBe(404)
      expect(truncated.bodyComplete).toBe(false)
      expect(Array.from(truncated.bytes)).toEqual([0x25, 0x50, 0x44, 0x46])

      const complete = yield* sendBytes(binaryRequest({ maxBytes: 1, maxErrorBodyBytes: 10 })).pipe(
        Effect.provide(binaryLayer(500, tenBytes))
      )

      expect(complete.bodyComplete).toBe(true)
      expect(complete.bytes.byteLength).toBe(10)
    })
  )

  it.effect('maps transport failures and invalid limits to transport_failed', () =>
    Effect.gen(function* () {
      const failed = yield* sendBytes({
        ...binaryRequest({ maxBytes: 10, maxErrorBodyBytes: 4 }),
        url: secretUrl
      }).pipe(
        Effect.provide(
          connectorBinaryHttpClientFromEffectHttpClientLayer.pipe(Layer.provide(failingHttpClient))
        ),
        Effect.flip
      )

      expect(failed).toMatchObject({ _tag: 'ConnectorBinaryHttpError', code: 'transport_failed' })
      expect(JSON.stringify(failed)).not.toContain('api.example.test')

      const seen: Array<Seen> = []

      const invalid = yield* sendBytes(binaryRequest({ maxBytes: -1, maxErrorBodyBytes: 4 })).pipe(
        Effect.provide(binaryLayer(200, tenBytes, seen)),
        Effect.flip
      )

      expect(invalid.code).toBe('transport_failed')
      expect(seen).toHaveLength(0)
    })
  )
})

const writeRequest = (
  overrides: Partial<ConnectorBinaryWriteHttpRequest> = {}
): ConnectorBinaryWriteHttpRequest => ({
  method: 'PUT',
  url: 'https://files.example.test/v1/upload/file.bin',
  headers: { authorization: 'Bearer synthetic-token', 'content-type': 'application/octet-stream' },
  bytes: tenBytes,
  redirect: 'manual',
  credentials: 'omit',
  maxUploadBytes: 10,
  successStatuses: [200, 201],
  maxBytes: 64,
  maxErrorBodyBytes: 4,
  ...overrides
})

/** A pre-authenticated session URL is a secret capability: errors must never carry it. */
const sessionUrl =
  "https://outlook.office.com/api/v2.0/Users('00000000-0000-4000-8000-000000000001')/Messages('synthetic')/AttachmentSessions('synthetic')?authtoken=synthetic-session-secret"

const sessionRequest = (
  overrides: Partial<ConnectorBinaryUploadSessionRequest> = {}
): ConnectorBinaryUploadSessionRequest => ({
  method: 'PUT',
  url: sessionUrl,
  headers: { 'content-range': 'bytes 0-9/20', 'content-type': 'application/octet-stream' },
  bytes: tenBytes,
  redirect: 'manual',
  credentials: 'omit',
  maxUploadBytes: 10,
  successStatuses: [200, 201],
  maxBytes: 64,
  maxErrorBodyBytes: 4,
  ...overrides
})

/** A write request whose `key` holds a value its static type forbids (hosts may pass anything). */
const withRuntimeValue = (key: string, value: unknown): ConnectorBinaryWriteHttpRequest => {
  const request = writeRequest()

  Reflect.set(request, key, value)

  return request
}

const writeLayer = (respond: () => Response, seen: Array<Seen> = []) =>
  connectorBinaryWriteHttpClientFromEffectHttpClientLayer.pipe(
    Layer.provide(fakeHttpClient(seen, respond))
  )

const sendWrite = (request: ConnectorBinaryWriteHttpRequest) =>
  Effect.gen(function* () {
    const http = yield* ConnectorBinaryWriteHttpClient

    return yield* http.request(request)
  })

const sendSession = (request: ConnectorBinaryUploadSessionRequest) =>
  Effect.gen(function* () {
    const http = yield* ConnectorBinaryWriteHttpClient

    if (http.uploadSession === undefined) {
      return expect.fail('expected the bridge to provide uploadSession')
    }

    return yield* http.uploadSession(request)
  })

const requestBytes = (request: HttpClientRequest.HttpClientRequest): Array<number> | undefined => {
  const body = request.body

  return Predicate.isTagged(body, 'Uint8Array') ? Array.from(body.body) : undefined
}

describe('connectorBinaryWriteHttpClientFromEffectHttpClientLayer', () => {
  it.effect('sends the exact bytes and headers and returns a complete 201 body', () =>
    Effect.gen(function* () {
      const seen: Array<Seen> = []

      const response = yield* sendWrite(writeRequest({ method: 'POST' })).pipe(
        Effect.provide(
          writeLayer(
            () =>
              new Response('{"id":"synthetic"}', {
                status: 201,
                headers: {
                  'content-type': 'application/json',
                  location: 'https://files.example.test/v1/items/1'
                }
              }),
            seen
          )
        )
      )

      expect(response.status).toBe(201)
      expect(response.bodyComplete).toBe(true)
      expect(new TextDecoder().decode(response.bytes)).toBe('{"id":"synthetic"}')
      expect(response.headers).toMatchObject({ location: 'https://files.example.test/v1/items/1' })
      expect(seen[0]?.request.method).toBe('POST')
      expect(requestBytes(seen[0]!.request)).toEqual(Array.from(tenBytes))
      expect(seen[0]?.request.headers).toMatchObject({
        authorization: 'Bearer synthetic-token',
        'content-type': 'application/octet-stream'
      })
      expect(seen[0]?.requestInit).toEqual({ redirect: 'manual', credentials: 'omit' })
    })
  )

  it.effect('fails an oversize success and truncates error bodies', () =>
    Effect.gen(function* () {
      const tooLarge = yield* sendWrite(writeRequest({ maxBytes: 9 })).pipe(
        Effect.provide(writeLayer(() => new Response(tenBytes, { status: 200 }))),
        Effect.flip
      )

      expect(tooLarge).toMatchObject({
        _tag: 'ConnectorBinaryHttpError',
        code: 'response_too_large'
      })

      const truncated = yield* sendWrite(writeRequest()).pipe(
        Effect.provide(writeLayer(() => new Response(tenBytes, { status: 409 })))
      )

      expect(truncated).toMatchObject({ status: 409, bodyComplete: false })
      expect(truncated.bytes.byteLength).toBe(4)
    })
  )

  it.effect('refuses invalid requests before any network contact', () =>
    Effect.gen(function* () {
      const seen: Array<Seen> = []
      const layer = writeLayer(() => new Response('', { status: 200 }), seen)

      for (const request of [
        writeRequest({ maxUploadBytes: 9 }),
        writeRequest({ maxBytes: -1 }),
        withRuntimeValue('method', 'DELETE'),
        withRuntimeValue('successStatuses', [204]),
        withRuntimeValue('bytes', 'not bytes')
      ]) {
        const error = yield* sendWrite(request).pipe(Effect.provide(layer), Effect.flip)

        expect(error).toMatchObject({ _tag: 'ConnectorBinaryHttpError', code: 'transport_failed' })
      }

      expect(seen).toHaveLength(0)
    })
  )

  it.effect(
    'uploads session byte ranges without Authorization and returns the final Location',
    () =>
      Effect.gen(function* () {
        const seen: Array<Seen> = []

        const response = yield* sendSession(sessionRequest()).pipe(
          Effect.provide(
            writeLayer(
              () =>
                new Response('', {
                  status: 201,
                  headers: {
                    location:
                      "https://outlook.office.com/api/v2.0/Users('x')/Messages('y')/Attachments('z')"
                  }
                }),
              seen
            )
          )
        )

        expect(response.status).toBe(201)
        expect(response.headers.location).toContain("Attachments('z')")
        expect(seen[0]?.request.method).toBe('PUT')
        expect(seen[0]?.url).toBe(sessionUrl)
        expect(requestBytes(seen[0]!.request)).toEqual(Array.from(tenBytes))
        expect(Object.keys(seen[0]?.request.headers ?? {})).not.toContain('authorization')
        expect(seen[0]?.requestInit).toEqual({ redirect: 'manual', credentials: 'omit' })
      })
  )

  it.effect('cancels a session with an empty DELETE answered 204', () =>
    Effect.gen(function* () {
      const seen: Array<Seen> = []

      const response = yield* sendSession(
        sessionRequest({
          method: 'DELETE',
          headers: {},
          bytes: new Uint8Array(0),
          maxUploadBytes: 0,
          successStatuses: [204],
          maxBytes: 0
        })
      ).pipe(Effect.provide(writeLayer(() => new Response(null, { status: 204 }), seen)))

      expect(response).toMatchObject({ status: 204, bodyComplete: true })
      expect(seen[0]?.request.method).toBe('DELETE')
      expect(seen[0]?.request.body._tag).toBe('Empty')
    })
  )

  it.effect('refuses credentials, bodies on DELETE, and bad status lists before sending', () =>
    Effect.gen(function* () {
      const seen: Array<Seen> = []
      const layer = writeLayer(() => new Response('', { status: 200 }), seen)

      for (const request of [
        sessionRequest({ headers: { Authorization: 'Bearer synthetic-token' } }),
        sessionRequest({ headers: { cookie: 'session=synthetic' } }),
        sessionRequest({ method: 'DELETE', successStatuses: [204] }),
        sessionRequest({ method: 'DELETE', bytes: new Uint8Array(0), maxUploadBytes: 0 }),
        sessionRequest({ successStatuses: [204] })
      ]) {
        const error = yield* sendSession(request).pipe(Effect.provide(layer), Effect.flip)

        expect(error).toMatchObject({ _tag: 'ConnectorBinaryHttpError', code: 'transport_failed' })
      }

      expect(seen).toHaveLength(0)
    })
  )

  it.effect('maps session transport failures to code-only errors without the session URL', () =>
    Effect.gen(function* () {
      const error = yield* sendSession(sessionRequest()).pipe(
        Effect.provide(
          connectorBinaryWriteHttpClientFromEffectHttpClientLayer.pipe(
            Layer.provide(failingHttpClient)
          )
        ),
        Effect.flip
      )

      expect(error).toMatchObject({ _tag: 'ConnectorBinaryHttpError', code: 'transport_failed' })

      const serialized = `${error.message} ${JSON.stringify(error)}`

      expect(serialized).not.toContain('outlook.office.com')
      expect(serialized).not.toContain('synthetic-session-secret')
    })
  )

  it.effect('is part of the all-ports bridge layer', () =>
    Effect.gen(function* () {
      const response = yield* sendSession(sessionRequest()).pipe(
        Effect.provide(
          connectorHttpClientsFromEffectHttpClientLayer.pipe(
            Layer.provide(fakeHttpClient([], () => new Response('{}', { status: 200 })))
          )
        )
      )

      expect(response.status).toBe(200)
    })
  )
})

const integration = makeIntegration({
  connectorId: 'example',
  credentialBindings: [makeCredentialBinding({ slotId: 'example.oauth', credentialRef: 'ref' })]
})

const slot = (id: string) => CredentialSlot.make({ id, kind: 'oauth' })

const resolveFor = (slotId: string) =>
  resolveWith({
    integration,
    slot: slot(slotId),
    binding: makeCredentialBinding({ slotId, credentialRef: 'ref' })
  })

describe('staticCredentialResolverLayer', () => {
  const oauth = OAuthCredential.make({
    provider: 'example',
    accessToken: 'synthetic-access-token',
    expiresAt: 4_000_000_000_000
  })

  it.effect('returns one credential for every slot', () =>
    Effect.gen(function* () {
      const layer = staticCredentialResolverLayer(oauth)

      expect(yield* resolveFor('example.oauth').pipe(Effect.provide(layer))).toBe(oauth)
      expect(yield* resolveFor('other.oauth').pipe(Effect.provide(layer))).toBe(oauth)
    })
  )

  it.effect('returns credentials keyed by slot id and fails missing slots', () =>
    Effect.gen(function* () {
      const apiKey = ApiKeyCredential.make({ key: 'synthetic-key' })
      const layer = staticCredentialResolverLayer({ 'example.oauth': oauth, 'example.key': apiKey })

      expect(yield* resolveFor('example.key').pipe(Effect.provide(layer))).toBe(apiKey)

      const missing = yield* resolveFor('example.missing').pipe(Effect.provide(layer), Effect.flip)

      expect(missing).toMatchObject({
        cause: 'credential_missing',
        slotId: 'example.missing',
        connectorId: 'example'
      })
      expect(Option.isNone(Option.fromNullishOr(missing.underlying))).toBe(true)
    })
  )
})
