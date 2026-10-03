/**
 * Offline replay of recorded wire fixtures as an Effect `HttpClient`.
 *
 * Replay never performs network I/O. Requests are matched by method and
 * normalized absolute URL (hash removed, query parameters sorted); each
 * recorded exchange is consumed once, in recorded order among exchanges with
 * the same method and URL. A request with no remaining match fails closed with
 * a typed `HttpClientError` and is still written to the ledger.
 *
 * @experimental
 */
import {
  Cause,
  Context,
  Data,
  Effect,
  Exit,
  Fiber,
  Layer,
  Match,
  Option,
  Predicate,
  Ref,
  Result
} from 'effect'
import type * as Schema from 'effect/Schema'
import {
  HttpClient,
  HttpClientError,
  HttpClientResponse,
  type HttpClientRequest
} from 'effect/http'
import {
  isWireBase64BodyResponse,
  isWireStreamResponse,
  type WireChunk,
  type WireExchange,
  type WireFixture,
  type WireHeaders,
  type WireResponse
} from './fixture.ts'
import {
  decodeBase64Bytes,
  headerRecord,
  isNullBodyStatus,
  normalizeWireUrl,
  parseJsonText,
  redactHeaders,
  requestBodyText,
  urlMatchesPattern
} from './wire-internal.ts'

/**
 * Optional fault filter. `method` compares case-insensitively. `url` matches
 * the normalized request URL exactly, or as a prefix when it ends with `*`.
 * An omitted field matches every request.
 */
export type WireFaultMatch = {
  readonly method?: string
  readonly url?: string
}

/**
 * Wire faults injected by the replay client. `attempt` is 1-based and counted
 * per method + normalized URL.
 *
 * - `StatusOnAttempt`: respond with this status instead of consuming a recorded
 *   exchange, so the next attempt still gets the recording. It fires only when
 *   an unconsumed recorded exchange exists for the method + normalized URL;
 *   unknown or exhausted requests still fail closed as `unmatched`.
 * - `FailAfterChunks`: emit the first `chunks` recorded chunks, then fail the
 *   body stream the way a dropped connection does under `FetchHttpClient`.
 * - `TruncateAfterChunks`: emit the first `chunks` recorded chunks, then end
 *   the body cleanly.
 * - `HoldAfterChunks`: emit the first `chunks` recorded chunks, run `release`,
 *   then emit the rest.
 *
 * `attempt` omitted means every matching attempt. A chunk fault that cannot
 * take effect fails the request with a typed `HttpClientError` (and a ledger
 * `invalid` outcome) instead of silently doing nothing: any chunk fault matched
 * against a whole-body response, `TruncateAfterChunks`/`HoldAfterChunks` with
 * `chunks` >= the recorded chunk count, or `FailAfterChunks` with `chunks` >
 * the recorded chunk count. That error's reason is a `TransportError`, so
 * transient-retry policies may retry past it: assert the ledger has no
 * `invalid` outcome when testing through a retrying client.
 */
export type WireFault = Data.TaggedEnum<{
  StatusOnAttempt: {
    readonly match?: WireFaultMatch
    readonly attempt: number
    readonly status: number
    readonly headers?: WireHeaders
    readonly body?: string
  }
  FailAfterChunks: {
    readonly match?: WireFaultMatch
    readonly attempt?: number
    readonly chunks: number
  }
  TruncateAfterChunks: {
    readonly match?: WireFaultMatch
    readonly attempt?: number
    readonly chunks: number
  }
  HoldAfterChunks: {
    readonly match?: WireFaultMatch
    readonly attempt?: number
    readonly chunks: number
    readonly release: Effect.Effect<void>
  }
}>

export const WireFault = Data.taggedEnum<WireFault>()

export type WireFaultTag = WireFault['_tag']

type ChunkFault = Exclude<WireFault, { readonly _tag: 'StatusOnAttempt' }>

/** Cause attached to a body stream failed by `FailAfterChunks`. */
export class WireTransportFault extends Data.TaggedError('WireTransportFault')<{
  readonly afterChunks: number
}> {
  override get message(): string {
    return `injected transport failure after ${this.afterChunks} chunks`
  }
}

/**
 * How a replayed request was answered: a recorded exchange, a response
 * injected by a `StatusOnAttempt` fault, nothing (fail closed), or a matched
 * exchange that could not be replayed (`invalid`: a chunk fault that cannot
 * take effect, or undecodable base64). `invalid` requests fail with a typed
 * `HttpClientError` and do not consume the exchange.
 */
export type ReplayLedgerMatch =
  | { readonly outcome: 'matched'; readonly fixtureId: string; readonly exchangeIndex: number }
  | { readonly outcome: 'injected' }
  | { readonly outcome: 'unmatched' }
  | {
      readonly outcome: 'invalid'
      readonly fixtureId: string
      readonly exchangeIndex: number
      /** Why the recording could not be replayed; never contains request or response data. */
      readonly reason: string
    }

export type ReplayLedgerEntry = {
  readonly method: string
  /** Normalized absolute URL. */
  readonly url: string
  /** Request headers with credential headers replaced by `<redacted>`. */
  readonly headers: Readonly<Record<string, string>>
  readonly bodyText?: string
  /** Parsed request body when `bodyText` is valid JSON. */
  readonly bodyJson?: Schema.Json
  /** 1-based attempt number for this method + URL. */
  readonly attempt: number
  readonly match: ReplayLedgerMatch
  /** Tag of the fault that shaped this response, if any (never set for a fault that did not apply). */
  readonly fault?: WireFaultTag
}

export type ReplayExchangeRef = {
  readonly fixtureId: string
  readonly exchangeIndex: number
}

export type ReplayLedgerApi = {
  /** Every request seen by the replay client, in arrival order. */
  readonly entries: Effect.Effect<ReadonlyArray<ReplayLedgerEntry>>
  /** Recorded exchanges not consumed yet, in fixture order. */
  readonly remaining: Effect.Effect<ReadonlyArray<ReplayExchangeRef>>
}

export class ReplayLedger extends Context.Service<ReplayLedger, ReplayLedgerApi>()(
  '@yolk-sdk/conformance/ReplayLedger'
) {}

export type ReplayHttpClientOptions = {
  readonly faults?: ReadonlyArray<WireFault>
}

type Candidate = {
  readonly id: number
  readonly key: string
  readonly fixtureId: string
  readonly exchangeIndex: number
  readonly exchange: WireExchange
}

type ReplayState = {
  readonly consumed: ReadonlySet<number>
  readonly attempts: ReadonlyMap<string, number>
  readonly entries: ReadonlyArray<ReplayLedgerEntry>
}

// Bytes to replay: one whole body, or one Uint8Array per recorded chunk.
type ReplayBody =
  | { readonly kind: 'body'; readonly body: string | Uint8Array<ArrayBuffer> }
  | {
      readonly kind: 'chunks'
      readonly chunks: ReadonlyArray<Uint8Array>
      readonly fault: ChunkFault | undefined
    }

type ReplayDecision =
  | { readonly kind: 'status'; readonly fault: Extract<WireFault, { _tag: 'StatusOnAttempt' }> }
  | {
      readonly kind: 'exchange'
      readonly response: WireResponse
      readonly body: ReplayBody
    }
  | { readonly kind: 'invalid'; readonly reason: string }
  | { readonly kind: 'unmatched' }

type LedgerEntryFields = {
  method: string
  url: string
  headers: Readonly<Record<string, string>>
  bodyText?: string
  bodyJson?: Schema.Json
  attempt: number
  match: ReplayLedgerMatch
  fault?: WireFaultTag
}

const requestKey = (method: string, normalizedUrl: string) =>
  `${method.toUpperCase()} ${normalizedUrl}`

const faultMatches = (
  match: WireFaultMatch | undefined,
  method: string,
  normalizedUrl: string
): boolean =>
  (match?.method === undefined || match.method.toUpperCase() === method.toUpperCase()) &&
  (match?.url === undefined || urlMatchesPattern(match.url, normalizedUrl))

const candidatesFrom = (fixtures: ReadonlyArray<WireFixture>): ReadonlyArray<Candidate> => {
  const candidates: Array<Candidate> = []

  for (const fixture of fixtures) {
    fixture.exchanges.forEach((exchange, exchangeIndex) => {
      candidates.push({
        id: candidates.length,
        key: requestKey(exchange.request.method, normalizeWireUrl(exchange.request.url)),
        fixtureId: fixture.id,
        exchangeIndex,
        exchange
      })
    })
  }

  return candidates
}

const chunkBytes = (chunk: WireChunk): Option.Option<Uint8Array> =>
  Predicate.isString(chunk)
    ? Option.some(new TextEncoder().encode(chunk))
    : decodeBase64Bytes(chunk.base64)

const chunkFaultProblem = (fault: ChunkFault, recorded: number): string | undefined => {
  if (!Number.isSafeInteger(fault.chunks) || fault.chunks < 0) {
    return `${fault._tag} needs a non-negative integer chunk count`
  }

  // `FailAfterChunks` may fail after the last chunk; truncating or holding
  // there would change nothing.
  const applies = WireFault.$is('FailAfterChunks')(fault)
    ? fault.chunks <= recorded
    : fault.chunks < recorded

  return applies
    ? undefined
    : `${fault._tag} after ${fault.chunks} chunk(s) cannot apply to a response with ${recorded} recorded chunk(s)`
}

/** Resolve the exact bytes to replay, or why the recording cannot be replayed as requested. */
const replayBody = (
  response: WireResponse,
  fault: ChunkFault | undefined
): Result.Result<ReplayBody, string> => {
  if (isWireStreamResponse(response)) {
    const chunks = Option.all(response.chunks.map(chunkBytes))

    if (Option.isNone(chunks)) {
      return Result.fail('a recorded chunk is not valid base64')
    }

    const problem = fault === undefined ? undefined : chunkFaultProblem(fault, chunks.value.length)

    return problem === undefined
      ? Result.succeed({ kind: 'chunks', chunks: chunks.value, fault })
      : Result.fail(problem)
  }

  if (fault !== undefined) {
    return Result.fail(`${fault._tag} cannot apply to a whole-body response`)
  }

  if (isWireBase64BodyResponse(response)) {
    return Option.match(decodeBase64Bytes(response.bodyBase64), {
      onNone: () => Result.fail('the recorded bodyBase64 is not valid base64'),
      // Copy into an ArrayBuffer-backed view, as `Response` requires.
      onSome: bytes => Result.succeed({ kind: 'body', body: new Uint8Array(bytes) })
    })
  }

  return Result.succeed({ kind: 'body', body: response.body })
}

/**
 * Strictly pull-driven body: one `Uint8Array` per recorded chunk (including
 * empty ones), and chunk `k` is produced only when the consumer pulls it,
 * never ahead of demand. The fault (already validated against the chunk count)
 * applies when the consumer pulls past `fault.chunks` chunks.
 */
const bodyReadable = (
  chunks: ReadonlyArray<Uint8Array>,
  fault: ChunkFault | undefined
): ReadableStream<Uint8Array> => {
  let next = 0
  let faultApplied = false
  let cancelled = false
  let held: Fiber.Fiber<void> | undefined

  const emitNext = (controller: ReadableStreamDefaultController<Uint8Array>): void => {
    const chunk = chunks[next]

    if (chunk === undefined) {
      controller.close()

      return
    }

    next += 1
    controller.enqueue(chunk)
  }

  return new ReadableStream<Uint8Array>(
    {
      pull: controller => {
        if (fault === undefined || faultApplied || next !== fault.chunks) {
          emitNext(controller)

          return
        }

        faultApplied = true

        return Match.valueTags(fault, {
          FailAfterChunks: ({ chunks: afterChunks }) =>
            controller.error(new WireTransportFault({ afterChunks })),
          TruncateAfterChunks: () => controller.close(),
          HoldAfterChunks: ({ release }) => {
            // Keep the release fiber so cancelling the body interrupts it (and runs its finalizers).
            // `runFork` starts `release` synchronously, so a cancel can land before `held` is set.
            const fiber = Effect.runFork(release)
            held = fiber

            if (cancelled) {
              held = undefined

              return Effect.runPromise(Fiber.interrupt(fiber))
            }

            return Effect.runPromise(Fiber.await(fiber)).then(exit => {
              held = undefined

              if (cancelled) return

              if (Exit.isSuccess(exit)) {
                emitNext(controller)
              } else {
                controller.error(Cause.squash(exit.cause))
              }
            })
          }
        })
      },
      cancel: () => {
        cancelled = true

        if (held === undefined) return

        return Effect.runPromise(Fiber.interrupt(held))
      }
    },
    { highWaterMark: 0 }
  )
}

const webResponse = (status: number, headers: WireHeaders, body: ReplayBody): Response => {
  const init = { status, headers: { ...headers } }

  if (isNullBodyStatus(status)) {
    return new Response(null, init)
  }

  if (body.kind === 'body') {
    return new Response(body.body, init)
  }

  return new Response(bodyReadable(body.chunks, body.fault), init)
}

const unmatchedError = (request: HttpClientRequest.HttpClientRequest) =>
  new HttpClientError.HttpClientError({
    reason: new HttpClientError.TransportError({
      request,
      description: 'replay has no remaining recorded exchange'
    })
  })

const invalidRecordingError = (request: HttpClientRequest.HttpClientRequest, cause: unknown) =>
  new HttpClientError.HttpClientError({
    reason: new HttpClientError.TransportError({
      request,
      cause,
      description: 'recorded response could not be replayed'
    })
  })

/**
 * Cause attached to the `HttpClientError` (reason `TransportError`) of a request
 * whose recording could not be replayed. Retrying clients may retry past it;
 * check the ledger for an `invalid` outcome.
 */
export class WireReplayInvalid extends Data.TaggedError('WireReplayInvalid')<{
  readonly reason: string
}> {
  override get message(): string {
    return this.reason
  }
}

/**
 * Build a replay `HttpClient` and its ledger over the given fixtures. Each
 * call has independent consumption, attempt, and ledger state.
 */
export const makeReplayHttpClient = (
  fixtures: ReadonlyArray<WireFixture>,
  options: ReplayHttpClientOptions = {}
): Effect.Effect<{ readonly client: HttpClient.HttpClient; readonly ledger: ReplayLedgerApi }> =>
  Effect.gen(function* () {
    const candidates = candidatesFrom(fixtures)
    const faults = options.faults ?? []

    const state = yield* Ref.make<ReplayState>({
      consumed: new Set(),
      attempts: new Map(),
      entries: []
    })

    const decide = (
      method: string,
      normalizedUrl: string,
      entry: Omit<LedgerEntryFields, 'attempt' | 'match' | 'fault'>
    ) =>
      Ref.modify(state, (current): [ReplayDecision, ReplayState] => {
        const key = requestKey(method, normalizedUrl)
        const attempt = (current.attempts.get(key) ?? 0) + 1
        const attempts = new Map(current.attempts).set(key, attempt)
        const fields: LedgerEntryFields = { ...entry, attempt, match: { outcome: 'unmatched' } }

        const candidate = candidates.find(
          item => item.key === key && !current.consumed.has(item.id)
        )

        // Fail closed first: faults never answer unknown or exhausted requests.
        if (candidate === undefined) {
          return [
            { kind: 'unmatched' },
            { ...current, attempts, entries: [...current.entries, fields] }
          ]
        }

        const statusFault = faults
          .filter(WireFault.$is('StatusOnAttempt'))
          .find(
            fault => fault.attempt === attempt && faultMatches(fault.match, method, normalizedUrl)
          )

        if (statusFault !== undefined) {
          fields.match = { outcome: 'injected' }
          fields.fault = statusFault._tag

          return [
            { kind: 'status', fault: statusFault },
            { ...current, attempts, entries: [...current.entries, fields] }
          ]
        }

        const response = candidate.exchange.response

        const chunkFault = faults
          .filter((fault): fault is ChunkFault => !WireFault.$is('StatusOnAttempt')(fault))
          .find(
            fault =>
              (fault.attempt === undefined || fault.attempt === attempt) &&
              faultMatches(fault.match, method, normalizedUrl)
          )

        const body = replayBody(response, chunkFault)
        const ref = { fixtureId: candidate.fixtureId, exchangeIndex: candidate.exchangeIndex }

        if (Result.isFailure(body)) {
          // The fault (or recording) did not apply: record the failure, not the
          // fault, and leave the exchange unconsumed.
          fields.match = { outcome: 'invalid', ...ref, reason: body.failure }

          return [
            { kind: 'invalid', reason: body.failure },
            { ...current, attempts, entries: [...current.entries, fields] }
          ]
        }

        fields.match = { outcome: 'matched', ...ref }

        if (chunkFault !== undefined) {
          fields.fault = chunkFault._tag
        }

        return [
          { kind: 'exchange', response, body: body.success },
          {
            consumed: new Set(current.consumed).add(candidate.id),
            attempts,
            entries: [...current.entries, fields]
          }
        ]
      })

    const client = HttpClient.make((request, url) =>
      Effect.gen(function* () {
        const normalizedUrl = normalizeWireUrl(url.toString())
        const bodyText = requestBodyText(request)

        const entry: Omit<LedgerEntryFields, 'attempt' | 'match' | 'fault'> = {
          method: request.method,
          url: normalizedUrl,
          headers: redactHeaders(headerRecord(request.headers))
        }

        if (bodyText !== undefined) {
          entry.bodyText = bodyText

          const bodyJson = yield* parseJsonText(bodyText)

          if (Option.isSome(bodyJson)) {
            entry.bodyJson = bodyJson.value
          }
        }

        const decision = yield* decide(request.method, normalizedUrl, entry)

        if (decision.kind === 'unmatched') {
          return yield* Effect.fail(unmatchedError(request))
        }

        if (decision.kind === 'invalid') {
          return yield* Effect.fail(
            invalidRecordingError(request, new WireReplayInvalid({ reason: decision.reason }))
          )
        }

        const source = yield* Effect.try({
          try: () =>
            decision.kind === 'status'
              ? webResponse(decision.fault.status, decision.fault.headers ?? {}, {
                  kind: 'body',
                  body: decision.fault.body ?? ''
                })
              : webResponse(decision.response.status, decision.response.headers, decision.body),
          catch: cause => invalidRecordingError(request, cause)
        })

        return HttpClientResponse.fromWeb(request, source)
      })
    )

    const ledger: ReplayLedgerApi = {
      entries: Ref.get(state).pipe(Effect.map(current => current.entries)),
      remaining: Ref.get(state).pipe(
        Effect.map(current =>
          candidates
            .filter(candidate => !current.consumed.has(candidate.id))
            .map(candidate => ({
              fixtureId: candidate.fixtureId,
              exchangeIndex: candidate.exchangeIndex
            }))
        )
      )
    }

    return { client, ledger }
  })

export const ReplayHttpClient = {
  /**
   * Layer providing a replay `HttpClient` and its `ReplayLedger`. Each layer
   * build gets fresh consumption and ledger state.
   */
  layer: (
    fixtures: ReadonlyArray<WireFixture>,
    options: ReplayHttpClientOptions = {}
  ): Layer.Layer<HttpClient.HttpClient | ReplayLedger> =>
    Layer.unwrap(
      makeReplayHttpClient(fixtures, options).pipe(
        Effect.map(({ client, ledger }) =>
          Layer.mergeAll(
            Layer.succeed(HttpClient.HttpClient, client),
            Layer.succeed(ReplayLedger, ledger)
          )
        )
      )
    )
} as const
