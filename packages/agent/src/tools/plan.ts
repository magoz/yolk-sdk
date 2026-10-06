import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import type { ToolError } from '@yolk-sdk/agent/loop'
import type {
  InteractionBusinessOutcome,
  InteractionValidationError,
  ToolCall
} from '@yolk-sdk/agent/protocol'
import { canonicalToolArguments } from './ledger.ts'
import type { NestedTool } from './registry.ts'
import { sha256HexSync } from './sha256.ts'

const NonEmptyTrimmedString = Schema.Trimmed.pipe(Schema.check(Schema.isNonEmpty()))

/**
 * One call a script staged instead of running (ADR 0005). `key` is `<codemodeCallId>/s<n>`
 * (1-based, staging order); `params` are the raw JSON arguments the script passed, validated by the
 * tool's side-effect-free decoder; `argsDigest` is their `toolLedgerArgs` digest, so the applied
 * call's ledger entry carries the same digest.
 */
export class StagedCall extends Schema.Class<StagedCall>('StagedCall')({
  key: NonEmptyTrimmedString,
  toolName: NonEmptyTrimmedString,
  params: Schema.Json,
  argsDigest: Schema.String
}) {}

/**
 * A staged tool plan: the ordered calls one script staged. `id` is the staging (code mode) call id,
 * `scope` the plan store scope it was saved in, and `digest` the `toolPlanDigest` of its calls.
 * Plain wire data: persist it with `Schema.toCodecJson(ToolPlan)`.
 */
export class ToolPlan extends Schema.Class<ToolPlan>('ToolPlan')({
  id: NonEmptyTrimmedString,
  scope: Schema.String,
  digest: Schema.String,
  calls: Schema.NonEmptyArray(StagedCall)
}) {}

/** Model-facing parameters of a plan review call: the plan id and digest the script reported. */
export const ToolPlanReviewParams = Schema.Struct({
  planId: NonEmptyTrimmedString.annotate({ description: 'The plan id the script reported.' }),
  planDigest: NonEmptyTrimmedString.annotate({
    description: 'The plan digest the script reported, copied exactly.'
  })
})

export type ToolPlanReviewParams = typeof ToolPlanReviewParams.Type

/** A person's review selection: the staged keys to apply (untick only; arguments never change). */
export const ToolPlanReviewResponse = Schema.Struct({
  selectedKeys: Schema.NonEmptyArray(NonEmptyTrimmedString)
})

export type ToolPlanReviewResponse = typeof ToolPlanReviewResponse.Type

/** Digest of one staged call's arguments: the `toolLedgerArgs` `argsDigest` format. */
export const stagedCallDigest = (params: unknown): string =>
  sha256HexSync(canonicalToolArguments(params))

/** Digest of a plan: lower-case hex SHA-256 of the canonical JSON of the ordered
 * `[toolName, argsDigest]` pairs of its calls. A conflict and tamper fingerprint, not a signature.
 */
export const toolPlanDigest = (
  calls: ReadonlyArray<{ readonly toolName: string; readonly argsDigest: string }>
): string => stagedCallDigest(calls.map(call => [call.toolName, call.argsDigest]))

/** Why a plan fails its integrity check, or `undefined` when its digests all match. */
export const toolPlanIntegrityProblem = (plan: ToolPlan): string | undefined => {
  const mismatch = plan.calls.find(call => stagedCallDigest(call.params) !== call.argsDigest)

  if (mismatch !== undefined) return `Staged call ${mismatch.key} does not match its digest.`

  // Keys are positional: a key moved to another call would select a call nobody reviewed.
  const misplaced = plan.calls.find((call, index) => call.key !== `${plan.id}/s${index + 1}`)

  if (misplaced !== undefined) return `Staged call ${misplaced.key} is out of place in the plan.`

  return toolPlanDigest(plan.calls) === plan.digest
    ? undefined
    : 'The plan does not match its digest.'
}

/** `claim` result: `claimed` (this submission now owns the plan), `same` (it already did: an
 * earlier execution started applying it), or `taken` (another submission owns it).
 */
export const ToolPlanClaimResult = Schema.Literals(['claimed', 'same', 'taken'])

export type ToolPlanClaimResult = typeof ToolPlanClaimResult.Type

export class ToolPlanStoreError extends Schema.TaggedError<ToolPlanStoreError>()(
  'ToolPlanStoreError',
  {
    message: Schema.String,
    cause: Schema.Literals(['conflict', 'not_found', 'storage'])
  }
) {}

/** A stored plan with its single-use claim (`claimedBy`: the owning review submission id). */
export type StoredToolPlan = {
  readonly plan: ToolPlan
  readonly claimedBy?: string | undefined
}

/**
 * Host-implemented storage of staged tool plans, scoped by the host to the conversation that
 * stages and reviews them (a review usually runs in a later turn or run than the script, so the
 * scope must outlive one run). Every operation is keyed within `scope`.
 *
 * - `put` inserts a plan once, keyed by `plan.id`: an existing plan with the same `digest` is a
 *   no-op (a re-executed script stages the same plan); a different digest fails with `conflict`.
 * - `get` returns the plan and its claim, or `undefined`.
 * - `claim` atomically records the review submission that applies the plan: `claimed` when it was
 *   unclaimed, `same` when this submission already owns it, `taken` when another one does. A plan
 *   is applied at most once; claims are never released.
 *
 * Operations must be interruptible, like `ToolLedgerStore` ones.
 */
export type ToolPlanStore = {
  readonly scope: string
  readonly put: (plan: ToolPlan) => Effect.Effect<void, ToolPlanStoreError>
  readonly get: (planId: string) => Effect.Effect<StoredToolPlan | undefined, ToolPlanStoreError>
  readonly claim: (input: {
    readonly planId: string
    readonly submissionId: string
  }) => Effect.Effect<ToolPlanClaimResult, ToolPlanStoreError>
}

/** An in-memory `ToolPlanStore` for tests and single-process hosts. Not durable. */
export type InMemoryToolPlanStore = ToolPlanStore & {
  readonly plans: Effect.Effect<ReadonlyArray<StoredToolPlan>>
}

/** Reference `ToolPlanStore` over a `Map`, following the store contract exactly. */
export const makeInMemoryToolPlanStore = (
  options: { readonly scope?: string } = {}
): InMemoryToolPlanStore => {
  const plans = new Map<string, { plan: ToolPlan; claimedBy?: string }>()

  return {
    scope: options.scope ?? 'memory',
    put: plan =>
      Effect.suspend(() => {
        const existing = plans.get(plan.id)

        if (existing === undefined) {
          plans.set(plan.id, { plan })

          return Effect.void
        }

        return existing.plan.digest === plan.digest
          ? Effect.void
          : Effect.fail(
              new ToolPlanStoreError({
                cause: 'conflict',
                message: `A different plan is already stored under ${plan.id}.`
              })
            )
      }),
    get: planId => Effect.sync(() => plans.get(planId)),
    claim: ({ planId, submissionId }) =>
      Effect.suspend(() => {
        const existing = plans.get(planId)

        if (existing === undefined)
          return Effect.fail(
            new ToolPlanStoreError({ cause: 'not_found', message: `No plan ${planId}.` })
          )

        if (existing.claimedBy === undefined) {
          plans.set(planId, { plan: existing.plan, claimedBy: submissionId })

          return Effect.succeed<ToolPlanClaimResult>('claimed')
        }

        return Effect.succeed<ToolPlanClaimResult>(
          existing.claimedBy === submissionId ? 'same' : 'taken'
        )
      }),
    plans: Effect.sync(() => [...plans.values()])
  }
}

/** Default cap of staged calls per plan. */
export const defaultToolPlanMaxCalls = 500

/** Default cap of a plan's staged arguments: UTF-8 bytes of their canonical JSON (1 MiB). */
export const defaultToolPlanMaxArgsBytes = 1024 * 1024

/** `resolveTools` plans option. Staging also requires an `interactionHost` and exactly one plan
 * review registration (`makePlanReviewTool`) in the resolution.
 */
export type ToolPlanOptions = {
  readonly store: ToolPlanStore
  /** Staged calls per plan; `stage` rejects past it (never truncates). Default 500. */
  readonly maxCalls?: number
  /** Canonical JSON bytes of all staged arguments of a plan; `stage` rejects past it. Default 1 MiB. */
  readonly maxArgsBytes?: number
}

/**
 * Optional per-tool staging hooks of a stageable registration, over the decoded staged arguments
 * and a fresh host context. `preview` renders a bounded JSON preview for host review screens
 * (`previewToolPlan`); `precheck` runs when a person's selection is validated (admission and
 * again before applying) and rejects a selection whose preconditions no longer hold. Neither may
 * have side effects.
 */
export type ToolStaging<Context, Params> = {
  readonly preview?: (input: {
    readonly params: Params
    readonly context: Context
  }) => Effect.Effect<Schema.Json, ToolError>
  readonly precheck?: (input: {
    readonly params: Params
    readonly context: Context
  }) => Effect.Effect<void, InteractionValidationError>
}

/** Registration-level staging hooks over the staged call (`makeTool` decodes before its typed
 * hooks). See `ToolStaging`.
 */
export type ToolStagingHandlers<Context> = {
  readonly preview?: (input: {
    readonly call: ToolCall
    readonly context: Context
  }) => Effect.Effect<Schema.Json, ToolError>
  readonly precheck?: (input: {
    readonly call: ToolCall
    readonly context: Context
  }) => Effect.Effect<void, InteractionValidationError>
}

export const ToolPlanStageErrorReason = Schema.Literals([
  'not_stageable',
  'invalid_arguments',
  'duplicate',
  'limit',
  'order'
])

export type ToolPlanStageErrorReason = typeof ToolPlanStageErrorReason.Type

/** A rejected `stage` (or a nested call the plan's ordering guardrail rejects). Model-visible. */
export class ToolPlanStageError extends Schema.TaggedError<ToolPlanStageError>()(
  'ToolPlanStageError',
  { message: Schema.String, reason: ToolPlanStageErrorReason }
) {}

/** What `stage` resolves to in a script. `index` is 1-based, matching the key's `s<n>`. */
export type StagedCallReceipt = {
  readonly staged: true
  readonly key: string
  readonly index: number
}

/**
 * The plan of one nested-access call (one script). Guardrails: once a call is staged, later
 * non-`read` nested calls are rejected (`admit`), and `stage` is rejected once a non-`read` nested
 * call was admitted; `read` calls are allowed anywhere. A duplicate (same tool and argument
 * digest) and calls past the plan caps are rejected, never truncated.
 */
export type ToolPlanBuilder = {
  /** Call before running each nested call; rejects non-`read` calls after staging. */
  readonly admit: (call: ToolCall) => Effect.Effect<void, ToolPlanStageError>
  /** Validates and records one call without executing or ledgering it. */
  readonly stage: (input: {
    readonly name: string
    readonly params: unknown
  }) => Effect.Effect<StagedCallReceipt, ToolPlanStageError>
  /** Staged calls so far, in order. */
  readonly staged: Effect.Effect<ReadonlyArray<StagedCall>>
  /** Saves the plan once (`ToolPlanStore.put`, idempotent); `undefined` when nothing was staged. */
  readonly finish: Effect.Effect<ToolPlan | undefined, ToolPlanStoreError>
}

/**
 * Staging for nested-access registrations (`NestedToolExecutor.staging`): present only when the
 * resolution has a plan store, an interaction host, and one plan review tool. Voice, subagent, and
 * other resolutions without them never get it.
 */
export type ToolPlanStaging = {
  /** Stageable tools of the resolution. */
  readonly tools: ReadonlyArray<NestedTool>
  /** Name of the plan review tool the model calls with the saved plan. */
  readonly reviewToolName: string
  readonly maxCalls: number
  readonly maxArgsBytes: number
  /** Starts this call's plan (id: the call id). `maxCalls` may only lower the resolution cap. */
  readonly begin: (options?: { readonly maxCalls?: number }) => ToolPlanBuilder
}

/** How applying continues after a selected call fails: `stop` (default; later selected calls are
 * `not_run`) or `continue`.
 */
export type ToolPlanFailurePolicy = 'stop' | 'continue'

/**
 * What happened to one staged call: `applied`, `failed` (an error result, a `ToolError`, or
 * rejected by `beforeCall`), `skipped` (not selected), `not_run` (selected, after a failure under
 * `stop`), or `unknown` (an interrupted apply's call that started without a recorded result).
 */
export type ToolPlanCallStatus = 'applied' | 'failed' | 'skipped' | 'not_run' | 'unknown'

export type ToolPlanCallOutcome = {
  /** The staged key (`<codemodeCallId>/s<n>`). */
  readonly key: string
  readonly toolName: string
  readonly status: ToolPlanCallStatus
  /** Ledger key of the applied call (`<reviewCallId>/<n>`), when it was attempted. */
  readonly callId?: string
  /** Truncated error text of a failed call. */
  readonly error?: string
}

export type ToolPlanCallCounts = { readonly [Status in ToolPlanCallStatus]: number }

/**
 * `result` of a plan review's `interaction_outcome`: `applied` (the selection ran; per-call
 * statuses), `refused` (nothing was applied: plan missing, changed, already applied, or no accepted
 * review), or `interrupted` (an earlier execution started applying and recorded no outcome; calls
 * are listed from the tool ledger, or `ledgerUnavailable`).
 */
export type ToolPlanOutcome = {
  readonly type: 'tool_plan_outcome'
  readonly planId: string
  readonly state: 'applied' | 'refused' | 'interrupted'
  readonly calls: ReadonlyArray<ToolPlanCallOutcome>
  readonly counts: ToolPlanCallCounts
  readonly ledgerUnavailable?: true
}

export type ToolPlanApplyResult = {
  readonly outcome: InteractionBusinessOutcome
  readonly content: string
  readonly structuredContent: ToolPlanOutcome
}

/** `beforeCall` of a plan review: admits or rejects each selected call before it runs (same shape
 * as code mode's `beforeNestedCall`). A failure records the call `failed` without executing it.
 */
export type ToolPlanBeforeCall<Context> = (input: {
  readonly call: ToolCall
  readonly staged: StagedCall
  readonly context: Context
}) => Effect.Effect<void, string>

/**
 * Plan capabilities `resolveTools` binds for plan review registrations (`makePlanReviewTool`).
 * `apply` is the privileged plan executor: it re-reads the review's interaction receipt and runs
 * nothing unless that receipt is accepted and started for this exact plan, digest, and selection.
 */
export type ToolPlanRuntime<Context> = {
  readonly scope: string
  /** Loads a plan for review: present, in scope, digests matching, unclaimed. */
  readonly load: (input: {
    readonly planId: string
    readonly planDigest: string
  }) => Effect.Effect<ToolPlan, InteractionValidationError>
  /** Selection checks: non-empty, no duplicates, keys of the plan, tools still stageable, and
   * each tool's `staging.precheck` with the resolution's (fresh) context.
   */
  readonly validateSelection: (input: {
    readonly plan: ToolPlan
    readonly keys: ReadonlyArray<string>
  }) => Effect.Effect<void, InteractionValidationError>
  readonly apply: (input: {
    readonly reviewCall: ToolCall
    readonly submissionId: string
    readonly planId: string
    readonly planDigest: string
    readonly keys: ReadonlyArray<string>
    /** Called with the resolution's (fresh) host context. */
    readonly beforeCall?: ToolPlanBeforeCall<Context> | undefined
    readonly onFailure: ToolPlanFailurePolicy
  }) => Effect.Effect<ToolPlanApplyResult>
  /** The listing for an apply that started and recorded no outcome (outcome `unknown`). */
  readonly interrupted: (input: {
    readonly reviewCall: ToolCall
  }) => Effect.Effect<ToolPlanApplyResult>
}

/** One entry of `previewToolPlan`. */
export type ToolPlanPreview =
  | {
      readonly key: string
      readonly status: 'ok'
      readonly toolName: string
      readonly params: Schema.Json
      /** The tool's `staging.preview`, when it has one. */
      readonly preview?: Schema.Json
    }
  | {
      readonly key: string
      readonly status: 'error'
      readonly toolName?: string
      readonly message: string
    }

export class ToolPlanPreviewError extends Schema.TaggedError<ToolPlanPreviewError>()(
  'ToolPlanPreviewError',
  {
    message: Schema.String,
    cause: Schema.Literals(['unavailable', 'invalid_plan', 'page_too_large'])
  }
) {}

/** Most keys one `previewToolPlan` call renders; hosts page larger plans. */
export const maxToolPlanPreviewKeys = 50

/** UTF-8 bytes of one preview's compact JSON; larger previews become error entries. */
export const maxToolPlanPreviewBytes = 16 * 1024

/** Plan capabilities of a resolution with staging (`ResolvedToolSet.plans`). */
export type ResolvedToolPlans = {
  readonly store: ToolPlanStore
  readonly reviewToolName: string
  readonly preview: (input: {
    readonly plan: ToolPlan
    readonly keys: ReadonlyArray<string>
  }) => Effect.Effect<ReadonlyArray<ToolPlanPreview>, ToolPlanPreviewError>
}
