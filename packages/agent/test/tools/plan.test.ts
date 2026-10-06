import { Effect, Predicate, Result } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import {
  contentText,
  InteractionRequest,
  InteractionResponse,
  InteractionValidationError,
  ToolApprovalPolicy,
  ToolCall,
  ToolDef,
  ToolResult,
  interactionRequestId,
  isCodeModeCallable,
  isToolStageable,
  type InteractionHost
} from '@yolk-sdk/agent/protocol'
import {
  EmptyToolParams,
  makeInMemoryToolLedgerStore,
  makeInMemoryToolPlanStore,
  makePlanReviewTool,
  makeTool,
  previewToolPlan,
  resolveTools,
  StagedCall,
  stagedCallDigest,
  ToolPlan,
  toolPlanDigest,
  type MakePlanReviewToolOptions,
  type NestedToolExecutor,
  type NestedToolStagingDescription,
  type ResolvedToolSet,
  type ToolModule,
  type ToolPlanBuilder,
  type ToolLedgerOptions,
  type ToolPlanClaimResult,
  type ToolPlanOptions,
  type ToolPlanRuntime,
  type ToolPlanStore,
  type ToolRegistration
} from '../../src/tools/index.ts'
import { makeFakeInteractionHost } from './interaction-host.ts'

type Ctx = { readonly tenant: string }

const context: Ctx = { tenant: 'tenant_1' }

const manual = ToolApprovalPolicy.make({ mode: 'manual' })

const Link = Schema.Struct({ resource: Schema.String, curriculum: Schema.String })

const Query = Schema.Struct({ query: Schema.String })

type Applied = Array<{ readonly resource: string; readonly key: string | undefined }>

const linkTool = (applied: Applied, options: LinkToolOptions = {}) =>
  makeTool<Ctx, typeof Link>({
    name: 'link_curriculum',
    description: 'Link a curriculum to a published resource',
    parameters: Link,
    access: 'write',
    approval: manual,
    staging: {
      preview: ({ params, context }) =>
        Effect.succeed({ summary: `${context.tenant}:${params.resource}->${params.curriculum}` }),
      precheck: ({ params }) =>
        params.resource === 'stale'
          ? Effect.fail(new InteractionValidationError({ message: 'stale resource' }))
          : Effect.void
    },
    execute: ({ call, params, idempotencyKey }) =>
      Effect.suspend(() => {
        if (params.resource === options.dieOn) return Effect.die(new Error('process crashed'))

        applied.push({ resource: params.resource, key: idempotencyKey })

        return Effect.succeed(
          params.resource === options.failOn
            ? ToolResult.make({
                toolCallId: call.id,
                content: `cannot link ${params.resource}`,
                isError: true
              })
            : ToolResult.make({ toolCallId: call.id, content: `linked ${params.resource}` })
        )
      })
  })

const lookupTool = makeTool<Ctx, typeof Query>({
  name: 'lookup',
  description: 'Read resources',
  parameters: Query,
  access: 'read',
  execute: ({ call, params }) =>
    Effect.succeed(ToolResult.make({ toolCallId: call.id, content: `found ${params.query}` }))
})

const noteTool = (notes: Array<string>) =>
  makeTool<Ctx, typeof Query>({
    name: 'note',
    description: 'Write a note',
    parameters: Query,
    access: 'write',
    execute: ({ call, params }) =>
      Effect.sync(() => {
        notes.push(params.query)

        return ToolResult.make({ toolCallId: call.id, content: 'noted' })
      })
  })

type Box = {
  nested?: NestedToolExecutor
  staging?: NestedToolStagingDescription
  described: boolean
}

/** A nested-access registration that only captures its `nested` executor and description input. */
const scriptTool = (box: Box): ToolRegistration<Ctx> =>
  makeTool<Ctx, typeof EmptyToolParams>({
    name: 'script',
    description: 'script',
    parameters: EmptyToolParams,
    access: 'write',
    nestedToolAccess: true,
    describe: ({ staging }) => {
      box.described = true

      if (staging !== undefined) box.staging = staging

      return 'script'
    },
    execute: ({ call, nested }) =>
      Effect.sync(() => {
        if (nested !== undefined) box.nested = nested

        return ToolResult.make({ toolCallId: call.id, content: 'ok' })
      })
  })

type LinkToolOptions = { failOn?: string; dieOn?: string }

type PlanOptionFields = { store: ToolPlanStore; maxCalls?: number; maxArgsBytes?: number }

type ResolveOptionFields = {
  interactionHost?: InteractionHost
  plans?: ToolPlanOptions
  ledger?: ToolLedgerOptions
}

type SetupOptions = {
  readonly host?: boolean
  readonly plans?: boolean
  readonly review?: MakePlanReviewToolOptions<Ctx> | false
  readonly reviewRegistration?: ToolRegistration<Ctx>
  readonly ledger?: boolean
  readonly maxCalls?: number
  readonly maxArgsBytes?: number
  readonly failOn?: string
  readonly dieOn?: string
  readonly settlement?: 'fail'
}

const setup = (options: SetupOptions = {}) =>
  Effect.gen(function* () {
    const fake = makeFakeInteractionHost(
      options.settlement === undefined ? {} : { settlement: options.settlement }
    )

    const store = makeInMemoryToolPlanStore({ scope: 'conversation_1' })
    const ledgerStore = makeInMemoryToolLedgerStore({ scope: 'conversation_1' })
    const applied: Applied = []
    const notes: Array<string> = []
    const box: Box = { described: false }

    const review =
      options.reviewRegistration ??
      (options.review === false ? undefined : makePlanReviewTool<Ctx>(options.review ?? {}))

    const linkOptions: LinkToolOptions = {}

    if (options.failOn !== undefined) linkOptions.failOn = options.failOn

    if (options.dieOn !== undefined) linkOptions.dieOn = options.dieOn

    const modules: ReadonlyArray<ToolModule<Ctx>> = [
      { id: 'host', tools: review === undefined ? [scriptTool(box)] : [scriptTool(box), review] },
      { id: 'cms', tools: [linkTool(applied, linkOptions), lookupTool, noteTool(notes)] }
    ]

    const plans: PlanOptionFields = { store }

    if (options.maxCalls !== undefined) plans.maxCalls = options.maxCalls

    if (options.maxArgsBytes !== undefined) plans.maxArgsBytes = options.maxArgsBytes

    const resolveOptions: ResolveOptionFields = {}

    if (options.host !== false) resolveOptions.interactionHost = fake.host

    if (options.plans !== false) resolveOptions.plans = plans

    if (options.ledger === true) resolveOptions.ledger = { store: ledgerStore }

    const toolSet = yield* resolveTools(modules, context, resolveOptions)

    yield* toolSet.execute(ToolCall.make({ id: 'script_1', name: 'script', params: {} }))

    return { fake, store, ledgerStore, applied, notes, box, toolSet }
  })

type Env = Effect.Success<ReturnType<typeof setup>>

const builderOf = (env: Env, options?: { readonly maxCalls?: number }): ToolPlanBuilder => {
  const staging = env.box.nested?.staging

  if (staging === undefined) throw new Error('Staging is unavailable')

  return staging.begin(options)
}

const stageLinks = (builder: ToolPlanBuilder, resources: ReadonlyArray<string>) =>
  Effect.forEach(resources, resource =>
    builder.stage({ name: 'link_curriculum', params: { resource, curriculum: 'LGR22' } })
  )

const savedPlan = (builder: ToolPlanBuilder) =>
  Effect.gen(function* () {
    const plan = yield* builder.finish

    if (plan === undefined) throw new Error('Nothing staged')

    return plan
  })

const stagedPlan = (env: Env, resources: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const builder = builderOf(env)

    yield* stageLinks(builder, resources)

    return yield* savedPlan(builder)
  })

const reviewInteraction = (toolSet: ResolvedToolSet) => {
  const interaction = toolSet.interactions.review_plan

  if (interaction === undefined || interaction.def.interaction === undefined)
    throw new Error('Missing plan review interaction')

  return { interaction, descriptor: interaction.def.interaction }
}

const reviewCall = (plan: ToolPlan, id = 'review_1', digest = plan.digest) =>
  ToolCall.make({ id, name: 'review_plan', params: { planId: plan.id, planDigest: digest } })

const submission = (call: ToolCall, keys: ReadonlyArray<string>) =>
  InteractionResponse.make({
    requestId: interactionRequestId(call),
    toolCallId: call.id,
    outcome: 'submitted',
    source: 'user',
    actionId: 'apply',
    data: { selectedKeys: [...keys] }
  })

/** Opens the review request, accepts a person's selection, and returns the receipt reference. */
const accept = (env: Env, call: ToolCall, keys: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const { interaction, descriptor } = reviewInteraction(env.toolSet)

    env.fake.addPending(
      InteractionRequest.make({
        requestId: interactionRequestId(call),
        toolCallId: call.id,
        call,
        interaction: descriptor
      })
    )

    return yield* env.fake.accept(submission(call, keys), interaction)
  })

const reviewAndApply = (env: Env, plan: ToolPlan, keys: ReadonlyArray<string>, id?: string) =>
  Effect.gen(function* () {
    const call = reviewCall(plan, id)
    const ref = yield* accept(env, call, keys)
    const result = yield* env.toolSet.execute(call, { interaction: ref })

    return { call, ref, result }
  })

const PlanReviewOutcome = Schema.Struct({
  outcome: Schema.String,
  result: Schema.optional(
    Schema.Struct({
      state: Schema.String,
      calls: Schema.Array(
        Schema.Struct({
          key: Schema.String,
          status: Schema.String,
          callId: Schema.optional(Schema.String),
          error: Schema.optional(Schema.String)
        })
      ),
      counts: Schema.Record(Schema.String, Schema.Number),
      ledgerUnavailable: Schema.optional(Schema.Boolean)
    })
  )
})

const outcomeOf = (result: ToolResult) =>
  Schema.decodeUnknownEffect(PlanReviewOutcome)(result.structuredContent).pipe(Effect.orDie)

const textOf = (result: ToolResult) =>
  Predicate.isString(result.content) ? result.content : contentText(result.content)

describe('stageable tool definitions', () => {
  it.effect('keeps stageable approval tools fail-closed for direct script calls', () =>
    Effect.gen(function* () {
      const env = yield* setup()
      const nested = env.box.nested
      const link = env.toolSet.tools.find(tool => tool.name === 'link_curriculum')

      expect(link?.staging).toBe(true)
      expect(link !== undefined && isToolStageable(link)).toBe(true)
      expect(link !== undefined && isCodeModeCallable(link)).toBe(false)
      expect(nested?.tools.map(tool => tool.def.name)).toEqual(['lookup', 'note'])
      expect(nested?.staging?.tools.map(tool => tool.def.name)).toEqual(['link_curriculum'])

      if (nested === undefined) throw new Error('Missing nested executor')

      const direct = yield* nested.execute(
        ToolCall.make({
          id: 'script_1/1',
          name: 'link_curriculum',
          params: { resource: 'r1', curriculum: 'LGR22' }
        })
      )

      expect(direct.isError).toBe(true)
      expect(textOf(direct)).toContain('not callable from code mode')
      expect(env.applied).toEqual([])
    })
  )

  it.effect('rejects staging on tools that are not plain approval-gated tools', () =>
    Effect.gen(function* () {
      const resolve = (tool: ToolRegistration<Ctx>) =>
        resolveTools([{ id: 'm', tools: [tool] }], context).pipe(Effect.flip)

      const withoutApproval = yield* resolve(
        makeTool<Ctx, typeof Link>({
          name: 'unsafe',
          description: 'x',
          parameters: Link,
          access: 'write',
          staging: true,
          execute: ({ call }) =>
            Effect.succeed(ToolResult.make({ toolCallId: call.id, content: '' }))
        })
      )

      const modelOnly = yield* resolve(
        makeTool<Ctx, typeof Link>({
          name: 'model_only',
          description: 'x',
          parameters: Link,
          access: 'write',
          approval: manual,
          callableBy: 'model',
          staging: true,
          execute: ({ call }) =>
            Effect.succeed(ToolResult.make({ toolCallId: call.id, content: '' }))
        })
      )

      const rawWithoutValidator = yield* resolve({
        def: ToolDef.make({
          name: 'raw',
          description: 'x',
          parameters: { type: 'object' },
          approval: manual,
          staging: true
        }),
        access: 'write',
        execute: ({ call }) => Effect.succeed(ToolResult.make({ toolCallId: call.id, content: '' }))
      })

      const twoReviews = yield* resolveTools(
        [
          {
            id: 'm',
            tools: [makePlanReviewTool<Ctx>(), makePlanReviewTool<Ctx>({ name: 'review_other' })]
          }
        ],
        context
      ).pipe(Effect.flip)

      expect(withoutApproval.cause).toBe('staging_unsupported_policy')
      expect(modelOnly.cause).toBe('staging_unsupported_policy')
      expect(rawWithoutValidator.cause).toBe('staging_validation_required')
      expect(twoReviews.cause).toBe('plan_review_duplicate')
    })
  )

  it.effect('offers staging only with plans, an interaction host, and a review tool', () =>
    Effect.gen(function* () {
      const full = yield* setup()
      const noPlans = yield* setup({ plans: false })
      const noHost = yield* setup({ host: false })
      const noReview = yield* setup({ review: false })

      expect(full.box.nested?.staging?.reviewToolName).toBe('review_plan')
      expect(full.box.staging?.tools.map(tool => tool.def.name)).toEqual(['link_curriculum'])
      expect(full.toolSet.plans?.reviewToolName).toBe('review_plan')
      expect(full.toolSet.interactions.review_plan).toBeDefined()

      // Voice and subagent resolutions without an interaction host (or plans) get no `stage`, and
      // the review tool stays unavailable.
      for (const env of [noPlans, noHost, noReview]) {
        expect(env.box.nested?.staging).toBeUndefined()
        expect(env.box.staging).toBeUndefined()
        expect(env.box.described).toBe(true)
        expect(env.toolSet.plans).toBeUndefined()
        expect(env.toolSet.interactions.review_plan).toBeUndefined()
      }
    })
  )
})

describe('staging guardrails', () => {
  it.effect('validates staged arguments without executing or ledgering anything', () =>
    Effect.gen(function* () {
      const env = yield* setup({ ledger: true })
      const builder = builderOf(env)

      const receipt = yield* builder.stage({
        name: 'link_curriculum',
        params: { resource: 'r1', curriculum: 'LGR22' }
      })

      const invalid = yield* builder
        .stage({ name: 'link_curriculum', params: { resource: 1 } })
        .pipe(Effect.flip)

      const unknown = yield* builder
        .stage({ name: 'note', params: { query: 'x' } })
        .pipe(Effect.flip)

      const notJson = yield* builder
        .stage({ name: 'link_curriculum', params: { resource: 'r', curriculum: Number.NaN } })
        .pipe(Effect.flip)

      expect(receipt).toEqual({ staged: true, key: 'script_1/s1', index: 1 })
      expect(invalid.reason).toBe('invalid_arguments')
      expect(invalid.message).toContain('link_curriculum')
      expect(unknown.reason).toBe('not_stageable')
      expect(unknown.message).toContain('link_curriculum')
      expect(notJson.reason).toBe('invalid_arguments')
      expect(env.applied).toEqual([])
      // Only the script call itself is ledgered; staging records nothing.
      expect((yield* env.ledgerStore.entries).map(entry => entry.key)).toEqual(['script_1'])
      expect(yield* builder.staged).toEqual([
        StagedCall.make({
          key: 'script_1/s1',
          toolName: 'link_curriculum',
          params: { resource: 'r1', curriculum: 'LGR22' },
          argsDigest: stagedCallDigest({ curriculum: 'LGR22', resource: 'r1' })
        })
      ])
    })
  )

  it.effect('rejects staging after a write ran, and writes after staging; reads run anywhere', () =>
    Effect.gen(function* () {
      const env = yield* setup()
      const writeFirst = builderOf(env)
      const read = ToolCall.make({ id: 'script_1/1', name: 'lookup', params: { query: 'q' } })
      const write = ToolCall.make({ id: 'script_1/2', name: 'note', params: { query: 'n' } })

      yield* writeFirst.admit(read)
      yield* writeFirst.admit(write)

      const stageAfterWrite = yield* stageLinks(writeFirst, ['r1']).pipe(Effect.flip)

      const stageFirst = builderOf(env)

      yield* stageLinks(stageFirst, ['r1'])
      yield* stageFirst.admit(read)

      const writeAfterStage = yield* stageFirst.admit(write).pipe(Effect.flip)

      expect(stageAfterWrite.reason).toBe('order')
      expect(stageAfterWrite.message).toContain('note')
      expect(writeAfterStage.reason).toBe('order')
      expect(yield* stageFirst.staged).toHaveLength(1)
    })
  )

  it.effect('rejects duplicates and calls past the caps, never truncating', () =>
    Effect.gen(function* () {
      const env = yield* setup({ maxCalls: 2, maxArgsBytes: 120 })
      const builder = builderOf(env)

      yield* stageLinks(builder, ['r1'])

      const duplicate = yield* builder
        .stage({ name: 'link_curriculum', params: { curriculum: 'LGR22', resource: 'r1' } })
        .pipe(Effect.flip)

      const tooLarge = yield* builder
        .stage({
          name: 'link_curriculum',
          params: { resource: 'x'.repeat(200), curriculum: 'LGR22' }
        })
        .pipe(Effect.flip)

      yield* stageLinks(builder, ['r2'])

      const pastMax = yield* stageLinks(builder, ['r3']).pipe(Effect.flip)

      const lowered = builderOf(env, { maxCalls: 1 })

      yield* stageLinks(lowered, ['r1'])

      const pastLowered = yield* stageLinks(lowered, ['r2']).pipe(Effect.flip)

      expect(duplicate.reason).toBe('duplicate')
      expect(duplicate.message).toContain('script_1/s1')
      expect(tooLarge.reason).toBe('limit')
      expect(pastMax.reason).toBe('limit')
      expect(pastLowered.reason).toBe('limit')
      expect((yield* builder.staged).map(call => call.key)).toEqual(['script_1/s1', 'script_1/s2'])
    })
  )
})

describe('plan persistence', () => {
  it.effect('saves the plan once, idempotently by id; a different digest conflicts', () =>
    Effect.gen(function* () {
      const env = yield* setup()
      const plan = yield* stagedPlan(env, ['r1', 'r2'])

      expect(plan.id).toBe('script_1')
      expect(plan.scope).toBe('conversation_1')
      expect(plan.digest).toBe(toolPlanDigest(plan.calls))

      // A re-executed script stages the same plan again: a no-op.
      const again = yield* stagedPlan(env, ['r1', 'r2'])

      expect(again.digest).toBe(plan.digest)

      const changed = yield* stagedPlan(env, ['r1', 'r3']).pipe(Effect.flip)

      expect(changed.cause).toBe('conflict')
      expect((yield* env.store.plans).map(stored => stored.plan.digest)).toEqual([plan.digest])
      expect(yield* builderOf(env).finish).toBeUndefined()

      const conflicting = ToolPlan.make({
        id: 'script_2',
        scope: 'conversation_1',
        digest: 'a',
        calls: [plan.calls[0]]
      })

      yield* env.store.put(conflicting)

      const put = yield* Effect.result(
        env.store.put(ToolPlan.make({ ...conflicting, digest: 'b' }))
      )

      expect(Result.isFailure(put)).toBe(true)
    })
  )
})

describe('plan review', () => {
  it.effect('applies exactly the selected calls in staged order, nested in the ledger', () =>
    Effect.gen(function* () {
      const env = yield* setup({ ledger: true })
      const plan = yield* stagedPlan(env, ['r1', 'r2', 'r3'])
      const { result } = yield* reviewAndApply(env, plan, ['script_1/s3', 'script_1/s1'])
      const outcome = yield* outcomeOf(result)

      expect(result.isError).toBeUndefined()
      expect(outcome.outcome).toBe('completed')
      expect(outcome.result?.state).toBe('applied')
      expect(outcome.result?.calls.map(call => [call.key, call.status, call.callId])).toEqual([
        ['script_1/s1', 'applied', 'review_1/1'],
        ['script_1/s2', 'skipped', undefined],
        ['script_1/s3', 'applied', 'review_1/3']
      ])
      expect(env.applied).toEqual([
        { resource: 'r1', key: 'conversation_1:review_1/1' },
        { resource: 'r3', key: 'conversation_1:review_1/3' }
      ])

      const entries = yield* env.ledgerStore.list('review_1')

      expect(entries.map(entry => [entry.key, entry.argsDigest])).toEqual([
        ['review_1/1', plan.calls[0].argsDigest],
        ['review_1/3', plan.calls[2]?.argsDigest]
      ])
      expect(textOf(result)).toContain('2 applied, 0 failed, 1 skipped, 0 not run')
    })
  )

  it.effect('validates the plan id, digest, and claim at call validation', () =>
    Effect.gen(function* () {
      const env = yield* setup()
      const plan = yield* stagedPlan(env, ['r1'])
      const { interaction } = reviewInteraction(env.toolSet)

      yield* interaction.validateCall(reviewCall(plan).params)

      const wrongDigest = yield* interaction
        .validateCall(reviewCall(plan, 'review_1', 'f'.repeat(64)).params)
        .pipe(Effect.flip)

      const missing = yield* interaction
        .validateCall({ planId: 'nope', planDigest: plan.digest })
        .pipe(Effect.flip)

      const malformed = yield* interaction.validateCall({ planId: plan.id }).pipe(Effect.flip)

      yield* reviewAndApply(env, plan, ['script_1/s1'])

      const claimed = yield* interaction.validateCall(reviewCall(plan).params).pipe(Effect.flip)

      expect(wrongDigest.message).toContain('planDigest does not match')
      expect(missing.message).toContain('was not found')
      expect(malformed.message).toContain('planDigest')
      expect(claimed.message).toContain('already reviewed and applied')
    })
  )

  it.effect('admits only non-empty, duplicate-free subsets that pass every precheck', () =>
    Effect.gen(function* () {
      const env = yield* setup()
      const plan = yield* stagedPlan(env, ['r1', 'stale'])

      const admission = (keys: ReadonlyArray<string>, id: string) =>
        accept(env, reviewCall(plan, id), keys).pipe(Effect.flip)

      const foreign = yield* admission(['script_1/s9'], 'review_a')
      const duplicate = yield* admission(['script_1/s1', 'script_1/s1'], 'review_b')
      const empty = yield* admission([], 'review_c')
      const stale = yield* admission(['script_1/s2'], 'review_d')

      yield* accept(env, reviewCall(plan, 'review_e'), ['script_1/s1'])

      expect(foreign.message).toContain('is not a staged call')
      expect(duplicate.message).toContain('repeats')
      expect(empty._tag).toBe('InteractionAdmissionError')
      expect(stale.message).toContain('stale resource')
      expect(env.applied).toEqual([])
    })
  )

  it.effect('applies a plan once: a second review is refused and runs nothing', () =>
    Effect.gen(function* () {
      const env = yield* setup()
      const plan = yield* stagedPlan(env, ['r1'])
      const call = reviewCall(plan, 'review_2')
      const ref = yield* accept(env, call, ['script_1/s1'])

      yield* reviewAndApply(env, plan, ['script_1/s1'])

      // The second review was accepted before the first applied; its call validation now fails.
      const second = yield* env.toolSet.execute(call, { interaction: ref }).pipe(Effect.flip)

      expect(second.cause).toBe('validation')
      expect(second.message).toContain('already reviewed and applied')
      expect(env.applied).toHaveLength(1)
    })
  )

  it.effect('refuses a plan another submission claimed in a race; never re-runs its own', () =>
    Effect.gen(function* () {
      const races: ReadonlyArray<ToolPlanClaimResult> = ['taken', 'same']

      for (const race of races) {
        const env = yield* setup()
        const plan = yield* stagedPlan(env, ['r1'])
        const call = reviewCall(plan)
        const ref = yield* accept(env, call, ['script_1/s1'])
        const claim = env.store.claim

        // Both executions passed call validation; the store decides at claim time.
        const racing = yield* resolveTools(
          [
            { id: 'host', tools: [makePlanReviewTool<Ctx>()] },
            { id: 'cms', tools: [linkTool(env.applied)] }
          ],
          context,
          {
            interactionHost: env.fake.host,
            plans: {
              store: {
                ...env.store,
                claim: input => claim(input).pipe(Effect.as(race))
              }
            }
          }
        )

        const outcome = yield* outcomeOf(yield* racing.execute(call, { interaction: ref }))

        expect(outcome.outcome).toBe(race === 'taken' ? 'failed' : 'unknown')
        expect(outcome.result?.state).toBe(race === 'taken' ? 'refused' : 'interrupted')
        expect(env.applied).toEqual([])
      }
    })
  )

  it.effect('cancelling the review applies nothing', () =>
    Effect.gen(function* () {
      const env = yield* setup()
      const plan = yield* stagedPlan(env, ['r1'])
      const call = reviewCall(plan)
      const { interaction, descriptor } = reviewInteraction(env.toolSet)

      env.fake.addPending(
        InteractionRequest.make({
          requestId: interactionRequestId(call),
          toolCallId: call.id,
          call,
          interaction: descriptor
        })
      )

      const ref = yield* env.fake.accept(
        InteractionResponse.make({
          requestId: interactionRequestId(call),
          toolCallId: call.id,
          outcome: 'cancelled',
          source: 'user'
        }),
        interaction
      )

      const result = yield* env.toolSet.execute(call, { interaction: ref })

      expect(result.isError).toBe(true)
      expect(textOf(result)).toContain('cancelled')
      expect(env.applied).toEqual([])
      expect((yield* env.store.get(plan.id))?.claimedBy).toBeUndefined()
    })
  )

  it.effect('stops after a failure by default and continues when configured', () =>
    Effect.gen(function* () {
      const stop = yield* setup({ failOn: 'r2' })
      const stopPlan = yield* stagedPlan(stop, ['r1', 'r2', 'r3'])
      const keys = stopPlan.calls.map(call => call.key)
      const stopped = yield* outcomeOf((yield* reviewAndApply(stop, stopPlan, keys)).result)

      const go = yield* setup({ failOn: 'r2', review: { onFailure: 'continue' } })
      const goPlan = yield* stagedPlan(go, ['r1', 'r2', 'r3'])
      const continued = yield* outcomeOf((yield* reviewAndApply(go, goPlan, keys)).result)

      expect(stopped.outcome).toBe('completed')
      expect(stopped.result?.calls.map(call => call.status)).toEqual([
        'applied',
        'failed',
        'not_run'
      ])
      expect(stopped.result?.calls[1]?.error).toBe('cannot link r2')
      expect(stop.applied.map(item => item.resource)).toEqual(['r1', 'r2'])
      expect(continued.result?.calls.map(call => call.status)).toEqual([
        'applied',
        'failed',
        'applied'
      ])
      expect(go.applied.map(item => item.resource)).toEqual(['r1', 'r2', 'r3'])
    })
  )

  it.effect('runs beforeCall first; a rejection fails the call without running it', () =>
    Effect.gen(function* () {
      const seen: Array<string> = []

      const env = yield* setup({
        review: {
          onFailure: 'continue',
          beforeCall: ({ call, staged, context }) =>
            Effect.suspend(() => {
              seen.push(`${call.id}:${staged.key}:${context.tenant}`)

              return staged.key === 'script_1/s1' ? Effect.fail('not allowed now') : Effect.void
            })
        }
      })

      const plan = yield* stagedPlan(env, ['r1', 'r2'])

      const outcome = yield* outcomeOf(
        (yield* reviewAndApply(env, plan, ['script_1/s1', 'script_1/s2'])).result
      )

      expect(seen).toEqual(['review_1/1:script_1/s1:tenant_1', 'review_1/2:script_1/s2:tenant_1'])
      expect(outcome.result?.calls.map(call => [call.status, call.error])).toEqual([
        ['failed', 'not allowed now'],
        ['applied', undefined]
      ])
      expect(env.applied.map(item => item.resource)).toEqual(['r2'])
    })
  )

  it.effect('lists per-key ledger states, as unknown, after a crash mid-apply; never re-runs', () =>
    Effect.gen(function* () {
      const env = yield* setup({ ledger: true, dieOn: 'r2', settlement: 'fail' })
      const plan = yield* stagedPlan(env, ['r1', 'r2', 'r3'])
      const call = reviewCall(plan)

      const ref = yield* accept(
        env,
        call,
        plan.calls.map(staged => staged.key)
      )

      // The process "crashes" on r2: the defect escapes and settlement cannot be recorded.
      const crashed = yield* env.toolSet.execute(call, { interaction: ref }).pipe(Effect.exit)

      expect(crashed._tag).toBe('Failure')
      expect(env.fake.receiptFor(interactionRequestId(call))?.status).toBe('started')

      const replayed = yield* env.toolSet.execute(call, { interaction: ref })
      const outcome = yield* outcomeOf(replayed)

      expect(replayed.isError).toBe(true)
      expect(outcome.outcome).toBe('unknown')
      expect(outcome.result?.state).toBe('interrupted')
      expect(outcome.result?.calls.map(item => [item.key, item.callId, item.status])).toEqual([
        ['script_1/s1', 'review_1/1', 'applied'],
        ['script_1/s2', 'review_1/2', 'unknown']
      ])
      expect(textOf(replayed)).toContain('It was not run again')
      expect(env.applied.map(item => item.resource)).toEqual(['r1'])
    })
  )

  it.effect('settles an apply that fails unexpectedly as unknown with the ledger listing', () =>
    Effect.gen(function* () {
      const env = yield* setup({ ledger: true, dieOn: 'r2' })
      const plan = yield* stagedPlan(env, ['r1', 'r2', 'r3'])
      const call = reviewCall(plan)

      const ref = yield* accept(
        env,
        call,
        plan.calls.map(staged => staged.key)
      )

      const failed = yield* env.toolSet.execute(call, { interaction: ref }).pipe(Effect.exit)
      const receipt = env.fake.receiptFor(interactionRequestId(call))
      const replayed = yield* env.toolSet.execute(call, { interaction: ref })
      const outcome = yield* outcomeOf(replayed)

      expect(failed._tag).toBe('Failure')
      expect(receipt?.status).toBe('settled')
      expect(outcome.outcome).toBe('unknown')
      expect(outcome.result?.calls.map(item => [item.key, item.status])).toEqual([
        ['script_1/s1', 'applied'],
        ['script_1/s2', 'unknown']
      ])
      expect(env.applied.map(item => item.resource)).toEqual(['r1'])
    })
  )

  it.effect('reports the listing as unavailable without a ledger', () =>
    Effect.gen(function* () {
      const env = yield* setup({ dieOn: 'r1', settlement: 'fail' })
      const plan = yield* stagedPlan(env, ['r1'])
      const call = reviewCall(plan)
      const ref = yield* accept(env, call, ['script_1/s1'])

      yield* env.toolSet.execute(call, { interaction: ref }).pipe(Effect.exit)

      const outcome = yield* outcomeOf(yield* env.toolSet.execute(call, { interaction: ref }))

      expect(outcome.outcome).toBe('unknown')
      expect(outcome.result?.ledgerUnavailable).toBe(true)
      expect(outcome.result?.calls).toEqual([])
    })
  )
})

describe('privileged plan executor', () => {
  type RuntimeBox = { runtime?: ToolPlanRuntime<Ctx> }

  const capturingReview = (box: RuntimeBox): ToolRegistration<Ctx> => {
    const review = makePlanReviewTool<Ctx>()
    const bind = review.planReview

    if (bind === undefined) throw new Error('Missing plan review binding')

    return {
      ...review,
      planReview: runtime => {
        box.runtime = runtime

        return bind(runtime)
      }
    }
  }

  const runtimeOf = (box: RuntimeBox) => {
    if (box.runtime === undefined) throw new Error('Missing runtime')

    return box.runtime
  }

  it.effect('refuses without an accepted, started receipt for this exact selection', () =>
    Effect.gen(function* () {
      const box: RuntimeBox = {}
      const env = yield* setup({ reviewRegistration: capturingReview(box) })
      const plan = yield* stagedPlan(env, ['r1', 'r2'])
      const runtime = runtimeOf(box)
      const call = reviewCall(plan)

      const applyWith = (submissionId: string, keys: ReadonlyArray<string>) =>
        runtime.apply({
          reviewCall: call,
          submissionId,
          planId: plan.id,
          planDigest: plan.digest,
          keys,
          onFailure: 'stop'
        })

      const noReceipt = yield* applyWith('forged', ['script_1/s1'])

      // Accepted but never claimed (so not started).
      const ref = yield* accept(env, call, ['script_1/s1'])
      const notStarted = yield* applyWith(ref.submissionId, ['script_1/s1'])

      expect(noReceipt.outcome).toBe('failed')
      expect(noReceipt.structuredContent.state).toBe('refused')
      expect(notStarted.structuredContent.state).toBe('refused')
      expect(env.applied).toEqual([])
      expect((yield* env.store.get(plan.id))?.claimedBy).toBeUndefined()
    })
  )

  it.effect('refuses a plan whose stored calls no longer match their digests', () =>
    Effect.gen(function* () {
      const box: RuntimeBox = {}
      const env = yield* setup({ reviewRegistration: capturingReview(box) })
      const runtime = runtimeOf(box)

      const first = StagedCall.make({
        key: 'script_9/s1',
        toolName: 'link_curriculum',
        params: { resource: 'tampered', curriculum: 'LGR22' },
        argsDigest: stagedCallDigest({ resource: 'original', curriculum: 'LGR22' })
      })

      const tampered = ToolPlan.make({
        id: 'script_9',
        scope: 'conversation_1',
        digest: toolPlanDigest([first]),
        calls: [first]
      })

      yield* env.store.put(tampered)

      const loaded = yield* runtime
        .load({ planId: tampered.id, planDigest: tampered.digest })
        .pipe(Effect.flip)

      const preview = yield* previewToolPlan({ toolSet: env.toolSet, plan: tampered }).pipe(
        Effect.flip
      )

      expect(loaded.message).toContain('does not match its digest')
      expect(preview.cause).toBe('invalid_plan')
      expect(env.applied).toEqual([])
    })
  )

  it.effect('refuses a plan whose keys were moved to other calls', () =>
    Effect.gen(function* () {
      const box: RuntimeBox = {}
      const env = yield* setup({ reviewRegistration: capturingReview(box) })
      const runtime = runtimeOf(box)

      const call = (key: string, resource: string) =>
        StagedCall.make({
          key,
          toolName: 'link_curriculum',
          params: { resource, curriculum: 'LGR22' },
          argsDigest: stagedCallDigest({ resource, curriculum: 'LGR22' })
        })

      // Every digest matches, but s1 now names the second call.
      const first = call('script_8/s2', 'keep')
      const second = call('script_8/s1', 'drop')

      const swapped = ToolPlan.make({
        id: 'script_8',
        scope: 'conversation_1',
        digest: toolPlanDigest([first, second]),
        calls: [first, second]
      })

      yield* env.store.put(swapped)

      const loaded = yield* runtime
        .load({ planId: swapped.id, planDigest: swapped.digest })
        .pipe(Effect.flip)

      expect(loaded.message).toContain('out of place')
    })
  )

  it.effect('rejects stages once the plan is saved', () =>
    Effect.gen(function* () {
      const env = yield* setup()
      const builder = builderOf(env)

      yield* stageLinks(builder, ['r1'])
      yield* builder.finish

      const late = yield* stageLinks(builder, ['r2']).pipe(Effect.flip)

      expect(late.reason).toBe('order')
    })
  )
})

describe('previewToolPlan', () => {
  it.effect('renders bounded per-key previews with the resolution context, paged', () =>
    Effect.gen(function* () {
      const env = yield* setup()
      const plan = yield* stagedPlan(env, ['r1', 'r2'])

      const previews = yield* previewToolPlan({
        toolSet: env.toolSet,
        plan,
        keys: ['script_1/s2', 'script_1/s7']
      })

      const tooMany = yield* previewToolPlan({
        toolSet: env.toolSet,
        plan,
        keys: Array.from({ length: 51 }, (_, index) => `k${index}`)
      }).pipe(Effect.flip)

      const other = yield* setup({ plans: false })

      const unavailable = yield* previewToolPlan({ toolSet: other.toolSet, plan }).pipe(Effect.flip)

      expect(previews).toEqual([
        {
          key: 'script_1/s2',
          status: 'ok',
          toolName: 'link_curriculum',
          params: { resource: 'r2', curriculum: 'LGR22' },
          preview: { summary: 'tenant_1:r2->LGR22' }
        },
        { key: 'script_1/s7', status: 'error', message: 'Not a staged call of the plan.' }
      ])
      expect(tooMany.cause).toBe('page_too_large')
      expect(unavailable.cause).toBe('unavailable')
    })
  )
})
