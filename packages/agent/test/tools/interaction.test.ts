import { Cause, Deferred, Effect, Exit, Fiber, Match, Predicate } from 'effect'
import { TestClock } from 'effect/testing'
import * as Schema from 'effect/Schema'
import { describe, expect, expectTypeOf, it } from '@effect/vitest'
import { ToolError, loadInteractionReceipts, prepareToolBatch } from '@yolk-sdk/agent/loop'
import {
  InteractionClaim,
  InteractionReceipt,
  InteractionRequest,
  InteractionResponse,
  InteractionValidationError,
  ToolCall,
  ToolResult,
  TextPart,
  interactionRequestId,
  validateInteractionSubmission,
  type InteractionHost,
  type InteractionRef
} from '@yolk-sdk/agent/protocol'
import {
  makeInputTool,
  makeInteractionTool,
  modelVisibleToolError,
  resolveTools,
  type InteractionActionResult,
  type ResolvedToolSet,
  type ToolModule
} from '../../src/tools/index.ts'
import { makeFakeInteractionHost } from './interaction-host.ts'

const Draft = Schema.Struct({
  title: Schema.String,
  body: Schema.String,
  note: Schema.optional(Schema.String)
})

const Proposal = Schema.Struct({ folder: Schema.String })

const edited = { title: 'Edited', body: 'Exact final body' }

const call = ToolCall.make({ id: 'doc', name: 'document', params: { folder: 'drafts' } })

const response = (data: Schema.Json = edited, actionId = 'publish') =>
  InteractionResponse.make({
    requestId: interactionRequestId(call),
    toolCallId: call.id,
    outcome: 'submitted',
    source: 'user',
    actionId,
    data
  })

const cancelled = InteractionResponse.make({
  requestId: interactionRequestId(call),
  toolCallId: call.id,
  outcome: 'cancelled',
  source: 'user'
})

type Context = { readonly canPublish: boolean }

const context: Context = { canPublish: true }

const moduleFor = (
  execute: (
    data: typeof Draft.Type
  ) => Effect.Effect<InteractionActionResult, ToolError | ReturnType<typeof modelVisibleToolError>>
): ToolModule<Context> => ({
  id: 'documents',
  tools: [
    makeInteractionTool({
      name: 'document',
      description: 'Review a document',
      access: 'write',
      callParameters: Proposal,
      response: Draft,
      actions: {
        publish: {
          label: 'Publish',
          validate: ({ data, context }: { data: typeof Draft.Type; context: Context }) =>
            data.title.length > 0 && context.canPublish
              ? Effect.void
              : Effect.fail(new InteractionValidationError({ message: 'Cannot publish' })),
          execute: ({ data, call: proposal }) => {
            expectTypeOf(data).toEqualTypeOf<typeof Draft.Type>()
            expectTypeOf(proposal.params).toEqualTypeOf<typeof Proposal.Type>()

            return execute(data)
          }
        },
        archive: { label: 'Archive', execute: ({ data }) => execute(data) }
      }
    })
  ]
})

const setup = (
  options: Parameters<typeof makeFakeInteractionHost>[0] = {},
  execute?: Parameters<typeof moduleFor>[0]
) =>
  Effect.gen(function* () {
    const fake = makeFakeInteractionHost(options)
    const effects: Array<typeof Draft.Type> = []

    const modules = [
      moduleFor(
        execute ??
          (data =>
            Effect.sync(() => {
              effects.push(data)

              return { outcome: 'completed', content: `Published ${data.title}` }
            }))
      )
    ]

    const tools = yield* resolveTools(modules, context, { interactionHost: fake.host })
    const interaction = tools.interactions.document

    if (interaction === undefined || interaction.def.interaction === undefined)
      throw new Error('Missing interaction')

    const request = InteractionRequest.make({
      requestId: interactionRequestId(call),
      toolCallId: call.id,
      call,
      interaction: interaction.def.interaction
    })

    fake.addPending(request)

    return { fake, tools, effects, interaction, request, modules }
  })

const outcomeOf = (result: { readonly structuredContent?: unknown }) =>
  Schema.is(Schema.Record(Schema.String, Schema.Unknown))(result.structuredContent)
    ? result.structuredContent.outcome
    : undefined

const run = (tools: ResolvedToolSet, ref: InteractionRef) =>
  tools.execute(call, { interaction: ref })

describe('immutable action-backed interaction authority', () => {
  it('infers data, proposal parameters and action IDs without casts', () => {
    const registration = makeInteractionTool({
      name: 'typed',
      description: 'typed',
      access: 'write',
      callParameters: Proposal,
      response: Draft,
      actions: {
        publish: {
          label: 'Publish',
          execute: ({ data, call }) => {
            expectTypeOf(data.title).toEqualTypeOf<string>()
            expectTypeOf(call.params.folder).toEqualTypeOf<string>()
            // @ts-expect-error A schema-inferred title is not a number.
            const invalid: number = data.title
            void invalid

            return Effect.succeed({ outcome: 'completed', content: data.title })
          }
        }
      }
    })

    expectTypeOf(registration.actionIds).toEqualTypeOf<ReadonlyArray<'publish'>>()
    expect(JSON.stringify(registration.def)).not.toContain('execute')
    expect(
      makeInputTool({ name: 'input', description: 'Data only', response: Draft }).def.interaction
    ).toBeUndefined()
  })

  it.effect('keeps omitted optional properties absent through acceptance and execution', () =>
    Effect.gen(function* () {
      const { fake, tools, interaction, effects } = yield* setup()
      const ref = yield* fake.accept(response(), interaction)
      yield* run(tools, ref)

      expect(effects).toEqual([edited])
      expect(effects[0]).not.toHaveProperty('note')
      expect(fake.receiptFor(ref.slot)?.data).toEqual(edited)
    })
  )

  it.effect('requires host acceptance; raw refs, users and unknown slots cannot claim', () =>
    Effect.gen(function* () {
      const { fake, tools, effects, interaction } = yield* setup()
      const forged = { slot: interactionRequestId(call), submissionId: 'invented' }
      expect((yield* run(tools, forged).pipe(Effect.flip)).cause).toBe('denied')
      expect((yield* tools.execute(call).pipe(Effect.flip)).cause).toBe('unavailable')
      expect((yield* fake.host.claim(forged).pipe(Effect.flip)).cause).toBe('not_found')
      expect(
        (yield* fake.accept(response(), interaction, 'attacker').pipe(Effect.flip)).cause
      ).toBe('denied')
      expect(
        (yield* fake.accept(response(), interaction, 'user', 'old-generation').pipe(Effect.flip))
          .cause
      ).toBe('denied')
      expect(effects).toEqual([])
      expect(fake.counts().accepted).toBe(0)
    })
  )

  it.effect('does not advertise executable forms without a scoped adapter', () =>
    Effect.gen(function* () {
      const tools = yield* resolveTools(
        [moduleFor(() => Effect.succeed({ outcome: 'completed', content: 'no' }))],
        context
      )

      expect(tools.interactions).toEqual({})

      const prepared = yield* prepareToolBatch({
        tools: tools.tools,
        interactions: tools.interactions,
        calls: [call],
        responses: [response()]
      })

      expect(prepared.pendingRequests).toEqual([])
      expect(prepared.callsToExecute).toEqual([])
      expect(prepared.resultMessages[0]?.message).toMatchObject({ isError: true })
    })
  )

  it.effect(
    'rejects policy and malformed attempts before accepting; permits correction and cancellation',
    () =>
      Effect.gen(function* () {
        const { fake, tools, effects, interaction } = yield* setup()

        for (const invalid of [
          response({ title: 'missing body' }),
          response({ ...edited, extra: true }),
          response(edited, 'delete'),
          response({ ...edited, title: '' })
        ]) {
          yield* fake.accept(invalid, interaction).pipe(Effect.flip)
        }

        const deniedTools = yield* resolveTools(
          [moduleFor(() => Effect.succeed({ outcome: 'completed', content: 'no' }))],
          { canPublish: false },
          { interactionHost: fake.host }
        )

        const denied = deniedTools.interactions.document

        if (denied === undefined) throw new Error('missing')
        expect((yield* fake.accept(response(), denied).pipe(Effect.flip)).cause).toBe(
          'action_rejected'
        )
        expect(fake.counts().accepted).toBe(0)
        expect(effects).toEqual([])
        const ref = yield* fake.accept(response(edited, 'archive'), interaction)
        expect(outcomeOf(yield* run(tools, ref))).toBe('completed')
        expect(effects).toEqual([edited])
      })
  )

  it.effect(
    'locks one slot across actions, cancellation and changed data; identical retry reuses it',
    () =>
      Effect.gen(function* () {
        const { fake, interaction, tools, effects } = yield* setup()
        const ref = yield* fake.accept(response(), interaction)
        expect(yield* fake.accept(response(), interaction)).toEqual(ref)

        for (const conflict of [
          response(edited, 'archive'),
          response({ ...edited, body: 'changed' }),
          cancelled
        ]) {
          expect((yield* fake.accept(conflict, interaction).pipe(Effect.flip)).cause).toBe(
            'conflict'
          )
        }

        const first = yield* run(tools, ref)
        expect(yield* run(tools, ref)).toEqual(first)
        expect(effects).toHaveLength(1)
        expect(
          (yield* tools
            .execute(ToolCall.make({ ...call, params: { folder: 'foreign' } }), {
              interaction: ref
            })
            .pipe(Effect.flip)).cause
        ).toBe('denied')
        const foreign = yield* setup({ scope: 'other-session/run/generation' })
        expect((yield* run(foreign.tools, ref).pipe(Effect.flip)).cause).toBe('denied')
        const foreignRef = yield* foreign.fake.accept(response(), foreign.interaction)
        expect(foreignRef.submissionId).not.toBe(ref.submissionId)
      })
  )

  it.effect(
    'accepts cancellation despite a changed proposal schema and never invokes business code',
    () =>
      Effect.gen(function* () {
        const { fake, tools, interaction, request, effects } = yield* setup()

        const changed = {
          ...interaction,
          validateCall: () =>
            Effect.fail(new InteractionValidationError({ message: 'Changed schema' }))
        }

        expect(
          (yield* validateInteractionSubmission({
            request,
            response: InteractionResponse.make({ ...cancelled, data: null }),
            ...changed
          }).pipe(Effect.flip)).cause
        ).toBe('cancelled_with_payload')
        const ref = yield* fake.accept(cancelled, changed)
        expect(outcomeOf(yield* run(tools, ref))).toBe('cancelled')
        expect(effects).toEqual([])
        expect(fake.counts().claims).toBe(0)
      })
  )

  it.effect(
    'repeated preparation is read/claim/settlement/business-effect free and retains sibling fences',
    () =>
      Effect.gen(function* () {
        const { fake, tools, interaction, effects } = yield* setup()
        yield* fake.accept(response(), interaction)
        const sibling = ToolCall.make({ ...call, id: 'other' })
        const receipts = yield* loadInteractionReceipts([call, sibling], fake.host)
        const before = fake.counts()

        for (let i = 0; i < 3; i++) {
          const prepared = yield* prepareToolBatch({
            tools: tools.tools,
            interactions: tools.interactions,
            calls: [call, sibling],
            responses: [cancelled],
            interactionReceipts: receipts
          })

          expect(prepared.pendingRequests).toHaveLength(1)
          expect(prepared.interactionBindings.get(call.id)?.submissionId).toBe(
            fake.receiptFor(interactionRequestId(call))?.submissionId
          )
        }

        expect(fake.counts()).toEqual(before)
        expect(effects).toEqual([])
      })
  )

  it.effect(
    'replays historical outcomes before current schemas, removed actions, or absent/disabled tools',
    () =>
      Effect.gen(function* () {
        const { fake, tools, interaction, effects } = yield* setup()
        const ref = yield* fake.accept(response(), interaction)
        const first = yield* run(tools, ref)

        const changed = makeInteractionTool({
          name: 'document',
          description: 'changed',
          access: 'write',
          callParameters: Schema.Struct({ never: Schema.String }),
          response: Schema.Boolean,
          actions: { archive: { label: 'Archive', execute: () => Effect.die('must not execute') } }
        })

        for (const modules of [
          [],
          [{ id: 'changed', tools: [changed] }],
          [{ id: 'disabled', tools: [{ ...changed, isEnabled: () => Effect.succeed(false) }] }]
        ]) {
          const current = yield* resolveTools(modules, context, { interactionHost: fake.host })

          const prepared = yield* prepareToolBatch({
            tools: current.tools,
            interactions: current.interactions,
            calls: [call],
            responses: [],
            interactionReceipts: yield* loadInteractionReceipts([call], fake.host)
          })

          expect(prepared.pendingRequests).toEqual([])
          expect(prepared.callsToExecute).toHaveLength(1)
          expect(yield* run(current, ref)).toEqual(first)
        }

        expect(effects).toHaveLength(1)
      })
  )

  it.effect('missing current handlers cannot start accepted work', () =>
    Effect.gen(function* () {
      const { fake, interaction, effects } = yield* setup()
      const ref = yield* fake.accept(response(), interaction)
      const missing = yield* resolveTools([], context, { interactionHost: fake.host })
      expect((yield* run(missing, ref).pipe(Effect.flip)).cause).toBe('unavailable')
      expect(effects).toEqual([])
      expect(fake.counts().claims).toBe(0)
    })
  )

  it.effect('rechecks changed/malformed claim receipts before any action', () =>
    Effect.gen(function* () {
      for (const change of ['action', 'data', 'call', 'result', 'status']) {
        const { fake, modules, interaction, effects } = yield* setup()
        const ref = yield* fake.accept(response(), interaction)

        const host: InteractionHost = {
          ...fake.host,
          claim: current =>
            fake.host.claim(current).pipe(
              Effect.map(claim => {
                const original = claim.receipt

                const receipt = InteractionReceipt.make({
                  ...original,
                  actionId: change === 'action' ? 'archive' : original.actionId,
                  data: change === 'data' ? { ...edited, title: 'tampered' } : original.data,
                  call:
                    change === 'call'
                      ? ToolCall.make({ ...call, params: { folder: 'changed' } })
                      : original.call,
                  status: Match.value(change).pipe(
                    Match.when('status', () => 'accepted' as const),
                    Match.when('result', () => 'settled' as const),
                    Match.orElse(() => original.status)
                  )
                })

                return InteractionClaim.Owned({ token: 'untrusted', receipt })
              })
            )
        }

        const current = yield* resolveTools(modules, context, { interactionHost: host })
        expect((yield* run(current, ref).pipe(Effect.flip)).cause).toBe('denied')
        expect(effects).toEqual([])
      }
    })
  )

  it.effect('concurrent claim losers cannot dispatch or take over a started slot', () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const finish = yield* Deferred.make<void>()
      let executions = 0

      const { fake, tools, interaction } = yield* setup({}, () =>
        Effect.gen(function* () {
          executions += 1
          yield* Deferred.succeed(started, undefined)
          yield* Deferred.await(finish)

          return { outcome: 'completed', content: 'Published' }
        })
      )

      const ref = yield* fake.accept(response(), interaction)
      const owner = yield* run(tools, ref).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      expect(outcomeOf(yield* run(tools, ref))).toBe('unknown')
      expect(executions).toBe(1)
      yield* Deferred.succeed(finish, undefined)
      const result = yield* Fiber.join(owner)
      expect(yield* run(tools, ref)).toEqual(result)
      expect(executions).toBe(1)
    })
  )

  it.effect(
    'lost successful settlement acknowledgement replays completed; failed storage seals uncertainty',
    () =>
      Effect.gen(function* () {
        for (const settlement of ['lose-ack', 'fail'] as const) {
          const { fake, tools, interaction, effects } = yield* setup({ settlement })
          const ref = yield* fake.accept(response(), interaction)
          const first = yield* run(tools, ref)
          expect(outcomeOf(first)).toBe(settlement === 'lose-ack' ? 'completed' : 'unknown')
          const replay = yield* run(tools, ref)
          expect(outcomeOf(replay)).toBe(settlement === 'lose-ack' ? 'completed' : 'unknown')
          expect(effects).toHaveLength(1)

          if (settlement === 'fail') expect(fake.receiptFor(ref.slot)?.status).toBe('started')
        }
      })
  )

  it.effect(
    'escaped typed failures are unknown, only explicit failed is definitive, rich content warns',
    () =>
      Effect.gen(function* () {
        for (const kind of ['tool-error', 'model-visible', 'failed', 'rich-unknown']) {
          const { fake, tools, interaction } = yield* setup({}, () => {
            if (kind === 'tool-error')
              return Effect.fail(
                new ToolError({ tool: 'document', cause: 'timeout', message: 'timeout' })
              )

            if (kind === 'model-visible')
              return Effect.fail(
                modelVisibleToolError({ tool: 'document', reason: 'timeout', message: 'timeout' })
              )

            return Effect.succeed({
              outcome: kind === 'failed' ? 'failed' : 'unknown',
              content: [TextPart.make({ text: 'Provider observation' })]
            })
          })

          const ref = yield* fake.accept(response(), interaction)
          const result = yield* run(tools, ref)
          expect(outcomeOf(result)).toBe(kind === 'failed' ? 'failed' : 'unknown')
          expect(result.isError).toBe(true)

          if (kind !== 'failed') {
            expect(JSON.stringify(result.content)).toContain('may have taken effect')
            expect(JSON.stringify(result.content)).toContain('Do not retry it automatically')
          }
        }
      })
  )

  it.effect('handler defects and synchronous throws preserve their Cause and persist unknown', () =>
    Effect.gen(function* () {
      for (const sync of [false, true]) {
        const { fake, tools, interaction } = yield* setup({}, () => {
          if (sync) throw new Error('handler bug')

          return Effect.die('handler bug')
        })

        const ref = yield* fake.accept(response(), interaction)
        const exit = yield* run(tools, ref).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)

        if (Exit.isFailure(exit)) {
          expect(Cause.hasDies(exit.cause)).toBe(true)
          expect(String(Cause.squash(exit.cause))).toContain('handler bug')
        }

        expect(fake.receiptFor(ref.slot)?.status).toBe('settled')
        expect(outcomeOf(yield* run(tools, ref))).toBe('unknown')
      }
    })
  )

  it.effect(
    'interruption stops the business Effect but finalizes uncertainty and never retries',
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        let executions = 0

        const { fake, tools, interaction } = yield* setup({}, () =>
          Effect.gen(function* () {
            executions += 1
            yield* Deferred.succeed(started, undefined)

            return yield* Effect.never
          })
        )

        const ref = yield* fake.accept(response(), interaction)
        const fiber = yield* run(tools, ref).pipe(Effect.forkChild)
        yield* Deferred.await(started)
        yield* Fiber.interrupt(fiber)
        expect(fake.receiptFor(ref.slot)?.status).toBe('settled')
        expect(outcomeOf(yield* run(tools, ref))).toBe('unknown')
        expect(executions).toBe(1)
      })
  )

  it.effect(
    'rejects nested normalization, defaults and type-changing transforms before acceptance',
    () =>
      Effect.gen(function* () {
        const schemas = [
          Schema.Struct({ nested: Schema.Struct({ title: Schema.Trim }) }),
          Schema.Struct({
            nested: Schema.Struct({
              title: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed('default')))
            })
          }),
          Schema.Struct({ nested: Schema.Struct({ title: Schema.NumberFromString }) })
        ]

        const values: Array<Schema.Json> = [
          { nested: { title: ' trimmed ' } },
          { nested: {} },
          { nested: { title: '123' } }
        ]

        for (const [index, schema] of schemas.entries()) {
          const fake = makeFakeInteractionHost()

          const tool = makeInteractionTool({
            name: 'document',
            description: 'exact',
            access: 'write',
            callParameters: Proposal,
            response: schema,
            actions: {
              publish: { label: 'Publish', execute: () => Effect.die('must not execute') }
            }
          })

          const tools = yield* resolveTools([{ id: 'exact', tools: [tool] }], context, {
            interactionHost: fake.host
          })

          const interaction = tools.interactions.document

          if (interaction === undefined || interaction.def.interaction === undefined)
            throw new Error('missing')
          fake.addPending(
            InteractionRequest.make({
              requestId: interactionRequestId(call),
              toolCallId: call.id,
              call,
              interaction: interaction.def.interaction
            })
          )
          const data = values[index]

          if (data === undefined) throw new Error('missing data')
          expect((yield* fake.accept(response(data), interaction).pipe(Effect.flip)).cause).toBe(
            'invalid_data'
          )
          expect(fake.counts().accepted).toBe(0)
          yield* fake.accept(cancelled, interaction)
        }

        const transformedCall = makeInteractionTool({
          name: 'document',
          description: 'exact proposal',
          access: 'write',
          callParameters: Schema.Struct({ folder: Schema.Trim }),
          response: Draft,
          actions: { publish: { label: 'Publish', execute: () => Effect.die('must not execute') } }
        })

        const handler = transformedCall.interaction

        if (handler === undefined) throw new Error('missing')
        expect((yield* handler.validateCall({ folder: ' trimmed ' }).pipe(Effect.flip))._tag).toBe(
          'InteractionValidationError'
        )
      })
  )

  it.effect('executes valid null, false and zero exactly, never absent data', () =>
    Effect.gen(function* () {
      for (const value of [null, false, 0]) {
        const fake = makeFakeInteractionHost()
        const received: Array<Schema.Json> = []

        const tool = makeInteractionTool({
          name: 'document',
          description: 'false-like',
          access: 'write',
          callParameters: Proposal,
          response: Schema.Union([Schema.Null, Schema.Boolean, Schema.Number]),
          actions: {
            publish: {
              label: 'Publish',
              execute: ({ data }) =>
                Effect.sync(() => {
                  received.push(data)

                  return { outcome: 'completed', content: 'Done' }
                })
            }
          }
        })

        const tools = yield* resolveTools([{ id: 'false-like', tools: [tool] }], context, {
          interactionHost: fake.host
        })

        const interaction = tools.interactions.document

        if (interaction === undefined || interaction.def.interaction === undefined)
          throw new Error('missing')
        fake.addPending(
          InteractionRequest.make({
            requestId: interactionRequestId(call),
            toolCallId: call.id,
            call,
            interaction: interaction.def.interaction
          })
        )
        expect(
          (yield* fake
            .accept(InteractionResponse.make({ ...response(), data: undefined }), interaction)
            .pipe(Effect.flip)).cause
        ).toBe('missing_data')
        const ref = yield* fake.accept(response(value), interaction)
        yield* run(tools, ref)
        expect(received).toEqual([value])
      }
    })
  )

  it.effect('two claimants with the same accepted snapshot acquire only one fencing token', () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const releaseClaims = yield* Deferred.make<void>()
      const businessStarted = yield* Deferred.make<void>()
      const releaseBusiness = yield* Deferred.make<void>()
      let claims = 0
      let executions = 0

      const { fake, modules, interaction } = yield* setup({}, () =>
        Effect.gen(function* () {
          executions += 1
          yield* Deferred.succeed(businessStarted, undefined)
          yield* Deferred.await(releaseBusiness)

          return { outcome: 'completed', content: 'done' }
        })
      )

      const host: InteractionHost = {
        ...fake.host,
        claim: ref =>
          Effect.gen(function* () {
            claims += 1

            if (claims === 2) yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(releaseClaims)

            return yield* fake.host.claim(ref)
          })
      }

      const tools = yield* resolveTools(modules, context, { interactionHost: host })
      const ref = yield* fake.accept(response(), interaction)

      const fibers = yield* Effect.all([
        run(tools, ref).pipe(Effect.forkChild),
        run(tools, ref).pipe(Effect.forkChild)
      ])

      yield* Deferred.await(entered)
      yield* Deferred.succeed(releaseClaims, undefined)
      yield* Deferred.await(businessStarted)
      yield* Deferred.succeed(releaseBusiness, undefined)
      const results = yield* Effect.forEach(fibers, Fiber.join)
      expect(executions).toBe(1)
      expect(fake.counts().claims).toBe(2)
      expect(results.some(result => outcomeOf(result) === 'completed')).toBe(true)
    })
  )

  it.effect('bounds uncertainty finalization when storage never acknowledges interruption', () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const settling = yield* Deferred.make<void>()

      const { fake, modules, interaction } = yield* setup({}, () =>
        Effect.gen(function* () {
          yield* Deferred.succeed(started, undefined)

          return yield* Effect.never
        })
      )

      const host: InteractionHost = {
        ...fake.host,
        settle: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(settling, undefined)

            return yield* Effect.never
          })
      }

      const tools = yield* resolveTools(modules, context, { interactionHost: host })
      const ref = yield* fake.accept(response(), interaction)
      const fiber = yield* run(tools, ref).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      const interrupted = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild)
      yield* Deferred.await(settling)
      yield* TestClock.adjust('5 seconds')
      yield* Fiber.join(interrupted)
      expect(fake.receiptFor(ref.slot)?.status).toBe('started')
      expect(outcomeOf(yield* run(tools, ref))).toBe('unknown')
    })
  )

  it.effect(
    'host settlement fences tokens, rejects foreign identity, and retains the first result',
    () =>
      Effect.gen(function* () {
        const { fake, tools, interaction } = yield* setup()
        const ref = yield* fake.accept(response(), interaction)
        const claim = yield* fake.host.claim(ref)

        if (!Predicate.isTagged(claim, 'Owned')) throw new Error('missing owner')
        const observed = yield* run(tools, ref)
        const outcome = { status: 'unknown' as const, result: observed }
        expect((yield* fake.host.settle('foreign-token', outcome).pipe(Effect.flip)).cause).toBe(
          'denied'
        )

        const bad = {
          ...outcome,
          result: ToolResult.make({ ...observed, toolCallId: 'other-call' })
        }

        expect((yield* fake.host.settle(claim.token, bad).pipe(Effect.flip)).cause).toBe('denied')
        const first = yield* fake.host.settle(claim.token, outcome)
        expect(yield* fake.host.settle(claim.token, outcome)).toEqual(first)
        expect(yield* run(tools, ref)).toEqual(first.result)
      })
  )

  it.effect(
    'malformed settlement acknowledgements produce sealed unknown instead of foreign success',
    () =>
      Effect.gen(function* () {
        const { fake, modules, interaction, effects } = yield* setup()

        const host: InteractionHost = {
          ...fake.host,
          settle: () =>
            Effect.succeed({
              status: 'completed',
              result: ToolResult.make({ toolCallId: 'other-call', content: 'unrelated success' })
            })
        }

        const tools = yield* resolveTools(modules, context, { interactionHost: host })
        const ref = yield* fake.accept(response(), interaction)
        expect(outcomeOf(yield* run(tools, ref))).toBe('unknown')
        expect(outcomeOf(yield* run(tools, ref))).toBe('unknown')
        expect(effects).toHaveLength(1)
        expect(fake.receiptFor(ref.slot)?.status).toBe('started')
      })
  )

  it.effect('accepted values are isolated from later browser edits', () =>
    Effect.gen(function* () {
      const { fake, tools, interaction, effects } = yield* setup()
      const browser = { title: 'consented', body: 'original' }
      const ref = yield* fake.accept(response(browser), interaction)
      browser.title = 'not consented'
      yield* run(tools, ref)
      expect(effects).toEqual([{ title: 'consented', body: 'original' }])
    })
  )

  it.effect('retains input/approval/background restrictions', () =>
    Effect.gen(function* () {
      const { modules } = yield* setup()
      const registration = modules[0]?.tools[0]

      if (registration === undefined) throw new Error('missing')

      for (const policy of [{ background: true }, { approval: { mode: 'manual' as const } }]) {
        expect(
          (yield* resolveTools(
            [{ id: 'bad', tools: [{ ...registration, ...policy }] }],
            context
          ).pipe(Effect.flip)).cause
        ).toBe('interaction_unsupported_policy')
      }
    })
  )
})
