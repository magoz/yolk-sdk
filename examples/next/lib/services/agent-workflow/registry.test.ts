// @vitest-environment node
import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  VercelWorkflows,
  VercelWorkflowsSdk,
  type VercelWorkflowsSdkClient
} from '@yolk-sdk/vercel-workflows/effect'
import { AgentWorkflowStore, WorkflowRunForbidden } from './live-layer'
import { stopAgentWorkflow } from './stop'
import { readWorkflowChild } from './read-child'
import { maxWorkflowChildren } from './policy'
import {
  emptyWorkflowRegistry,
  transitionWorkflowRegistry,
  WorkflowChildRecord,
  type RegistryCommand
} from './registry'

const child = (callId = 'call') =>
  WorkflowChildRecord.make({
    callId,
    request: { prompt: 'immutable' },
    description: 'Task',
    subagentType: 'general',
    startedAtMs: 1,
    workflowRunId: null,
    result: null
  })

const fakeStore = () => {
  let state = emptyWorkflowRegistry()
  const authorize = (
    runId: string,
    userId: string
  ): Effect.Effect<undefined, WorkflowRunForbidden> =>
    runId === 'parent' && userId === 'owner'
      ? Effect.succeed(undefined)
      : Effect.fail(new WorkflowRunForbidden({ message: 'Workflow run not found' }))
  const change = (command: RegistryCommand) => {
    state = transitionWorkflowRegistry(state, command)
    return state
  }
  const layer = Layer.succeed(AgentWorkflowStore, {
    register: authorize,
    read: (runId, userId) => authorize(runId, userId).pipe(Effect.map(() => state)),
    change: (runId, userId, command) =>
      authorize(runId, userId).pipe(Effect.map(() => change(command)))
  })
  return { layer, change, read: () => state }
}

describe('durable host registry (transactional behavioral fake)', () => {
  it('reserves once, admits one physical run, and never steals slow claims', () => {
    const store = fakeStore()
    store.change({ type: 'reserve', child: child() })
    store.change({
      type: 'reserve',
      child: WorkflowChildRecord.make({ ...child(), request: 'changed' })
    })
    store.change({ type: 'admit', callId: 'call', workflowRunId: 'child-a' })
    store.change({ type: 'admit', callId: 'call', workflowRunId: 'child-b' })
    expect(store.read().children).toHaveLength(1)
    expect(store.read().children[0]).toMatchObject({
      request: { prompt: 'immutable' },
      workflowRunId: 'child-a'
    })
  })

  it('only the admitted child can commit and repeated reads/commits are idempotent', () => {
    const store = fakeStore()
    store.change({ type: 'reserve', child: child() })
    store.change({ type: 'admit', callId: 'call', workflowRunId: 'child-a' })
    store.change({ type: 'complete', callId: 'call', workflowRunId: 'child-b', result: 'forged' })
    expect(store.read().children[0]?.result).toBeNull()
    store.change({ type: 'complete', callId: 'call', workflowRunId: 'child-a', result: 'final' })
    store.change({
      type: 'complete',
      callId: 'call',
      workflowRunId: 'child-a',
      result: 'duplicate'
    })
    expect(store.read().children[0]?.result).toBe('final')
    expect(store.read().children[0]?.result).toBe('final')
  })

  it('Stop fences late reservation, admission, and in-flight terminal writes', () => {
    for (const admitted of [true, false]) {
      const store = fakeStore()
      store.change({ type: 'reserve', child: child() })
      if (admitted) store.change({ type: 'admit', callId: 'call', workflowRunId: 'child-a' })
      store.change({ type: 'stop' })
      store.change({ type: 'reserve', child: child('late') })
      store.change({ type: 'admit', callId: 'call', workflowRunId: 'child-late' })
      store.change({
        type: 'complete',
        callId: 'call',
        workflowRunId: 'child-a',
        result: 'late-result'
      })
      expect(store.read().children).toHaveLength(1)
      expect(store.read().children[0]?.workflowRunId).toBe(admitted ? 'child-a' : null)
      expect(store.read().children[0]?.result).toBeNull()
    }
  })

  it('enforces the bounded lifetime fanout including pending reservations', () => {
    const store = fakeStore()
    for (let i = 0; i < 100; i++) store.change({ type: 'reserve', child: child(String(i)) })
    expect(store.read().children).toHaveLength(maxWorkflowChildren)
  })

  it('authorizes lookup and wait against both parent and owner', async () => {
    const store = fakeStore()
    for (const [runId, userId] of [
      ['parent', 'intruder'],
      ['other-parent', 'owner']
    ]) {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* AgentWorkflowStore
          return yield* service.read(runId ?? '', userId ?? '')
        }).pipe(Effect.provide(store.layer), Effect.result)
      )
      expect(result._tag).toBe('Failure')
    }
  })

  it('sweeps children even if parent is completed; partial cancellation is observable and retryable', async () => {
    const store = fakeStore()
    for (const id of ['a', 'b']) {
      store.change({ type: 'reserve', child: child(id) })
      store.change({ type: 'admit', callId: id, workflowRunId: id })
    }
    let fail = true
    const cancelled: string[] = []
    const sdk: VercelWorkflowsSdkClient = {
      start: async () => {
        throw new Error('not used')
      },
      resumeHook: async () => {},
      getRun: <TResult>(id: string) => ({
        runId: id,
        status: Promise.resolve(id === 'parent' ? 'completed' : 'running'),
        get returnValue(): Promise<TResult> {
          throw new Error('not used')
        },
        getReadable: () => {
          throw new Error('not used')
        },
        cancel: async () => {
          expect(store.read().stopped).toBe(true)
          if (id === 'a' && fail) throw new Error('transient cancel failure')
          cancelled.push(id)
        }
      })
    }
    const workflows = VercelWorkflows.layerFromSdk.pipe(
      Layer.provide(Layer.succeed(VercelWorkflowsSdk, sdk))
    )
    const run = () =>
      Effect.runPromise(
        stopAgentWorkflow('parent', 'owner').pipe(
          Effect.provide(Layer.merge(store.layer, workflows)),
          Effect.result
        )
      )
    const first = await run()
    expect(first).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'WorkflowStopIncomplete', runIds: ['a'] }
    })
    expect(cancelled).toEqual(['b'])
    fail = false
    expect((await run())._tag).toBe('Success')
    expect(cancelled).toContain('a')
  })
  it('reads killed-child status briefly, enforces lookup ownership, and never infers app success', async () => {
    const store = fakeStore()
    store.change({ type: 'reserve', child: child() })
    store.change({ type: 'admit', callId: 'call', workflowRunId: 'physical' })
    let status: 'running' | 'failed' | 'completed' = 'running'
    let statusReads = 0
    const sdk: VercelWorkflowsSdkClient = {
      start: async () => {
        throw new Error('not used')
      },
      resumeHook: async () => {},
      getRun: <TResult>() => ({
        runId: 'physical',
        get status() {
          statusReads++
          return Promise.resolve(status)
        },
        get returnValue(): Promise<TResult> {
          throw new Error('Long waits forbidden')
        },
        getReadable: () => {
          throw new Error('not used')
        },
        cancel: async () => {}
      })
    }
    const workflows = VercelWorkflows.layerFromSdk.pipe(
      Layer.provide(Layer.succeed(VercelWorkflowsSdk, sdk))
    )
    const read = (userId = 'owner') =>
      Effect.runPromise(
        readWorkflowChild({ parentRunId: 'parent', userId, callId: 'call' }).pipe(
          Effect.provide(Layer.merge(store.layer, workflows))
        )
      )
    expect(await read()).toEqual({ done: false, workflowRunId: 'physical', result: null })
    expect(statusReads).toBe(1)
    await expect(read('intruder')).rejects.toMatchObject({ _tag: 'WorkflowRunForbidden' })
    expect(statusReads).toBe(1)
    status = 'completed'
    expect(await read()).toMatchObject({
      done: true,
      result: { isError: true, content: 'Child workflow completed without a stored outcome' }
    })
    status = 'failed'
    expect(await read()).toMatchObject({
      done: true,
      result: { isError: true, content: 'Child workflow failed without a stored outcome' }
    })
    store.change({ type: 'stop' })
    expect(await read()).toMatchObject({
      done: true,
      result: { isError: true, content: 'Child cancelled' }
    })
    // A Stop cannot turn an already committed terminal child into a cancellation.
    const completedStore = fakeStore()
    completedStore.change({ type: 'reserve', child: child() })
    completedStore.change({ type: 'admit', callId: 'call', workflowRunId: 'physical' })
    completedStore.change({
      type: 'complete',
      callId: 'call',
      workflowRunId: 'physical',
      result: { terminal: 'kept' }
    })
    completedStore.change({ type: 'stop' })
    expect(
      await Effect.runPromise(
        readWorkflowChild({ parentRunId: 'parent', userId: 'owner', callId: 'call' }).pipe(
          Effect.provide(Layer.merge(completedStore.layer, workflows))
        )
      )
    ).toMatchObject({ done: true, result: { terminal: 'kept' } })

    const uncertainStore = fakeStore()
    uncertainStore.change({
      type: 'reserve',
      child: WorkflowChildRecord.make({ ...child(), startedAtMs: Date.now() })
    })
    const readUncertain = () =>
      Effect.runPromise(
        readWorkflowChild({ parentRunId: 'parent', userId: 'owner', callId: 'call' }).pipe(
          Effect.provide(Layer.merge(uncertainStore.layer, workflows))
        )
      )
    expect(await readUncertain()).toMatchObject({ done: false, workflowRunId: null })
    uncertainStore.change({ type: 'launch-uncertain', callId: 'call' })
    expect(await readUncertain()).toMatchObject({
      done: true,
      workflowRunId: null,
      result: { isError: true }
    })
    expect(uncertainStore.read().children[0]?.result).toBeNull()
    // A genuinely lost start response can still self-admit later; no false terminal claim.
    uncertainStore.change({ type: 'admit', callId: 'call', workflowRunId: 'physical' })
    status = 'running'
    expect(await readUncertain()).toMatchObject({ done: false, workflowRunId: 'physical' })

    const abandonedStore = fakeStore()
    abandonedStore.change({ type: 'reserve', child: child() })
    expect(
      await Effect.runPromise(
        readWorkflowChild({ parentRunId: 'parent', userId: 'owner', callId: 'call' }).pipe(
          Effect.provide(Layer.merge(abandonedStore.layer, workflows))
        )
      )
    ).toMatchObject({ done: true, workflowRunId: null, result: { isError: true } })
  })
})
