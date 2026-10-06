import { Effect, Match, Option, Predicate, Result } from 'effect'
import * as Schema from 'effect/Schema'
import type { ToolError } from '@yolk-sdk/agent/loop'
import {
  contentText,
  InteractionBusinessOutcome,
  interactionJsonEquals,
  interactionRequestId,
  InteractionHostError,
  InteractionValidationError,
  ToolCall,
  ToolResult,
  type InteractionHost,
  type InteractionReceipt
} from '@yolk-sdk/agent/protocol'
import {
  compactToolArguments,
  truncateCodePoints,
  utf8ByteLength
} from '../protocol/bounded-text.ts'
import { nestedToolCallMaxErrorChars } from '../protocol/nested-tool-calls.ts'
import {
  canonicalToolArguments,
  sortToolLedgerEntries,
  type ToolLedgerAbandonedInput,
  type ToolLedgerEntry,
  type ToolLedgerError
} from './ledger.ts'
import {
  maxToolPlanPreviewBytes,
  maxToolPlanPreviewKeys,
  StagedCall,
  ToolPlan,
  ToolPlanPreviewError,
  ToolPlanReviewParams,
  ToolPlanReviewResponse,
  ToolPlanStageError,
  toolPlanDigest,
  toolPlanIntegrityProblem,
  toolPlanPrecheckConcurrency,
  toolPlanReviewActionId,
  type StagedCallReceipt,
  type ToolPlanApplyResult,
  type ToolPlanBuilder,
  type ToolPlanCallCounts,
  type ToolPlanCallOutcome,
  type ToolPlanCallStatus,
  ToolPlanOutcome,
  type ToolPlanPreview,
  type ToolPlanPreviewPage,
  type ToolPlanRuntime,
  type ToolPlanStaging,
  type ToolPlanStore
} from './plan.ts'
import { sha256HexSync } from './sha256.ts'
import type { NestedTool, ToolAccess, ToolRegistration } from './registry.ts'

/** What a resolution supplies to staging and to the plan executor (internal to `tools`). */
export type ToolPlanResolution<Context> = {
  readonly store: ToolPlanStore
  readonly maxCalls: number
  readonly maxArgsBytes: number
  readonly host: InteractionHost
  readonly context: Context
  readonly reviewToolName: string
  /** The plan id of a staging call (`ToolPlanOptions.planId`, default the call id). */
  readonly planId: (call: ToolCall) => string
  readonly stageableTools: ReadonlyArray<NestedTool>
  /** A resolved, enabled, stageable registration by tool name. */
  readonly stageable: (name: string) => ToolRegistration<Context> | undefined
  /** Access of a script-callable registration by tool name. */
  readonly nestedAccess: (name: string) => ToolAccess | undefined
  /** The call with the registry's argument normalization (what validators and handlers see). */
  readonly businessCall: (registration: ToolRegistration<Context>, call: ToolCall) => ToolCall
  /** The registry's single dispatch seam (`executeRegistration`), with `parentCallId` for keys. */
  readonly execute: (
    registration: ToolRegistration<Context>,
    call: ToolCall,
    parentCallId: string
  ) => Effect.Effect<ToolResult, ToolError>
  /** Whether the ledger records an applied call (its `isLedgered` policy), with a ledger. */
  readonly ledgered:
    | ((registration: ToolRegistration<Context>, call: ToolCall, parentCallId: string) => boolean)
    | undefined
  /**
   * The apply fence, when the resolution has a ledger: runs `execute` under the tool ledger entry
   * of `call` (the review call id), so one execution applies and others replay its outcome, wait
   * while it runs (`inFlightTimeoutResult` past the wait), or find it abandoned.
   */
  readonly fence:
    | ((input: {
        readonly call: ToolCall
        readonly execute: Effect.Effect<ToolResult, ToolError>
        readonly abandonedResult: (input: ToolLedgerAbandonedInput) => ToolResult
        readonly inFlightTimeoutResult: Effect.Effect<ToolResult>
      }) => Effect.Effect<ToolResult, ToolError>)
    | undefined
  /** The ledger's `list`, when the resolution has a ledger. */
  readonly listNested:
    | ((parentKey: string) => Effect.Effect<ReadonlyArray<ToolLedgerEntry>, ToolLedgerError>)
    | undefined
}

const stageError = (reason: ToolPlanStageError['reason'], message: string) =>
  new ToolPlanStageError({ reason, message })

const isJson = Schema.is(Schema.Json)

const decodeSnapshot = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))

const stagedCall = (fields: {
  readonly key: string
  readonly toolName: string
  readonly params: Schema.Json
  readonly argsDigest: string
}) => StagedCall.make(fields)

const toolList = (tools: ReadonlyArray<NestedTool>) => {
  const names = tools.map(tool => tool.def.name)
  const listed = names.slice(0, 20).join(', ')

  return names.length === 0
    ? 'none'
    : names.length > 20
      ? `${listed}, and ${names.length - 20} more`
      : listed
}

// Plan ids become key prefixes (`<planId>/s<n>`) and `ToolPlan.id`: non-empty and trimmed. Any
// other characters, `/` included, are the host's choice: positional keys stay unambiguous.
const isValidPlanId = (id: string) => id.length > 0 && id.trim() === id

const makeBuilder = <Context>(
  resolution: ToolPlanResolution<Context>,
  planId: string,
  maxCalls: number
): ToolPlanBuilder => {
  const calls: Array<StagedCall> = []
  let bytes = 0
  let firstWrite: string | undefined
  let saved: Option.Option<ToolPlan | undefined> = Option.none()
  // Set before the save starts, so no stage can commit into a plan that is being saved.
  let finishing = false

  const orderError = (name: string) =>
    stageError(
      'order',
      `stage() is not allowed after ${name} ran: a script that stages must not run other write tools first. Stage every write, or run writes in a separate script.`
    )

  const checkRoom = (name: string) => {
    if (!isValidPlanId(planId))
      return stageError(
        'not_stageable',
        'Staging is unavailable: the host plan id for this call is empty or not trimmed.'
      )

    if (finishing || Option.isSome(saved))
      return stageError('order', 'The plan of this script is already saved.')

    if (firstWrite !== undefined) return orderError(firstWrite)

    if (calls.length >= maxCalls)
      return stageError(
        'limit',
        `Staged call limit reached: a plan holds at most ${maxCalls} calls (${name} was not staged). Nothing was truncated; stage fewer calls per script.`
      )

    return undefined
  }

  return {
    admit: call =>
      Effect.suspend(() => {
        const access = resolution.nestedAccess(call.name)

        if (access === undefined || access === 'read') return Effect.void

        if (calls.length > 0)
          return Effect.fail(
            stageError(
              'order',
              `${call.name} cannot run after calls were staged: once a script stages, it may only run read tools. Stage this call too, or run it in a separate script.`
            )
          )

        firstWrite ??= call.name

        return Effect.void
      }),
    stage: ({ name, params }) =>
      Effect.gen(function* () {
        const registration = resolution.stageable(name)

        if (registration === undefined)
          return yield* Effect.fail(
            stageError(
              'not_stageable',
              `${name} cannot be staged. Stageable tools: ${toolList(resolution.stageableTools)}.`
            )
          )

        const early = checkRoom(name)

        if (early !== undefined) return yield* Effect.fail(early)

        const notJson = stageError(
          'invalid_arguments',
          `${name}: staged arguments must be plain JSON.`
        )

        if (!isJson(params)) return yield* Effect.fail(notJson)

        const validate = registration.validate

        if (validate === undefined)
          return yield* Effect.fail(
            stageError('not_stageable', `${name} has no side-effect-free validator.`)
          )

        // One snapshot of the arguments is validated, digested, and stored: later changes to the
        // caller's value cannot diverge from what was checked.
        const canonical = canonicalToolArguments(params)
        const snapshot = yield* decodeSnapshot(canonical).pipe(Effect.mapError(() => notJson))
        const size = utf8ByteLength(canonical)
        const argsDigest = sha256HexSync(canonical)

        const probe = ToolCall.make({
          id: `${planId}/s${calls.length + 1}`,
          name,
          params: snapshot
        })

        yield* validate(resolution.businessCall(registration, probe)).pipe(
          Effect.mapError(error => stageError('invalid_arguments', error.message))
        )

        // Committed synchronously: concurrent stages re-check every limit here.
        return yield* Effect.suspend((): Effect.Effect<StagedCallReceipt, ToolPlanStageError> => {
          const late = checkRoom(name)

          if (late !== undefined) return Effect.fail(late)

          if (bytes + size > resolution.maxArgsBytes)
            return Effect.fail(
              stageError(
                'limit',
                `Staged arguments limit reached: a plan holds at most ${resolution.maxArgsBytes} bytes of arguments (${name} was not staged). Nothing was truncated; stage fewer calls per script.`
              )
            )

          const duplicate = calls.find(
            call => call.toolName === name && call.argsDigest === argsDigest
          )

          if (duplicate !== undefined)
            return Effect.fail(
              stageError(
                'duplicate',
                `${name} with these arguments is already staged as ${duplicate.key}.`
              )
            )

          const index = calls.length + 1
          const key = `${planId}/s${index}`

          calls.push(stagedCall({ key, toolName: name, params: snapshot, argsDigest }))
          bytes += size

          return Effect.succeed({ staged: true, key, index })
        })
      }),
    staged: Effect.sync(() => [...calls]),
    finish: Effect.suspend(() => {
      if (Option.isSome(saved)) return Effect.succeed(saved.value)

      finishing = true

      const [first, ...rest] = calls

      if (first === undefined) {
        saved = Option.some(undefined)

        return Effect.succeed(undefined)
      }

      const plan = ToolPlan.make({
        id: planId,
        scope: resolution.store.scope,
        digest: toolPlanDigest(calls),
        calls: [first, ...rest]
      })

      return resolution.store.put(plan).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            saved = Option.some(plan)
          })
        ),
        Effect.as(plan)
      )
    })
  }
}

/** A positive finite limit, floored; otherwise `undefined` (callers pick the default). */
export const positiveInteger = (value: number | undefined) =>
  value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined

/** `NestedToolExecutor.staging` for one nested-access call. */
export const makeToolPlanStaging = <Context>(
  resolution: ToolPlanResolution<Context>,
  parent: ToolCall
): ToolPlanStaging => ({
  tools: resolution.stageableTools,
  reviewToolName: resolution.reviewToolName,
  maxCalls: resolution.maxCalls,
  maxArgsBytes: resolution.maxArgsBytes,
  begin: options =>
    makeBuilder(
      resolution,
      // A throwing host callback disables staging for this call (an invalid id), never the script.
      Result.getOrElse(
        Result.try(() => resolution.planId(parent)),
        () => ''
      ),
      Math.min(resolution.maxCalls, positiveInteger(options?.maxCalls) ?? resolution.maxCalls)
    )
})

const invalid = (message: string) => new InteractionValidationError({ message })

/** What a listing may conclude about selected calls without a ledger entry (see `listing`). */
type ListingBasis = 'fenced' | 'ended' | 'uncertain'

// The apply fence stores the apply's result in its ledger entry; a replay decodes it back.
const FencedApply = Schema.Struct({
  type: Schema.Literal('tool_plan_apply'),
  outcome: InteractionBusinessOutcome,
  content: Schema.String,
  result: ToolPlanOutcome
})

const decodeFencedApply = Schema.decodeUnknownOption(FencedApply)

const toFenceResult = (reviewCall: ToolCall, applied: ToolPlanApplyResult): ToolResult =>
  ToolResult.make({
    toolCallId: reviewCall.id,
    content: applied.content,
    structuredContent: {
      type: 'tool_plan_apply',
      outcome: applied.outcome,
      content: applied.content,
      result: applied.structuredContent
    }
  })

const fromFenceResult = (result: ToolResult): ToolPlanApplyResult | undefined =>
  Option.getOrUndefined(
    Option.map(decodeFencedApply(result.structuredContent), fenced => ({
      outcome: fenced.outcome,
      content: fenced.content,
      structuredContent: fenced.result
    }))
  )

const countsOf = (calls: ReadonlyArray<ToolPlanCallOutcome>): ToolPlanCallCounts => {
  const count = (status: ToolPlanCallStatus) => calls.filter(call => call.status === status).length

  return {
    applied: count('applied'),
    failed: count('failed'),
    skipped: count('skipped'),
    not_run: count('not_run'),
    unknown: count('unknown')
  }
}

const outcomeLine = (call: ToolPlanCallOutcome) =>
  `- ${call.key} ${call.toolName}: ${call.status.replace('_', ' ')}${call.error === undefined ? '' : `: ${truncateCodePoints(call.error, 200)}`}`

/** Model-visible lines stay bounded for large plans: applied and skipped calls are counted only,
 * and at most `maxListedCalls` other calls are listed. `structuredContent.calls` keeps every call.
 */
const maxListedCalls = 50

const notableLines = (calls: ReadonlyArray<ToolPlanCallOutcome>) => {
  const notable = calls.filter(call => call.status !== 'applied' && call.status !== 'skipped')
  const lines = notable.slice(0, maxListedCalls).map(outcomeLine)

  return notable.length > maxListedCalls
    ? [...lines, `- … and ${notable.length - maxListedCalls} more`]
    : lines
}

const countsText = (counts: ToolPlanCallCounts) =>
  `${counts.applied} applied, ${counts.failed} failed, ${counts.skipped} skipped, ${counts.not_run} not run`

/** Appended to refusals caused by an outage before the plan was claimed: the review attempt
 * ended, but the plan is intact and a new review can apply it.
 */
const reviewAgain =
  'The plan is unchanged and can still be applied: open a new review (call the review tool again).'

const refusedResult = (planId: string, message: string): ToolPlanApplyResult => {
  const structuredContent: ToolPlanOutcome = {
    type: 'tool_plan_outcome',
    planId,
    state: 'refused',
    calls: [],
    counts: countsOf([])
  }

  return {
    outcome: 'failed',
    content: `Plan ${planId} was not applied: ${message} Nothing was applied.`,
    structuredContent
  }
}

const resultText = (result: ToolResult) => {
  const text = Predicate.isString(result.content) ? result.content : contentText(result.content)

  return text.length > 0 ? text : 'The tool returned an error result.'
}

type CallOutcomeFields = {
  key: string
  toolName: string
  status: ToolPlanCallStatus
  callId?: string
  error?: string
}

const callOutcome = (fields: CallOutcomeFields): ToolPlanCallOutcome => {
  const outcome: CallOutcomeFields = {
    key: fields.key,
    toolName: fields.toolName,
    status: fields.status
  }

  if (fields.callId !== undefined) outcome.callId = fields.callId

  if (fields.error !== undefined)
    outcome.error = truncateCodePoints(fields.error, nestedToolCallMaxErrorChars)

  return outcome
}

const decodeReviewParams = Schema.decodeUnknownOption(ToolPlanReviewParams)

const decodeReviewResponse = Schema.decodeUnknownOption(ToolPlanReviewResponse)

const sameKeys = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
  left.length === right.length && left.every((key, index) => key === right[index])

/** The receipt binds exactly this apply: started, submitted, same call, plan, and selection.
 * `reviewCall` is the normalized business call; comparing its params with the receipt's original
 * params is exact only because `ToolPlanReviewParams` has no optional fields (keep it so).
 */
const receiptMatches = (
  receipt: InteractionReceipt | undefined,
  input: {
    readonly reviewToolName: string
    readonly reviewCall: ToolCall
    readonly submissionId: string
    readonly planId: string
    readonly planDigest: string
    readonly keys: ReadonlyArray<string>
  }
) => {
  if (
    receipt === undefined ||
    receipt.status !== 'started' ||
    receipt.outcome !== 'submitted' ||
    receipt.actionId !== toolPlanReviewActionId ||
    receipt.submissionId !== input.submissionId ||
    receipt.slot !== interactionRequestId(input.reviewCall) ||
    receipt.call.id !== input.reviewCall.id ||
    receipt.call.name !== input.reviewCall.name ||
    receipt.call.name !== input.reviewToolName ||
    !interactionJsonEquals(receipt.call.params, input.reviewCall.params)
  )
    return false

  const params = decodeReviewParams(receipt.call.params)
  const data = decodeReviewResponse(receipt.data)

  return (
    Option.isSome(params) &&
    Option.isSome(data) &&
    params.value.planId === input.planId &&
    params.value.planDigest === input.planDigest &&
    sameKeys(data.value.selectedKeys, input.keys)
  )
}

const ledgerStatus = (entry: ToolLedgerEntry): ToolPlanCallStatus => {
  const outcome = entry.outcome

  if (outcome === undefined) return 'unknown'

  if (Predicate.isTagged(outcome, 'Failed')) return 'failed'

  return outcome.result.isError === true ? 'failed' : 'applied'
}

const ledgerError = (entry: ToolLedgerEntry) => {
  const outcome = entry.outcome

  if (outcome === undefined) return undefined

  if (Predicate.isTagged(outcome, 'Failed')) return outcome.error.message

  return outcome.result.isError === true ? resultText(outcome.result) : undefined
}

/** The plan capabilities bound into plan review registrations. */
export const makeToolPlanRuntime = <Context>(
  resolution: ToolPlanResolution<Context>
): ToolPlanRuntime<Context> => {
  const { store } = resolution

  const stagedCallFor = (registration: ToolRegistration<Context>, staged: StagedCall, id: string) =>
    resolution.businessCall(
      registration,
      ToolCall.make({ id, name: staged.toolName, params: staged.params })
    )

  const load: ToolPlanRuntime<Context>['load'] = ({ planId, planDigest }) =>
    store.get(planId).pipe(
      // An outage is never a verdict on the review: callers fail closed and retry.
      Effect.mapError(
        error =>
          new InteractionHostError({
            cause: 'storage',
            message: `The plan store is unavailable: ${error.message}`
          })
      ),
      Effect.flatMap((stored): Effect.Effect<ToolPlan, InteractionValidationError> => {
        if (stored === undefined || stored.plan.id !== planId)
          return Effect.fail(invalid(`Plan ${planId} was not found.`))

        const plan = stored.plan

        if (plan.scope !== store.scope)
          return Effect.fail(invalid(`Plan ${planId} belongs to another scope.`))

        const problem = toolPlanIntegrityProblem(plan)

        if (problem !== undefined) return Effect.fail(invalid(problem))

        if (plan.digest !== planDigest)
          return Effect.fail(
            invalid(
              `planDigest does not match plan ${planId}; pass the digest the script reported exactly.`
            )
          )

        if (stored.claimedBy !== undefined)
          return Effect.fail(
            invalid(`Plan ${planId} was already reviewed and applied; it cannot be applied again.`)
          )

        return Effect.succeed(plan)
      })
    )

  const validateSelection: ToolPlanRuntime<Context>['validateSelection'] = ({ plan, keys }) =>
    Effect.gen(function* () {
      if (keys.length === 0) return yield* Effect.fail(invalid('Select at least one call.'))

      if (new Set(keys).size !== keys.length)
        return yield* Effect.fail(invalid('The selection repeats a staged call.'))

      const selected: Array<{
        readonly staged: StagedCall
        readonly registration: ToolRegistration<Context>
      }> = []

      for (const key of keys) {
        const staged = plan.calls.find(call => call.key === key)

        if (staged === undefined)
          return yield* Effect.fail(invalid(`${key} is not a staged call of plan ${plan.id}.`))

        const registration = resolution.stageable(staged.toolName)

        if (registration === undefined)
          return yield* Effect.fail(
            invalid(`${staged.toolName} (${key}) can no longer be applied from a plan.`)
          )

        selected.push({ staged, registration })
      }

      yield* Effect.forEach(
        selected,
        ({ staged, registration }) => {
          const precheck = registration.staging?.precheck

          return precheck === undefined
            ? Effect.void
            : Effect.suspend(() =>
                precheck({
                  call: stagedCallFor(registration, staged, staged.key),
                  context: resolution.context
                })
              ).pipe(Effect.mapError(error => invalid(`${staged.key}: ${error.message}`)))
        },
        { concurrency: toolPlanPrecheckConcurrency, discard: true }
      )
    })

  const listNested = (reviewCall: ToolCall) =>
    resolution.listNested === undefined
      ? Effect.succeed(undefined)
      : resolution.listNested(reviewCall.id).pipe(
          Effect.map(sortToolLedgerEntries),
          Effect.catch(error =>
            Effect.logWarning(
              `Plan review ${reviewCall.id}: the tool ledger could not list applied calls: ${error.message}`
            ).pipe(Effect.as(undefined))
          )
        )

  /**
   * The listing of an apply without a recorded outcome. A selected call without a ledger entry is
   * `not_run` only when that is provable: another review owns the plan, this execution holds the
   * apply fence that no apply passed (`fenced`), or the apply itself ended and the tool is
   * ledgered (`ended`, the apply's own seal). While an apply may still be running (`uncertain`)
   * it is `unknown`: that apply can still reach it.
   */
  const listing = (input: {
    readonly reviewCall: ToolCall
    readonly submissionId: string
    readonly planId: string | undefined
    readonly plan: ToolPlan | undefined
    readonly claimedBy: string | undefined
    readonly selection: ReadonlyArray<string> | undefined
    readonly entries: ReadonlyArray<ToolLedgerEntry> | undefined
    readonly basis: ListingBasis
  }): ToolPlanApplyResult => {
    const { reviewCall, plan, selection, entries } = input

    const fromEntry = (key: string, entry: ToolLedgerEntry) => {
      const error = ledgerError(entry)
      const fields = { key, toolName: entry.toolName, status: ledgerStatus(entry) }

      return callOutcome(
        error === undefined
          ? { ...fields, callId: entry.key }
          : { ...fields, callId: entry.key, error }
      )
    }

    const neverRuns = (staged: StagedCall, callId: string) => {
      if (input.claimedBy !== undefined && input.claimedBy !== input.submissionId) return true

      if (input.basis === 'fenced') return true

      if (input.basis === 'uncertain' || entries === undefined) return false

      const registration = resolution.stageable(staged.toolName)

      return (
        registration !== undefined &&
        resolution.ledgered?.(
          registration,
          ToolCall.make({ id: callId, name: staged.toolName, params: staged.params }),
          reviewCall.id
        ) === true
      )
    }

    const calls =
      plan !== undefined && selection !== undefined
        ? plan.calls.map((staged, position) => {
            const base = { key: staged.key, toolName: staged.toolName }

            if (!selection.includes(staged.key)) return callOutcome({ ...base, status: 'skipped' })

            const callId = `${reviewCall.id}/${position + 1}`
            const entry = entries?.find(candidate => candidate.key === callId)

            if (entry !== undefined) return fromEntry(staged.key, entry)

            return callOutcome({
              ...base,
              status: neverRuns(staged, callId) ? 'not_run' : 'unknown'
            })
          })
        : (entries?.map(entry => {
            const position = Number(entry.key.slice(entry.key.lastIndexOf('/') + 1))

            return fromEntry(plan?.calls[position - 1]?.key ?? entry.key, entry)
          }) ?? [])

    const counts = countsOf(calls)
    const label = input.planId ?? `of review ${reviewCall.id}`

    // Known no effect only when every listed call provably never ran.
    const nothingRan =
      calls.length > 0 &&
      calls.every(call => call.status === 'not_run' || call.status === 'skipped')

    const header = Match.value(input.basis).pipe(
      Match.when(
        'fenced',
        () =>
          `Applying plan ${label} never started: the execution that accepted the review stopped before applying any call. Nothing was applied, and nothing will run for this review.`
      ),
      Match.when(
        'ended',
        () =>
          `Applying plan ${label} stopped unexpectedly before recording an outcome. It was not run again.`
      ),
      Match.when(
        'uncertain',
        () =>
          `Applying plan ${label} has no recorded outcome: an earlier execution started applying it and may still be running (or it crashed). It was not run again here.`
      ),
      Match.exhaustive
    )

    const body =
      calls.length === 0
        ? entries === undefined
          ? 'Its calls cannot be listed (no tool ledger is available), so any selected call may already have been applied.'
          : 'The tool ledger recorded no applied calls for it.'
        : [
            `Calls as recorded now (none were undone): ${counts.applied} applied, ${counts.failed} failed, ${counts.unknown} unknown, ${counts.not_run} not started.`,
            ...notableLines(calls)
          ].join('\n')

    const outcome: ToolPlanOutcome = {
      type: 'tool_plan_outcome',
      planId: input.planId ?? '',
      state: 'interrupted',
      calls,
      counts
    }

    return {
      outcome: nothingRan ? 'failed' : 'unknown',
      content: [
        header,
        body,
        'Unknown calls may have been applied, possibly by an execution that is still running; calls not started were not applied and will not run for this review. Verify the current state before staging any of them again.'
      ].join('\n\n'),
      structuredContent: entries === undefined ? { ...outcome, ledgerUnavailable: true } : outcome
    }
  }

  const fenceCallOf = (reviewCall: ToolCall) =>
    ToolCall.make({ id: reviewCall.id, name: reviewCall.name, params: reviewCall.params })

  // Runs `effect` behind the apply fence, or falls back when it is unavailable: in flight past
  // the wait, abandoned, or replaying a stored outcome that no longer decodes.
  const fenced = (input: {
    readonly reviewCall: ToolCall
    readonly execute: Effect.Effect<ToolPlanApplyResult>
    readonly uncertain: (entries: ReadonlyArray<ToolLedgerEntry> | undefined) => ToolPlanApplyResult
    readonly unavailable: (message: string) => Effect.Effect<ToolPlanApplyResult>
  }): Effect.Effect<ToolPlanApplyResult> =>
    Effect.gen(function* () {
      const fence = resolution.fence

      if (fence === undefined) return yield* input.execute

      const toFence = (applied: ToolPlanApplyResult) => toFenceResult(input.reviewCall, applied)

      const result = yield* fence({
        call: fenceCallOf(input.reviewCall),
        execute: input.execute.pipe(Effect.map(toFence)),
        abandonedResult: ({ nested }) => toFence(input.uncertain(nested)),
        inFlightTimeoutResult: listNested(input.reviewCall).pipe(
          Effect.map(entries => toFence(input.uncertain(entries)))
        )
      }).pipe(Effect.result)

      if (Result.isFailure(result)) return yield* input.unavailable(result.failure.message)

      const replayed = fromFenceResult(result.success)

      return replayed ?? input.uncertain(yield* listNested(input.reviewCall))
    })

  const interrupted: ToolPlanRuntime<Context>['interrupted'] = ({
    reviewCall,
    submissionId,
    phase
  }) =>
    Effect.gen(function* () {
      const planId = Option.getOrUndefined(decodeReviewParams(reviewCall.params))?.planId

      // Best-effort reads: a failing read only makes the listing less precise, never empty.
      const stored =
        planId === undefined
          ? undefined
          : yield* store.get(planId).pipe(Effect.orElseSucceed(() => undefined))

      const receipt = yield* resolution.host
        .read(interactionRequestId(reviewCall))
        .pipe(Effect.orElseSucceed(() => undefined))

      const selection =
        receipt === undefined
          ? undefined
          : Option.getOrUndefined(decodeReviewResponse(receipt.data))?.selectedKeys

      const listingOf = (
        basis: ListingBasis,
        entries: ReadonlyArray<ToolLedgerEntry> | undefined,
        claimedBy: string | undefined = stored?.claimedBy
      ) =>
        listing({
          reviewCall,
          submissionId,
          planId,
          plan: stored?.plan,
          claimedBy,
          selection,
          entries,
          basis
        })

      // The apply's own seal: it ended here, so calls it never reached never started.
      if (phase === 'seal') return listingOf('ended', yield* listNested(reviewCall))

      // A replay: wait for an in-flight apply behind the fence and return its real outcome, or
      // hold the fence itself. The fence is proof only within one ledger scope that keeps its
      // entries (a host requirement). The durable plan claim, which every apply takes inside the
      // fence before its first call, must also agree, which catches an apply that already
      // claimed the plan elsewhere (not one that has yet to): nothing ran only when the plan and
      // selection are known, the plan is not claimed by this review, and the ledger lists no
      // call of it.
      const holdingFence = Effect.gen(function* () {
        const entries = yield* listNested(reviewCall)

        const current =
          planId === undefined ? undefined : yield* store.get(planId).pipe(Effect.result)

        const claimedBy =
          current !== undefined && Result.isSuccess(current)
            ? current.success?.claimedBy
            : stored?.claimedBy

        const proven =
          resolution.fence !== undefined &&
          current !== undefined &&
          Result.isSuccess(current) &&
          current.success !== undefined &&
          stored?.plan !== undefined &&
          selection !== undefined &&
          claimedBy !== submissionId &&
          entries !== undefined &&
          entries.length === 0

        return listingOf(proven ? 'fenced' : 'uncertain', entries, claimedBy)
      })

      return yield* fenced({
        reviewCall,
        execute: holdingFence,
        uncertain: entries => listingOf('uncertain', entries),
        unavailable: () =>
          listNested(reviewCall).pipe(Effect.map(entries => listingOf('uncertain', entries)))
      })
    })

  const apply: ToolPlanRuntime<Context>['apply'] = input =>
    Effect.gen(function* () {
      const { planId, reviewCall } = input
      const refused = (message: string) => Effect.succeed(refusedResult(planId, message))

      // The privileged executor re-reads the receipt: nothing runs without the person's accepted,
      // started review of exactly this plan, digest, and selection.
      const receipt = yield* resolution.host
        .read(interactionRequestId(reviewCall))
        .pipe(Effect.result)

      if (Result.isFailure(receipt))
        return yield* refused(
          `the review receipt could not be read (${receipt.failure.message}). ${reviewAgain}`
        )

      if (!receiptMatches(receipt.success, { ...input, reviewToolName: resolution.reviewToolName }))
        return yield* refused('no accepted review of this plan and selection was found.')

      const stored = yield* store.get(planId).pipe(Effect.result)

      if (Result.isFailure(stored))
        return yield* refused(
          `the plan store is unavailable (${stored.failure.message}). ${reviewAgain}`
        )

      const plan = stored.success?.plan

      if (plan === undefined || plan.id !== planId) return yield* refused('the plan was not found.')

      if (plan.scope !== store.scope) return yield* refused('the plan belongs to another scope.')

      const problem = toolPlanIntegrityProblem(plan)

      if (problem !== undefined) return yield* refused(problem)

      if (plan.digest !== input.planDigest)
        return yield* refused('the plan does not match the reviewed digest.')

      const selected = new Set(input.keys)

      if (input.keys.some(key => !plan.calls.some(call => call.key === key)))
        return yield* refused('the selection names calls that are not in the plan.')

      const uncertain = (entries: ReadonlyArray<ToolLedgerEntry> | undefined) =>
        listing({
          reviewCall,
          submissionId: input.submissionId,
          planId,
          plan,
          claimedBy: undefined,
          selection: input.keys,
          entries,
          basis: 'uncertain'
        })

      // Behind the fence: claim the plan once, then run the selected calls in staged order.
      const run: Effect.Effect<ToolPlanApplyResult> = Effect.gen(function* () {
        const claim = yield* store
          .claim({ planId, submissionId: input.submissionId })
          .pipe(Effect.result)

        if (Result.isFailure(claim))
          return yield* refused(
            `the plan could not be claimed (${claim.failure.message}); it may now be locked against other reviews.`
          )

        if (claim.success === 'taken')
          return yield* refused(
            'another review already claimed this plan; a plan is applied at most once.'
          )

        // Claimed earlier outside this fence: never run again.
        if (claim.success === 'same') return uncertain(yield* listNested(reviewCall))

        const outcomes: Array<ToolPlanCallOutcome> = []
        let stopped = false

        for (const [position, staged] of plan.calls.entries()) {
          const base = { key: staged.key, toolName: staged.toolName }

          if (!selected.has(staged.key)) {
            outcomes.push(callOutcome({ ...base, status: 'skipped' }))
            continue
          }

          if (stopped) {
            outcomes.push(callOutcome({ ...base, status: 'not_run' }))
            continue
          }

          const callId = `${reviewCall.id}/${position + 1}`
          const registration = resolution.stageable(staged.toolName)

          // Never attempted: no call id (it was neither admitted nor executed).
          if (registration === undefined) {
            outcomes.push(
              callOutcome({
                ...base,
                status: 'failed',
                error: `${staged.toolName} can no longer be applied from a plan.`
              })
            )

            if (input.onFailure === 'stop') stopped = true

            continue
          }

          const attempt: Effect.Effect<string | undefined> = Effect.gen(function* () {
            const call = ToolCall.make({
              id: callId,
              name: staged.toolName,
              params: staged.params
            })

            const beforeCall = input.beforeCall

            if (beforeCall !== undefined) {
              const admitted = yield* Effect.suspend(() =>
                beforeCall({ call, staged, context: resolution.context })
              ).pipe(Effect.result)

              if (Result.isFailure(admitted)) return admitted.failure
            }

            const executed = yield* resolution
              .execute(registration, call, reviewCall.id)
              .pipe(Effect.result)

            if (Result.isFailure(executed)) return executed.failure.message

            return executed.success.isError === true ? resultText(executed.success) : undefined
          })

          const error = yield* attempt

          if (error === undefined) {
            outcomes.push(callOutcome({ ...base, status: 'applied', callId }))
          } else {
            outcomes.push(callOutcome({ ...base, status: 'failed', callId, error }))

            if (input.onFailure === 'stop') stopped = true
          }
        }

        const counts = countsOf(outcomes)

        const structuredContent: ToolPlanOutcome = {
          type: 'tool_plan_outcome',
          planId,
          state: 'applied',
          calls: outcomes,
          counts
        }

        return {
          outcome: 'completed',
          content: [
            `Applied plan ${planId}: ${countsText(counts)}.${counts.applied === 0 ? ' No call reported success.' : ''}`,
            ...notableLines(outcomes),
            ...(counts.not_run > 0
              ? ['Calls marked not run were skipped after a failure; nothing was undone.']
              : [])
          ].join('\n'),
          structuredContent
        }
      })

      return yield* fenced({
        reviewCall,
        execute: run,
        uncertain,
        unavailable: message =>
          refused(`the tool ledger is unavailable (${message}). ${reviewAgain}`)
      })
    })

  return { scope: store.scope, load, validateSelection, apply, interrupted }
}

/** Per-key previews for host review screens (`previewToolPlan`). */
export const previewToolPlanWith =
  <Context>(resolution: ToolPlanResolution<Context>) =>
  (input: {
    readonly plan: ToolPlan
    readonly keys: ReadonlyArray<string>
  }): Effect.Effect<ReadonlyArray<ToolPlanPreview>, ToolPlanPreviewError> =>
    Effect.gen(function* () {
      const { plan, keys } = input

      if (keys.length > maxToolPlanPreviewKeys)
        return yield* Effect.fail(
          new ToolPlanPreviewError({
            cause: 'page_too_large',
            message: `Preview at most ${maxToolPlanPreviewKeys} keys per call.`
          })
        )

      const problem =
        plan.scope !== resolution.store.scope
          ? 'The plan belongs to another scope.'
          : toolPlanIntegrityProblem(plan)

      if (problem !== undefined)
        return yield* Effect.fail(
          new ToolPlanPreviewError({ cause: 'invalid_plan', message: problem })
        )

      return yield* Effect.forEach(
        keys,
        (key): Effect.Effect<ToolPlanPreview> => {
          const staged = plan.calls.find(call => call.key === key)

          if (staged === undefined)
            return Effect.succeed({
              key,
              status: 'error',
              message: 'Not a staged call of the plan.'
            })

          const registration = resolution.stageable(staged.toolName)

          if (registration === undefined)
            return Effect.succeed({
              key,
              status: 'error',
              toolName: staged.toolName,
              message: `${staged.toolName} can no longer be applied from a plan.`
            })

          const preview = registration.staging?.preview

          if (preview === undefined)
            return Effect.succeed({
              key,
              status: 'ok',
              toolName: staged.toolName,
              params: staged.params
            })

          return Effect.suspend(() =>
            preview({
              call: resolution.businessCall(
                registration,
                ToolCall.make({ id: staged.key, name: staged.toolName, params: staged.params })
              ),
              context: resolution.context
            })
          ).pipe(
            Effect.match({
              onFailure: (error): ToolPlanPreview => ({
                key,
                status: 'error',
                toolName: staged.toolName,
                message: truncateCodePoints(error.message, nestedToolCallMaxErrorChars)
              }),
              onSuccess: (rendered): ToolPlanPreview =>
                utf8ByteLength(compactToolArguments(rendered)) > maxToolPlanPreviewBytes
                  ? {
                      key,
                      status: 'error',
                      toolName: staged.toolName,
                      message: `The preview exceeds ${maxToolPlanPreviewBytes} bytes.`
                    }
                  : {
                      key,
                      status: 'ok',
                      toolName: staged.toolName,
                      params: staged.params,
                      preview: rendered
                    }
            })
          )
        },
        { concurrency: 4 }
      )
    })

/** One page of a stored plan's previews (`previewStoredToolPlan`): loaded from the resolution's
 * plan store with the review's scope, integrity, and digest checks, reporting the claim state.
 */
export const previewStoredToolPlanWith =
  <Context>(resolution: ToolPlanResolution<Context>) =>
  (input: {
    readonly planId: string
    readonly planDigest: string
    readonly offset?: number
    readonly limit?: number
  }): Effect.Effect<ToolPlanPreviewPage, ToolPlanPreviewError> =>
    Effect.gen(function* () {
      const stored = yield* resolution.store.get(input.planId).pipe(
        Effect.mapError(
          error =>
            new ToolPlanPreviewError({
              cause: 'storage',
              message: `The plan store is unavailable: ${error.message}`
            })
        )
      )

      if (stored === undefined || stored.plan.id !== input.planId)
        return yield* Effect.fail(
          new ToolPlanPreviewError({
            cause: 'not_found',
            message: `Plan ${input.planId} was not found.`
          })
        )

      const plan = stored.plan

      if (plan.digest !== input.planDigest)
        return yield* Effect.fail(
          new ToolPlanPreviewError({
            cause: 'invalid_plan',
            message: `planDigest does not match plan ${input.planId}.`
          })
        )

      const offset = Math.max(0, Math.floor(input.offset ?? 0))

      const limit = Math.min(
        maxToolPlanPreviewKeys,
        positiveInteger(input.limit) ?? maxToolPlanPreviewKeys
      )

      const keys = plan.calls.slice(offset, offset + limit).map(call => call.key)
      const previews = yield* previewToolPlanWith(resolution)({ plan, keys })
      const nextOffset = offset + keys.length

      const page: ToolPlanPreviewPage = {
        planId: plan.id,
        planDigest: plan.digest,
        total: plan.calls.length,
        offset,
        claimed: stored.claimedBy !== undefined,
        previews
      }

      return nextOffset < plan.calls.length ? { ...page, nextOffset } : page
    })
