import { Cause, Clock, Data, Duration, Effect, Exit, Option, Predicate, Result } from 'effect'
import * as Schema from 'effect/Schema'
import { ToolError } from '@yolk-sdk/agent/loop'
import {
  contentText,
  TextPart,
  ToolResult,
  type Content,
  type ToolCall
} from '@yolk-sdk/agent/protocol'
import {
  compactToolArguments,
  truncateUtf8,
  truncationMarker,
  utf8ByteLength
} from '../protocol/bounded-text.ts'
import { subagentToolName } from '../protocol/tool.ts'
import type { ToolAccess } from './registry.ts'
import { sha256HexSync } from './sha256.ts'

const NonEmptyTrimmedString = Schema.Trimmed.pipe(Schema.check(Schema.isNonEmpty()))

/** Recorded failure of a ledgered call: the `ToolError` the tool failed with (never a cause chain,
 * stack, or provider body). Replays fail with the same `ToolError`.
 */
export const ToolLedgerFailure = Schema.Struct({
  tool: Schema.String,
  cause: ToolError.fields.cause,
  message: Schema.String
})

export type ToolLedgerFailure = typeof ToolLedgerFailure.Type

/** The call returned a result (possibly an `isError` result); stored bounded and wire-safe. */
export const ToolLedgerSucceeded = Schema.TaggedStruct('Succeeded', { result: ToolResult })

/** The call failed with a `ToolError`. */
export const ToolLedgerFailed = Schema.TaggedStruct('Failed', { error: ToolLedgerFailure })

/** Recorded outcome of a ledgered call: the bounded, wire-safe result or the typed failure. */
export const ToolLedgerOutcome = Schema.Union([ToolLedgerSucceeded, ToolLedgerFailed])

export type ToolLedgerOutcome = typeof ToolLedgerOutcome.Type

/**
 * One persisted ledger entry. `key` is the top-level `call.id`, or `<parentCallId>/<seq>` for a
 * nested call (then `parentKey` is the parent call id). `args` is the compact JSON of the call
 * arguments, cut to 8 KiB (an audit preview; `argsTruncated` says it was cut). `argsDigest` is the
 * SHA-256 of the full arguments' canonical JSON, a stable format (see `toolLedgerArgs`; store it
 * as text, for example `char(64)`); conflict detection compares it with the tool name, never the
 * preview. An entry without `outcome` is claimed: running under a live lease, or abandoned once
 * the lease expired. Plain wire data: persist it with `Schema.toCodecJson(ToolLedgerEntry)`.
 */
export class ToolLedgerEntry extends Schema.Class<ToolLedgerEntry>('ToolLedgerEntry')({
  key: NonEmptyTrimmedString,
  parentKey: Schema.optional(NonEmptyTrimmedString),
  toolName: NonEmptyTrimmedString,
  args: Schema.String,
  argsTruncated: Schema.Boolean,
  argsDigest: Schema.String,
  claimedAtMs: Schema.Number,
  leaseExpiresAtMs: Schema.Number,
  completedAtMs: Schema.optional(Schema.Number),
  outcome: Schema.optional(ToolLedgerOutcome)
}) {}

/**
 * What `claim` observed:
 * - `Fresh`: the entry did not exist and is now claimed by this caller, which runs the call.
 * - `Completed`: a result is recorded; it is returned without executing.
 * - `InFlight`: claimed by another execution whose lease is still live.
 * - `Abandoned`: claimed, the lease expired, and no result was recorded. The call may have been
 *   applied; it is never executed again.
 */
export type ToolLedgerClaim = Data.TaggedEnum<{
  Fresh: { readonly entry: ToolLedgerEntry }
  Completed: { readonly entry: ToolLedgerEntry; readonly outcome: ToolLedgerOutcome }
  InFlight: { readonly entry: ToolLedgerEntry }
  Abandoned: { readonly entry: ToolLedgerEntry }
}>

export const ToolLedgerClaim = Data.taggedEnum<ToolLedgerClaim>()

export class ToolLedgerError extends Schema.TaggedError<ToolLedgerError>()('ToolLedgerError', {
  message: Schema.String
}) {}

/**
 * What `claim` receives. Times come in two forms so a store can pick one clock and use it for
 * every lease: `nowMs` and `leaseExpiresAtMs` are the caller's `Clock` time (clock-agnostic
 * stores, such as the in-memory one, store and compare them as given), and `leaseMs` is the lease
 * length, for stores that use their own clock (for example a database's `now()`: lease
 * `now() + leaseMs`, classified against `now()`). Never mix the two clocks in one store.
 */
export type ToolLedgerClaimRequest = {
  readonly key: string
  readonly parentKey?: string
  readonly toolName: string
  /** Bounded preview of the arguments (`toolLedgerArgs`); store it as given. */
  readonly args: string
  /** Whether `args` was cut (`toolLedgerArgs`); store it as given. */
  readonly argsTruncated: boolean
  /** SHA-256 of the full arguments (`toolLedgerArgs`); store it as given. */
  readonly argsDigest: string
  /** The caller's `Clock` time. */
  readonly nowMs: number
  /** Lease of a fresh claim on the caller's clock: `nowMs + leaseMs`. */
  readonly leaseExpiresAtMs: number
  /** Lease length (the resolved `ToolLedgerOptions.leaseMs`), for stores using their own clock. */
  readonly leaseMs: number
}

/** What `heartbeat` receives; the clocks follow `ToolLedgerClaimRequest`. */
export type ToolLedgerHeartbeatRequest = {
  readonly key: string
  /** The extended lease on the caller's clock: its current time plus `leaseMs`. */
  readonly leaseExpiresAtMs: number
  /** Lease length, for stores using their own clock (new lease `now() + leaseMs`). */
  readonly leaseMs: number
}

type ClaimRequestFields = {
  key: string
  parentKey?: string
  toolName: string
  args: string
  argsTruncated: boolean
  argsDigest: string
  nowMs: number
  leaseExpiresAtMs: number
  leaseMs: number
}

/**
 * Host-implemented durable storage of tool calls, scoped by the host (for example one Workflow
 * run). Every operation is keyed within `scope`; never look entries up across scopes.
 *
 * - `claim` is atomic: insert a claimed entry when the key is absent (`Fresh`, persisting every
 *   request field, `argsDigest` included), else classify the existing entry without changing it
 *   (`classifyToolLedgerEntry`). Repeated claims of an existing key are reads; waiting callers
 *   poll with them.
 * - `heartbeat` extends the lease of a claimed entry without an outcome (never shortening it); it
 *   never revives or changes a completed entry.
 * - Leases use one clock per store: the caller's (`nowMs`, `leaseExpiresAtMs`) or the store's own
 *   (`leaseMs`, for example a database `now()`); `classifyToolLedgerEntry` takes that clock's time.
 * - `complete` records the outcome once; a later completion of the same key is ignored.
 * - `list` returns the entries whose `parentKey` is the given key (nested calls of one call).
 *
 * No operation ever hands a claimed entry to another execution: a claim is never taken over, so
 * heartbeats and completion need no fencing token.
 *
 * Every operation must be interruptible, for example `Effect.tryPromise` passing its
 * `AbortSignal` to the driver. The ledger's timeouts (polls within the wait, each `heartbeat` and
 * `complete` attempt bounded by `toolLedgerCompleteTimeoutMs`) interrupt the operation and wait
 * for it to stop, so they cannot cut uninterruptible store work: an `Effect.uninterruptible`
 * section, or a release or rollback that blocks, holds the wait, heartbeat, or completion (and
 * the call's interruption) until it ends.
 */
export type ToolLedgerStore = {
  /** Host scope (for example the Workflow run id); the prefix of every idempotency key. */
  readonly scope: string
  readonly claim: (
    request: ToolLedgerClaimRequest
  ) => Effect.Effect<ToolLedgerClaim, ToolLedgerError>
  readonly heartbeat: (input: ToolLedgerHeartbeatRequest) => Effect.Effect<void, ToolLedgerError>
  readonly complete: (input: {
    readonly key: string
    readonly outcome: ToolLedgerOutcome
    readonly completedAtMs: number
  }) => Effect.Effect<void, ToolLedgerError>
  readonly list: (
    parentKey: string
  ) => Effect.Effect<ReadonlyArray<ToolLedgerEntry>, ToolLedgerError>
}

/** Classifies an existing entry at `nowMs`: completed, in flight under a live lease, or
 * abandoned.
 */
export const classifyToolLedgerEntry = (entry: ToolLedgerEntry, nowMs: number): ToolLedgerClaim =>
  entry.outcome !== undefined
    ? ToolLedgerClaim.Completed({ entry, outcome: entry.outcome })
    : entry.leaseExpiresAtMs > nowMs
      ? ToolLedgerClaim.InFlight({ entry })
      : ToolLedgerClaim.Abandoned({ entry })

/** Input of the ledger policy predicate. `parentCallId` is set for nested (code mode) calls. */
export type ToolLedgerPolicyInput = {
  readonly call: ToolCall
  readonly moduleId: string
  readonly access: ToolAccess
  readonly parentCallId?: string
}

/**
 * Default policy: every tool whose access is not `read`, plus the built-in `subagent` tool. A
 * subagent call is `read` but runs a whole child run whose tool calls get fresh ids, so only
 * ledgering the call itself keeps a re-executed step from running the child (and its writes)
 * again. Hosts with their own delegation tools add them through `isLedgered`, for example
 * `input => defaultToolLedgerPolicy(input) || input.call.name === 'delegate'`.
 */
export const defaultToolLedgerPolicy = (input: ToolLedgerPolicyInput) =>
  input.access !== 'read' || input.call.name === subagentToolName

/** What an abandoned call's registration sees to build its result (see `abandonedResult`). */
export type ToolLedgerAbandonedInput = {
  readonly call: ToolCall
  readonly entry: ToolLedgerEntry
  /**
   * The call's nested entries (`list(call.id)`), ordered by sequence number; `undefined` when
   * `list` failed. Then the nested calls are unknown (any of them may have been applied): report
   * the listing as unavailable, never as empty.
   */
  readonly nested: ReadonlyArray<ToolLedgerEntry> | undefined
}

/**
 * How the ledger handled one ledgered call:
 * - `fresh`: claimed by this execution, which runs the call.
 * - `completed`: an outcome was already recorded; it is replayed without running.
 * - `in_flight_wait`: another execution was running it; this one waited and replayed its outcome.
 * - `in_flight_timeout`: another execution was running it past `maxWaitMs`/`deadline`; not run.
 * - `abandoned`: claimed earlier, lease expired, no outcome (possibly after a wait); not run.
 * - `conflict`: the key holds a different call (tool name or arguments); not run.
 */
export type ToolLedgerDecision =
  | 'fresh'
  | 'completed'
  | 'in_flight_wait'
  | 'in_flight_timeout'
  | 'abandoned'
  | 'conflict'

/** What `onLedgerDecision` receives. `waitedMs` is present when the call waited for another
 * execution (its first claim was in flight).
 */
export type ToolLedgerDecisionEvent = {
  readonly key: string
  readonly parentKey?: string
  readonly toolName: string
  readonly decision: ToolLedgerDecision
  readonly waitedMs?: number
}

type DecisionEventFields = {
  key: string
  parentKey?: string
  toolName: string
  decision: ToolLedgerDecision
  waitedMs?: number
}

/** `resolveTools` ledger option. Without it, tool execution is unchanged. */
export type ToolLedgerOptions = {
  readonly store: ToolLedgerStore
  /** Which calls are ledgered. Default `defaultToolLedgerPolicy` (every non-`read` tool and the
   * built-in `subagent` tool).
   */
  readonly isLedgered?: (input: ToolLedgerPolicyInput) => boolean
  /** Lease of a running call. Default 30000. */
  readonly leaseMs?: number
  /** Heartbeat interval while a call runs. Default a third of `leaseMs`; at most half of it. */
  readonly heartbeatIntervalMs?: number
  /** Poll interval while waiting for an in-flight call. Default 1000. */
  readonly pollIntervalMs?: number
  /**
   * Longest wait for an in-flight call, measured from the first claim: it bounds the sleeps and the
   * polling claims after the first one (each poll gets at most the remaining wait; one still
   * pending when the wait ends is abandoned and the call times out). The last sleep is shortened
   * so one final poll starts within the wait. It does not bound the first claim, the call's own
   * execution, or the recording of its outcome. Default 150000.
   */
  readonly maxWaitMs?: number
  /**
   * Epoch milliseconds by which a wait for an in-flight duplicate must end (for example the step's
   * function budget). A non-finite value is ignored. It bounds only that wait: a call that runs is
   * not cut at the deadline, and recording its outcome can take up to three
   * `toolLedgerCompleteTimeoutMs` attempts (about 15 s) after it returns. Pass a deadline that
   * reserves that finalization time before the platform stops the step.
   */
  readonly deadline?: () => number | undefined
  /** UTF-8 bytes of a stored result's compact JSON. Default 1 MiB (see `toolLedgerResult`). */
  readonly maxResultBytes?: number
  /**
   * Observability seam: called once per ledgered call with the ledger's decision, before the call
   * runs or its result is returned (after any wait). Not called when the claim itself fails. It
   * never affects execution: a throw (or a rejected promise) is logged and ignored, and a returned
   * promise is not awaited.
   */
  readonly onLedgerDecision?: (event: ToolLedgerDecisionEvent) => void
}

export const defaultToolLedgerLeaseMs = 30_000

export const defaultToolLedgerPollIntervalMs = 1_000

export const defaultToolLedgerMaxWaitMs = 150_000

export const defaultToolLedgerMaxResultBytes = 1024 * 1024

/** Timeout of one `store.complete` attempt (three attempts at most) and of each `store.heartbeat`.
 * It only cuts interruptible store work (see `ToolLedgerStore`).
 */
export const toolLedgerCompleteTimeoutMs = 5_000

/** UTF-8 byte budget of `ToolLedgerEntry.args`. */
export const toolLedgerMaxArgsBytes = 8 * 1024

/** The idempotency key handed to tool executors: the host scope plus the ledger key. Stable across
 * re-executions of the same call, so tools and external APIs can deduplicate as defence in depth.
 */
export const toolIdempotencyKey = (scope: string, key: string) => `${scope}:${key}`

const compactJson = (value: unknown): string | undefined =>
  Result.match(
    Result.try(() => JSON.stringify(value)),
    {
      onFailure: () => undefined,
      onSuccess: (encoded: string | undefined) => encoded
    }
  )

/** What the ledger records of a call's arguments (see `toolLedgerArgs`). */
export type ToolLedgerArgs = {
  /** Compact JSON within `toolLedgerMaxArgsBytes`, cut with a trailing `…`: an audit preview. */
  readonly args: string
  /** Whether `args` was cut, so it no longer holds every argument. */
  readonly argsTruncated: boolean
  /** Lower-case hex SHA-256 of the full arguments' canonical JSON (format: `toolLedgerArgs`). */
  readonly argsDigest: string
}

const isJsonObject = (value: Schema.Json): value is { readonly [key: string]: Schema.Json } =>
  Predicate.isObject(value) && !Array.isArray(value)

// Object keys sorted: equal values encode equally whatever the key order (for example after a
// round trip through a database JSON column).
const canonicalJson = (value: Schema.Json): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`

  if (isJsonObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`)
      .join(',')}}`
  }

  return JSON.stringify(value)
}

// Falls back to the compact JSON itself when it does not parse (the unserializable placeholder)
// or nests too deeply for the recursion (a `RangeError`): the digest stays deterministic for a
// runtime and the claim is never preceded by a throw.
const canonicalArguments = (compact: string) =>
  Result.match(
    Result.try(() => canonicalJson(JSON.parse(compact))),
    { onFailure: () => compact, onSuccess: canonical => canonical }
  )

/**
 * The ledger's record of call arguments: `args`, their compact JSON cut to
 * `toolLedgerMaxArgsBytes` (an audit preview; `argsTruncated` says it was cut), and `argsDigest`.
 * Conflict detection compares `argsDigest`, so arguments that differ only past the preview still
 * conflict. Pure and synchronous.
 *
 * `argsDigest` is a stable format that hosts persist (as text, for example `char(64)`): the
 * lower-case hex SHA-256 of the UTF-8 bytes of the canonical JSON of the raw `call.params` (as
 * the model sent them, before Schema decoding): compact, object keys sorted by UTF-16 code units,
 * arrays in order, numbers and strings as `JSON.stringify` writes them. It is a conflict
 * fingerprint, not a security boundary, and it cannot tell apart:
 * - two calls under the same key with equal arguments: call ids must be unique within a ledger
 *   scope (include the turn or step in the scope when a provider can reuse ids), or the later call
 *   replays the earlier result;
 * - unserializable arguments (cycles, `BigInt`): they all share one digest;
 * - integers beyond 2^53, which lose precision before hashing.
 * Arguments nested too deeply to canonicalize (thousands of levels, depending on the runtime's
 * stack) are digested from their compact JSON instead.
 */
export const toolLedgerArgs = (params: unknown): ToolLedgerArgs => {
  const compact = compactToolArguments(params)
  const args = truncateUtf8(compact, toolLedgerMaxArgsBytes)

  return {
    args,
    argsTruncated: args !== compact,
    argsDigest: sha256HexSync(canonicalArguments(compact))
  }
}

const jsonValue = (value: unknown): Result.Result<unknown, undefined> => {
  const encoded = compactJson(value)

  return encoded === undefined
    ? Result.fail(undefined)
    : Result.try({ try: () => JSON.parse(encoded), catch: () => undefined })
}

type StoredResultFields = {
  toolCallId: string
  content: Content
  isError?: boolean
  structuredContent?: unknown
  acceptance?: ToolResult['acceptance']
  nestedCalls?: ToolResult['nestedCalls']
  usage?: ToolResult['usage']
}

const reducedNote = '[The stored copy of this result was reduced to fit the tool ledger bound.]'

const mediaPlaceholder = (tag: string) => `[${tag.toLowerCase()} omitted from the stored result]`

const textOnlyContent = (content: Content): Content =>
  Predicate.isString(content)
    ? content
    : content.map(part =>
        Predicate.isTagged(part, 'Text')
          ? part
          : TextPart.make({ text: mediaPlaceholder(part._tag) })
      )

const withNote = (content: Content): Content =>
  Predicate.isString(content)
    ? `${content}\n\n${reducedNote}`
    : [...content, TextPart.make({ text: `\n\n${reducedNote}` })]

const resultBytes = (fields: StoredResultFields) => utf8ByteLength(compactJson(fields) ?? '')

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff

const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff

// At most `maxUnits` UTF-16 code units of `text`, never splitting a surrogate pair.
const codeUnitPrefix = (text: string, maxUnits: number) => {
  if (text.length <= maxUnits) return text

  const end =
    maxUnits > 0 &&
    isHighSurrogate(text.charCodeAt(maxUnits - 1)) &&
    isLowSurrogate(text.charCodeAt(maxUnits))
      ? maxUnits - 1
      : maxUnits

  return text.slice(0, end)
}

// The whole `text` when it fits, else its longest prefix (whole code points) whose cut content
// keeps the result within `maxBytes`, measured on the actual serialized JSON (escapes such as
// `\u0001` take six bytes). Below that: the note alone, then an empty content.
const fitText = (base: StoredResultFields, text: string, maxBytes: number): ToolResult => {
  const withText = (kept: string): StoredResultFields => ({
    ...base,
    content: `${kept}\n\n${reducedNote}`
  })

  const whole = withText(text)

  if (resultBytes(whole) <= maxBytes) return ToolResult.make(whole)

  // Every code unit serializes to at least one byte, so a longer prefix never fits: cutting first
  // keeps a multi-megabyte text from being split into code points and re-joined in full.
  const characters = Array.from(codeUnitPrefix(text, maxBytes))

  const cut = (count: number) =>
    withText(`${characters.slice(0, count).join('')}${truncationMarker}`)

  if (resultBytes(cut(0)) > maxBytes) {
    const noteOnly: StoredResultFields = { ...base, content: reducedNote }

    return ToolResult.make(resultBytes(noteOnly) <= maxBytes ? noteOnly : { ...base, content: '' })
  }

  // `cut(characters.length)` never fits: it is the whole text plus the marker, or a prefix of at
  // least `maxBytes` bytes plus the marker.
  let fits = 0
  let tooLong = characters.length

  while (tooLong - fits > 1) {
    const middle = Math.floor((fits + tooLong) / 2)

    if (resultBytes(cut(middle)) <= maxBytes) {
      fits = middle
    } else {
      tooLong = middle
    }
  }

  return ToolResult.make(cut(fits))
}

/**
 * The stored copy of a result: wire-safe (`structuredContent` made plain JSON through a JSON round
 * trip, dropped when it cannot be serialized) and at most `maxBytes` UTF-8 bytes of compact JSON,
 * measured on the serialized result. Over the bound it degrades in steps, each adding a note to
 * the content: media parts become text placeholders, then `nestedCalls` (audit data) is dropped,
 * then `structuredContent` (which can carry state, such as code mode store writes), then the text
 * is cut. A bound smaller than the identifying fields (`toolCallId`, `isError`, `acceptance`,
 * `usage`) leaves an empty content. The live call still returns the original result; only replays
 * see the stored copy.
 */
export const toolLedgerResult = (
  result: ToolResult,
  maxBytes: number = defaultToolLedgerMaxResultBytes
): ToolResult => {
  const full: StoredResultFields = { toolCallId: result.toolCallId, content: result.content }

  if (result.isError !== undefined) full.isError = result.isError

  if (result.acceptance !== undefined) full.acceptance = result.acceptance

  if (result.usage !== undefined) full.usage = result.usage

  const structured =
    result.structuredContent === undefined ? undefined : jsonValue(result.structuredContent)

  if (structured !== undefined && Result.isSuccess(structured)) {
    full.structuredContent = structured.success
  }

  if (result.nestedCalls !== undefined) full.nestedCalls = result.nestedCalls

  if (resultBytes(full) <= maxBytes) return ToolResult.make(full)

  const textOnly: StoredResultFields = { ...full, content: withNote(textOnlyContent(full.content)) }

  if (resultBytes(textOnly) <= maxBytes) return ToolResult.make(textOnly)

  const withoutNested: StoredResultFields = { ...textOnly }

  delete withoutNested.nestedCalls

  if (resultBytes(withoutNested) <= maxBytes) return ToolResult.make(withoutNested)

  const withoutStructured: StoredResultFields = { ...withoutNested }

  delete withoutStructured.structuredContent

  if (resultBytes(withoutStructured) <= maxBytes) return ToolResult.make(withoutStructured)

  return fitText(withoutStructured, contentText(textOnlyContent(result.content)), maxBytes)
}

const nestedSeq = (key: string) => {
  const seq = Number(key.slice(key.lastIndexOf('/') + 1))

  return Number.isFinite(seq) ? seq : Number.POSITIVE_INFINITY
}

/** Orders entries by the trailing `/<seq>` of their keys, then by key. */
export const sortToolLedgerEntries = (
  entries: ReadonlyArray<ToolLedgerEntry>
): ReadonlyArray<ToolLedgerEntry> =>
  [...entries].sort((left, right) => {
    const bySeq = nestedSeq(left.key) - nestedSeq(right.key)

    return Number.isNaN(bySeq) || bySeq === 0 ? (left.key < right.key ? -1 : 1) : bySeq
  })

export type ResolvedToolLedgerOptions = {
  readonly store: ToolLedgerStore
  readonly isLedgered: (input: ToolLedgerPolicyInput) => boolean
  readonly leaseMs: number
  readonly heartbeatIntervalMs: number
  readonly pollIntervalMs: number
  readonly maxWaitMs: number
  readonly deadline: (() => number | undefined) | undefined
  readonly maxResultBytes: number
  readonly onLedgerDecision: ((event: ToolLedgerDecisionEvent) => void) | undefined
}

const positive = (value: number | undefined, fallback: number) =>
  value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback

/** Ledger options with defaults applied (once per resolution). */
export const resolveToolLedgerOptions = (options: ToolLedgerOptions): ResolvedToolLedgerOptions => {
  const leaseMs = positive(options.leaseMs, defaultToolLedgerLeaseMs)

  return {
    store: options.store,
    isLedgered: options.isLedgered ?? defaultToolLedgerPolicy,
    leaseMs,
    // At most half the lease: renewal margin so a single late heartbeat does not let the lease
    // lapse. Not a guarantee: a stalled process or store can still let it expire.
    heartbeatIntervalMs: Math.min(
      positive(options.heartbeatIntervalMs, Math.max(1, Math.floor(leaseMs / 3))),
      Math.max(1, Math.floor(leaseMs / 2))
    ),
    pollIntervalMs: positive(options.pollIntervalMs, defaultToolLedgerPollIntervalMs),
    maxWaitMs:
      options.maxWaitMs !== undefined && Number.isFinite(options.maxWaitMs)
        ? Math.max(0, options.maxWaitMs)
        : defaultToolLedgerMaxWaitMs,
    deadline: options.deadline,
    maxResultBytes: positive(options.maxResultBytes, defaultToolLedgerMaxResultBytes),
    onLedgerDecision: options.onLedgerDecision
  }
}

const decisionHookFailed = (key: string, error: unknown) =>
  Effect.logWarning(
    `Tool ledger onLedgerDecision failed for ${key}; ignored: ${error instanceof Error ? error.message : String(error)}`
  )

// Never fails and never waits for the hook: a throw or a rejected promise is only logged.
const reportDecision = (
  hook: ((event: ToolLedgerDecisionEvent) => void) | undefined,
  event: ToolLedgerDecisionEvent
): Effect.Effect<void> =>
  hook === undefined
    ? Effect.void
    : Effect.try({ try: (): unknown => hook(event), catch: error => error }).pipe(
        Effect.flatMap(returned =>
          Predicate.isPromiseLike(returned)
            ? Effect.tryPromise({
                try: () => Promise.resolve(returned),
                catch: error => error
              }).pipe(
                Effect.catch(error => decisionHookFailed(event.key, error)),
                Effect.forkDetach({ startImmediately: true }),
                Effect.asVoid
              )
            : Effect.void
        ),
        Effect.catch(error => decisionHookFailed(event.key, error))
      )

type ToolLedgerErrorState = 'in_flight' | 'abandoned' | 'conflict'

/** `structuredContent.details` of the model-visible results the ledger returns instead of running
 * a call.
 */
export type ToolLedgerErrorDetails = {
  readonly type: 'tool_ledger'
  readonly state: ToolLedgerErrorState
  readonly key: string
}

const ledgerErrorResult = (input: {
  readonly call: ToolCall
  readonly state: ToolLedgerErrorState
  readonly key: string
  readonly reason: 'timeout' | 'unavailable'
  readonly message: string
}) => {
  const details: ToolLedgerErrorDetails = {
    type: 'tool_ledger',
    state: input.state,
    key: input.key
  }

  return ToolResult.make({
    toolCallId: input.call.id,
    content: input.message,
    isError: true,
    structuredContent: {
      type: 'model_visible_tool_error',
      tool: input.call.name,
      reason: input.reason,
      message: input.message,
      details
    }
  })
}

/** Default result for an abandoned call: model-visible, never a re-execution. */
export const abandonedToolCallResult = (call: ToolCall) =>
  ledgerErrorResult({
    call,
    state: 'abandoned',
    key: call.id,
    reason: 'unavailable',
    message: `An earlier execution of ${call.name} (call ${call.id}) started but never recorded a result, so it may already have been applied. It was not run again. Verify the current state before retrying.`
  })

const inFlightTimeoutResult = (call: ToolCall) =>
  ledgerErrorResult({
    call,
    state: 'in_flight',
    key: call.id,
    reason: 'timeout',
    message: `${call.name} (call ${call.id}) is still running in another execution and did not finish in time. It was not run again here; it may still be applied. Verify the current state before retrying.`
  })

const conflictResult = (call: ToolCall, entry: ToolLedgerEntry) =>
  ledgerErrorResult({
    call,
    state: 'conflict',
    key: entry.key,
    reason: 'unavailable',
    message: `The tool ledger already holds a different call under id ${entry.key} (${entry.toolName}); ${call.name} was not run.`
  })

const ledgerUnavailable = (call: ToolCall) => (error: ToolLedgerError) =>
  new ToolError({
    tool: call.name,
    cause: 'unavailable',
    message: `The tool ledger is unavailable (${error.message}); ${call.name} was not run.`
  })

// One store write, failing with a `ToolLedgerError` once `toolLedgerCompleteTimeoutMs` passes.
// The timeout interrupts the operation and waits for it to stop, so it only bounds interruptible
// store work (the `ToolLedgerStore` contract).
const boundedStoreWrite = <A>(
  write: Effect.Effect<A, ToolLedgerError>
): Effect.Effect<A, ToolLedgerError> =>
  write.pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(toolLedgerCompleteTimeoutMs),
      orElse: () =>
        Effect.fail(
          new ToolLedgerError({ message: `timed out after ${toolLedgerCompleteTimeoutMs} ms` })
        )
    })
  )

const succeededOutcome = (result: ToolResult, maxBytes: number): ToolLedgerOutcome =>
  ToolLedgerSucceeded.make({ result: toolLedgerResult(result, maxBytes) })

const failedOutcome = (error: ToolError): ToolLedgerOutcome =>
  ToolLedgerFailed.make({
    error: { tool: error.tool, cause: error.cause, message: error.message }
  })

// Results answer the current call id.
const replay = (
  call: ToolCall,
  outcome: ToolLedgerOutcome
): Effect.Effect<ToolResult, ToolError> => {
  if (Predicate.isTagged(outcome, 'Failed')) return Effect.fail(new ToolError(outcome.error))

  const stored = outcome.result

  if (stored.toolCallId === call.id) return Effect.succeed(stored)

  const fields: StoredResultFields = { toolCallId: call.id, content: stored.content }

  if (stored.isError !== undefined) fields.isError = stored.isError

  if (stored.structuredContent !== undefined) fields.structuredContent = stored.structuredContent

  if (stored.acceptance !== undefined) fields.acceptance = stored.acceptance

  if (stored.nestedCalls !== undefined) fields.nestedCalls = stored.nestedCalls

  if (stored.usage !== undefined) fields.usage = stored.usage

  return Effect.succeed(ToolResult.make(fields))
}

/**
 * The ledger seam behind `ResolvedToolSet.execute` and nested execution (internal to `tools`).
 * Claims the call; runs it only when the claim is fresh (heartbeating the lease, then recording
 * the outcome), replays a completed outcome, waits for an in-flight one, and never re-runs an
 * abandoned one. Storage failures before execution fail closed (`ToolError` `unavailable`, nothing
 * runs); heartbeat and completion failures after execution are logged and never mask the result.
 */
export const executeLedgered = (input: {
  readonly options: ResolvedToolLedgerOptions
  readonly call: ToolCall
  readonly parentKey: string | undefined
  readonly execute: Effect.Effect<ToolResult, ToolError>
  readonly abandonedResult?: ((input: ToolLedgerAbandonedInput) => ToolResult) | undefined
}): Effect.Effect<ToolResult, ToolError> =>
  Effect.gen(function* () {
    const { call, options } = input
    const { store } = options
    const key = call.id
    const { args, argsTruncated, argsDigest } = toolLedgerArgs(call.params)

    const claim = (nowMs: number) => {
      const request: ClaimRequestFields = {
        key,
        toolName: call.name,
        args,
        argsTruncated,
        argsDigest,
        nowMs,
        leaseExpiresAtMs: nowMs + options.leaseMs,
        leaseMs: options.leaseMs
      }

      if (input.parentKey !== undefined) request.parentKey = input.parentKey

      return store.claim(request).pipe(Effect.mapError(ledgerUnavailable(call)))
    }

    const startedAt = yield* Clock.currentTimeMillis
    const requestedDeadline = options.deadline?.()

    // A non-finite deadline (NaN, Infinity) is no deadline; `maxWaitMs` still bounds the wait.
    const deadline =
      requestedDeadline !== undefined && Number.isFinite(requestedDeadline)
        ? requestedDeadline
        : undefined

    const waitUntil = Math.min(
      startedAt + options.maxWaitMs,
      deadline === undefined ? Number.POSITIVE_INFINITY : deadline
    )

    // The digest covers the full arguments; the bounded `args` preview never decides a match.
    const matches = (entry: ToolLedgerEntry) =>
      entry.toolName === call.name && entry.argsDigest === argsDigest

    let current = yield* claim(startedAt)
    const waited = ToolLedgerClaim.$is('InFlight')(current) && matches(current.entry)

    const decide = (decision: ToolLedgerDecision) =>
      Effect.gen(function* () {
        const event: DecisionEventFields = { key, toolName: call.name, decision }

        if (input.parentKey !== undefined) event.parentKey = input.parentKey

        if (waited) event.waitedMs = Math.max(0, (yield* Clock.currentTimeMillis) - startedAt)

        yield* reportDecision(options.onLedgerDecision, event)
      })

    const waitTimedOut = decide('in_flight_timeout').pipe(Effect.as(inFlightTimeoutResult(call)))

    const stillInFlight = (claimed: ToolLedgerClaim) =>
      ToolLedgerClaim.$is('InFlight')(claimed) && matches(claimed.entry)

    // Every wait step, store polls included, stays within the wait budget: a stalled poll ends in
    // the timeout result, never in running the call. Polls run every `pollIntervalMs`; within the
    // last interval one final poll runs halfway through what remains (its own budget is the other
    // half), so a call completing before it is replayed instead of timing out.
    while (stillInFlight(current)) {
      const now = yield* Clock.currentTimeMillis
      const remaining = waitUntil - now

      if (remaining <= 0) return yield* waitTimedOut

      const final = remaining <= options.pollIntervalMs

      const sleepMs = final ? Math.floor(remaining / 2) : options.pollIntervalMs

      if (sleepMs > 0) yield* Effect.sleep(Duration.millis(sleepMs))

      const polledAt = yield* Clock.currentTimeMillis

      if (polledAt >= waitUntil) return yield* waitTimedOut

      const polled = yield* claim(polledAt).pipe(
        Effect.timeoutOption(Duration.millis(waitUntil - polledAt))
      )

      if (Option.isNone(polled)) return yield* waitTimedOut

      current = polled.value

      if (final && stillInFlight(current)) return yield* waitTimedOut
    }

    const heartbeat = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis

      yield* boundedStoreWrite(
        store.heartbeat({
          key,
          leaseExpiresAtMs: now + options.leaseMs,
          leaseMs: options.leaseMs
        })
      )
    }).pipe(
      Effect.catch(error =>
        Effect.logWarning(`Tool ledger heartbeat failed for ${key}: ${error.message}`)
      )
    )

    // Each attempt is bounded, so a hung (interruptible) store never holds the call or its
    // interruption for long; an outcome that cannot be recorded leaves the entry claimed (it reads
    // as abandoned).
    const complete = (outcome: ToolLedgerOutcome) =>
      Effect.gen(function* () {
        const completedAtMs = yield* Clock.currentTimeMillis

        yield* boundedStoreWrite(store.complete({ key, outcome, completedAtMs }))
      }).pipe(
        Effect.retry({ times: 2 }),
        Effect.catch(error =>
          Effect.logWarning(
            `Tool ledger completion failed for ${key}; the call stays claimed and will read as abandoned: ${error.message}`
          )
        ),
        Effect.uninterruptible
      )

    // The stored copy is built lazily and a defect while building or recording it is only logged:
    // a throw after the call succeeded never masks its live result (the entry stays claimed).
    const record = (outcome: () => ToolLedgerOutcome): Effect.Effect<void> =>
      Effect.suspend(() => complete(outcome())).pipe(
        Effect.catchDefect(defect =>
          Effect.logWarning(
            `Tool ledger could not record the outcome of ${key}; the call stays claimed and will read as abandoned: ${defect instanceof Error ? defect.message : String(defect)}`
          )
        )
      )

    // Results and ToolErrors are recorded (a ToolError also when the cause carries interruptions,
    // for example of the tool's own sibling work: the tool did fail). A defect, or an interruption
    // without a ToolError, leaves the entry claimed: its outcome is unknown, so a later execution
    // reports it as abandoned instead of running it again.
    const recordOutcome = (exit: Exit.Exit<ToolResult, ToolError>): Effect.Effect<void> => {
      if (Exit.isSuccess(exit))
        return record(() => succeededOutcome(exit.value, options.maxResultBytes))

      if (Cause.hasDies(exit.cause)) return Effect.void

      return Option.match(Cause.findErrorOption(exit.cause), {
        onNone: () => Effect.void,
        onSome: error => record(() => failedOutcome(error))
      })
    }

    // Only the call itself is interruptible: once it has returned, its outcome is recorded before
    // an interruption takes effect.
    const runFresh = Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.sleep(Duration.millis(options.heartbeatIntervalMs)).pipe(
          Effect.andThen(heartbeat),
          Effect.forever,
          Effect.forkScoped
        )

        return yield* Effect.uninterruptibleMask(restore =>
          restore(input.execute).pipe(
            Effect.exit,
            Effect.tap(recordOutcome),
            Effect.flatMap(exit => exit)
          )
        )
      })
    )

    const abandoned = (entry: ToolLedgerEntry): Effect.Effect<ToolResult, ToolError> => {
      const abandonedResult = input.abandonedResult

      // A failed listing keeps the abandoned result (the call may have been applied); only the
      // nested entries are reported as unavailable.
      return abandonedResult === undefined
        ? Effect.succeed(abandonedToolCallResult(call))
        : store.list(key).pipe(
            Effect.map(sortToolLedgerEntries),
            Effect.catch(error =>
              Effect.logWarning(
                `Tool ledger could not list the nested calls of abandoned ${key}: ${error.message}`
              ).pipe(Effect.as(undefined))
            ),
            Effect.map(nested => abandonedResult({ call, entry, nested }))
          )
    }

    if (!ToolLedgerClaim.$is('Fresh')(current) && !matches(current.entry)) {
      yield* decide('conflict')

      return conflictResult(call, current.entry)
    }

    return yield* ToolLedgerClaim.$match(current, {
      Fresh: (): Effect.Effect<ToolResult, ToolError> =>
        decide('fresh').pipe(Effect.andThen(runFresh)),
      Completed: ({ outcome }) =>
        decide(waited ? 'in_flight_wait' : 'completed').pipe(Effect.andThen(replay(call, outcome))),
      // Unreachable for a matching entry (the wait loop consumes it); kept total.
      InFlight: () => decide('in_flight_timeout').pipe(Effect.as(inFlightTimeoutResult(call))),
      Abandoned: ({ entry }) => decide('abandoned').pipe(Effect.andThen(abandoned(entry)))
    })
  })

/** An in-memory `ToolLedgerStore` for tests and single-process hosts. Not durable: it survives
 * neither restarts nor a second instance, so it cannot protect Workflow steps.
 */
export type InMemoryToolLedgerStore = ToolLedgerStore & {
  /** Every entry, in claim order. */
  readonly entries: Effect.Effect<ReadonlyArray<ToolLedgerEntry>>
}

type EntryFields = {
  key: string
  parentKey?: string
  toolName: string
  args: string
  argsTruncated: boolean
  argsDigest: string
  claimedAtMs: number
  leaseExpiresAtMs: number
  completedAtMs?: number
  outcome?: ToolLedgerOutcome
}

const entryFields = (entry: ToolLedgerEntry): EntryFields => {
  const fields: EntryFields = {
    key: entry.key,
    toolName: entry.toolName,
    args: entry.args,
    argsTruncated: entry.argsTruncated,
    argsDigest: entry.argsDigest,
    claimedAtMs: entry.claimedAtMs,
    leaseExpiresAtMs: entry.leaseExpiresAtMs
  }

  if (entry.parentKey !== undefined) fields.parentKey = entry.parentKey

  if (entry.completedAtMs !== undefined) fields.completedAtMs = entry.completedAtMs

  if (entry.outcome !== undefined) fields.outcome = entry.outcome

  return fields
}

/** Reference `ToolLedgerStore` over a `Map`, following the store contract exactly. */
export const makeInMemoryToolLedgerStore = (
  options: { readonly scope?: string } = {}
): InMemoryToolLedgerStore => {
  const entries = new Map<string, ToolLedgerEntry>()

  return {
    scope: options.scope ?? 'memory',
    claim: request =>
      Effect.sync(() => {
        const existing = entries.get(request.key)

        if (existing !== undefined) return classifyToolLedgerEntry(existing, request.nowMs)

        const fields: EntryFields = {
          key: request.key,
          toolName: request.toolName,
          args: request.args,
          argsTruncated: request.argsTruncated,
          argsDigest: request.argsDigest,
          claimedAtMs: request.nowMs,
          leaseExpiresAtMs: request.leaseExpiresAtMs
        }

        if (request.parentKey !== undefined) fields.parentKey = request.parentKey

        const entry = ToolLedgerEntry.make(fields)

        entries.set(request.key, entry)

        return ToolLedgerClaim.Fresh({ entry })
      }),
    heartbeat: ({ key, leaseExpiresAtMs }) =>
      Effect.sync(() => {
        const existing = entries.get(key)

        if (existing === undefined || existing.outcome !== undefined) return

        entries.set(
          key,
          ToolLedgerEntry.make({
            ...entryFields(existing),
            leaseExpiresAtMs: Math.max(existing.leaseExpiresAtMs, leaseExpiresAtMs)
          })
        )
      }),
    complete: ({ key, outcome, completedAtMs }) =>
      Effect.sync(() => {
        const existing = entries.get(key)

        if (existing === undefined || existing.outcome !== undefined) return

        entries.set(key, ToolLedgerEntry.make({ ...entryFields(existing), outcome, completedAtMs }))
      }),
    list: parentKey =>
      Effect.sync(() => [...entries.values()].filter(entry => entry.parentKey === parentKey)),
    entries: Effect.sync(() => [...entries.values()])
  }
}
