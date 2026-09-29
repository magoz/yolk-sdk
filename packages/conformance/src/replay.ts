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
import { Context, Data, Effect, Layer, Match, Option, Ref, Stream } from 'effect'
import type * as Schema from 'effect/Schema'
import {
  HttpClient,
  HttpClientError,
  HttpClientResponse,
  type HttpClientRequest
} from 'effect/unstable/http'
import {
  isWireStreamResponse,
  type WireExchange,
  type WireFixture,
  type WireHeaders,
  type WireResponse
} from './fixture.ts'
import {
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
 *   exchange, so the next attempt still gets the recording.
 * - `FailAfterChunks`: emit the first `chunks` recorded chunks, then fail the
 *   body stream the way a dropped connection does under `FetchHttpClient`.
 * - `TruncateAfterChunks`: emit the first `chunks` recorded chunks, then end
 *   the body cleanly.
 * - `HoldAfterChunks`: emit the first `chunks` recorded chunks, run `release`,
 *   then emit the rest.
 *
 * Chunk faults apply only to streamed (`chunks`) responses; `attempt` omitted
 * means every matching attempt.
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
 * injected by a `StatusOnAttempt` fault, or nothing (fail closed).
 */
export type ReplayLedgerMatch =
  | { readonly outcome: 'matched'; readonly fixtureId: string; readonly exchangeIndex: number }
  | { readonly outcome: 'injected' }
  | { readonly outcome: 'unmatched' }

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
  /** Tag of the fault that shaped this response, if any. */
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

type ReplayDecision =
  | { readonly kind: 'status'; readonly fault: Extract<WireFault, { _tag: 'StatusOnAttempt' }> }
  | {
      readonly kind: 'exchange'
      readonly response: WireResponse
      readonly fault: ChunkFault | undefined
    }
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

const bodyStream = (
  chunks: ReadonlyArray<string>,
  fault: ChunkFault | undefined
): Stream.Stream<Uint8Array, WireTransportFault> => {
  const encoder = new TextEncoder()

  // One Uint8Array per recorded chunk, each in its own stream chunk so the
  // consumer observes the original boundaries progressively.
  const emit = (texts: ReadonlyArray<string>) =>
    Stream.fromIterable(texts).pipe(
      Stream.map(text => encoder.encode(text)),
      Stream.rechunk(1)
    )

  if (fault === undefined) {
    return emit(chunks)
  }

  const head = emit(chunks.slice(0, fault.chunks))
  const rest = chunks.slice(fault.chunks)

  return Match.valueTags(fault, {
    FailAfterChunks: ({ chunks: afterChunks }) =>
      head.pipe(Stream.concat(Stream.fail(new WireTransportFault({ afterChunks })))),
    TruncateAfterChunks: () => head,
    HoldAfterChunks: ({ release }) =>
      head.pipe(Stream.concat(Stream.fromEffectDrain(release)), Stream.concat(emit(rest)))
  })
}

const webResponse = (response: WireResponse, fault: ChunkFault | undefined): Response => {
  const init = { status: response.status, headers: { ...response.headers } }

  if (isNullBodyStatus(response.status)) {
    return new Response(null, init)
  }

  if (!isWireStreamResponse(response)) {
    return new Response(response.body, init)
  }

  // highWaterMark 0: chunks are produced only when the consumer pulls.
  const readable = Stream.toReadableStream(bodyStream(response.chunks, fault), {
    strategy: { highWaterMark: 0 }
  })

  return new Response(readable, init)
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

        const candidate = candidates.find(
          item => item.key === key && !current.consumed.has(item.id)
        )

        if (candidate === undefined) {
          return [
            { kind: 'unmatched' },
            { ...current, attempts, entries: [...current.entries, fields] }
          ]
        }

        const response = candidate.exchange.response

        const chunkFault = isWireStreamResponse(response)
          ? faults
              .filter((fault): fault is ChunkFault => !WireFault.$is('StatusOnAttempt')(fault))
              .find(
                fault =>
                  (fault.attempt === undefined || fault.attempt === attempt) &&
                  faultMatches(fault.match, method, normalizedUrl)
              )
          : undefined

        fields.match = {
          outcome: 'matched',
          fixtureId: candidate.fixtureId,
          exchangeIndex: candidate.exchangeIndex
        }

        if (chunkFault !== undefined) {
          fields.fault = chunkFault._tag
        }

        return [
          { kind: 'exchange', response, fault: chunkFault },
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

        const response: WireResponse =
          decision.kind === 'status'
            ? {
                status: decision.fault.status,
                headers: decision.fault.headers ?? {},
                body: decision.fault.body ?? ''
              }
            : decision.response

        const source = yield* Effect.try({
          try: () =>
            webResponse(response, decision.kind === 'exchange' ? decision.fault : undefined),
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
