import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { ToolError } from '@yolk-sdk/agent/loop'
import {
  InteractionActionDescriptor,
  InteractionDescriptor,
  InteractionValidationError,
  ToolDef
} from '@yolk-sdk/agent/protocol'
import { decodeToolArguments } from './arguments.ts'
import {
  maxToolPlanPreviewKeys,
  ToolPlanPreviewError,
  ToolPlanReviewParams,
  ToolPlanReviewResponse,
  toolPlanReviewActionId,
  type ToolPlan,
  type ToolPlanBeforeCall,
  type ToolPlanFailurePolicy,
  type ToolPlanPreview,
  type ToolPlanPreviewPage
} from './plan.ts'
import {
  toolJsonSchemaFromSchema,
  type InteractionActionResult,
  type ResolvedToolSet,
  type ToolAccess,
  type ToolRegistration
} from './registry.ts'

export { toolPlanReviewActionId } from './plan.ts'

/** Default name of the plan review tool. */
export const toolPlanReviewToolName = 'review_plan'

/** Default `InteractionDescriptor.kind` (host renderer key) of the plan review tool. */
export const toolPlanReviewRenderer = 'tool_plan_review'

export type MakePlanReviewToolOptions<Context> = {
  /** Default `review_plan`. */
  readonly name?: string
  readonly description?: string
  /** Host renderer key (`InteractionDescriptor.kind`). Default `tool_plan_review`. */
  readonly renderer?: string
  readonly title?: string
  readonly interactionDescription?: string
  /** Label of the apply action. Default `Apply selected`. */
  readonly actionLabel?: string
  /** Default `write`. */
  readonly access?: ToolAccess
  /** Admits or rejects each selected call right before it runs; a failure records the call
   * `failed` without running it. The only per-call host authority hook for applied calls: they
   * bypass code mode's `beforeNestedCall` and `ToolExecutor` decorators, so wire your
   * run-authority (nested-write) authorizer here. See `ToolPlanBeforeCall`.
   */
  readonly beforeCall?: ToolPlanBeforeCall<Context>
  /** After a failed call: `stop` (default; later selected calls are `not_run`) or `continue`. */
  readonly onFailure?: ToolPlanFailurePolicy
}

const defaultDescription =
  'Ask a person to review a staged tool plan (calls a code mode script recorded with `stage()`) and apply the calls they select. Pass the `planId` and `planDigest` the script reported, exactly. Nothing is applied until the person approves; they may untick calls but never change arguments. The result lists each call as applied, failed, skipped, or not run.'

const decodeParams = decodeToolArguments(ToolPlanReviewParams)

const decodeResponse = Schema.decodeUnknownEffect(ToolPlanReviewResponse, {
  onExcessProperty: 'error'
})

const decodedResponse = (data: unknown) =>
  decodeResponse(data).pipe(
    Effect.flatMap(response =>
      new Set(response.selectedKeys).size === response.selectedKeys.length
        ? Effect.succeed(response)
        : Effect.fail(new InteractionValidationError({ message: 'The selection repeats a call.' }))
    )
  )

/**
 * The plan review tool (ADR 0005): an action-backed interaction (default name `review_plan`, params
 * `{ planId, planDigest }`, response `{ selectedKeys }`) through which a person reviews a staged
 * tool plan once and selects the calls to apply. Resolve it with `resolveTools(..., { plans,
 * interactionHost })`; without both it is unavailable (no staging, no dispatch).
 *
 * - Call validation loads the plan: present, in the store's scope, digests matching, unclaimed.
 * - Admission (`validateAction`, with the resolution's fresh context) checks the selection: a
 *   non-empty subset of the plan's keys without duplicates, tools still stageable, and each tool's
 *   `staging.precheck`.
 * - The apply action claims the plan once (`ToolPlanStore.claim`), then runs the selected calls in
 *   staged order through the registry's execute path (decoding, wrappers, the tool ledger under
 *   `<reviewCallId>/<n>` with the review call as parent), calling `beforeCall` first. Unselected
 *   calls are `skipped`; under `onFailure: 'stop'` calls after a failure are `not_run`. A partial
 *   apply is a `completed` outcome listing every call. Another execution of a started review
 *   never runs it again: with a tool ledger it waits behind the apply fence and returns the real
 *   outcome, otherwise (or past the wait) it lists each call, `not_run` only when provable (ADR
 *   0005, "Apply fence"). Cancelling the interaction applies nothing.
 */
export const makePlanReviewTool = <Context>(
  options: MakePlanReviewToolOptions<Context> = {}
): ToolRegistration<Context> => {
  const name = options.name ?? toolPlanReviewToolName
  const onFailure = options.onFailure ?? 'stop'
  const label = options.actionLabel ?? 'Apply selected'

  type DescriptorFields = {
    kind: string
    title?: string
    description?: string
    schema: ReturnType<typeof toolJsonSchemaFromSchema>
    actions: readonly [InteractionActionDescriptor]
  }

  const descriptor: DescriptorFields = {
    kind: options.renderer ?? toolPlanReviewRenderer,
    schema: toolJsonSchemaFromSchema(ToolPlanReviewResponse),
    actions: [InteractionActionDescriptor.make({ id: toolPlanReviewActionId, label })]
  }

  if (options.title !== undefined) descriptor.title = options.title

  if (options.interactionDescription !== undefined)
    descriptor.description = options.interactionDescription

  const def = ToolDef.make({
    name,
    description: options.description ?? defaultDescription,
    parameters: toolJsonSchemaFromSchema(ToolPlanReviewParams),
    interaction: InteractionDescriptor.make(descriptor)
  })

  return {
    def,
    access: options.access ?? 'write',
    validate: call =>
      decodeParams(call.params).pipe(
        Effect.asVoid,
        Effect.mapError(
          error =>
            new ToolError({
              tool: name,
              cause: 'validation',
              message: `Invalid ${name} arguments: ${error.message}`
            })
        )
      ),
    execute: ({ call }) =>
      Effect.fail(
        new ToolError({
          tool: name,
          cause: 'unavailable',
          message: `Plan review "${name}" for call ${call.id} requires an accepted interaction and cannot execute directly.`
        })
      ),
    planReview: runtime => ({
      validateCall: params =>
        decodeParams(params).pipe(Effect.flatMap(runtime.load), Effect.asVoid),
      validateResponse: data => decodedResponse(data).pipe(Effect.asVoid),
      actions: {
        [toolPlanReviewActionId]: {
          label,
          validate: ({ data, call }) =>
            Effect.gen(function* () {
              const params = yield* decodeParams(call.params)
              const response = yield* decodedResponse(data)
              const plan = yield* runtime.load(params)

              yield* runtime.validateSelection({ plan, keys: response.selectedKeys })
            }),
          execute: ({ data, submissionId, call }) =>
            Effect.gen(function* () {
              const params = yield* decodeParams(call.params)
              const response = yield* decodedResponse(data)

              return yield* runtime.apply({
                reviewCall: call,
                submissionId,
                planId: params.planId,
                planDigest: params.planDigest,
                keys: response.selectedKeys,
                beforeCall: options.beforeCall,
                onFailure
              })
            }).pipe(
              // Decoding failures happen before anything runs: a known no-effect outcome.
              Effect.catch(error =>
                Effect.succeed<InteractionActionResult>({
                  outcome: 'failed',
                  content: `The plan review could not be applied: ${error.message} Nothing was applied.`
                })
              )
            )
        }
      },
      unknownOutcome: ({ call, submissionId, phase }) =>
        runtime.interrupted({ reviewCall: call, submissionId, phase })
    })
  }
}

/**
 * Per-key previews of a staged plan for host review screens: each staged call's arguments and its
 * tool's optional `staging.preview` (bounded to `maxToolPlanPreviewBytes`; a failing or oversized
 * preview is an error entry). At most `maxToolPlanPreviewKeys` keys per call: page larger plans.
 * Resolve the tool set with a fresh host context; previews use it. Fails `unavailable` when the
 * resolution has no staging, and `invalid_plan` for a plan of another scope or with mismatched
 * digests. `keys` defaults to the first page of the plan.
 */
export const previewToolPlan = (input: {
  readonly toolSet: ResolvedToolSet
  readonly plan: ToolPlan
  readonly keys?: ReadonlyArray<string>
}): Effect.Effect<ReadonlyArray<ToolPlanPreview>, ToolPlanPreviewError> => {
  const plans = input.toolSet.plans

  if (plans === undefined)
    return Effect.fail(
      new ToolPlanPreviewError({
        cause: 'unavailable',
        message:
          'This tool set has no staged tool plans (resolve it with plans and an interaction host).'
      })
    )

  return plans.preview({
    plan: input.plan,
    keys: input.keys ?? input.plan.calls.slice(0, maxToolPlanPreviewKeys).map(call => call.key)
  })
}

type StoredPreviewRequestFields = {
  planId: string
  planDigest: string
  offset?: number
  limit?: number
}

/**
 * One page of previews of a stored plan, for host review screens that only have the review call's
 * `{ planId, planDigest }`: loads the plan from the resolution's plan store (`not_found`,
 * `storage`), refuses another digest, scope, or a plan failing its integrity checks
 * (`invalid_plan`), and reports whether a review already claimed it. Pages hold at most
 * `maxToolPlanPreviewKeys` calls from `offset` (default 0); follow `nextOffset`.
 */
export const previewStoredToolPlan = (input: {
  readonly toolSet: ResolvedToolSet
  readonly planId: string
  readonly planDigest: string
  readonly offset?: number
  readonly limit?: number
}): Effect.Effect<ToolPlanPreviewPage, ToolPlanPreviewError> => {
  const plans = input.toolSet.plans

  if (plans === undefined)
    return Effect.fail(
      new ToolPlanPreviewError({
        cause: 'unavailable',
        message:
          'This tool set has no staged tool plans (resolve it with plans and an interaction host).'
      })
    )

  const page: StoredPreviewRequestFields = {
    planId: input.planId,
    planDigest: input.planDigest
  }

  if (input.offset !== undefined) page.offset = input.offset

  if (input.limit !== undefined) page.limit = input.limit

  return plans.previewStored(page)
}
