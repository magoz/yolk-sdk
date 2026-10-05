/**
 * Shared wrapper of the fixture-only stateful connector emulators (internal; used by `/dropbox`,
 * `/notion`, `/todoist`, `/telegram`, `/github`, `/google`, `/linkedin-search`, and `/mcp`, not by
 * the earlier `/fortnox` and `/microsoft` emulators, which keep their own).
 *
 * The emulator state lives in an `@emulators/core` custom runtime that the Node-only subpath
 * creates and hands in (`src/stateful-core.ts`; this module imports no Node builtin and never
 * imports the core); the request ledger, status faults, credential handling, and the
 * `/_emulate/*` control plane live here, because the core reserves `/_emulate`.
 *
 * The owner rule: response behaviour comes only from the committed conformance fixtures. Every
 * request is answered by its route or with one ledgered 400 not-emulated
 * (`{ error: { type: 'not_emulated', message } }`, `notEmulated` in the ledger). Precedence per
 * request:
 *
 * 1. route match on the raw path (path parameters decoded once; unknown routes and methods, and
 *    invalid percent-encoding, are not emulated), and the origin the route is recorded on;
 * 2. a non-empty `Authorization: Bearer` credential (never compared against anything, stored,
 *    forwarded, or ledgered) and the emulator's header rules;
 * 3. the body the route takes (none, JSON with an `application/json` media type, or raw bytes);
 * 4. the route's request-shape check, which reads no state;
 * 5. in the core runtime, the route's plan: a pure, state-reading eligibility check that refuses
 *    what the state cannot answer the way a fixture does, and otherwise returns a commit;
 * 6. the first matching status fault, decided only for an eligible request (nothing is written);
 * 7. the commit, the only step that writes.
 *
 * A request that is not emulated (steps 1 to 5) never uses up a fault. The plan, the fault
 * decision, and the commit run synchronously together, so no other request interleaves. A route
 * that throws answers an evidence-tagged 500 emulator error
 * (`responseError` in the ledger); a closed emulator answers 503. No recovery answer reads the
 * injectable clock, so a failing clock cannot change it. Every response of a matched route
 * carries `x-emulator-evidence: unverified` when the route is unverified. Ledgered bodies and
 * query parameters have credential-named keys redacted.
 *
 * Fail-closed mode (opt-in, `failClosed`; used by `/github`, `/google`, and `/linkedin-search`):
 * every route parameter has a raw pattern (matched in full), and a request is recognised only when
 * its raw path is exactly an emulated route shape under that route's method and any `Authorization`
 * header is exactly `Bearer <at least 8 non-space characters>` (a recognisable bearer, below).
 * Every other request is ledgered and answered with constant text only (`/<unrecognised>`, a
 * standard method or `<other>`, an empty query, no body, a constant reason). A recognised bearer
 * must match the RFC 6750 `b64token` syntax exactly (`^[A-Za-z0-9\-._~+/]+=*$`, at least 8
 * characters), start with a character in `[G-Zg-z\-._~+/]` other than `n`, `r`, `t`, `u`, and hold
 * at least one character outside the JSON-number alphabet `[0-9.eE+-]` (every GitHub and Google
 * token form does: `ghp_…`, `github_pat_…`, `gho_…`, `ya29.…`). So no number's text can contain it;
 * it holds no escape introducer (`%`, `\`, `"`), so no escape starts inside it; and its first
 * character is no hex digit and no JSON escape letter, so no stray `%`, `\`, or partial escape to
 * its left can complete with it, and its characters always decode in place. An `Authorization`
 * header with any other value is unrecognisable. A recognised request that repeats the bearer value
 * in its raw path, any path segment, the raw query or any query key or value, any recorded header,
 * or its body is refused and ledgered with constant text only: a standard method, the path
 * `/<unrecognised>`, its route template, an empty query, no headers or body, and a constant reason
 * (`the query repeats the credential`, for example). Each part is checked through the closure of
 * two total, lexical transforms that cannot fail: a tolerant percent-decode (every `%XX` below
 * `%80` becomes its ASCII character; any other `%` sequence is left as it is) and a tolerant
 * JSON-unescape (in any text, whether or not it parses as JSON, `\uXXXX` below `\u0080` and `\"`,
 * `\\`, `\/`, `\b`, `\f`, `\n`, `\r`, `\t` become their characters). Starting from each part's raw
 * text, either transform is applied to every text of the previous step, deduplicated, until no new
 * text appears (a fixpoint), and every text is checked for the bearer as a substring; both
 * transforms never lengthen a text and shorten it whenever they change it. So any depth of
 * percent-encoding or JSON escaping, in any order, is seen through in every part: the raw path and
 * each raw path segment, the raw query and each query key and value (already decoded once by
 * `URLSearchParams`), each recorded header, and the raw body. The work is capped at 64 rounds, 1024
 * distinct texts, or 8 Mi characters read by the transforms, whichever comes first; a part whose
 * closure hits a cap before its fixpoint counts as repeating the credential and is refused with the
 * same constant entry (uncertainty refuses, it never admits; so any part over 4 Mi characters is
 * always refused). Any other recognised request has the bearer value scrubbed from its ledgered
 * fields and every not-emulated reason (plan-time reasons included); its recorded query is keyed by
 * recorded key; a key recorded more than once lists its values in order (as a JSON array); and
 * recorded headers and query keys and values that start like JSON (`{`, `[`, `"`) are recorded
 * parsed with credential-named keys redacted at any depth, or as `<redacted>` when they do not
 * parse, whatever the header's declared format. Empty query components (a bare `?`, a stray `&`)
 * are refused. Routes check their own query and body keys with `exactQuery` and `exactBodyKeys`,
 * whose reasons never echo a request's own key (`exactQuery`'s opt-in `rawNames`, used by
 * `/linkedin-search`, also refuses a parameter name in any but its plain form, comparing the raw
 * names the wrapper hands routes as `rawQuery`). A template parameter written `{name+}` spans one
 * or more path segments (each decoded once, none may decode to a `/`). The credential helpers live
 * in `src/stateful-secrets.ts`. A route may also name decoded views of its raw body
 * (`decodedViews`, opt-in; `/google` gives the base64url-decoded MIME of a Gmail draft's
 * `message.raw`, which the provider's own wire format wraps): in fail-closed mode each view goes
 * through the same fixpoint check as the raw body, before anything is recorded, a fault is decided,
 * or anything is committed, and a hit is the same constant credential-repeat entry. A view may
 * throw to refuse a body it cannot check completely: that request is ledgered as the same constant
 * entry, as a repeat when the `DecodedViewRefusal` it threw carries cleanly decoded text holding
 * the bearer, else with the refusal's reason when the route declares it in `viewRefusalReasons` (a
 * constant the route owns, scrubbed defensively), else with
 * `the request body cannot be checked for the credential`. A route without `decodedViews` is
 * checked exactly as before. An emulator may also opt in to a per-origin bearer digest
 * (`bearerDigest`, fail-closed mode only; `/linkedin-search` uses it): routes then see a one-way
 * digest of the bearer for the origin the request arrived on (`EmulatedRequest.bearerDigest`),
 * never the bearer, so a seed can mark a key as rejected on one origin by its digest, and the
 * bearer still never reaches the state, the ledger, or `/_emulate/*`. A digest that throws or
 * repeats the bearer answers the 500 emulator error (`responseError`). Without it, routes see no
 * digest, as before.
 *
 * More opt-ins serve `/mcp`, whose JSON-RPC methods share one HTTP endpoint; a route or emulator
 * that does not take them behaves exactly as before. A route may answer several manifest rows
 * (`variants`, for example `RPC <origin><path>#<method>`): its admission names the row, which
 * becomes the request's ledger route, its coverage row, and what a fault's `match.route` compares
 * (a request refused before admission keeps the route template). A fault's `match.route` must name
 * a manifest row (a variant, or the template of a route without variants); any other value is
 * rejected when the fault is added, and `match.method` is always the HTTP method. A plan may return
 * a `StreamedCommit`: the answer it prepares, and the `commit` that writes. Faults are decided
 * against the prepared answer, and a faulted request never runs `commit`; an emulator built with
 * `makeChunkedStatefulEmulator` also takes `truncate-after-chunks` faults, which send the prepared
 * answer cut short and write nothing (one that cannot take effect answers 500 and is not used up).
 * In fail-closed mode: `constantRefusals` ledgers every refusal with constant text only
 * (`/<unrecognised>`, no query, headers, or body), so request text reaches the ledger only once a
 * route admitted the request; `guardAllHeaders` checks every request header name and value but
 * `Authorization` for a credential repeat, not only the recorded ones; and `guardOutput` checks a
 * streamed commit's prepared answer (every header and chunk) and its `persisted` texts (minted ids,
 * for example) for the bearer before any fault is decided or anything is committed, refusing a hit
 * with the constant credential-repeat entry, so no answer or stored value repeats the bearer, while
 * routes still see only its digest. `uniqueJsonKeys` refuses a JSON body in which an object repeats
 * a key (after unescaping). Routes also see every request header name
 * (`EmulatedRequest.headerNames`), never a credential value. `bearerPrefixes` (fail-closed mode
 * only) gives an origin a fixed bearer prefix (`/mcp` gives `https://useafloat.com` the Afloat key
 * prefix `afloat_`): there a bearer is recognised only as `<prefix><remainder>`, and the remainder,
 * which must itself be a recognisable bearer, is the guarded secret and the digest input.
 *
 * Resolved mode (opt-in, `resolveRequest`; not with `failClosed`; used by `/todoist` and
 * `/telegram`) serves an emulator whose credential the wrapper cannot find by itself (a Telegram
 * bot token in a path segment) or that has its own credential rules (a Todoist bearer of any 8
 * non-space characters): the emulator resolves every request itself, failing closed
 * (`StatefulResolution`): an unrecognised request is ledgered with constant text only (the method
 * as sent when standard, else `<other>`), a request it refuses before its body is read keeps its
 * scrubbed fields, and a recognised one names its route, credential-free parameters, ledger path,
 * guarded path, and the credential values to guard. Those values are scrubbed from everything the
 * ledger keeps or a refusal answers (plan-time reasons included), and a query, guarded path, or
 * body that repeats one (raw or percent-decoded once, and in any parsed JSON key, string, or
 * number) is refused with a constant reason before anything else is checked. The ledger records
 * the resolution's path and the query as sent (credential-named keys redacted), faults'
 * `match.path` compares that path, and routes and the core see it too (routes see no header
 * names and read no header but `content-type`), so the credential never reaches a route or the
 * core. The request body is read once, after the query and path checks (so a query or path refusal
 * leaves it unread, and any later refusal finds it read); a body that is already consumed or
 * locked is refused as unreadable; a refusal reason that cannot be percent-encoded (an unpaired
 * surrogate) is a handler failure (500). Fault answers and refusals are decided in the core with
 * the commit, but returned by the wrapper itself, so a reset or a close before they are read never
 * cancels them (only a commit's answer is the core's own); a core that answers without running
 * the dispatch (closed meanwhile) gives the 500 handler failure (`responseError`
 * `the route handler answered no eligibility verdict`). Resolved mode records no request
 * header (`recordHeaders` must be empty). More opt-ins, off by default: a `json-or-empty` route
 * body (JSON of any media type, or none), `makeHeaderlessStatefulEmulator` (ledger entries without
 * a `headers` field), and `errorTexts` (the texts of the recovery answers).
 *
 * @experimental
 */
import { Data, Predicate, Result } from 'effect'
import * as Schema from 'effect/Schema'
import {
  EmulatorHeaderRecord,
  answeredOutsideCore,
  emulatorJobHeader,
  handlerFailedHeader,
  handlerFailedResponse,
  isCredentialHeaderName,
  isCredentialQueryKey,
  redactCredentialFields,
  redactCredentialQuery,
  redactedCredentialValue
} from './emulator-http.ts'
import {
  emulatorEvidenceHeader,
  emulatorRouteKey,
  type EmulatorEvidence,
  type EmulatorRouteEvidence
} from './route-evidence.ts'
import {
  isRecognisableBearerValue,
  jsonRepeatsSecret,
  repeatsSecret,
  scrubSecrets,
  textRepeatsSecret,
  unrecognisedLedgerPath,
  unrecognisedMethod
} from './stateful-secrets.ts'

/** A request the emulator does not emulate, with the reason (answered 400 not-emulated). */
export class NotEmulated extends Data.TaggedClass('NotEmulated')<{ readonly reason: string }> {}

/**
 * What a route's decoded view throws to refuse a body with a reason of its own (fail-closed mode;
 * see `StatefulRouteBinding.decodedViews`). `reason` must be one of the route's declared
 * `viewRefusalReasons` (a constant the route owns, never derived from the request); `decoded` holds
 * any text the view did decode cleanly, which is still checked for the bearer first.
 */
export class DecodedViewRefusal extends Data.TaggedError('DecodedViewRefusal')<{
  readonly reason: string
  readonly decoded: ReadonlyArray<string>
}> {}

export const notEmulated = (reason: string): NotEmulated => new NotEmulated({ reason })

export const isNotEmulated = (value: unknown): value is NotEmulated => value instanceof NotEmulated

export const jsonResponse = (
  status: number,
  body: unknown,
  headers: HeadersInit = {}
): Response => {
  const responseHeaders = new Headers(headers)

  if (!responseHeaders.has('content-type')) {
    responseHeaders.set('content-type', 'application/json')
  }

  return new Response(JSON.stringify(body), { status, headers: responseHeaders })
}

/** The one answer for everything no fixture records. */
export const notEmulatedResponse = (reason: string): Response =>
  jsonResponse(400, { error: { type: 'not_emulated', message: `Not emulated: ${reason}` } })

const emulatorError = (status: number, message: string, headers: HeadersInit = {}): Response =>
  jsonResponse(status, { error: { message, type: 'emulator_error' } }, headers)

// Fault statuses are errors only (400-599), so no control answers a success no fixture records.
// One range check, so a rejection names the range actually accepted (400-599 holds no 204, 205,
// or 3xx, which the shared response-status schema otherwise excludes).
const FaultStatus = Schema.Int.check(Schema.isBetween({ minimum: 400, maximum: 599 }))

const FaultCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

const ChunkCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/**
 * Optional fault filter; an omitted field matches every request. `method` is the HTTP method
 * (never a manifest row's `RPC`). `path` is the raw request path (in resolved mode, the
 * resolution's ledger path); ending in `*`, a prefix. `route` is a manifest row path, compared
 * with the request's ledger route: the template of its matched route, or the manifest variant its
 * route admitted it as (see `StatefulRouteBinding.variants`).
 * A `route` that names no manifest row of the emulator could never match, so adding the fault
 * rejects it (a route with variants is matched by its variant rows, never its template).
 */
export const StatefulFaultMatch = Schema.Struct({
  method: Schema.optionalKey(Schema.String),
  path: Schema.optionalKey(Schema.String),
  route: Schema.optionalKey(Schema.String)
})

export type StatefulFaultMatch = typeof StatefulFaultMatch.Type

/**
 * A status fault: answer matching requests with this status (400-599), headers, and body before
 * the route runs, so nothing is written. The body defaults to an emulator-fault body
 * (`{ error: { type: 'emulator_fault', message } }`), never a guessed provider envelope. `count`
 * limits how many requests it answers (omitted: all). `match.path` is the raw request path.
 * Invalid header names or values, `location`, and framing headers are rejected.
 */
export const StatefulFault = Schema.Struct({
  kind: Schema.Literal('status'),
  status: FaultStatus,
  headers: Schema.optionalKey(EmulatorHeaderRecord),
  body: Schema.optionalKey(Schema.Json),
  match: Schema.optionalKey(StatefulFaultMatch),
  count: Schema.optionalKey(FaultCount)
})

export type StatefulFault = typeof StatefulFault.Type

/**
 * Opt-in (`makeChunkedStatefulEmulator`): send the first `chunks` body chunks of the answer a
 * streamed commit prepared (`StreamedCommit`), then close the body cleanly (a truncated answer).
 * It is decided where a status fault is, after the plan, and a truncated request writes nothing:
 * its `commit` never runs (no state, counter, or runtime change). One that cannot take effect (the
 * answer is not streamed, or has no more than `chunks` chunks) answers the 500 emulator error and
 * is not used up, never a silent no-op.
 */
export const StatefulTruncateFault = Schema.Struct({
  kind: Schema.Literal('truncate-after-chunks'),
  chunks: ChunkCount,
  match: Schema.optionalKey(StatefulFaultMatch),
  count: Schema.optionalKey(FaultCount)
})

export type StatefulTruncateFault = typeof StatefulTruncateFault.Type

/** A status fault, or (`makeChunkedStatefulEmulator`) a truncation fault. */
export const StatefulStreamFault = Schema.Union([StatefulFault, StatefulTruncateFault])

export type StatefulStreamFault = typeof StatefulStreamFault.Type

export type StatefulFaultState<Fault = StatefulFault> = {
  readonly id: number
  readonly fault: Fault
  /** Remaining matching requests; `undefined` for an unlimited fault. */
  readonly remaining: number | undefined
  readonly applied: number
}

export type StatefulLedgerEntry = {
  /** 1-based arrival order since the last ledger clear or reset. */
  readonly seq: number
  readonly method: string
  /**
   * Raw request path; in fail-closed mode with guarded secrets scrubbed, in resolved mode the
   * resolution's ledger path (scrubbed), and `/<unrecognised>` for an unrecognised request.
   */
  readonly path: string
  /** Path template of the matched route. */
  readonly route?: string
  /** Query parameters; the values of credential-named keys are `<redacted>`. */
  readonly query: Readonly<Record<string, string>>
  /** Parsed JSON request body, with credential-named keys redacted at any depth. */
  readonly body?: Schema.Json
  /** Length of a raw (non-JSON) request body. */
  readonly bodyBytes?: number
  /**
   * The non-credential request headers the emulator records (lower-case names); a JSON header is
   * recorded with credential-named keys redacted at any depth, or as `<redacted>` when unparseable.
   */
  readonly headers: Readonly<Record<string, string>>
  readonly status: number
  /** Evidence of the matched route; `unknown-route` for requests on no route. */
  readonly evidence: EmulatorEvidence | 'unknown-route'
  /** Why the request was answered 400 not-emulated. */
  readonly notEmulated?: string
  /** Set when a fault answered the request (`truncate-after-chunks` cut its streamed body). */
  readonly fault?: 'status' | 'truncate-after-chunks'
  /** Set when the emulator could not build the response, or a route threw (answered 500). */
  readonly responseError?: string
}

export type StatefulRouteCoverage = EmulatorRouteEvidence & {
  /** Ledger requests on this route since the last ledger clear or reset. */
  readonly requests: number
}

export type StatefulCoverage = {
  readonly routes: ReadonlyArray<StatefulRouteCoverage>
  /** Ledger requests on no route. */
  readonly unknownRouteRequests: number
  /** Ledger requests answered 400 not-emulated (on a route or not). */
  readonly notEmulatedRequests: number
}

/**
 * A ledger entry of an emulator built with `makeHeaderlessStatefulEmulator`, which records no
 * request header and takes status faults only: the entry carries no `headers` field, no
 * `bodyBytes` (it has no `bytes` routes), and only a `status` fault.
 */
export type StatefulHeaderlessLedgerEntry = Omit<
  StatefulLedgerEntry,
  'headers' | 'bodyBytes' | 'fault'
> & {
  /** Set when a fault answered the request. */
  readonly fault?: 'status'
}

/** One routed API request, as a route sees it. */
export type EmulatedRequest = {
  readonly method: string
  /** Raw (still percent-encoded) path; in resolved mode, the resolution's ledger path. */
  readonly path: string
  /**
   * Path parameters, percent-decoded once; in resolved mode (`resolveRequest`), the parameters the
   * resolution supplies (never a credential).
   */
  readonly params: Readonly<Record<string, string>>
  readonly query: URLSearchParams
  /**
   * The raw query (after `?`, before `#`, never decoded; `''` without one), as the wrapper saw it.
   * Absent on a request built elsewhere (then `exactQuery`'s `rawNames` refuses any parameter).
   */
  readonly rawQuery?: string | undefined
  /**
   * A non-credential request header (credential headers always read as `undefined`; in resolved
   * mode, every header but `content-type` does).
   */
  readonly header: (name: string) => string | undefined
  /**
   * The lower-case names of every request header, credential headers included (names only, never
   * a credential value); none in resolved mode. Absent on a request built elsewhere.
   */
  readonly headerNames?: ReadonlyArray<string> | undefined
  /** Parsed JSON body (`json` routes, and `json-or-empty` routes with a body). */
  readonly json: Schema.Json | undefined
  /** Raw body (`bytes` routes). */
  readonly bytes: Uint8Array | undefined
  /**
   * Fail-closed mode with `bearerDigest` only: the digest of the recognised bearer for the origin
   * the request arrived on (never the bearer itself); `undefined` otherwise.
   */
  readonly bearerDigest?: string | undefined
}

export type RunContext<Env> = {
  readonly env: Env
  /** Ledger sequence number of the request (for synthetic request ids). */
  readonly seq: number
}

/** The writing part of an eligible request: applies its change and answers. */
export type Commit = () => Response

/** A streamed answer: its status, headers, and body chunks (sent one per pull). */
export type StreamedAnswer = {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  /** The body chunks; none answers no body at all. */
  readonly chunks: ReadonlyArray<string>
}

/**
 * A commit whose answer the plan prepares: `answer` is sent (one chunk per pull) only after
 * `commit` has written the request's change. Because the answer exists before anything is
 * written, the wrapper decides faults against it: a status fault or a `truncate-after-chunks`
 * fault (`makeChunkedStatefulEmulator`) answers without running `commit`, so a faulted request
 * writes nothing. `persisted` lists the texts `commit` will store (minted ids, for example), which
 * the opt-in output guard (`guardOutput`) checks together with the answer.
 */
export type StreamedCommit = {
  readonly answer: StreamedAnswer
  readonly commit: () => void
  readonly persisted: ReadonlyArray<string>
}

/** A streamed commit: the prepared `answer`, and the write (none by default) it commits. */
export const streamedCommit = (
  answer: StreamedAnswer,
  commit: () => void = () => undefined,
  persisted: ReadonlyArray<string> = []
): StreamedCommit => ({ answer, commit, persisted })

/** What a plan returns: a commit, a streamed commit, or not emulated. */
export type Planned = Commit | StreamedCommit | NotEmulated

/** An admitted request: its pure, state-reading eligibility check, returning the commit. */
export type Admission<State, Env> = {
  readonly plan: (state: State, context: RunContext<Env>) => Planned
  /**
   * The path of the manifest variant the request was admitted as (`StatefulRouteBinding.variants`):
   * required when the route has variants, absent otherwise.
   */
  readonly variant?: string
}

/**
 * The body a route takes: none; JSON with an `application/json` media type; JSON of any media type
 * or none (`json-or-empty`: an empty body is no body, any other must be valid JSON, and the route
 * checks the media type itself); or raw bytes.
 */
export type RouteBody = 'none' | 'json' | 'json-or-empty' | 'bytes'

/** Route parts that are not evidence: the recorded origin and the raw parameter patterns. */
export type StatefulRouteBinding = {
  /** The origin a fixture records the route on; another origin is not emulated. Omitted: any. */
  readonly origin?: string
  /**
   * Raw (still percent-encoded) patterns of the path parameters; a parameter that does not match
   * its pattern makes the path match no route. Fail-closed emulators give every parameter one.
   */
  readonly params?: Readonly<Record<string, RegExp>>
  /**
   * Fail-closed mode only: texts the route derives from its raw body that the provider's wire
   * format encodes in a way the percent and JSON closure cannot see through (for example base64url
   * content). Each view is checked for the bearer like the raw body. A body that holds no such
   * content yields no view. A view may throw to refuse a body whose encoded content it cannot
   * check completely (for example content the route would refuse anyway); the request is then
   * ledgered as the constant credential-repeat entry shape, before anything is recorded, a fault is
   * decided, or anything is committed, with this reason:
   *
   * - `the request body repeats the credential` when the throw is a `DecodedViewRefusal` whose
   *   cleanly `decoded` texts hold the bearer (a repeat, not a refusal);
   * - otherwise its `reason` when that is one of `viewRefusalReasons` (scrubbed of the bearer,
   *   defensively);
   * - otherwise (an undeclared reason, or any other throw)
   *   `the request body cannot be checked for the credential`.
   *
   * Omitted: none.
   */
  readonly decodedViews?: (body: string) => ReadonlyArray<string>
  /**
   * The constant reasons a decoded view may refuse a body with (`DecodedViewRefusal`); any other
   * reason is replaced by the uncheckable reason. Owned by the route, never derived from a request.
   */
  readonly viewRefusalReasons?: ReadonlyArray<string>
  /**
   * Opt-in: the manifest rows this route answers INSTEAD of its own (for example one row per
   * JSON-RPC method on one HTTP endpoint, `{ method: 'RPC', path: '<origin><path>#<method>' }`).
   * Each admission names its row (`Admission.variant`), which becomes the request's ledger route,
   * its coverage row, and what a fault's `match.route` compares; a request refused before it is
   * admitted keeps the route's own template. Every variant carries the route's evidence, and no
   * variant path repeats another manifest row or a route template (checked at build). Omitted:
   * the route is its own manifest row, as before.
   */
  readonly variants?: ReadonlyArray<EmulatorRouteEvidence>
}

export type StatefulRoute<State, Env> = EmulatorRouteEvidence &
  StatefulRouteBinding & {
    readonly body: RouteBody
    /** The request-shape check (reads no state): an admission, or not emulated. */
    readonly admit: (request: EmulatedRequest, env: Env) => Admission<State, Env> | NotEmulated
  }

/**
 * A route of the table: its evidence (and recorded origin), the body it takes, its request-shape
 * check `admit` (no state), and `plan`, which only ever sees an admitted input: it reads the state
 * without writing and answers not emulated or the commit that writes.
 */
export const statefulRoute = <State, Env, Input>(
  evidence: EmulatorRouteEvidence & StatefulRouteBinding,
  body: RouteBody,
  admit: (request: EmulatedRequest, env: Env) => Input | NotEmulated,
  plan: (state: State, input: Input, context: RunContext<Env>) => Planned
): StatefulRoute<State, Env> => ({
  ...evidence,
  body,
  admit: (request, env) => {
    const input = admit(request, env)

    return isNotEmulated(input) ? input : { plan: (state, context) => plan(state, input, context) }
  }
})

/** Route evidence without the handler parts. */
export const routeEvidence = <State, Env>({
  body: _body,
  admit: _admit,
  origin: _origin,
  params: _params,
  decodedViews: _decodedViews,
  viewRefusalReasons: _viewRefusalReasons,
  variants: _variants,
  ...evidence
}: StatefulRoute<State, Env>): EmulatorRouteEvidence => evidence

/** The manifest rows of a route: its variants, or the route itself (`routeEvidence`). */
export const routeManifest = <State, Env>(
  route: StatefulRoute<State, Env>
): ReadonlyArray<EmulatorRouteEvidence> => route.variants ?? [routeEvidence(route)]

/** A percent-decoded path segment, or `undefined` for invalid percent-encoding. */
export const decodeSegment = (segment: string): string | undefined => {
  try {
    return decodeURIComponent(segment)
  } catch {
    return undefined
  }
}

// `{name}` is one path segment; `{name+}` is one or more segments.
const templatePattern = (template: string): RegExp =>
  new RegExp(
    `^${template
      .split(/(\{[A-Za-z]+\+?\})/)
      .map(part =>
        /^\{[A-Za-z]+\}$/.test(part)
          ? '([^/]+)'
          : /^\{[A-Za-z]+\+\}$/.test(part)
            ? '(.+)'
            : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      )
      .join('')}$`
  )

const templateNames = (template: string): ReadonlyArray<string> =>
  [...template.matchAll(/\{([A-Za-z]+)\+?\}/g)].map(match => match[1] ?? '')

/**
 * A multi-segment parameter decoded segment by segment (each once), or `undefined` for an empty
 * segment, invalid percent-encoding, or a segment that decodes to a `/`.
 */
const decodeSegments = (raw: string): string | undefined => {
  const segments = raw.split('/').map(segment => {
    const decoded = segment === '' ? undefined : decodeSegment(segment)

    return decoded === undefined || decoded.includes('/') ? undefined : decoded
  })

  return segments.some(segment => segment === undefined) ? undefined : segments.join('/')
}

export type MatchedRoute<State, Env> = {
  readonly route: StatefulRoute<State, Env>
  readonly params: Readonly<Record<string, string>>
}

/**
 * `pattern` required to match a whole raw parameter: `^(?:source)$` with its flags, so alternation
 * and lazy quantifiers are tried against the whole value, never against a prefix of it.
 */
const wholePattern = (pattern: RegExp): RegExp =>
  new RegExp(`^(?:${pattern.source})$`, pattern.flags)

/**
 * A matcher over a route table: the route answering `method` + raw `path`, with its parameters
 * decoded once, or `undefined` (also for a parameter that is not valid percent-encoding). A raw
 * parameter pattern must match the whole raw parameter; a pattern with the `g` or `y` flag (whose
 * matches depend on earlier ones) is refused when the matcher is built.
 */
export const routeMatcher = <State, Env>(routes: ReadonlyArray<StatefulRoute<State, Env>>) => {
  const keys = routes.map(route => emulatorRouteKey(route.method, route.path))
  const duplicate = keys.find((key, index) => keys.indexOf(key) !== index)

  if (duplicate !== undefined) {
    throw new Error(`duplicate emulator route ${duplicate}`)
  }

  for (const route of routes) {
    for (const [name, pattern] of Object.entries(route.params ?? {})) {
      if (pattern.global || pattern.sticky) {
        const where = `${route.method} ${route.path} parameter ${name}`

        throw new Error(`raw patterns take no g or y flag (${where})`)
      }
    }
  }

  const compiled = routes.map(route => ({
    route,
    pattern: templatePattern(route.path),
    names: templateNames(route.path),
    // Compiled when the matcher is built, so no request compiles a RegExp.
    whole: new Map(
      Object.entries(route.params ?? {}).map(([name, raw]) => [name, wholePattern(raw)] as const)
    ),
    multi: new Set([...route.path.matchAll(/\{([A-Za-z]+)\+\}/g)].map(match => match[1] ?? ''))
  }))

  return (method: string, path: string): MatchedRoute<State, Env> | undefined => {
    for (const candidate of compiled) {
      if (candidate.route.method !== method.toUpperCase()) continue

      const match = candidate.pattern.exec(path)

      if (match === null) continue

      const raws = candidate.names.map((name, index) => [name, match[index + 1] ?? ''] as const)

      // A raw parameter outside its pattern (matched in full) is no shape of this route.
      if (
        raws.some(([name, raw]) => {
          const pattern = candidate.whole.get(name)

          return pattern !== undefined && !pattern.test(raw)
        })
      ) {
        continue
      }

      const params: Record<string, string> = {}

      for (const [name, raw] of raws) {
        const value = candidate.multi.has(name) ? decodeSegments(raw) : decodeSegment(raw)

        if (value === undefined) return undefined

        params[name] = value
      }

      return { route: candidate.route, params }
    }

    return undefined
  }
}

/** The template parameters of a route that have no raw pattern (fail-closed emulators need one). */
export const unpatternedParams = <State, Env>(
  route: StatefulRoute<State, Env>
): ReadonlyArray<string> => templateNames(route.path).filter(name => !route.params?.[name])

const decodeJsonText = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Json))

/** Parsed JSON, or `undefined` for invalid JSON. */
export const parseJsonText = (text: string): Schema.Json | undefined => {
  const result = decodeJsonText(text)

  return Result.isSuccess(result) ? result.success : undefined
}

export const isJsonObject = (value: Schema.Json | undefined): value is Schema.JsonObject =>
  value !== undefined && value !== null && Predicate.isObject(value) && !Array.isArray(value)

/**
 * True when any object of a valid JSON text repeats a key, compared after JSON unescaping (so
 * `"id"` and `"\u0069d"` are one key). `JSON.parse` would keep the last value silently.
 */
export const repeatsJsonKey = (text: string): boolean => {
  // One entry per open object or array: an object's keys so far, and whether a key comes next.
  const open: Array<{ readonly keys: Set<string> | undefined; expectKey: boolean }> = []
  let index = 0

  while (index < text.length) {
    const character = text[index]

    if (character === '"') {
      let end = index + 1

      while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1

      const top = open.at(-1)

      if (top?.keys !== undefined && top.expectKey) {
        const key = parseJsonText(text.slice(index, end + 1))

        if (!Predicate.isString(key) || top.keys.has(key)) return true

        top.keys.add(key)
        top.expectKey = false
      }

      index = end + 1
      continue
    }

    if (character === '{') open.push({ keys: new Set(), expectKey: true })
    else if (character === '[') open.push({ keys: undefined, expectKey: false })
    else if (character === '}' || character === ']') open.pop()
    else if (character === ',') {
      const top = open.at(-1)

      if (top?.keys !== undefined) top.expectKey = true
    }

    index += 1
  }

  return false
}

/** The media type of a `content-type` value (lower-case, without parameters). */
export const mediaType = (value: string | undefined): string =>
  (value ?? '').split(';')[0]?.trim().toLowerCase() ?? ''

/**
 * A JSON object with exactly the `required` keys plus any of the `optional` ones, or not
 * emulated (naming the first missing or unknown key).
 */
export const exactObject = (
  value: Schema.Json | undefined,
  label: string,
  required: ReadonlyArray<string>,
  optional: ReadonlyArray<string> = []
): Schema.JsonObject | NotEmulated => {
  if (!isJsonObject(value)) return notEmulated(`${label} must be a JSON object`)

  const unknown = Object.keys(value).find(key => !required.includes(key) && !optional.includes(key))

  if (unknown !== undefined) return notEmulated(`${label} key '${unknown}' is not emulated`)

  const missing = required.find(key => !(key in value))

  return missing === undefined
    ? value
    : notEmulated(`${label} without '${missing}' is not emulated`)
}

/**
 * Constant-text shape check (for fail-closed emulators): a JSON object with exactly the `required`
 * keys plus any of the `optional` ones, or not emulated. Unlike `exactObject`, a reason never
 * echoes a request's own key; it names only `label` and a missing key from the route's own list.
 */
export const exactBodyKeys = (
  value: Schema.Json | undefined,
  label: string,
  required: ReadonlyArray<string>,
  optional: ReadonlyArray<string> = []
): Schema.JsonObject | NotEmulated => {
  if (!isJsonObject(value)) return notEmulated(`${label} must be a JSON object`)

  const keys = Object.keys(value)

  if (keys.some(key => !required.includes(key) && !optional.includes(key))) {
    return notEmulated(`${label} has a key this route does not take`)
  }

  const missing = required.find(key => !keys.includes(key))

  return missing === undefined
    ? value
    : notEmulated(`${label} without '${missing}' is not emulated`)
}

/** Options of `exactQuery`. */
export type ExactQueryOptions = {
  /**
   * Opt-in: every raw parameter name (before `URLSearchParams` decodes it) must be written exactly
   * as the route names it, so a percent-encoded or `+`-spaced spelling of an accepted name is not
   * emulated. Omitted: names are compared decoded, as before.
   */
  readonly rawNames?: boolean
  /**
   * Opt-in: these keys (each also listed in `required` or `optional`) may occur more than once.
   * They are left out of the returned record; a route reads them in order with
   * `request.query.getAll`. Omitted: every key occurs once, as before.
   */
  readonly repeatable?: ReadonlyArray<string>
}

/** The raw parameter names of a raw query, in order (`[]` for an empty query). */
const rawQueryNames = (raw: string): ReadonlyArray<string> =>
  raw === '' ? [] : raw.split('&').map(component => component.split('=', 1)[0] ?? '')

/**
 * Constant-text query check (for fail-closed emulators): exactly the `required` query keys plus
 * any of the `optional` ones, each once, as a record of their values; or not emulated. A reason
 * never echoes a request's own key; it names only a missing key from the route's own list. With
 * `rawNames`, every raw parameter name must also be the plain name it decodes to; with
 * `repeatable`, the listed keys may repeat and are read with `request.query.getAll` instead.
 */
export const exactQuery = (
  request: EmulatedRequest,
  required: ReadonlyArray<string>,
  optional: ReadonlyArray<string> = [],
  options: ExactQueryOptions = {}
): Readonly<Record<string, string>> | NotEmulated => {
  const keys = [...request.query.keys()]
  const repeatable = options.repeatable ?? []
  const once = keys.filter(key => !repeatable.includes(key))

  if (once.length !== new Set(once).size) {
    return notEmulated('repeated query parameters are not emulated')
  }

  if (keys.some(key => !required.includes(key) && !optional.includes(key))) {
    return notEmulated('a query parameter this route does not take is not emulated')
  }

  if (options.rawNames === true) {
    const raw = rawQueryNames(request.rawQuery ?? '')

    if (raw.length !== keys.length || raw.some((name, index) => name !== keys[index])) {
      return notEmulated('a query parameter name in any but its plain form is not emulated')
    }
  }

  const missing = required.find(key => !keys.includes(key))

  return missing === undefined
    ? Object.fromEntries([...request.query].filter(([key]) => !repeatable.includes(key)))
    : notEmulated(`requests without query parameter ${missing} are not emulated on this route`)
}

/** An integer in `[minimum, maximum]`, or not emulated. */
export const integerIn = (
  value: Schema.Json | undefined,
  label: string,
  minimum: number,
  maximum: number
): number | NotEmulated =>
  Predicate.isNumber(value) && Number.isSafeInteger(value) && value >= minimum && value <= maximum
    ? value
    : notEmulated(`${label} must be an integer from ${minimum} to ${maximum}`)

/** Error-input kinds of the JS API. */
export type StatefulInputKind = 'seed' | 'fault' | 'option'

/** The core runtime the Node subpath creates (state, snapshot, restore), as the wrapper uses it. */
export type StatefulCore<State> = {
  readonly fetch: (request: Request) => Promise<Response>
  readonly baseUrl: string
  readonly snapshot: () => State
  readonly restore: (state: State) => Promise<void>
  readonly close: () => Promise<void>
}

/**
 * What the core runs for a request the wrapper forwarded: `(state, request)` to a response. The
 * Node subpath registers it as the core app's only route.
 */
export type CoreDispatch<State> = (state: State, request: Request) => Response

/** A request header the ledger records. */
export type RecordedHeader = { readonly name: string; readonly json: boolean }

/**
 * Fail-closed mode: the constant reasons ledgered and answered for an unrecognised request (no
 * emulated route shape) and for an unrecognisable `Authorization` header. Nothing the request
 * carries is ledgered or answered for either.
 */
export type StatefulFailClosed = {
  readonly unrecognised: string
  readonly unrecognisedAuthorization: string
}

/**
 * Resolved mode: what the emulator's `resolveRequest` decides for one API request, failing closed.
 *
 * - `unrecognised`: the raw request matches no emulated route shape exactly (or its credential
 *   cannot be extracted). It is ledgered and answered with constant text only
 *   (`/<unrecognised>`, the method as sent when it is a standard one, else `<other>`, an empty
 *   query, no headers or body, the constant `reason`).
 * - `refused`: a recognised route refuses the request before its body is read (a missing
 *   credential, a query key it does not take); the entry keeps the request's scrubbed fields.
 * - `route`: a recognised request, handed to `route` with the credential-free `params`.
 *
 * For `refused` and `route`, `ledgerPath` is the path the ledger records (and a fault's
 * `match.path` compares), with the credential already replaced by the emulator if the path carries
 * it; `secrets` are the credential values the emulator took from the recognised shape (a path
 * segment, a header), which the wrapper scrubs from everything it ledgers or answers and refuses
 * to see repeated. `guardedPath` is the request text besides the query that must not repeat a
 * secret (the path without the segment that carries the credential, for example).
 */
export type StatefulResolution<State, Env> =
  | { readonly kind: 'unrecognised'; readonly reason: string }
  | {
      readonly kind: 'refused'
      readonly route: StatefulRoute<State, Env>
      readonly ledgerPath: string
      readonly reason: string
      readonly secrets: ReadonlyArray<string>
    }
  | {
      readonly kind: 'route'
      readonly route: StatefulRoute<State, Env>
      readonly params: Readonly<Record<string, string>>
      readonly ledgerPath: string
      readonly guardedPath: string
      readonly secrets: ReadonlyArray<string>
    }

/**
 * The emulator-owned texts of its recovery answers
 * (`{ error: { type: 'emulator_error', message } }`): `failed` when a response cannot be built or a
 * route throws (500), `closed` after `close` (503), and `unhandled` when handling the request
 * itself fails (500).
 */
export type StatefulErrorTexts = {
  readonly failed: string
  readonly closed: string
  readonly unhandled: string
}

const defaultErrorTexts: StatefulErrorTexts = {
  failed: 'the emulator could not build the response',
  closed: 'the emulator is closed',
  unhandled: 'the emulator failed to handle the request'
}

export type StatefulEmulatorConfig<State, Env> = {
  readonly routes: ReadonlyArray<StatefulRoute<State, Env>>
  readonly env: Env
  readonly initial: State
  /** Decode and build a seed; a string is why it is invalid. */
  readonly buildSeed: (input: unknown) => State | string
  /** Header rules every request must meet (after the credential); a string is not emulated. */
  readonly requestProblem?: (header: (name: string) => string | undefined) => string | undefined
  /**
   * Non-credential request headers the ledger records (lower-case names). A `json` header is
   * parsed and its credential-named keys redacted at any depth; an unparseable value is recorded
   * as `<redacted>`. A credential header name is refused when the emulator is built.
   */
  readonly recordHeaders: ReadonlyArray<RecordedHeader>
  /**
   * Opt-in fail-closed mode (see the module header): constant-text ledger entries for unrecognised
   * requests and Authorization headers, and the bearer value guarded as a secret. Every route
   * parameter must have a raw pattern (checked when the emulator is built).
   */
  readonly failClosed?: StatefulFailClosed
  /**
   * Opt-in resolved mode (not with `failClosed`; checked when the emulator is built), for an
   * emulator whose credential the wrapper cannot find by itself (a token in a path segment) or
   * that has its own credential rules: the emulator resolves every API request itself
   * (`StatefulResolution`) instead of the wrapper's route match and `Authorization` handling, and
   * names the credential values to guard. The wrapper then records the resolution's ledger path
   * and the query as sent (credential-named keys redacted), both scrubbed of the secrets, matches a
   * fault's `match.path` against that ledger path, and refuses, before the request headers are
   * checked or the body is parsed, a recognised request that repeats a secret: the raw query, the
   * `guardedPath`, or the body, each raw or percent-decoded once (`repeatsSecret`), and a JSON body
   * also in any key, string, or number once parsed and as it would be recorded
   * (`jsonRepeatsSecret`). Those refusals keep the request's scrubbed fields and never record the
   * body. Routes see the ledger path and no header names; fault answers and refusals are returned
   * outside the core; `recordHeaders` must be empty (checked at build). See the module header.
   * Omitted: the wrapper matches routes itself, as before.
   */
  readonly resolveRequest?: (request: Request, url: URL) => StatefulResolution<State, Env>
  /**
   * Opt-in: the texts of the emulator's recovery answers (`StatefulErrorTexts`). Omitted: the
   * default texts, as before.
   */
  readonly errorTexts?: StatefulErrorTexts
  /**
   * Opt-in, fail-closed mode only (checked when the emulator is built): a one-way digest of a
   * recognised bearer for the origin the request arrived on, handed to routes as
   * `EmulatedRequest.bearerDigest`, never the bearer itself. A route compares it with digests its
   * state holds (for example of the keys a seed marks as rejected on one origin), so a credential
   * can change an answer without the bearer reaching the state, the ledger, or `/_emulate/*`.
   * Taking the origin makes the digest per origin: one key gives different digests on two origins.
   * A digest that throws or repeats the bearer (through the closure) answers the 500 emulator
   * error before the route's shape check (no fault used, nothing written). Omitted: routes see no
   * digest, as before.
   */
  readonly bearerDigest?: (bearer: string, origin: string) => string
  /**
   * Opt-in, fail-closed mode only (checked at build): per arrival origin, a fixed literal prefix
   * (1 to 32 `b64token` characters) every bearer on that origin must start with. On such an origin
   * an `Authorization` header is recognised only as `Bearer <prefix><remainder>`, and the
   * REMAINDER, not the whole bearer, must be a recognisable bearer (`isRecognisableBearerValue`):
   * it is the guarded secret (checked for repeats, scrubbed, never stored) and what `bearerDigest`
   * receives. A bearer without the prefix is an unrecognisable `Authorization` header there. This
   * serves keys whose fixed public prefix starts with a hex digit or an escape letter (an Afloat
   * `afloat_` key), whose secret part is guarded instead, as resolved mode guards a Telegram bot
   * token's secret part. Other origins keep the plain rule. Omitted: the plain rule everywhere, as
   * before.
   */
  readonly bearerPrefixes?: Readonly<Record<string, string>>
  /**
   * Opt-in, fail-closed mode only (checked at build): every refusal is ledgered with constant text
   * only, like an unrecognised request (`/<unrecognised>`, a standard method or `<other>`, an
   * empty query, no headers or body), keeping only its constant route (template or variant) and
   * reason, so a ledger entry holds request text only once the route admitted the request. Route
   * reasons must then be constants. Omitted: refusals keep the request's recorded fields, as
   * before.
   */
  readonly constantRefusals?: boolean
  /**
   * Opt-in, fail-closed mode only (checked at build): every request header other than
   * `Authorization`, its name and its value, is checked for a credential repeat through the
   * closure (not only the recorded headers), independently of what the ledger records; a repeat is
   * refused with the constant credential-repeat entry (`a request header repeats the credential`).
   * Omitted: only the recorded headers are checked, as before.
   */
  readonly guardAllHeaders?: boolean
  /**
   * Opt-in, fail-closed mode only (checked at build): a recognised request's prepared output must
   * not repeat its bearer. Every plan answers a `StreamedCommit` (a plain `Commit` answers the 500
   * emulator error), and before any fault is decided or anything is committed, every answer header
   * name and value, every answer chunk, and every `persisted` text are checked for the bearer
   * through the closure; a hit is refused with the constant credential-repeat entry
   * (`the answer would repeat the credential`), no fault used and nothing written. Routes still see
   * only the bearer's digest. Omitted: answers are not checked, as before.
   */
  readonly guardOutput?: boolean
  /**
   * Opt-in: a JSON body in which any object repeats a key (after JSON unescaping, so `"id"` and
   * `"\u0069d"` are one key) is not emulated (`a JSON body with a repeated key is not emulated`),
   * instead of `JSON.parse` keeping the last value. Omitted: the last value wins, as before.
   */
  readonly uniqueJsonKeys?: boolean
  /** Clear runtime data (cursors) on reset and seed. */
  readonly clearRuntime: () => void
  /** Extra `/_emulate/state` fields (runtime data). */
  readonly runtimeState: () => Schema.JsonObject
  /** The `/_emulate/seed` answer for a new state. */
  readonly seedSummary: (state: State) => Schema.JsonObject
  readonly inputInvalid: (input: StatefulInputKind, reason: string) => Error
}

export type StatefulEmulatorApi<State, Seed, Fault = StatefulFault, Entry = StatefulLedgerEntry> = {
  /**
   * The fetch handler (API routes and `/_emulate/*`); a request arrives on the origin of its URL.
   * Never rejects.
   */
  readonly fetch: (request: Request) => Promise<Response>
  /**
   * The fetch handler for requests that arrive on `origin` whatever their URL says (serve it on
   * a loopback server behind `EmulatedHttpClient`, which rewrites the origin). Never rejects.
   */
  readonly fetchOn: (origin: string) => (request: Request) => Promise<Response>
  readonly ledger: {
    readonly entries: () => ReadonlyArray<Entry>
    readonly clear: () => void
  }
  readonly faults: {
    /** Add a fault; throws the emulator's input-invalid error for an invalid fault. */
    readonly add: (fault: Fault) => StatefulFaultState<Fault>
    readonly list: () => ReadonlyArray<StatefulFaultState<Fault>>
    readonly clear: () => void
  }
  /** Restore the current seed and clear the ledger, faults, and runtime data (cursors). */
  readonly reset: () => Promise<void>
  /**
   * Replace the state with a new seed, which becomes what `reset` restores (runtime data is
   * cleared). Rejects with the emulator's input-invalid error for an invalid seed.
   */
  readonly seed: (seed: Seed) => Promise<void>
  /** A deep copy of the current state. */
  readonly snapshot: () => State
  readonly coverage: () => StatefulCoverage
  /** Close the core runtime. Later requests answer 503. Idempotent. */
  readonly close: () => Promise<void>
}

const strict = { onExcessProperty: 'error' } as const

const decodeFault = Schema.decodeUnknownResult(StatefulFault, strict)

const decodeFaultList = Schema.decodeUnknownResult(
  Schema.Union([StatefulFault, Schema.Struct({ faults: Schema.Array(StatefulFault) })]),
  strict
)

const decodeStreamFault = Schema.decodeUnknownResult(StatefulStreamFault, strict)

const decodeStreamFaultList = Schema.decodeUnknownResult(
  Schema.Union([StatefulStreamFault, Schema.Struct({ faults: Schema.Array(StatefulStreamFault) })]),
  strict
)

const issueMessage = (issue: Schema.SchemaError['issue']): string =>
  new Schema.SchemaError(issue).message

// A non-empty bearer credential. The value is never checked, stored, forwarded, or ledgered.
const bearerPattern = /^bearer\s+\S+/i

/**
 * Fail-closed mode: exactly `Bearer `, one space, and one token of at least 8 non-space characters
 * (no other scheme spelling, no extra words, so combined duplicate headers never match). The token
 * must also match the RFC 6750 `b64token` syntax, start with a character that completes no escape
 * (not a hex digit, not `n`, `r`, `t`, `u`), and hold a character outside the JSON-number alphabet
 * (`isRecognisableBearerValue`, which says why). The value is guarded, never compared against
 * anything, stored, or ledgered.
 */
const recognisableBearerPattern = /^Bearer ([^\s]{8,})$/

/**
 * The fail-closed secret of an `Authorization` header, or `undefined` when unrecognisable. Without
 * a `prefix` it is the whole bearer. With one (`bearerPrefixes`, for the origin the request arrived
 * on) the bearer must be `<prefix><remainder>`, and the secret is the remainder: it, not the
 * bearer, must be recognisable (a key whose fixed prefix starts with a hex digit or an escape
 * letter guards its secret part, the Telegram precedent).
 */
const recognisableBearer = (
  authorization: string | null,
  prefix: string | undefined
): string | undefined => {
  const bearer = recognisableBearerPattern.exec(authorization ?? '')?.[1]

  if (bearer === undefined) return undefined

  const secret =
    prefix === undefined ? bearer : bearer.startsWith(prefix) ? bearer.slice(prefix.length) : ''

  return isRecognisableBearerValue(secret) ? secret : undefined
}

/** A `bearerPrefixes` prefix: 1 to 32 `b64token` characters (no `=`). */
const bearerPrefixPattern = /^[A-Za-z0-9\-._~+/]{1,32}$/

/** The raw query of a request URL (after `?`, before `#`), or `undefined` when it has none. */
const rawQuery = (requestUrl: string): string | undefined => {
  const withoutFragment = requestUrl.split('#', 1)[0] ?? ''
  const start = withoutFragment.indexOf('?')

  return start === -1 ? undefined : withoutFragment.slice(start + 1)
}

/** True for a bare `?` or an empty `&`-separated component (`URLSearchParams` drops both). */
const hasEmptyQueryComponent = (requestUrl: string): boolean => {
  const query = rawQuery(requestUrl)

  return query !== undefined && query.split('&').some(component => component === '')
}

/**
 * Fail-closed mode: a query key or value or a header value that starts like a JSON object, array,
 * or string (`{`, `[`, `"`) is recorded parsed with credential-named keys redacted at any depth, or
 * whole as `<redacted>` when it does not parse; any other text (numbers included) is recorded
 * unchanged. A request whose text repeats a guarded secret never gets here: it is ledgered with
 * constant text only.
 */
const recordedJsonLooking = (text: string): string => {
  const trimmed = text.trimStart()

  if (!trimmed.startsWith('{') && !trimmed.startsWith('[') && !trimmed.startsWith('"')) {
    return text
  }

  const parsed = parseJsonText(text)

  return parsed === undefined
    ? redactedCredentialValue
    : JSON.stringify(redactCredentialFields(parsed))
}

/**
 * Fail-closed mode: the recorded query, built from every original pair (never one value per key)
 * and keyed by recorded key: credential-named keys have their values redacted, keys and values are
 * recorded as `recordedJsonLooking` does, and a key recorded more than once (two original keys may
 * record alike, for example two unparseable JSON-looking keys as `<redacted>`) lists its values in
 * order, as a JSON array.
 */
const recordedQueryPairs = (
  query: URLSearchParams,
  scrub: (text: string) => string
): Readonly<Record<string, string>> => {
  const values = new Map<string, Array<string>>()

  for (const [key, value] of query) {
    const recordedKey = scrub(recordedJsonLooking(key))

    const recordedValue = scrub(
      isCredentialQueryKey(key) ? redactedCredentialValue : recordedJsonLooking(value)
    )

    values.set(recordedKey, [...(values.get(recordedKey) ?? []), recordedValue])
  }

  return Object.fromEntries(
    [...values].map(([key, list]) => [
      key,
      list.length === 1 ? (list[0] ?? '') : JSON.stringify(list)
    ])
  )
}

/** The constant reason of a body a route's decoded view refuses to check (the view threw). */
const uncheckableBodyReason = 'the request body cannot be checked for the credential'

const missingBearerReason =
  'requests without Authorization: Bearer <token of at least 8 characters> are not emulated'

const pathMatches = (pattern: string, path: string): boolean =>
  pattern.endsWith('*') ? path.startsWith(pattern.slice(0, -1)) : pattern === path

const faultMatches = (
  fault: StatefulStreamFault,
  method: string,
  path: string,
  route: string | undefined
): boolean =>
  (fault.match?.method === undefined || fault.match.method.toUpperCase() === method) &&
  (fault.match?.path === undefined || pathMatches(fault.match.path, path)) &&
  (fault.match?.route === undefined || fault.match.route === route)

const faultBody = (status: number): Schema.Json => ({
  error: { type: 'emulator_fault', message: `Emulator fault: status ${status}.` }
})

const readText = (request: Request): Promise<string | undefined> =>
  request.text().then(
    text => text,
    () => undefined
  )

const readBytes = (request: Request): Promise<Uint8Array | undefined> =>
  request.arrayBuffer().then(
    buffer => new Uint8Array(buffer),
    () => undefined
  )

const isControlPath = (path: string): boolean =>
  path === '/_emulate' || path.startsWith('/_emulate/')

type MutableLedgerEntry = {
  seq: number
  method: string
  path: string
  route?: string
  query: Readonly<Record<string, string>>
  body?: Schema.Json
  bodyBytes?: number
  headers: Record<string, string>
  status: number
  evidence: EmulatorEvidence | 'unknown-route'
  notEmulated?: string
  fault?: 'status' | 'truncate-after-chunks'
  responseError?: string
}

type MutableFaultState = {
  readonly id: number
  readonly fault: StatefulStreamFault
  remaining: number | undefined
  applied: number
}

/** How the first matching fault shapes an eligible request's answer. */
type FaultDecision =
  | { readonly kind: 'none' }
  | { readonly kind: 'answer'; readonly response: Response }
  | { readonly kind: 'truncate'; readonly after: number }

type Job<State, Env> = {
  readonly admission: Admission<State, Env>
  /** Ledger sequence number of the request (for synthetic request ids). */
  readonly seq: number
  /**
   * Decides the first matching fault for an answer of `chunks` streamed chunks (`undefined` for an
   * answer that is not streamed), using it up when it applies.
   */
  readonly decideFault: (chunks: number | undefined) => FaultDecision
  /** Guarded credential values, scrubbed from a plan's not-emulated reason. */
  readonly secrets: ReadonlyArray<string>
  notEmulated?: string
  /** Set when `guardOutput` refused the prepared output (a constant credential-repeat entry). */
  credentialRepeat?: boolean
  /** Resolved mode: the fault's answer, decided in the core but returned outside it. */
  faultAnswer?: Response
  /** Set when the core ran the dispatch for this job (it may answer without it, when closed). */
  dispatched?: boolean
}

const withEvidence = (response: Response, evidence: EmulatorEvidence): Response => {
  const headers = new Headers(response.headers)

  if (evidence === 'unverified') {
    headers.set(emulatorEvidenceHeader, 'unverified')
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  })
}

/**
 * The recorded query: credential-named keys redacted, and any value that parses as a JSON object or
 * array (Dropbox's browser-style `arg` parameter, for example) recorded with its credential-named
 * keys redacted at any depth, and a JSON-looking value that does not parse recorded as `<redacted>`,
 * as a recorded JSON header is.
 */
const recordedQuery = (query: URLSearchParams): Readonly<Record<string, string>> =>
  Object.fromEntries(
    Object.entries(redactCredentialQuery(query)).map(([key, value]) => {
      if (!value.trimStart().startsWith('{') && !value.trimStart().startsWith('[')) {
        return [key, value]
      }

      // A JSON-looking value that does not parse cannot be redacted field by field: record it
      // whole as redacted, as a recorded JSON header is.
      const parsed = parseJsonText(value)

      return [
        key,
        parsed === undefined
          ? redactedCredentialValue
          : JSON.stringify(redactCredentialFields(parsed))
      ]
    })
  )

/** A recorded header value: JSON with credential-named keys redacted, or the plain value. */
const recordedHeaderValue = (header: RecordedHeader, value: string): string => {
  if (!header.json) return value

  const parsed = parseJsonText(value)

  return parsed === undefined
    ? redactedCredentialValue
    : JSON.stringify(redactCredentialFields(parsed))
}

/** The request text a ledger entry records (constant in a `constantRefusals` refusal). */
type RecordedFields = Pick<MutableLedgerEntry, 'method' | 'path' | 'query' | 'headers'> & {
  body?: Schema.Json
  bodyBytes?: number
}

/** `constantRefusals`: a refused request's entry keeps only constant text. */
const blankEntry = (entry: MutableLedgerEntry) => {
  entry.method = unrecognisedMethod(entry.method.toUpperCase())
  entry.path = unrecognisedLedgerPath
  entry.query = {}
  entry.headers = {}
  delete entry.body
  delete entry.bodyBytes
}

const snapshotEntry = (entry: MutableLedgerEntry): StatefulLedgerEntry => ({
  ...entry,
  query: { ...entry.query },
  headers: { ...entry.headers }
})

/** Whether an entry records no truncation fault (only a status fault, if any). */
const hasStatusFaultOnly = <Entry extends { readonly fault?: MutableLedgerEntry['fault'] }>(
  entry: Entry
): entry is Entry & { readonly fault?: 'status' } => entry.fault !== 'truncate-after-chunks'

/** `makeHeaderlessStatefulEmulator`: the entry without its (always empty) `headers` field. */
const snapshotHeaderlessEntry = ({
  headers: _headers,
  bodyBytes: _bodyBytes,
  ...entry
}: MutableLedgerEntry): StatefulHeaderlessLedgerEntry => {
  const copy = { ...entry, query: { ...entry.query } }

  if (hasStatusFaultOnly(copy)) return copy

  // Unreachable: a headerless emulator decodes status faults only.
  throw new Error('a headerless stateful emulator records status faults only')
}

/**
 * Resolved mode: the constant reason when the raw query or the resolution's `guardedPath` repeats a
 * guarded secret (`repeatsSecret`: raw, and percent-decoded once), or `undefined`. Checked before
 * the body is read, so such a refusal leaves the request body unread.
 */
const partsCredentialRepeat = (
  url: URL,
  guardedPath: string,
  secrets: ReadonlyArray<string>
): string | undefined => {
  if (repeatsSecret(url.search, secrets)) return 'the query repeats the credential'

  return repeatsSecret(guardedPath, secrets) ? 'the request path repeats the credential' : undefined
}

/**
 * Resolved mode: the constant reason when the body text repeats a guarded secret, or `undefined`:
 * `repeatsSecret` on the raw text, and for a body that parses as JSON also `jsonRepeatsSecret`
 * (every key, string, and number) and as it would be recorded. A body that cannot be read or parsed
 * is left to the route's body check.
 */
const bodyCredentialRepeat = (
  text: string | undefined,
  secrets: ReadonlyArray<string>
): string | undefined => {
  if (text === undefined || text === '') return undefined

  const repeat = 'the request body repeats the credential'

  if (repeatsSecret(text, secrets)) return repeat

  const json = parseJsonText(text)

  // Normalised forms (`\u0051` escapes, `1.2345678e7` numbers) only show once parsed.
  return json !== undefined &&
    (jsonRepeatsSecret(json, secrets) || repeatsSecret(JSON.stringify(json), secrets))
    ? repeat
    : undefined
}

/** The body as `Request.text()` reads it: UTF-8, a leading byte order mark dropped. */
const bodyText = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

const snapshotFault = (state: MutableFaultState): StatefulFaultState<StatefulStreamFault> => ({
  ...state
})

const isStreamedCommit = (planned: Commit | StreamedCommit): planned is StreamedCommit =>
  !Predicate.isFunction(planned)

/** The constant reason of a prepared output that would repeat the bearer (`guardOutput`). */
const outputRepeatReason = 'the answer would repeat the credential'

/**
 * `guardOutput`: whether a streamed commit's answer (every header name and value, every chunk, and
 * the whole body) or any text it would persist repeats a guarded secret, through the closure.
 */
const outputRepeatsSecret = (planned: StreamedCommit, secrets: ReadonlyArray<string>): boolean => {
  const { answer } = planned

  return [
    ...Object.entries(answer.headers).flat(),
    ...answer.chunks,
    answer.chunks.join(''),
    ...planned.persisted
  ].some(text => textRepeatsSecret(text, secrets))
}

/**
 * A streamed answer's body, strictly pull-driven (one chunk per pull), closed cleanly after
 * `after` chunks when a truncation fault applies; no body at all for an answer without chunks.
 */
const streamedResponse = (answer: StreamedAnswer, after: number | undefined): Response => {
  if (answer.chunks.length === 0) {
    return new Response(null, { status: answer.status, headers: answer.headers })
  }

  const encoder = new TextEncoder()
  const sent = after === undefined ? answer.chunks : answer.chunks.slice(0, after)
  let next = 0

  const body = new ReadableStream<Uint8Array>(
    {
      pull: controller => {
        const chunk = sent[next]

        if (chunk === undefined) {
          controller.close()

          return
        }

        next += 1
        controller.enqueue(encoder.encode(chunk))
      }
    },
    { highWaterMark: 0 }
  )

  return new Response(body, { status: answer.status, headers: answer.headers })
}

/**
 * Build the wrapper over a core runtime (`makeStatefulEmulator`, with truncation faults
 * `makeChunkedStatefulEmulator`, or without ledgered headers `makeHeaderlessStatefulEmulator`).
 * `createCore` receives the dispatch the core must run for every request (its only route) and
 * returns the runtime adapter; `snapshotLedgerEntry` copies a ledger entry for readers.
 */
const buildStatefulEmulator = async <State, Env, Seed, Entry>(
  config: StatefulEmulatorConfig<State, Env>,
  createCore: (dispatch: CoreDispatch<State>) => Promise<StatefulCore<State>>,
  chunkFaults: boolean,
  snapshotLedgerEntry: (entry: MutableLedgerEntry) => Entry
): Promise<StatefulEmulatorApi<State, Seed, StatefulStreamFault, Entry>> => {
  const credentialHeader = config.recordHeaders.find(header => isCredentialHeaderName(header.name))

  if (credentialHeader !== undefined) {
    throw new Error(`the ledger never records the credential header ${credentialHeader.name}`)
  }

  if (config.resolveRequest !== undefined && config.failClosed !== undefined) {
    throw new Error('resolveRequest (resolved mode) and failClosed exclude each other')
  }

  // Resolved mode checks no request header for a credential repeat, so it records none.
  if (config.resolveRequest !== undefined && config.recordHeaders.length > 0) {
    throw new Error('resolveRequest (resolved mode) records no request header (recordHeaders)')
  }

  const resolveRequest = config.resolveRequest
  const errorTexts = config.errorTexts ?? defaultErrorTexts

  if (config.bearerDigest !== undefined && config.failClosed === undefined) {
    throw new Error('bearerDigest needs fail-closed mode (failClosed)')
  }

  if (config.bearerPrefixes !== undefined) {
    if (config.failClosed === undefined) {
      throw new Error('bearerPrefixes needs fail-closed mode (failClosed)')
    }

    for (const [origin, prefix] of Object.entries(config.bearerPrefixes)) {
      if (!URL.canParse(origin) || new URL(origin).origin !== origin) {
        throw new Error(`bearerPrefixes takes origins only (${origin})`)
      }

      if (!bearerPrefixPattern.test(prefix)) {
        throw new Error(`bearerPrefixes takes 1 to 32 b64token characters (${origin})`)
      }
    }
  }

  for (const option of ['constantRefusals', 'guardAllHeaders', 'guardOutput'] as const) {
    if (config[option] === true && config.failClosed === undefined) {
      throw new Error(`${option} needs fail-closed mode (failClosed)`)
    }
  }

  const constantRefusals = config.constantRefusals === true
  const templates = new Set(config.routes.map(route => route.path))
  const variantRows = new Set<string>()

  for (const route of config.routes) {
    if (route.variants === undefined) continue

    if (route.variants.length === 0) {
      throw new Error(`route ${route.method} ${route.path} has an empty variants list`)
    }

    for (const variant of route.variants) {
      const where = `variant ${variant.method} ${variant.path} of ${route.method} ${route.path}`

      if (variant.evidence !== route.evidence) {
        throw new Error(`${where} must carry its route's evidence`)
      }

      if (templates.has(variant.path) || variantRows.has(variant.path)) {
        throw new Error(`${where} repeats a route template or another variant path`)
      }

      variantRows.add(variant.path)
    }
  }

  if (config.failClosed !== undefined) {
    for (const route of config.routes) {
      const missing = unpatternedParams(route)

      if (missing.length > 0) {
        const where = `fail-closed route ${route.method} ${route.path}`

        throw new Error(`${where} needs raw patterns for ${missing.join(', ')}`)
      }
    }
  }

  const match = routeMatcher(config.routes)
  const manifest = config.routes.flatMap(routeManifest)
  const manifestPaths = new Set(manifest.map(row => row.path))
  const jobs = new Map<number, Job<State, Env>>()
  let nextJobId = 1

  // Plan, fault decision, and commit run synchronously together: no request interleaves.
  const dispatch: CoreDispatch<State> = (state, request) => {
    const job = jobs.get(Number(request.headers.get(emulatorJobHeader) ?? 'NaN'))

    if (job === undefined) return handlerFailedResponse()

    job.dispatched = true

    try {
      const planned = job.admission.plan(state, { env: config.env, seq: job.seq })

      if (isNotEmulated(planned)) {
        // Resolved mode keeps every refusal reason percent-encodable: one that is not (an unpaired
        // surrogate) is a handler failure.
        if (
          resolveRequest !== undefined &&
          Result.isFailure(Result.try(() => encodeURIComponent(planned.reason)))
        ) {
          return handlerFailedResponse()
        }

        const reason = scrubSecrets(planned.reason, job.secrets)

        job.notEmulated = reason

        // Resolved mode: the wrapper answers the refusal itself, outside the core.
        return resolveRequest === undefined ? notEmulatedResponse(reason) : answeredOutsideCore()
      }

      const streamed = isStreamedCommit(planned)

      // `guardOutput`: the prepared answer and the texts the commit would store must not repeat
      // the bearer; checked before any fault is decided or anything is written.
      if (config.guardOutput === true) {
        if (!streamed) return handlerFailedResponse()

        if (outputRepeatsSecret(planned, job.secrets)) {
          job.notEmulated = outputRepeatReason
          job.credentialRepeat = true

          return notEmulatedResponse(outputRepeatReason)
        }
      }

      const decision = job.decideFault(streamed ? planned.answer.chunks.length : undefined)

      if (decision.kind === 'answer') {
        if (resolveRequest === undefined) return decision.response

        // Resolved mode: the fault's answer is returned outside the core, so a reset or a close
        // before it is read never cancels it.
        job.faultAnswer = decision.response

        return answeredOutsideCore()
      }

      if (!streamed) return planned()

      // A truncated answer is the prepared one cut short; its commit never runs.
      if (decision.kind === 'truncate') return streamedResponse(planned.answer, decision.after)

      planned.commit()

      return streamedResponse(planned.answer, undefined)
    } catch {
      return handlerFailedResponse()
    }
  }

  const core = await createCore(dispatch)

  let baseline: State = config.initial
  let entries: Array<MutableLedgerEntry> = []
  let faultStates: Array<MutableFaultState> = []
  let nextSeq = 1
  let nextFaultId = 1
  let closed = false

  const clearLedger = () => {
    entries = []
    nextSeq = 1
  }

  /** Why a fault's `match.route` could never match (it names no manifest row), or `undefined`. */
  const matchRouteProblem = (fault: StatefulStreamFault): string | undefined => {
    const route = fault.match?.route

    return route === undefined || manifestPaths.has(route)
      ? undefined
      : 'match.route must name a manifest row of this emulator'
  }

  const addFault = (input: unknown): StatefulFaultState<StatefulStreamFault> | string => {
    const decoded = chunkFaults ? decodeStreamFault(input) : decodeFault(input)

    if (Result.isFailure(decoded)) {
      return issueMessage(decoded.failure.issue)
    }

    const problem = matchRouteProblem(decoded.success)

    if (problem !== undefined) return problem

    const state: MutableFaultState = {
      id: nextFaultId++,
      fault: decoded.success,
      remaining: decoded.success.count,
      applied: 0
    }

    faultStates.push(state)

    return snapshotFault(state)
  }

  const takeFault = (
    method: string,
    path: string,
    route: string | undefined
  ): MutableFaultState | undefined =>
    faultStates.find(
      state =>
        (state.remaining === undefined || state.remaining > 0) &&
        faultMatches(state.fault, method, path, route)
    )

  const spend = (state: MutableFaultState) => {
    state.applied += 1

    if (state.remaining !== undefined) {
      state.remaining -= 1
    }
  }

  /** Build the fault's response first: a response that cannot be built must not consume it. */
  const applyFault = (state: MutableFaultState, fault: StatefulFault): Response => {
    const headers = new Headers(fault.headers ?? {})
    const body = fault.body ?? faultBody(fault.status)

    if (!headers.has('content-type')) {
      headers.set('content-type', Predicate.isString(body) ? 'text/plain' : 'application/json')
    }

    const response = new Response(Predicate.isString(body) ? body : JSON.stringify(body), {
      status: fault.status,
      headers
    })

    spend(state)

    return response
  }

  const reset = async () => {
    clearLedger()
    faultStates = []
    config.clearRuntime()
    await core.restore(baseline)
  }

  const reseed = async (input: unknown): Promise<State | string> => {
    const next = config.buildSeed(input)

    if (Predicate.isString(next)) {
      return next
    }

    await core.restore(next)
    config.clearRuntime()
    baseline = next

    return next
  }

  const coverage = (): StatefulCoverage => ({
    routes: manifest.map(route => ({
      ...route,
      requests: entries.filter(
        entry =>
          entry.route === route.path &&
          (variantRows.has(route.path) || entry.method.toUpperCase() === route.method)
      ).length
    })),
    unknownRouteRequests: entries.filter(entry => entry.evidence === 'unknown-route').length,
    notEmulatedRequests: entries.filter(entry => entry.notEmulated !== undefined).length
  })

  /** The ledgered 400; the reason is scrubbed of the request's guarded secrets first. */
  const refuse = (
    entry: MutableLedgerEntry,
    reason: string,
    secrets: ReadonlyArray<string> = []
  ): Response => {
    const safe = scrubSecrets(reason, secrets)

    entry.notEmulated = safe

    return notEmulatedResponse(safe)
  }

  /**
   * Fail-closed mode: the constant reason when any part of a recognised request repeats a guarded
   * secret, or `undefined`. Checked, each through the fixpoint closure of `textRepeatsSecret` (a
   * capped closure counts as a repeat): the raw path and every path segment, the raw query and
   * every decoded query key and value, every recorded header, and the body.
   */
  const credentialRepeat = (
    request: Request,
    url: URL,
    body: string | undefined,
    secrets: ReadonlyArray<string>,
    binding: StatefulRouteBinding
  ): string | undefined => {
    if (
      textRepeatsSecret(url.pathname, secrets) ||
      url.pathname.split('/').some(segment => textRepeatsSecret(segment, secrets))
    ) {
      return 'the request path repeats the credential'
    }

    if (
      textRepeatsSecret(url.search, secrets) ||
      [...url.searchParams].some(
        ([key, value]) => textRepeatsSecret(key, secrets) || textRepeatsSecret(value, secrets)
      )
    ) {
      return 'the query repeats the credential'
    }

    if (
      config.recordHeaders.some(recorded =>
        textRepeatsSecret(request.headers.get(recorded.name) ?? '', secrets)
      )
    ) {
      return 'a recorded request header repeats the credential'
    }

    if (config.guardAllHeaders === true) {
      const headers: Array<string> = []

      request.headers.forEach((value, name) => {
        if (name !== 'authorization') headers.push(name, value)
      })

      if (headers.some(text => textRepeatsSecret(text, secrets))) {
        return 'a request header repeats the credential'
      }
    }

    if (body === undefined) return undefined

    const repeat = 'the request body repeats the credential'

    if (textRepeatsSecret(body, secrets)) return repeat

    // The route's decoded views of its body (base64url content, for example) are checked too. A
    // view that throws refuses the body (uncertainty refuses, it never admits): a repeat when what
    // it decoded cleanly holds the bearer, else its declared constant reason, else the uncheckable
    // reason, so a request without the bearer is never told it repeats it.
    const { decodedViews, viewRefusalReasons = [] } = binding
    const views = Result.try(() => (decodedViews === undefined ? [] : decodedViews(body)))

    if (Result.isFailure(views)) {
      const refusal = views.failure

      if (!(refusal instanceof DecodedViewRefusal)) return uncheckableBodyReason

      if (refusal.decoded.some(view => textRepeatsSecret(view, secrets))) return repeat

      return viewRefusalReasons.includes(refusal.reason)
        ? scrubSecrets(refusal.reason, secrets)
        : uncheckableBodyReason
    }

    return views.success.some(view => textRepeatsSecret(view, secrets)) ? repeat : undefined
  }

  /** Everything after the route match: credential, headers, body, shape, then the core. */
  const routed = async (
    request: Request,
    url: URL,
    entry: MutableLedgerEntry,
    matched: MatchedRoute<State, Env>,
    secrets: ReadonlyArray<string>,
    arrivedOn: string,
    recorded: RecordedFields,
    /** Resolved mode: the request text besides the query that must not repeat a secret. */
    guardedPath: string | undefined
  ): Promise<Response> => {
    // Resolved mode: routes read the content type only, never a header that may carry a secret.
    const header = (name: string): string | undefined =>
      isCredentialHeaderName(name) ||
      (guardedPath !== undefined && name.toLowerCase() !== 'content-type')
        ? undefined
        : (request.headers.get(name) ?? undefined)

    const refused = (reason: string) => refuse(entry, reason, secrets)

    // Resolved mode reads the request body once, after the query and path checks, and every later
    // step reuses that read (`undefined`: the body is unreadable, consumed or locked included).
    let resolvedBody: { readonly bytes: Uint8Array | undefined } | undefined

    if (guardedPath !== undefined) {
      // Resolved mode: the emulator resolved the credential; nothing may repeat it.
      const partsRepeat = partsCredentialRepeat(url, guardedPath, secrets)

      if (partsRepeat !== undefined) return refused(partsRepeat)

      resolvedBody = { bytes: await readBytes(request) }

      const bodyRepeat = bodyCredentialRepeat(
        resolvedBody.bytes === undefined ? undefined : bodyText(resolvedBody.bytes),
        secrets
      )

      if (bodyRepeat !== undefined) return refused(bodyRepeat)
    } else if (config.failClosed === undefined) {
      if (!bearerPattern.test(request.headers.get('authorization') ?? '')) {
        return refused('a non-empty Authorization: Bearer credential is required')
      }
    } else {
      // The header is absent here (an unrecognisable one never reaches a route).
      if (secrets.length === 0) return refused(missingBearerReason)

      // A request repeating the credential never gets here (see `credentialRepeat`).
      if (hasEmptyQueryComponent(request.url)) {
        return refused('empty query components (a bare ? or a stray &) are not emulated')
      }
    }

    const problem = config.requestProblem?.(header)

    if (problem !== undefined) return refused(problem)

    // Resolved mode reuses the one body read it already made. Every other emulator awaits
    // `readText(request)` directly, so its request scheduling is exactly what it was.
    const resolvedText = (): string | undefined =>
      resolvedBody?.bytes === undefined ? undefined : bodyText(resolvedBody.bytes)

    let json: Schema.Json | undefined
    let bytes: Uint8Array | undefined

    switch (matched.route.body) {
      case 'none': {
        const text = resolvedBody === undefined ? await readText(request) : resolvedText()

        if (text === undefined || text !== '') {
          return refused('this route takes no request body')
        }

        break
      }

      case 'json': {
        const text = resolvedBody === undefined ? await readText(request) : resolvedText()

        if (mediaType(header('content-type')) !== 'application/json') {
          return refused('this route takes a content-type: application/json body')
        }

        const parsed = text === undefined ? undefined : parseJsonText(text)

        if (parsed === undefined) return refused('the request body is not valid JSON')

        if (config.uniqueJsonKeys === true && text !== undefined && repeatsJsonKey(text)) {
          return refused('a JSON body with a repeated key is not emulated')
        }

        // Redacted before it is stored: a refused request's body stays in the ledger too (with
        // `constantRefusals`, only once the route admits the request).
        recorded.body = redactCredentialFields(parsed)

        if (!constantRefusals) entry.body = recorded.body

        json = parsed

        break
      }

      case 'json-or-empty': {
        const text = resolvedBody === undefined ? await readText(request) : resolvedText()

        if (text === undefined) return refused('the request body is unreadable')

        if (text === '') break

        const parsed = parseJsonText(text)

        if (parsed === undefined) return refused('the request body is not JSON')

        if (config.uniqueJsonKeys === true && repeatsJsonKey(text)) {
          return refused('a JSON body with a repeated key is not emulated')
        }

        recorded.body = redactCredentialFields(parsed)

        if (!constantRefusals) entry.body = recorded.body

        json = parsed

        break
      }

      case 'bytes': {
        bytes = resolvedBody === undefined ? await readBytes(request) : resolvedBody.bytes

        if (bytes === undefined) return refused('the request body is unreadable')

        recorded.bodyBytes = bytes.byteLength

        if (!constantRefusals) entry.bodyBytes = recorded.bodyBytes

        break
      }
    }

    // Fail-closed mode only (checked at build): the per-origin digest of the bearer, never the
    // bearer. A digest that cannot be made, or that repeats the bearer, is a handler failure.
    let bearerDigest: string | undefined
    const [bearer] = secrets

    if (config.bearerDigest !== undefined && bearer !== undefined) {
      const digest = Result.try(() => config.bearerDigest?.(bearer, arrivedOn))

      if (
        Result.isFailure(digest) ||
        !Predicate.isString(digest.success) ||
        textRepeatsSecret(digest.success, secrets)
      ) {
        entry.responseError = 'the bearer digest failed'

        return emulatorError(500, errorTexts.failed)
      }

      bearerDigest = digest.success
    }

    // Resolved mode: routes see the ledgered path and no header names, never the credential a
    // path segment or a header name may carry.
    const admitted = matched.route.admit(
      {
        method: request.method.toUpperCase(),
        path: guardedPath === undefined ? url.pathname : entry.path,
        params: matched.params,
        query: url.searchParams,
        rawQuery: rawQuery(request.url) ?? '',
        header,
        headerNames: guardedPath === undefined ? [...request.headers.keys()] : [],
        json,
        bytes,
        bearerDigest
      },
      config.env
    )

    if (isNotEmulated(admitted)) return refused(admitted.reason)

    // A route with variants admits a request as exactly one of them; a route without variants
    // admits it as none of them.
    const variants = matched.route.variants
    const variant = admitted.variant

    if (
      variants === undefined ? variant !== undefined : !variants.some(row => row.path === variant)
    ) {
      entry.responseError = 'the route admitted the request as no row of its manifest'

      return emulatorError(500, errorTexts.failed)
    }

    if (variant !== undefined) entry.route = variant

    // `constantRefusals`: the request text is recorded only now that the route admitted it.
    if (constantRefusals) {
      entry.method = recorded.method
      entry.path = recorded.path
      entry.query = recorded.query
      entry.headers = recorded.headers

      if (recorded.body !== undefined) entry.body = recorded.body

      if (recorded.bodyBytes !== undefined) entry.bodyBytes = recorded.bodyBytes
    }

    const method = request.method.toUpperCase()
    const jobId = nextJobId++
    // Resolved mode: faults match, and the core sees, the ledgered path (never the credential).
    const requestPath = guardedPath === undefined ? url.pathname : entry.path

    const job: Job<State, Env> = {
      admission: admitted,
      seq: entry.seq,
      secrets,
      decideFault: chunks => {
        const state = takeFault(method, requestPath, entry.route)

        if (state === undefined) return { kind: 'none' }

        const fault = state.fault

        if (fault.kind === 'status') {
          const response = applyFault(state, fault)

          entry.fault = 'status'

          return { kind: 'answer', response }
        }

        // A truncation that cannot take effect answers 500 and is not used up (never a no-op).
        if (chunks === undefined || fault.chunks >= chunks) {
          entry.responseError =
            `emulator fault cannot apply: truncate-after-chunks after ${fault.chunks} chunk(s) ` +
            'needs a streamed answer of more chunks'

          return { kind: 'answer', response: emulatorError(500, 'emulator fault cannot apply') }
        }

        spend(state)
        entry.fault = 'truncate-after-chunks'

        return { kind: 'truncate', after: fault.chunks }
      }
    }

    jobs.set(jobId, job)

    try {
      const response = await core.fetch(
        new Request(new URL(requestPath, core.baseUrl), {
          method: 'POST',
          headers: { [emulatorJobHeader]: String(jobId) }
        })
      )

      if (response.headers.has(handlerFailedHeader)) {
        entry.responseError = 'the route handler failed'

        return emulatorError(500, errorTexts.failed)
      }

      // Resolved mode: a core that answered without running the dispatch (closed meanwhile)
      // decided nothing about the request.
      if (guardedPath !== undefined && job.dispatched !== true) {
        entry.responseError = 'the route handler answered no eligibility verdict'

        return emulatorError(500, errorTexts.failed)
      }

      if (job.notEmulated !== undefined) {
        entry.notEmulated = job.notEmulated

        if (constantRefusals || job.credentialRepeat === true) blankEntry(entry)

        // The constant credential-repeat entry keeps the route template, as a request repeat does.
        if (job.credentialRepeat === true) entry.route = matched.route.path

        // Resolved mode: the wrapper answers the refusal itself, outside the core.
        if (guardedPath !== undefined) return notEmulatedResponse(job.notEmulated)
      }

      return job.faultAnswer ?? response
    } finally {
      jobs.delete(jobId)
    }
  }

  /**
   * Fail closed: an unrecognised request is ledgered and answered with constant text only. `method`
   * is the request method upper-cased (fail-closed mode) or as sent (resolved mode).
   */
  const unrecognised = (method: string, reason: string): Response => {
    entries.push({
      seq: nextSeq++,
      method: unrecognisedMethod(method),
      path: unrecognisedLedgerPath,
      query: {},
      headers: {},
      status: 400,
      evidence: 'unknown-route',
      notEmulated: reason
    })

    return notEmulatedResponse(reason)
  }

  const emulatedApi = async (request: Request, url: URL, arrivedOn: string): Promise<Response> => {
    const resolution = resolveRequest?.(request, url)

    // Resolved mode: the emulator's own resolution fails closed with constant text only.
    if (resolution?.kind === 'unrecognised') return unrecognised(request.method, resolution.reason)

    const matched: MatchedRoute<State, Env> | undefined =
      resolution === undefined
        ? match(request.method, url.pathname)
        : {
            route: resolution.route,
            params: resolution.kind === 'route' ? resolution.params : {}
          }

    const failClosed = config.failClosed
    let secrets: ReadonlyArray<string> = resolution?.secrets ?? []

    if (failClosed !== undefined) {
      const authorization = request.headers.get('authorization')
      const bearer = recognisableBearer(authorization, config.bearerPrefixes?.[arrivedOn])

      // Its credential cannot be extracted and scrubbed: nothing of the request is kept.
      if (authorization !== null && bearer === undefined) {
        return unrecognised(request.method.toUpperCase(), failClosed.unrecognisedAuthorization)
      }

      if (matched === undefined) {
        return unrecognised(request.method.toUpperCase(), failClosed.unrecognised)
      }

      secrets = bearer === undefined ? [] : [bearer]

      if (secrets.length > 0) {
        // Read from a copy: the route reads the body again.
        const body = request.body === null ? undefined : await readText(request.clone())
        const reason = credentialRepeat(request, url, body, secrets, matched.route)

        // Nothing of a request that repeats the credential is kept, in any part: it is ledgered
        // and answered with constant text only (its route template is constant too).
        if (reason !== undefined) {
          entries.push({
            seq: nextSeq++,
            method: unrecognisedMethod(request.method.toUpperCase()),
            path: unrecognisedLedgerPath,
            route: matched.route.path,
            query: {},
            headers: {},
            status: 400,
            evidence: matched.route.evidence,
            notEmulated: reason
          })

          return withEvidence(notEmulatedResponse(reason), matched.route.evidence)
        }
      }
    }

    const scrub = (text: string): string => scrubSecrets(text, secrets)

    // Query keys and values are scrubbed of the request's secrets before they are recorded. In
    // fail-closed mode every original pair is recorded (no pair repeats a secret by now): a key
    // that occurs more than once is recorded as a JSON array of its values, in order. Resolved
    // mode records the values as sent (credential-named keys redacted).
    const query =
      failClosed === undefined
        ? Object.fromEntries(
            Object.entries(
              resolution === undefined
                ? recordedQuery(url.searchParams)
                : redactCredentialQuery(url.searchParams)
            ).map(([key, value]) => [scrub(key), scrub(value)])
          )
        : recordedQueryPairs(url.searchParams, scrub)

    const recorded: RecordedFields = {
      method: scrub(request.method),
      path: scrub(resolution?.ledgerPath ?? url.pathname),
      query,
      headers: {}
    }

    for (const header of config.recordHeaders) {
      const value = request.headers.get(header.name)

      if (value === null) continue

      const text = recordedHeaderValue(header, value)

      // Fail-closed mode recognises a JSON-looking value whatever the header's declared format.
      recorded.headers[header.name] = scrub(
        failClosed === undefined ? text : recordedJsonLooking(text)
      )
    }

    const evidence = matched?.route.evidence ?? 'unknown-route'

    // `constantRefusals`: constant text until the route admits the request.
    const entry: MutableLedgerEntry = constantRefusals
      ? {
          seq: nextSeq++,
          method: unrecognisedMethod(request.method.toUpperCase()),
          path: unrecognisedLedgerPath,
          query: {},
          headers: {},
          status: 0,
          evidence
        }
      : resolution === undefined
        ? {
            seq: nextSeq++,
            method: recorded.method,
            path: recorded.path,
            query: recorded.query,
            headers: { ...recorded.headers },
            status: 0,
            evidence
          }
        : // Resolved mode: the route is known from the start (it keeps this position).
          {
            seq: nextSeq++,
            method: recorded.method,
            path: recorded.path,
            route: resolution.route.path,
            query: recorded.query,
            headers: { ...recorded.headers },
            status: 0,
            evidence
          }

    entries.push(entry)

    if (matched === undefined) {
      entry.status = 400

      return refuse(entry, 'no emulated route for this method and path')
    }

    entry.route = matched.route.path

    if (matched.route.origin !== undefined && matched.route.origin !== arrivedOn) {
      entry.status = 400

      return withEvidence(
        refuse(entry, `this route is recorded on ${matched.route.origin} only`, secrets),
        matched.route.evidence
      )
    }

    // Resolved mode: the emulator refused the request before its body is read.
    if (resolution?.kind === 'refused') {
      const tagged = withEvidence(
        refuse(entry, resolution.reason, secrets),
        resolution.route.evidence
      )

      entry.status = tagged.status

      return tagged
    }

    const guardedPath = resolution?.guardedPath

    // Error recovery still answers through the route: the fallback 500 is evidence-tagged and
    // the ledger records the status actually sent.
    const response = await routed(
      request,
      url,
      entry,
      matched,
      secrets,
      arrivedOn,
      recorded,
      guardedPath
    ).catch(() => {
      entry.responseError = 'the emulator could not build or produce the response'

      return emulatorError(500, errorTexts.failed)
    })

    const tagged = withEvidence(response, matched.route.evidence)

    entry.status = tagged.status

    return tagged
  }

  const controlPlane = async (request: Request, path: string): Promise<Response> => {
    const method = request.method
    const allow = (methods: string) => emulatorError(405, 'method not allowed', { allow: methods })

    const jsonBody = async (): Promise<Schema.Json | undefined> => {
      const text = await readText(request)

      return text === undefined ? undefined : parseJsonText(text)
    }

    switch (path) {
      case '/_emulate/ledger':
        if (method === 'GET') {
          return jsonResponse(200, { entries: entries.map(snapshotLedgerEntry) })
        }

        if (method === 'DELETE') {
          const cleared = entries.length

          clearLedger()

          return jsonResponse(200, { cleared })
        }

        return allow('GET, DELETE')

      case '/_emulate/faults': {
        if (method === 'GET') {
          return jsonResponse(200, { faults: faultStates.map(snapshotFault) })
        }

        if (method === 'DELETE') {
          const cleared = faultStates.length

          faultStates = []

          return jsonResponse(200, { cleared })
        }

        if (method !== 'POST') {
          return allow('GET, POST, DELETE')
        }

        const input = await jsonBody()

        const decoded = chunkFaults ? decodeStreamFaultList(input) : decodeFaultList(input)

        if (Result.isFailure(decoded)) {
          return emulatorError(400, `invalid fault: ${issueMessage(decoded.failure.issue)}`)
        }

        const faults = 'faults' in decoded.success ? decoded.success.faults : [decoded.success]
        const problem = faults.map(matchRouteProblem).find(Predicate.isString)

        // Checked before any fault is added: a list is added whole or not at all.
        if (problem !== undefined) return emulatorError(400, `invalid fault: ${problem}`)

        return jsonResponse(201, { faults: faults.map(fault => addFault(fault)) })
      }

      case '/_emulate/reset':
        if (method !== 'POST') {
          return allow('POST')
        }

        await reset()

        return jsonResponse(200, { reset: true })

      case '/_emulate/state':
        if (method !== 'GET') {
          return allow('GET')
        }

        return jsonResponse(200, {
          state: core.snapshot(),
          ...config.runtimeState(),
          faults: faultStates.map(snapshotFault),
          ledgerEntries: entries.length
        })

      case '/_emulate/seed': {
        if (method !== 'POST') {
          return allow('POST')
        }

        const next = await reseed((await jsonBody()) ?? null)

        if (Predicate.isString(next)) {
          return emulatorError(400, `invalid seed: ${next}`)
        }

        return jsonResponse(200, { seeded: true, ...config.seedSummary(next) })
      }

      case '/_emulate/coverage':
        if (method !== 'GET') {
          return allow('GET')
        }

        return jsonResponse(200, coverage())

      default:
        return emulatorError(404, 'unknown control-plane route')
    }
  }

  /**
   * Last resort when handling itself fails (for example an unparseable request URL): a 500
   * emulator error, tagged with the matched route's evidence when there is one (in resolved mode,
   * whose own resolution may be what failed, never).
   */
  const lastResort = (request: Request): Response => {
    const path = URL.canParse(request.url) ? new URL(request.url).pathname : undefined
    const failed = emulatorError(500, errorTexts.unhandled)

    if (path === undefined || isControlPath(path) || resolveRequest !== undefined) return failed

    const matched = match(request.method, path)

    return matched === undefined ? failed : withEvidence(failed, matched.route.evidence)
  }

  const handle = async (request: Request, origin: string | undefined): Promise<Response> => {
    if (closed) {
      return emulatorError(503, errorTexts.closed)
    }

    const url = new URL(request.url)

    return isControlPath(url.pathname)
      ? controlPlane(request, url.pathname)
      : emulatedApi(request, url, origin ?? url.origin)
  }

  const fetchOn =
    (origin: string | undefined) =>
    (request: Request): Promise<Response> =>
      handle(request, origin).catch(() => lastResort(request))

  return {
    fetch: fetchOn(undefined),
    fetchOn: origin => fetchOn(origin),
    ledger: {
      entries: () => entries.map(snapshotLedgerEntry),
      clear: clearLedger
    },
    faults: {
      add: fault => {
        const added = addFault(fault)

        if (Predicate.isString(added)) {
          throw config.inputInvalid('fault', added)
        }

        return added
      },
      list: () => faultStates.map(snapshotFault),
      clear: () => {
        faultStates = []
      }
    },
    reset,
    seed: async input => {
      const next = await reseed(input)

      if (Predicate.isString(next)) {
        throw config.inputInvalid('seed', next)
      }
    },
    snapshot: () => core.snapshot(),
    coverage,
    close: () => {
      closed = true

      return core.close()
    }
  }
}

/** The fault states of an emulator without truncation faults (its decoder takes status faults). */
const statusFaultStates = (
  states: ReadonlyArray<StatefulFaultState<StatefulStreamFault>>
): ReadonlyArray<StatefulFaultState> =>
  states.flatMap(state => {
    const fault = state.fault

    return fault.kind === 'status' ? [{ ...state, fault }] : []
  })

/** The API of an emulator without truncation faults: its fault methods take status faults only. */
const withStatusFaults = <State, Seed, Entry>(
  api: StatefulEmulatorApi<State, Seed, StatefulStreamFault, Entry>,
  inputInvalid: (input: StatefulInputKind, reason: string) => Error
): StatefulEmulatorApi<State, Seed, StatefulFault, Entry> => ({
  ...api,
  faults: {
    add: fault => {
      const [added] = statusFaultStates([api.faults.add(fault)])

      if (added === undefined) throw inputInvalid('fault', 'a status fault is required')

      return added
    },
    list: () => statusFaultStates(api.faults.list()),
    clear: api.faults.clear
  }
})

/**
 * Build the wrapper over a core runtime. `createCore` receives the dispatch the core must run for
 * every request (its only route) and returns the runtime adapter. Faults are status faults only.
 */
export const makeStatefulEmulator = async <State, Env, Seed>(
  config: StatefulEmulatorConfig<State, Env>,
  createCore: (dispatch: CoreDispatch<State>) => Promise<StatefulCore<State>>
): Promise<StatefulEmulatorApi<State, Seed>> =>
  withStatusFaults(
    await buildStatefulEmulator<State, Env, Seed, StatefulLedgerEntry>(
      config,
      createCore,
      false,
      snapshotEntry
    ),
    config.inputInvalid
  )

/**
 * `makeStatefulEmulator` for an emulator that records no request header (opt-in): it takes no
 * `recordHeaders`, and its ledger entries carry no `headers` field
 * (`StatefulHeaderlessLedgerEntry`). Faults are status faults only.
 */
export const makeHeaderlessStatefulEmulator = async <State, Env, Seed>(
  config: Omit<StatefulEmulatorConfig<State, Env>, 'recordHeaders'>,
  createCore: (dispatch: CoreDispatch<State>) => Promise<StatefulCore<State>>
): Promise<StatefulEmulatorApi<State, Seed, StatefulFault, StatefulHeaderlessLedgerEntry>> =>
  withStatusFaults(
    await buildStatefulEmulator<State, Env, Seed, StatefulHeaderlessLedgerEntry>(
      { ...config, recordHeaders: [] },
      createCore,
      false,
      snapshotHeaderlessEntry
    ),
    config.inputInvalid
  )

/**
 * `makeStatefulEmulator` that also takes `truncate-after-chunks` faults
 * (`StatefulTruncateFault`), which cut a streamed answer (`StreamedCommit`). Opt-in: the other
 * emulators keep status faults only.
 */
export const makeChunkedStatefulEmulator = <State, Env, Seed>(
  config: StatefulEmulatorConfig<State, Env>,
  createCore: (dispatch: CoreDispatch<State>) => Promise<StatefulCore<State>>
): Promise<StatefulEmulatorApi<State, Seed, StatefulStreamFault>> =>
  buildStatefulEmulator<State, Env, Seed, StatefulLedgerEntry>(
    config,
    createCore,
    true,
    snapshotEntry
  )

/** Throws `inputInvalid('option', ...)` unless every drill knob is a known boolean (or absent). */
export const checkBooleanDrills = (
  drills: object | undefined,
  knobs: ReadonlyArray<string>,
  inputInvalid: (input: StatefulInputKind, reason: string) => Error
): void => {
  for (const [key, value] of Object.entries(drills ?? {})) {
    if (!knobs.includes(key)) {
      throw inputInvalid('option', `unknown drill knob ${key}`)
    }

    if (value !== undefined && !Predicate.isBoolean(value)) {
      throw inputInvalid('option', `drills.${key} must be a boolean`)
    }
  }
}
