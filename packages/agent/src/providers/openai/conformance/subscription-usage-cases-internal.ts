/**
 * Shared subscription-usage conformance case builder (internal; not a public export).
 *
 * Claude, Codex, Grok, and OpenCode Go each expose a best-effort subscription-usage fetcher that
 * reads a private JSON endpoint and normalizes it into a `ProviderSubscriptionUsageSnapshot`.
 * Their cases share one shape, built here with each vendor's case id, config service, public
 * fetcher, fixture, window ids, and a case-local reader of the raw wire body:
 *
 * - the fetcher succeeds and the snapshot names the vendor's provider id;
 * - it carries at least one window, with distinct ids from the vendor's known set in the vendor's
 *   order;
 * - no window is fabricated or dropped: the case reads the same response body at its own
 *   `HttpClient` boundary (a conformance-local wrapper handing the provider the same bytes) and
 *   requires one snapshot window per wire window with a valid used percentage, with the same id,
 *   percentage, and reset instant (absent when the wire has none).
 *
 * Only shapes and window ids are reported, never body text. Lives in a conformance directory so it
 * may import `@yolk-sdk/conformance/*`.
 */
import { Effect, Option, Predicate, Ref } from 'effect'
import * as Schema from 'effect/Schema'
import { HttpClient, HttpClientResponse } from 'effect/http'
import {
  defineConformanceCase,
  expectConformance,
  expectEqual,
  type ConformanceCase,
  type ConformanceMismatch
} from '@yolk-sdk/conformance/case'
import type {
  ProviderSubscriptionUsageError,
  ProviderSubscriptionUsageSnapshot
} from '../../subscription-usage.ts'

/** A window the case expects from the raw wire body (read independently of the SDK parser). */
export type SubscriptionUsageExpectedWindow = {
  readonly id: string
  readonly usedPercent: number
  readonly resetsAt: string | undefined
}

export type SubscriptionUsageConformanceCase<R> = ConformanceCase<
  ProviderSubscriptionUsageError | ConformanceMismatch,
  HttpClient.HttpClient | R
>

export type SubscriptionUsageConformanceSpec<Settings, R> = {
  /** Dotted case id, for example `anthropic.claude.usage.snapshot`. */
  readonly id: string
  readonly title: string
  /** The wire the endpoint answers, for the case docs. */
  readonly docs: string
  /** Vendor-specific claim text appended to the shared claim. */
  readonly wire: string
  /** The snapshot's expected `provider`. */
  readonly providerId: string
  /** The vendor's window ids, in the order the snapshot lists them. */
  readonly windowIds: ReadonlyArray<string>
  readonly settings: Effect.Effect<Settings, never, R>
  /** The public fetcher, called with its default URL. */
  readonly fetch: (
    settings: Settings
  ) => Effect.Effect<
    ProviderSubscriptionUsageSnapshot,
    ProviderSubscriptionUsageError,
    HttpClient.HttpClient
  >
  /** Case-local reading of the raw body: the windows it reports, in `windowIds` order. */
  readonly expectedWindows: (
    body: Schema.Json,
    fetchedAt: string
  ) => ReadonlyArray<SubscriptionUsageExpectedWindow>
  readonly fixture: string
}

/** The canonical ISO instant of a wire date string or epoch-seconds number, when readable. */
export const wireInstant = (value: Schema.Json | undefined): string | undefined => {
  if (!Predicate.isString(value) && !Predicate.isNumber(value)) return undefined

  const date = new Date(Predicate.isNumber(value) ? value * 1000 : value)

  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined
}

/** A used percentage the snapshot may carry: a finite number from 0 to 100. */
export const wirePercent = (value: Schema.Json | undefined): number | undefined =>
  Predicate.isNumber(value) && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : undefined

export const isWireRecord = (value: Schema.Json | undefined): value is Schema.JsonObject =>
  Predicate.isObject(value) && !Array.isArray(value)

export const wireField = (value: Schema.Json | undefined, key: string): Schema.Json | undefined =>
  isWireRecord(value) ? value[key] : undefined

type CapturedBody = { readonly status: number; readonly text: string }

/**
 * The case's own HttpClient boundary: reads every response body whole and hands the provider a
 * response with the same status, headers, and bytes.
 */
const capturingBodies = (
  client: HttpClient.HttpClient,
  bodies: Ref.Ref<ReadonlyArray<CapturedBody>>
): HttpClient.HttpClient =>
  HttpClient.transform(client, (effect, request) =>
    Effect.flatMap(effect, response =>
      response.arrayBuffer.pipe(
        Effect.tap(bytes =>
          Ref.update(bodies, current => [
            ...current,
            { status: response.status, text: new TextDecoder().decode(bytes) }
          ])
        ),
        Effect.map(bytes =>
          HttpClientResponse.fromWeb(
            request,
            new Response(bytes, { status: response.status, headers: response.headers })
          )
        )
      )
    )
  )

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))

const sameWindow = (
  actual: { readonly id: string; readonly usedPercent: number; readonly resetsAt?: string },
  expected: SubscriptionUsageExpectedWindow
): boolean =>
  actual.id === expected.id &&
  actual.usedPercent === expected.usedPercent &&
  actual.resetsAt === expected.resetsAt

/** Build one vendor's subscription-usage snapshot case. */
export const makeSubscriptionUsageConformanceCase = <Settings, R>(
  spec: SubscriptionUsageConformanceSpec<Settings, R>
): SubscriptionUsageConformanceCase<R> =>
  defineConformanceCase({
    id: spec.id,
    title: spec.title,
    safety: 'read',
    docs: spec.docs,
    wire: `The fetcher (default URL) succeeds with a snapshot for provider \`${spec.providerId}\` carrying at least one window; window ids are distinct, drawn from ${spec.windowIds.map(id => `\`${id}\``).join(', ')}, and listed in that order. No window is fabricated or dropped: the case reads the same response body at its own HttpClient boundary (handing the provider the same bytes) and requires exactly one JSON body whose reported windows (those with a numeric used percentage from 0 to 100) match the snapshot one for one, with the same id, used percentage, and reset instant (absent when the wire has none). ${spec.wire}`,
    fixtures: [spec.fixture],
    run: Effect.gen(function* () {
      const settings = yield* spec.settings
      const client = yield* HttpClient.HttpClient
      const bodies = yield* Ref.make<ReadonlyArray<CapturedBody>>([])

      const snapshot = yield* spec
        .fetch(settings)
        .pipe(Effect.provideService(HttpClient.HttpClient, capturingBodies(client, bodies)))

      const windows = Array.from(snapshot.windows)
      const ids = windows.map(window => window.id)

      yield* expectEqual(snapshot.provider, spec.providerId, 'expected the vendor provider id')
      yield* expectConformance(windows.length > 0, 'expected at least one usage window')
      yield* expectConformance(
        new Set(ids).size === ids.length && ids.every(id => spec.windowIds.includes(id)),
        'expected distinct window ids from the known set',
        { expected: [...spec.windowIds], actual: ids }
      )
      yield* expectEqual(
        ids,
        spec.windowIds.filter(id => ids.includes(id)),
        'expected windows in the vendor order'
      )

      const captured = yield* Ref.get(bodies)
      const [body] = captured
      const json = body === undefined ? Option.none() : decodeJson(body.text)

      if (captured.length !== 1 || Option.isNone(json)) {
        return yield* expectConformance(false, 'expected exactly one JSON usage body', {
          actual: captured.length
        })
      }

      const expected = spec.expectedWindows(json.value, snapshot.fetchedAt)

      // Only window ids are reported, never body values.
      yield* expectEqual(
        ids,
        expected.map(window => window.id),
        'expected one window per reported wire window (none fabricated, none dropped)'
      )
      yield* expectConformance(
        windows.every((window, index) => {
          const wire = expected[index]

          return wire !== undefined && sameWindow(window, wire)
        }),
        'expected each window to carry the wire used percentage and reset instant'
      )
    })
  })
