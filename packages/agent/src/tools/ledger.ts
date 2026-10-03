import { Clock, Data, Duration, Effect, Predicate, Result } from 'effect'
import * as Schema from 'effect/Schema'
import { ToolError } from '@yolk-sdk/agent/loop'
import {
  contentText,
  TextPart,
  ToolResult,
  type Content,
  type ToolCall
} from '@yolk-sdk/agent/protocol'
import type { ToolAccess } from './registry.ts'

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
 * arguments, cut to 8 KiB (audit and conflict detection only). An entry without `outcome` is
 * claimed: running under a live lease, or abandoned once the lease expired. Plain wire data:
 * persist it with `Schema.toCodecJson(ToolLedgerEntry)`.
 */
export class ToolLedgerEntry extends Schema.Class<ToolLedgerEntry>('ToolLedgerEntry')({
  key: NonEmptyTrimmedString,
  parentKey: Schema.optional(NonEmptyTrimmedString),
  toolName: NonEmptyTrimmedString,
  args: Schema.String,
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
  readonly args: string
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
  nowMs: number
  leaseExpiresAtMs: number
  leaseMs: number
}

/**
 * Host-implemented durable storage of tool calls, scoped by the host (for example one Workflow
 * run). Every operation is keyed within `scope`; never look entries up across scopes.
 *
 * - `claim` is atomic: insert a claimed entry when the key is absent (`Fresh`), else classify the
 *   existing entry without changing it (`classifyToolLedgerEntry`). Repeated claims of an existing
 *   key are reads; waiting callers poll with them.
 * - `heartbeat` extends the lease of a claimed entry without an outcome (never shortening it); it
 *   never revives or changes a completed entry.
 * - Leases use one clock per store: the caller's (`nowMs`, `leaseExpiresAtMs`) or the store's own
 *   (`leaseMs`, for example a database `now()`); `classifyToolLedgerEntry` takes that clock's time.
 * - `complete` records the outcome once; a later completion of the same key is ignored.
 * - `list` returns the entries whose `parentKey` is the given key (nested calls of one call).
 *
 * No operation ever hands a claimed entry to another execution: a claim is never taken over, so
 * heartbeats and completion need no fencing token.
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

/** Classifies an existing entry at `nowMs`: completed, in flight under a live lease, or abandoned. */
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

/** Default policy: every tool whose access is not `read`. */
export const defaultToolLedgerPolicy = (input: ToolLedgerPolicyInput) => input.access !== 'read'

/** What an abandoned call's registration sees to build its result (see `abandonedResult`). */
export type ToolLedgerAbandonedInput = {
  readonly call: ToolCall
  readonly entry: ToolLedgerEntry
  /** The call's nested entries (`list(call.id)`), ordered by sequence number. */
  readonly nested: ReadonlyArray<ToolLedgerEntry>
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
  /** Which calls are ledgered. Default `defaultToolLedgerPolicy` (every non-`read` tool). */
  readonly isLedgered?: (input: ToolLedgerPolicyInput) => boolean
  /** Lease of a running call. Default 30000. */
  readonly leaseMs?: number
  /** Heartbeat interval while a call runs. Default a third of `leaseMs`; at most half of it. */
  readonly heartbeatIntervalMs?: number
  /** Poll interval while waiting for an in-flight call. Default 1000. */
  readonly pollIntervalMs?: number
  /** Longest wait for an in-flight call. Default 150000. */
  readonly maxWaitMs?: number
  /** Epoch milliseconds by which a wait must end (for example the step's function budget). */
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

/** UTF-8 byte budget of `ToolLedgerEntry.args`. */
export const toolLedgerMaxArgsBytes = 8 * 1024

/** The idempotency key handed to tool executors: the host scope plus the ledger key. Stable across
 * re-executions of the same call, so tools and external APIs can deduplicate as defence in depth.
 */
export const toolIdempotencyKey = (scope: string, key: string) => `${scope}:${key}`

const textEncoder = new TextEncoder()

const utf8Bytes = (text: string) => textEncoder.encode(text).length

const truncationMarker = '…'

// Cuts on code point boundaries so surrogate pairs and multi-byte characters stay whole.
const truncateUtf8 = (text: string, maxBytes: number) => {
  if (utf8Bytes(text) <= maxBytes) return text

  const budget = maxBytes - utf8Bytes(truncationMarker)
  let bytes = 0
  let kept = ''

  for (const character of text) {
    const size = utf8Bytes(character)

    if (bytes + size > budget) break

    kept += character
    bytes += size
  }

  return `${kept}${truncationMarker}`
}

const compactJson = (value: unknown): string | undefined =>
  Result.match(
    Result.try(() => JSON.stringify(value)),
    {
      onFailure: () => undefined,
      onSuccess: (encoded: string | undefined) => encoded
    }
  )

/** Compact JSON of call arguments within `toolLedgerMaxArgsBytes`. */
export const toolLedgerArgs = (params: unknown) =>
  truncateUtf8(compactJson(params) ?? '[unserializable arguments]', toolLedgerMaxArgsBytes)

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

const resultBytes = (fields: StoredResultFields) => utf8Bytes(compactJson(fields) ?? '')

/**
 * The stored copy of a result: wire-safe (`structuredContent` made plain JSON through a JSON round
 * trip, dropped when it cannot be serialized) and at most `maxBytes` of compact JSON. Over the
 * bound it degrades in steps, each adding a note to the content: media parts become text
 * placeholders, then `structuredContent` is dropped, then `nestedCalls` is dropped and the text is
 * cut. The live call still returns the original result; only replays see the stored copy.
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

  const withoutStructured: StoredResultFields = { ...textOnly }

  delete withoutStructured.structuredContent

  if (resultBytes(withoutStructured) <= maxBytes) return ToolResult.make(withoutStructured)

  const minimal: StoredResultFields = { ...withoutStructured, content: `\n\n${reducedNote}` }

  delete minimal.nestedCalls

  const text = contentText(textOnlyContent(result.content))
  const overhead = resultBytes(minimal)
  // JSON escaping can double a character's bytes; halve the budget to stay within the bound.
  const cut = truncateUtf8(text, Math.max(0, Math.floor((maxBytes - overhead) / 2)))

  return ToolResult.make({ ...minimal, content: `${cut}\n\n${reducedNote}` })
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
    // At most half the lease, so one late heartbeat never lets a live lease lapse.
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
    const args = toolLedgerArgs(call.params)

    const claim = (nowMs: number) => {
      const request: ClaimRequestFields = {
        key,
        toolName: call.name,
        args,
        nowMs,
        leaseExpiresAtMs: nowMs + options.leaseMs,
        leaseMs: options.leaseMs
      }

      if (input.parentKey !== undefined) request.parentKey = input.parentKey

      return store.claim(request).pipe(Effect.mapError(ledgerUnavailable(call)))
    }

    const startedAt = yield* Clock.currentTimeMillis
    const deadline = options.deadline?.()

    const waitUntil = Math.min(
      startedAt + options.maxWaitMs,
      deadline === undefined ? Number.POSITIVE_INFINITY : deadline
    )

    const matches = (entry: ToolLedgerEntry) => entry.toolName === call.name && entry.args === args

    let current = yield* claim(startedAt)
    const waited = ToolLedgerClaim.$is('InFlight')(current) && matches(current.entry)

    const decide = (decision: ToolLedgerDecision) =>
      Effect.gen(function* () {
        const event: DecisionEventFields = { key, toolName: call.name, decision }

        if (input.parentKey !== undefined) event.parentKey = input.parentKey

        if (waited) event.waitedMs = Math.max(0, (yield* Clock.currentTimeMillis) - startedAt)

        yield* reportDecision(options.onLedgerDecision, event)
      })

    while (ToolLedgerClaim.$is('InFlight')(current) && matches(current.entry)) {
      const now = yield* Clock.currentTimeMillis

      if (now >= waitUntil) {
        yield* decide('in_flight_timeout')

        return inFlightTimeoutResult(call)
      }

      yield* Effect.sleep(Duration.millis(Math.min(options.pollIntervalMs, waitUntil - now)))
      current = yield* claim(yield* Clock.currentTimeMillis)
    }

    const heartbeat = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis

      yield* store.heartbeat({
        key,
        leaseExpiresAtMs: now + options.leaseMs,
        leaseMs: options.leaseMs
      })
    }).pipe(
      Effect.catch(error =>
        Effect.logWarning(`Tool ledger heartbeat failed for ${key}: ${error.message}`)
      )
    )

    const complete = (outcome: ToolLedgerOutcome) =>
      Effect.gen(function* () {
        const completedAtMs = yield* Clock.currentTimeMillis

        yield* store.complete({ key, outcome, completedAtMs })
      }).pipe(
        Effect.retry({ times: 2 }),
        Effect.catch(error =>
          Effect.logWarning(
            `Tool ledger completion failed for ${key}; the call stays claimed and will read as abandoned: ${error.message}`
          )
        ),
        Effect.uninterruptible
      )

    // Interruption or a defect leaves the entry claimed: its outcome is unknown, so a later
    // execution reports it as abandoned instead of running it again.
    const runFresh = Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.sleep(Duration.millis(options.heartbeatIntervalMs)).pipe(
          Effect.andThen(heartbeat),
          Effect.forever,
          Effect.forkScoped
        )

        return yield* input.execute.pipe(
          Effect.tap(result => complete(succeededOutcome(result, options.maxResultBytes))),
          Effect.tapError(error => complete(failedOutcome(error)))
        )
      })
    )

    const abandoned = (entry: ToolLedgerEntry): Effect.Effect<ToolResult, ToolError> => {
      const abandonedResult = input.abandonedResult

      return abandonedResult === undefined
        ? Effect.succeed(abandonedToolCallResult(call))
        : store.list(key).pipe(
            Effect.mapError(ledgerUnavailable(call)),
            Effect.map(nested =>
              abandonedResult({ call, entry, nested: sortToolLedgerEntries(nested) })
            )
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
