// @vitest-environment node
import { Effect, Layer, Predicate, Result } from 'effect'
import * as Schema from 'effect/Schema'
import {
  VercelWorkflows,
  VercelWorkflowsSdk,
  type VercelWorkflowsSdkClient
} from '@yolk-sdk/vercel-workflows/effect'
import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  AgentWorkflowStore,
  decodeWorkflowOwnership,
  UserId,
  WorkflowRunForbidden,
  WorkflowRunId
} from './live-layer'
import { readWorkflowChild } from './read-child'
import { emptyWorkflowRegistry } from './registry'

const fakeStoreLayer = Layer.succeed(AgentWorkflowStore, {
  register: (runId, userId) =>
    runId === 'parent' && userId === 'owner'
      ? Effect.succeed(undefined)
      : Effect.fail(new WorkflowRunForbidden({ message: 'Workflow run not found' })),
  read: (runId, userId) =>
    runId === 'parent' && userId === 'owner'
      ? Effect.succeed(emptyWorkflowRegistry())
      : Effect.fail(new WorkflowRunForbidden({ message: 'Workflow run not found' })),
  change: (runId, userId, _command) =>
    runId === 'parent' && userId === 'owner'
      ? Effect.succeed(emptyWorkflowRegistry())
      : Effect.fail(new WorkflowRunForbidden({ message: 'Workflow run not found' }))
})

const unusedWorkflowsLayer = VercelWorkflows.layerFromSdk.pipe(
  Layer.provide(
    Layer.succeed(VercelWorkflowsSdk, {
      start: async () => {
        throw new Error('not used')
      },
      resumeHook: async () => {},
      getRun: () => {
        throw new Error('not used')
      }
    } satisfies VercelWorkflowsSdkClient)
  )
)

describe('agent workflow branded ids', () => {
  it('keeps WorkflowRunId and UserId nominally incompatible', () => {
    const runId = WorkflowRunId.make('parent')
    const userId = UserId.make('owner')

    // Brands keep their string wire representation.
    const runWire: string = runId
    expect(runWire).toBe('parent')
    const userWire: string = userId
    expect(userWire).toBe('owner')

    const backToRun: WorkflowRunId = runId
    expect(backToRun).toBe('parent')

    // @ts-expect-error - WorkflowRunId is not a UserId
    const mismatchUser: UserId = runId
    // @ts-expect-error - UserId is not a WorkflowRunId
    const mismatchRun: WorkflowRunId = userId
    // @ts-expect-error - unbranded strings require minting through the canonical schema
    const runFromString: WorkflowRunId = 'parent'
    // @ts-expect-error - unbranded strings require minting through the canonical schema
    const userFromString: UserId = 'owner'

    expect([mismatchUser, mismatchRun, runFromString, userFromString]).toHaveLength(4)
  })

  it('roundtrips workflow brands through their encoded string form', async () => {
    const ownership = await Effect.runPromise(
      decodeWorkflowOwnership({ runId: 'parent', userId: 'owner' })
    )

    expect(ownership.runId).toBe('parent')
    expect(ownership.userId).toBe('owner')
    expect(await Effect.runPromise(Schema.encodeEffect(WorkflowRunId)(ownership.runId))).toBe(
      'parent'
    )
    expect(await Effect.runPromise(Schema.encodeEffect(UserId)(ownership.userId))).toBe('owner')

    // Non-empty trimmed validation is preserved: empty, blank, padded, and
    // non-string ids fail instead of coercing.
    for (const raw of ['', '   ', ' parent ', 42, null]) {
      const runResult = await Effect.runPromise(
        Schema.decodeUnknownEffect(WorkflowRunId)(raw).pipe(Effect.result)
      )

      expect(Result.isFailure(runResult)).toBe(true)

      const userResult = await Effect.runPromise(
        Schema.decodeUnknownEffect(UserId)(raw).pipe(Effect.result)
      )

      expect(Result.isFailure(userResult)).toBe(true)
    }
  })

  it('requires branded ids at the positional store methods', async () => {
    const owned = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* AgentWorkflowStore

        return yield* store.read(WorkflowRunId.make('parent'), UserId.make('owner'))
      }).pipe(Effect.provide(fakeStoreLayer))
    )

    expect(owned.stopped).toBe(false)

    const program = Effect.gen(function* () {
      const store = yield* AgentWorkflowStore

      // Root pnpm tsc checks these without executing intentionally ill-typed calls.
      expectTypeOf<Parameters<typeof store.read>[0]>().toEqualTypeOf<WorkflowRunId>()
      expectTypeOf<Parameters<typeof store.read>[1]>().toEqualTypeOf<UserId>()
      expectTypeOf<Parameters<typeof store.register>[0]>().toEqualTypeOf<WorkflowRunId>()
      expectTypeOf<Parameters<typeof store.register>[1]>().toEqualTypeOf<UserId>()
      expectTypeOf<Parameters<typeof store.change>[0]>().toEqualTypeOf<WorkflowRunId>()
      expectTypeOf<Parameters<typeof store.change>[1]>().toEqualTypeOf<UserId>()
    }).pipe(Effect.provide(fakeStoreLayer), Effect.result)

    expect((await Effect.runPromise(program))._tag).toBe('Success')

    // Forged but well-formed ids decode yet stay unauthorized at the logic level:
    // ownership checks remain row comparisons, not brand checks.
    const forged = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* AgentWorkflowStore

        return yield* store.read(WorkflowRunId.make('other-parent'), UserId.make('owner'))
      }).pipe(Effect.provide(fakeStoreLayer), Effect.result)
    )

    expect(forged._tag).toBe('Failure')

    if (Predicate.isTagged(forged, 'Failure')) {
      expect(forged.failure).toBeInstanceOf(WorkflowRunForbidden)
    }
  })

  it('rejects invalid raw ids at the read-child decode boundary', async () => {
    const result = await Effect.runPromise(
      readWorkflowChild({ parentRunId: '', userId: 'owner', callId: 'call' }).pipe(
        Effect.provide(Layer.merge(fakeStoreLayer, unusedWorkflowsLayer)),
        Effect.result
      )
    )

    expect(result._tag).toBe('Failure')

    const valid = await Effect.runPromise(
      readWorkflowChild({ parentRunId: 'parent', userId: 'owner', callId: 'missing' }).pipe(
        Effect.provide(Layer.merge(fakeStoreLayer, unusedWorkflowsLayer)),
        Effect.result
      )
    )

    // Well-formed ids reach the ownership/registry logic: an unknown child handle
    // resolves to a terminal failure ToolResult, not a decode error.
    expect(valid._tag).toBe('Success')
  })
})
