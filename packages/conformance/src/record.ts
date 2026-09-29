/**
 * Record live HTTP exchanges as wire fixtures.
 *
 * This module never constructs a network client: hosts supply the real
 * `HttpClient` (for example `FetchHttpClient.layer`) and this wrapper records
 * what flows through it without changing the bytes the caller receives.
 *
 * @experimental
 */
import { Context, Data, Effect, Exit, Layer, Option, Ref, Stream } from 'effect'
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  type HttpClientError
} from 'effect/unstable/http'
import {
  decodeWireFixture,
  scanFixtureForSecrets,
  type FixtureSecretIssue,
  type WireExchange,
  type WireFixture,
  type WireHeaders,
  type WireRequest,
  type WireResponse
} from './fixture.ts'
import {
  headerRecord,
  isCredentialHeaderName,
  isNullBodyStatus,
  mediaType,
  parseJsonText,
  requestBodyText
} from './wire-internal.ts'

/** Default allowlisted request headers. Credential headers are always dropped. */
export const defaultRecordedRequestHeaders: ReadonlyArray<string> = ['content-type', 'accept']

/**
 * Default allowlisted response headers. Entries ending in `*` are prefixes.
 * Credential headers (including `set-cookie`) are always dropped.
 */
export const defaultRecordedResponseHeaders: ReadonlyArray<string> = [
  'content-type',
  'retry-after',
  'retry-after-ms',
  'x-ratelimit-*',
  'ratelimit-*',
  'anthropic-ratelimit-*'
]

/** Response media types recorded as `chunks` instead of a single `body`. */
export const defaultStreamMediaTypes: ReadonlyArray<string> = ['text/event-stream']

export type WireRecorderOptions = {
  readonly requestHeaders?: ReadonlyArray<string>
  readonly responseHeaders?: ReadonlyArray<string>
  readonly streamMediaTypes?: ReadonlyArray<string>
}

/** Raised by `drain` when a recorded request failed or its body was not read to the end. */
export class WireRecordingIncomplete extends Data.TaggedError('WireRecordingIncomplete')<{
  /** `METHOD url` (query string removed) of each incomplete exchange. */
  readonly requests: ReadonlyArray<string>
}> {
  override get message(): string {
    return `Recording incomplete for ${this.requests.length} request(s): ${this.requests.join(', ')}`
  }
}

export type WireRecorderApi = {
  /**
   * Take every recorded exchange, in request order, and clear the recorder.
   * Fails with `WireRecordingIncomplete` (and discards the drained entries)
   * when any request failed or its body was not fully read.
   */
  readonly drain: Effect.Effect<ReadonlyArray<WireExchange>, WireRecordingIncomplete>
}

export class WireRecorder extends Context.Service<WireRecorder, WireRecorderApi>()(
  '@yolk-sdk/conformance/WireRecorder'
) {
  /**
   * Wrap the `HttpClient` already in context and provide the recording client
   * plus its `WireRecorder`. Provide the real client below this layer.
   */
  static layer = (
    options: WireRecorderOptions = {}
  ): Layer.Layer<HttpClient.HttpClient | WireRecorder, never, HttpClient.HttpClient> =>
    Layer.unwrap(
      Effect.gen(function* () {
        const upstream = yield* HttpClient.HttpClient
        const { client, recorder } = yield* makeRecordingHttpClient(upstream, options)

        return Layer.mergeAll(
          Layer.succeed(HttpClient.HttpClient, client),
          Layer.succeed(WireRecorder, recorder)
        )
      })
    )
}

type RecordingEntry =
  | { readonly status: 'pending'; readonly label: string }
  | { readonly status: 'failed'; readonly label: string }
  | { readonly status: 'complete'; readonly label: string; readonly exchange: WireExchange }

const headerAllowed = (allowlist: ReadonlyArray<string>, name: string): boolean =>
  !isCredentialHeaderName(name) &&
  allowlist.some(entry => {
    const lower = entry.toLowerCase()

    return lower.endsWith('*') ? name.startsWith(lower.slice(0, -1)) : name === lower
  })

const allowlistHeaders = (
  headers: Readonly<Record<string, string | undefined>>,
  allowlist: ReadonlyArray<string>
): WireHeaders => {
  const recorded: Record<string, string> = {}

  for (const [name, value] of Object.entries(headerRecord(headers))) {
    if (headerAllowed(allowlist, name)) {
      recorded[name] = value
    }
  }

  return recorded
}

type WireRequestFields = {
  method: string
  url: string
  headers?: WireHeaders
  body?: WireRequest['body']
}

const recordRequest = (
  request: HttpClientRequest.HttpClientRequest,
  allowlist: ReadonlyArray<string>
): Effect.Effect<WireRequest> =>
  Effect.gen(function* () {
    const url = Option.match(HttpClientRequest.toUrl(request), {
      onNone: () => request.url,
      onSome: resolved => {
        resolved.hash = ''

        return resolved.toString()
      }
    })

    const fields: WireRequestFields = { method: request.method, url }
    const headers = allowlistHeaders(request.headers, allowlist)

    if (Object.keys(headers).length > 0) {
      fields.headers = headers
    }

    const text = requestBodyText(request)

    if (text !== undefined && text.length > 0) {
      const json = yield* parseJsonText(text)

      fields.body = Option.getOrElse(json, () => text)
    }

    return fields
  })

/**
 * Wrap a host-provided `HttpClient` so every exchange is recorded. Streamed
 * responses (see `streamMediaTypes`) are teed chunk by chunk with network
 * boundaries preserved (a multi-byte UTF-8 character split across chunks is
 * attributed to the chunk that completes it); other responses are recorded as
 * one `body`. The caller receives the same status, headers, and bytes. Body
 * read failures still reach the caller as `HttpClientError`s (the upstream
 * error is kept as the cause), matching how `FetchHttpClient` reports them.
 */
export const makeRecordingHttpClient = (
  upstream: HttpClient.HttpClient,
  options: WireRecorderOptions = {}
): Effect.Effect<{ readonly client: HttpClient.HttpClient; readonly recorder: WireRecorderApi }> =>
  Effect.gen(function* () {
    const requestAllowlist = options.requestHeaders ?? defaultRecordedRequestHeaders
    const responseAllowlist = options.responseHeaders ?? defaultRecordedResponseHeaders

    const streamMediaTypes = (options.streamMediaTypes ?? defaultStreamMediaTypes).map(type =>
      type.toLowerCase()
    )

    const entries = yield* Ref.make<ReadonlyArray<RecordingEntry>>([])

    const reserve = (label: string) =>
      Ref.modify(entries, current => [
        current.length,
        [...current, { status: 'pending', label }] satisfies ReadonlyArray<RecordingEntry>
      ])

    const settle = (index: number, entry: RecordingEntry) =>
      Ref.update(entries, current => current.map((item, at) => (at === index ? entry : item)))

    const client = HttpClient.transform(
      upstream,
      (
        effect: Effect.Effect<
          HttpClientResponse.HttpClientResponse,
          HttpClientError.HttpClientError
        >,
        request
      ) =>
        Effect.gen(function* () {
          const wireRequest = yield* recordRequest(request, requestAllowlist)
          // Query strings may carry credentials: labels keep origin and path only.
          const label = `${wireRequest.method} ${wireRequest.url.split('?', 1)[0]}`
          const index = yield* reserve(label)
          const failed = settle(index, { status: 'failed', label })
          const response = yield* effect.pipe(Effect.tapError(() => failed))
          const headers = headerRecord(response.headers)
          const recordedHeaders = allowlistHeaders(headers, responseAllowlist)
          const init = { status: response.status, headers }

          const complete = (wireResponse: WireResponse) =>
            settle(index, {
              status: 'complete',
              label,
              exchange: { request: wireRequest, response: wireResponse }
            })

          const type = mediaType(headers['content-type'])

          if (type !== undefined && streamMediaTypes.includes(type)) {
            const decoder = new TextDecoder()
            const chunks: Array<string> = []

            const teed = response.stream.pipe(
              Stream.tap(bytes =>
                Effect.sync(() => {
                  const text = decoder.decode(bytes, { stream: true })

                  if (text.length > 0) {
                    chunks.push(text)
                  }
                })
              ),
              Stream.onExit(exit => {
                if (Exit.isFailure(exit)) {
                  return failed
                }

                const tail = decoder.decode()

                if (tail.length > 0) {
                  chunks.push(tail)
                }

                return complete({ status: response.status, headers: recordedHeaders, chunks })
              })
            )

            const readable = Stream.toReadableStream(teed, { strategy: { highWaterMark: 0 } })

            return HttpClientResponse.fromWeb(request, new Response(readable, init))
          }

          const bytes = yield* response.arrayBuffer.pipe(Effect.tapError(() => failed))

          yield* complete({
            status: response.status,
            headers: recordedHeaders,
            body: new TextDecoder().decode(bytes)
          })

          return HttpClientResponse.fromWeb(
            request,
            new Response(isNullBodyStatus(response.status) ? null : bytes, init)
          )
        })
    )

    const recorder: WireRecorderApi = {
      drain: Ref.getAndSet(entries, []).pipe(
        Effect.flatMap(drained => {
          const exchanges: Array<WireExchange> = []
          const incomplete: Array<string> = []

          for (const entry of drained) {
            if (entry.status === 'complete') {
              exchanges.push(entry.exchange)
            } else {
              incomplete.push(entry.label)
            }
          }

          return incomplete.length > 0
            ? Effect.fail(new WireRecordingIncomplete({ requests: incomplete }))
            : Effect.succeed(exchanges)
        })
      )
    }

    return { client, recorder }
  })

/** A fixture failed schema validation (for example an empty exchange list or bad date). */
export class WireFixtureInvalid extends Data.TaggedError('WireFixtureInvalid')<{
  readonly fixtureId: string
  readonly cause: unknown
}> {
  override get message(): string {
    return `Wire fixture ${this.fixtureId} is invalid`
  }
}

/** The secret scan found credentials or credential-like values in a fixture. */
export class WireFixtureSecretsFound extends Data.TaggedError('WireFixtureSecretsFound')<{
  readonly fixtureId: string
  readonly issues: ReadonlyArray<FixtureSecretIssue>
}> {
  override get message(): string {
    return `Wire fixture ${this.fixtureId} contains ${this.issues.length} secret-scan issue(s)`
  }
}

export type WireFixtureInput = Omit<WireFixture, 'exchanges'> & {
  readonly exchanges: ReadonlyArray<WireExchange>
}

/**
 * Validate a fixture and run `scanFixtureForSecrets`. Fails with
 * `WireFixtureInvalid` or `WireFixtureSecretsFound`; never returns a fixture
 * with scan issues.
 */
export const makeWireFixture = (
  input: WireFixtureInput
): Effect.Effect<WireFixture, WireFixtureInvalid | WireFixtureSecretsFound> =>
  Effect.gen(function* () {
    const fixture = yield* decodeWireFixture(input).pipe(
      Effect.mapError(cause => new WireFixtureInvalid({ fixtureId: input.id, cause }))
    )

    const issues = scanFixtureForSecrets(fixture)

    if (issues.length > 0) {
      return yield* Effect.fail(new WireFixtureSecretsFound({ fixtureId: fixture.id, issues }))
    }

    return fixture
  })
