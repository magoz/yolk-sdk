import { Effect, Option, Predicate, Result } from 'effect'
import * as Schema from 'effect/Schema'
import type { ToolError } from '@yolk-sdk/agent/loop'
import {
  contentText,
  interactionJsonEquals,
  interactionRequestId,
  InteractionHostError,
  InteractionValidationError,
  ToolCall,
  type InteractionHost,
  type InteractionReceipt,
  type ToolResult
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
  type ToolPlanOutcome,
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

  const interrupted: ToolPlanRuntime<Context>['interrupted'] = ({ reviewCall, submissionId }) =>
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

      const entries =
        resolution.listNested === undefined
          ? undefined
          : yield* resolution.listNested(reviewCall.id).pipe(
              Effect.map(sortToolLedgerEntries),
              Effect.catch(error =>
                Effect.logWarning(
                  `Plan review ${reviewCall.id}: the tool ledger could not list applied calls: ${error.message}`
                ).pipe(Effect.as(undefined))
              )
            )

      const fromEntry = (key: string, entry: ToolLedgerEntry) => {
        const error = ledgerError(entry)
        const fields = { key, toolName: entry.toolName, status: ledgerStatus(entry) }

        return callOutcome(
          error === undefined
            ? { ...fields, callId: entry.key }
            : { ...fields, callId: entry.key, error }
        )
      }

      const plan = stored?.plan

      // With the plan and the accepted selection, every staged call is accounted for: unselected
      // calls are skipped; a selected call without a ledger entry never started when its tool is
      // ledgered (the claim precedes execution) or when this review never claimed the plan, and
      // is unknown otherwise (no ledger, or a tool the ledger policy skips).
      const calls =
        plan !== undefined && selection !== undefined
          ? plan.calls.map((staged, position) => {
              const base = { key: staged.key, toolName: staged.toolName }

              if (!selection.includes(staged.key))
                return callOutcome({ ...base, status: 'skipped' })

              const callId = `${reviewCall.id}/${position + 1}`
              const entry = entries?.find(candidate => candidate.key === callId)

              if (entry !== undefined) return fromEntry(staged.key, entry)

              if (stored?.claimedBy !== submissionId)
                return callOutcome({ ...base, status: 'not_run' })

              const registration = resolution.stageable(staged.toolName)

              const ledgered =
                entries !== undefined &&
                registration !== undefined &&
                resolution.ledgered?.(
                  registration,
                  ToolCall.make({ id: callId, name: staged.toolName, params: staged.params }),
                  reviewCall.id
                ) === true

              return callOutcome({ ...base, status: ledgered ? 'not_run' : 'unknown' })
            })
          : (entries?.map(entry => {
              const position = Number(entry.key.slice(entry.key.lastIndexOf('/') + 1))

              return fromEntry(plan?.calls[position - 1]?.key ?? entry.key, entry)
            }) ?? [])

      const counts = countsOf(calls)
      const label = planId ?? `of review ${reviewCall.id}`

      const listing =
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
        planId: planId ?? '',
        state: 'interrupted',
        calls,
        counts
      }

      return {
        outcome: 'unknown',
        content: [
          `Applying plan ${label} has no recorded outcome: an earlier execution started applying it and recorded none (it crashed or is still running). It was not run again.`,
          listing,
          'Unknown calls may have been applied; calls not started were not. Verify the current state before staging any of them again.'
        ].join('\n\n'),
        structuredContent: entries === undefined ? { ...outcome, ledgerUnavailable: true } : outcome
      }
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
        return yield* refused(`the review receipt could not be read (${receipt.failure.message}).`)

      if (!receiptMatches(receipt.success, { ...input, reviewToolName: resolution.reviewToolName }))
        return yield* refused('no accepted review of this plan and selection was found.')

      const stored = yield* store.get(planId).pipe(Effect.result)

      if (Result.isFailure(stored))
        return yield* refused(`the plan store is unavailable (${stored.failure.message}).`)

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

      const claim = yield* store
        .claim({ planId, submissionId: input.submissionId })
        .pipe(Effect.result)

      if (Result.isFailure(claim))
        return yield* refused(`the plan could not be claimed (${claim.failure.message}).`)

      if (claim.success === 'taken')
        return yield* refused('another review already applied this plan; a plan is applied once.')

      if (claim.success === 'same')
        return yield* interrupted({ reviewCall, submissionId: input.submissionId })

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
