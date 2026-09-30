/**
 * Conformance-only bridges from Effect's `HttpClient` to the connector ports, plus a static
 * credential resolver.
 *
 * **Conformance and testing only; not for production.** These layers let connector conformance
 * cases run the real connector actions over a replay `HttpClient` (`@yolk-sdk/conformance/replay`),
 * an emulator, or a host's live client driven by hand. They enforce NO streamed byte limits,
 * redirect policy, DNS/IP policy, timeouts, or TLS policy beyond what the wrapped `HttpClient`
 * does. No bridge propagates trace context; upload-session requests and requests without an
 * `Authorization` header (whose URL may be the credential) get no client span, since the span would
 * record the URL and its query string. A host `HttpClient.TracerDisabledWhen` still applies on top.
 * Production hosts implement `ConnectorHttpClient` / `ConnectorBinaryHttpClient` /
 * `ConnectorBinaryWriteHttpClient` themselves (see the connectors README host integration
 * contract) and own real credential storage.
 *
 * @experimental
 */
import { Effect, Layer, Option, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpClientError,
  type HttpClientResponse
} from 'effect/unstable/http'
import {
  ConnectorBinaryHttpClient,
  ConnectorBinaryHttpError,
  type ConnectorBinaryHttpRequest,
  type ConnectorBinaryHttpResponse
} from '../binary-http.ts'
import {
  ConnectorBinaryWriteHttpClient,
  type ConnectorBinaryUploadSessionRequest,
  type ConnectorBinaryWriteHttpRequest
} from '../binary-write-http.ts'
import {
  CredentialResolver,
  RuntimeCredential,
  type CredentialResolveRequest
} from '../credential.ts'
import { ConnectorError } from '../error.ts'
import { ConnectorHttpClient, ConnectorHttpResponse, type ConnectorHttpRequest } from '../http.ts'
import { isBytes } from '../transfer-internal.ts'

type FetchOptions = {
  redirect?: 'manual'
  credentials?: 'omit'
}

const headerValue = (
  headers: Readonly<Record<string, string>> | undefined,
  name: string
): string | undefined =>
  Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1]

const plainHeaders = (response: HttpClientResponse.HttpClientResponse): Record<string, string> =>
  Object.fromEntries(Object.entries(response.headers))

const toEffectRequest = (input: {
  readonly method: ConnectorHttpRequest['method']
  readonly url: string
  readonly headers?: Readonly<Record<string, string>> | undefined
  readonly body?: string | Uint8Array | undefined
}): HttpClientRequest.HttpClientRequest => {
  const base = HttpClientRequest.make(input.method)(input.url)
  const contentType = headerValue(input.headers, 'content-type')

  // The body sets a default content type; the connector's own headers are applied afterwards so
  // a caller-supplied `content-type` (for example `application/json`) always wins.
  const withBody =
    input.body === undefined
      ? base
      : Predicate.isString(input.body)
        ? HttpClientRequest.bodyText(base, input.body, contentType)
        : HttpClientRequest.bodyUint8Array(base, input.body, contentType)

  return HttpClientRequest.setHeaders(withBody, input.headers ?? {})
}

/**
 * Whether the client span for a request is skipped. `HttpClient` records `url.full` and
 * `url.query` on its span even when trace propagation is off, so a request whose URL may itself be
 * the credential must not be traced.
 */
type TracerDisabledWhen = (request: HttpClientRequest.HttpClientRequest) => boolean

/** Upload-session URLs are secret capabilities: never traced. */
const neverTraced: TracerDisabledWhen = () => true

/**
 * A request without an `Authorization` header may carry its credential in the URL (for example a
 * pre-authenticated download, copy-monitor, or upload URL), so it is not traced either.
 * `HttpClientRequest` header names are lowercase.
 */
const untracedWithoutAuthorization: TracerDisabledWhen = request =>
  request.headers['authorization'] === undefined

/**
 * Execute one request with the port's fetch semantics. `redirect: 'manual'` and
 * `credentials: 'omit'` are forwarded as `FetchHttpClient.RequestInit` for this request only
 * (merged over any host defaults), which `FetchHttpClient` honors; other `HttpClient`
 * implementations must honor them on their own. Trace-context propagation headers are disabled so
 * the upstream sees exactly the connector's headers, and requests matched by `tracerDisabledWhen`
 * get no client span (whose attributes would carry the URL). A host `HttpClient.TracerDisabledWhen`
 * is kept: a request is untraced when either the host's predicate or the bridge's matches.
 */
const executeWithPortSemantics = <A>(
  client: HttpClient.HttpClient,
  request: HttpClientRequest.HttpClientRequest,
  options: FetchOptions,
  read: (
    response: HttpClientResponse.HttpClientResponse
  ) => Effect.Effect<A, HttpClientError.HttpClientError>,
  tracerDisabledWhen: TracerDisabledWhen = untracedWithoutAuthorization
): Effect.Effect<A, HttpClientError.HttpClientError> =>
  Effect.gen(function* () {
    const hostDefaults = yield* Effect.serviceOption(FetchHttpClient.RequestInit)
    const hostTracerDisabledWhen = yield* HttpClient.TracerDisabledWhen

    const requestInit: globalThis.RequestInit = {
      ...Option.getOrElse(hostDefaults, () => ({})),
      ...options
    }

    return yield* client.execute(request).pipe(
      Effect.flatMap(read),
      Effect.provideService(FetchHttpClient.RequestInit, requestInit),
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      Effect.provideService(
        HttpClient.TracerDisabledWhen,
        next => hostTracerDisabledWhen(next) || tracerDisabledWhen(next)
      )
    )
  })

const fetchOptions = (request: {
  readonly redirect?: 'manual' | undefined
  readonly credentials?: 'omit' | undefined
}): FetchOptions => {
  const options: FetchOptions = {}

  if (request.redirect !== undefined) {
    options.redirect = request.redirect
  }

  if (request.credentials !== undefined) {
    options.credentials = request.credentials
  }

  return options
}

// Never attach the HttpClientError: its request carries the URL (and possibly query secrets).
const transportFailure = () =>
  new ConnectorError({
    cause: 'transport_failed',
    message: 'HTTP request failed before a complete response'
  })

/**
 * `ConnectorHttpClient` over the `HttpClient` in context. Conformance/testing only.
 *
 * Preserves method, URL, headers (including `content-type`), the string body, and response
 * status/headers/body text. `redirect: 'manual'` and `credentials: 'omit'` are forwarded as
 * `FetchHttpClient.RequestInit` options (see `executeWithPortSemantics`). Transport and body-read
 * failures become `ConnectorError` with cause `transport_failed` and a fixed message: never the
 * URL, headers, or body. Enforces NO byte limits, redirect, or DNS/IP policy. Not for production.
 */
export const connectorHttpClientFromEffectHttpClientLayer: Layer.Layer<
  ConnectorHttpClient,
  never,
  HttpClient.HttpClient
> = Layer.effect(
  ConnectorHttpClient,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient

    return ConnectorHttpClient.of({
      request: request =>
        executeWithPortSemantics(
          client,
          toEffectRequest(request),
          fetchOptions(request),
          response =>
            response.text.pipe(
              Effect.map(body =>
                ConnectorHttpResponse.make({
                  status: response.status,
                  headers: plainHeaders(response),
                  body
                })
              )
            )
        ).pipe(Effect.mapError(transportFailure))
    })
  })
)

const isByteLimit = (value: number) => Number.isSafeInteger(value) && value >= 0

const binaryResponse = (
  request: Pick<ConnectorBinaryHttpRequest, 'maxBytes' | 'maxErrorBodyBytes'>,
  status: number,
  headers: Record<string, string>,
  bytes: Uint8Array,
  successStatuses: ReadonlyArray<number> = [200]
): Effect.Effect<ConnectorBinaryHttpResponse, ConnectorBinaryHttpError> => {
  if (successStatuses.includes(status)) {
    // An oversize success must fail, never succeed truncated.
    return bytes.byteLength > request.maxBytes
      ? Effect.fail(new ConnectorBinaryHttpError({ code: 'response_too_large' }))
      : Effect.succeed({ status, headers, bytes, bodyComplete: true })
  }

  return bytes.byteLength > request.maxErrorBodyBytes
    ? Effect.succeed({
        status,
        headers,
        bytes: bytes.slice(0, request.maxErrorBodyBytes),
        bodyComplete: false
      })
    : Effect.succeed({ status, headers, bytes, bodyComplete: true })
}

/**
 * `ConnectorBinaryHttpClient` over the `HttpClient` in context. Conformance/testing only.
 *
 * GET only. Buffers the whole response, then applies the port contract: an HTTP 200 body larger
 * than `maxBytes` fails with `response_too_large`; any other status keeps at most
 * `maxErrorBodyBytes` bytes and reports `bodyComplete: false` when it truncated. Because limits
 * are checked only AFTER buffering, this enforces no streamed byte limit, and no redirect, DNS/IP,
 * timeout, or TLS policy beyond the wrapped client. `redirect: 'manual'` and `credentials: 'omit'`
 * are forwarded as `FetchHttpClient.RequestInit` options. Transport failures become
 * `ConnectorBinaryHttpError` `transport_failed` without URL, headers, or body. Not for production.
 */
export const connectorBinaryHttpClientFromEffectHttpClientLayer: Layer.Layer<
  ConnectorBinaryHttpClient,
  never,
  HttpClient.HttpClient
> = Layer.effect(
  ConnectorBinaryHttpClient,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient

    return ConnectorBinaryHttpClient.of({
      request: request =>
        Effect.gen(function* () {
          if (
            request.method !== 'GET' ||
            !isByteLimit(request.maxBytes) ||
            !isByteLimit(request.maxErrorBodyBytes)
          ) {
            return yield* new ConnectorBinaryHttpError({ code: 'transport_failed' })
          }

          const { status, headers, bytes } = yield* executeWithPortSemantics(
            client,
            toEffectRequest({ method: 'GET', url: request.url, headers: request.headers }),
            fetchOptions(request),
            response =>
              response.arrayBuffer.pipe(
                Effect.map(buffer => ({
                  status: response.status,
                  headers: plainHeaders(response),
                  bytes: new Uint8Array(buffer)
                }))
              )
          ).pipe(Effect.mapError(() => new ConnectorBinaryHttpError({ code: 'transport_failed' })))

          return yield* binaryResponse(request, status, headers, bytes)
        })
    })
  })
)

const binaryTransportFailure = () => new ConnectorBinaryHttpError({ code: 'transport_failed' })

const hasHeader = (headers: Readonly<Record<string, string>>, name: string): boolean =>
  Object.keys(headers).some(key => key.toLowerCase() === name)

const isSuccessStatusList = (
  statuses: ReadonlyArray<number>,
  allowed: ReadonlyArray<ReadonlyArray<number>>
): boolean =>
  allowed.some(
    candidate =>
      candidate.length === statuses.length &&
      candidate.every((status, index) => statuses[index] === status)
  )

/**
 * One buffered binary write: validate the request shape and limits BEFORE any network contact
 * (a failure sends nothing), send the bytes with the port's fetch semantics, then apply the
 * success/error body limits after buffering.
 */
const sendBinaryWrite = (
  client: HttpClient.HttpClient,
  request: ConnectorBinaryWriteHttpRequest | ConnectorBinaryUploadSessionRequest,
  valid: boolean,
  tracerDisabledWhen: TracerDisabledWhen = untracedWithoutAuthorization
): Effect.Effect<ConnectorBinaryHttpResponse, ConnectorBinaryHttpError> =>
  Effect.gen(function* () {
    if (
      !valid ||
      !isByteLimit(request.maxUploadBytes) ||
      !isByteLimit(request.maxBytes) ||
      !isByteLimit(request.maxErrorBodyBytes) ||
      !isBytes(request.bytes) ||
      request.bytes.byteLength > request.maxUploadBytes
    ) {
      return yield* binaryTransportFailure()
    }

    const { status, headers, bytes } = yield* executeWithPortSemantics(
      client,
      toEffectRequest({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: request.method === 'DELETE' ? undefined : request.bytes
      }),
      fetchOptions(request),
      response =>
        response.arrayBuffer.pipe(
          Effect.map(buffer => ({
            status: response.status,
            headers: plainHeaders(response),
            bytes: new Uint8Array(buffer)
          }))
        ),
      tracerDisabledWhen
    ).pipe(Effect.mapError(binaryTransportFailure))

    return yield* binaryResponse(request, status, headers, bytes, request.successStatuses)
  })

/**
 * `ConnectorBinaryWriteHttpClient` over the `HttpClient` in context. Conformance/testing only.
 *
 * `request` sends POST/PUT bytes; `uploadSession` sends PUT byte ranges and DELETE cancellation to
 * a pre-authenticated upload-session URL. Before any network contact, both fail with
 * `transport_failed` (sending nothing) on an unexpected method or success-status list, invalid
 * limits, or more bytes than `maxUploadBytes`; `uploadSession` also refuses any `authorization`,
 * `cookie`, or `proxy-authorization` header and a DELETE with bytes. Responses are buffered, then
 * a success status (`successStatuses`) larger than `maxBytes` fails with `response_too_large`, and
 * any other status keeps at most `maxErrorBodyBytes` bytes (`bodyComplete: false` when truncated).
 * `redirect: 'manual'` and `credentials: 'omit'` are forwarded as `FetchHttpClient.RequestInit`
 * options. Session requests are never traced (`HttpClient.TracerDisabledWhen`), so no span
 * records the session URL. Errors are code-only `ConnectorBinaryHttpError`s: never the URL (a
 * session URL is a secret capability), headers, or bodies. Enforces NO streamed byte limit, redirect, DNS/IP,
 * timeout, or TLS policy beyond the wrapped client, never retries, and is not for production.
 */
export const connectorBinaryWriteHttpClientFromEffectHttpClientLayer: Layer.Layer<
  ConnectorBinaryWriteHttpClient,
  never,
  HttpClient.HttpClient
> = Layer.effect(
  ConnectorBinaryWriteHttpClient,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient

    return ConnectorBinaryWriteHttpClient.of({
      request: request =>
        sendBinaryWrite(
          client,
          request,
          (request.method === 'POST' || request.method === 'PUT') &&
            isSuccessStatusList(request.successStatuses, [[200, 201]])
        ),
      uploadSession: request =>
        sendBinaryWrite(
          client,
          request,
          !['authorization', 'cookie', 'proxy-authorization'].some(name =>
            hasHeader(request.headers, name)
          ) &&
            ((request.method === 'PUT' &&
              isSuccessStatusList(request.successStatuses, [[200, 201]])) ||
              (request.method === 'DELETE' &&
                isBytes(request.bytes) &&
                request.bytes.byteLength === 0 &&
                isSuccessStatusList(request.successStatuses, [[204]]))),
          neverTraced
        )
    })
  })
)

/**
 * Every conformance bridge over the `HttpClient` in context: `ConnectorHttpClient`,
 * `ConnectorBinaryHttpClient`, and `ConnectorBinaryWriteHttpClient` (with `uploadSession`).
 * Conformance/testing only.
 */
export const connectorHttpClientsFromEffectHttpClientLayer: Layer.Layer<
  ConnectorHttpClient | ConnectorBinaryHttpClient | ConnectorBinaryWriteHttpClient,
  never,
  HttpClient.HttpClient
> = Layer.mergeAll(
  connectorHttpClientFromEffectHttpClientLayer,
  connectorBinaryHttpClientFromEffectHttpClientLayer,
  connectorBinaryWriteHttpClientFromEffectHttpClientLayer
)

/** One credential for every slot, or credentials keyed by credential slot id. */
export type StaticCredentials =
  | RuntimeCredential
  | Readonly<Record<string, RuntimeCredential | undefined>>

const isRuntimeCredential = Schema.is(RuntimeCredential)

const staticCredentialFor = (
  credentials: StaticCredentials,
  request: CredentialResolveRequest
): RuntimeCredential | undefined => {
  if (isRuntimeCredential(credentials)) {
    return credentials
  }

  const entry = Object.entries(credentials).find(([slotId]) => slotId === request.slot.id)

  return entry?.[1]
}

/**
 * `CredentialResolver` that returns fixed runtime credentials: one credential for every slot, or a
 * record keyed by credential slot id (a missing slot fails with `credential_missing`). For replay,
 * emulated, and live-by-hand conformance runs only. It ignores `requiredScopes`, never refreshes,
 * and holds the raw secret in memory for the life of the layer. Hosts own real credential
 * storage, refresh, scope checks, and auditing.
 */
export const staticCredentialResolverLayer = (
  credentials: StaticCredentials
): Layer.Layer<CredentialResolver> =>
  Layer.succeed(
    CredentialResolver,
    CredentialResolver.of({
      resolve: request => {
        const credential = staticCredentialFor(credentials, request)

        return Predicate.isNotUndefined(credential)
          ? Effect.succeed(credential)
          : Effect.fail(
              new ConnectorError({
                cause: 'credential_missing',
                message: `No static credential for slot: ${request.slot.id}`,
                connectorId: request.integration.connectorId,
                slotId: request.slot.id
              })
            )
      }
    })
  )

export {
  ConformanceCleanupReporter,
  type ConformanceCleanupReporterApi
} from './cleanup-reporter.ts'
