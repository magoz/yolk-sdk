// @vitest-environment node
import { describe, expect, it } from '@effect/vitest'
import { Effect, Fiber, Layer } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import { HookNotFoundError } from 'workflow/errors'
import { ToolApprovalRequest, ToolApprovalResponse, ToolCall } from '@yolk-sdk/agent/protocol'
import {
  VercelWorkflows,
  VercelWorkflowsSdk,
  type VercelWorkflowsSdkClient
} from '@yolk-sdk/vercel-workflows/effect'
import { resumeWorkflowHitlAnswer } from './hitl-resume'
import { AgentWorkflowStore, UserId, WorkflowRunId } from './live-layer'
import {
  emptyWorkflowRegistry,
  transitionWorkflowRegistry,
  WorkflowHitlPause,
  type RegistryCommand
} from './registry'

const runId = WorkflowRunId.make('parent')

const userId = UserId.make('owner')

const pause = (index: number, toolCallId: string) =>
  WorkflowHitlPause.make({
    pauseId: `event-${index}`,
    hookToken: `pause-${index}`,
    requests: [
      ToolApprovalRequest.make({
        requestId: `approval:${toolCallId}`,
        toolCallId,
        call: ToolCall.make({ id: toolCallId, name: 'write', params: {} })
      })
    ],
    answer: null,
    delivered: false
  })

const approve = (toolCallId: string) =>
  ToolApprovalResponse.make({
    requestId: `approval:${toolCallId}`,
    toolCallId,
    decision: 'approved',
    source: 'user'
  })

/** Fake store and platform; `onResume` stands in for the platform hook (and the workflow). */
const harness = (onResume: (token: string) => void) => {
  let state = emptyWorkflowRegistry()
  const resumes: string[] = []

  const change = (command: RegistryCommand) => {
    state = transitionWorkflowRegistry(state, command)

    return state
  }

  const sdk: VercelWorkflowsSdkClient = {
    start: async () => {
      throw new Error('not used')
    },
    getRun: () => {
      throw new Error('not used')
    },
    resumeHook: async token => {
      resumes.push(token)
      onResume(token)
    }
  }

  const layer = Layer.mergeAll(
    Layer.succeed(AgentWorkflowStore, {
      register: () => Effect.succeed(undefined),
      read: () => Effect.sync(() => state),
      change: (_runId, _userId, command) => Effect.sync(() => change(command))
    }),
    VercelWorkflows.layerFromSdk.pipe(Layer.provide(Layer.succeed(VercelWorkflowsSdk, sdk)))
  )

  return { layer, change, resumes }
}

const resume = (pauseId: string | undefined, toolCallId: string, tailIndex: number) =>
  resumeWorkflowHitlAnswer({ runId, userId, pauseId, response: approve(toolCallId), tailIndex })

describe('resumeWorkflowHitlAnswer', () => {
  it.effect('reports an identical retry after delivery without resuming the hook again', () =>
    Effect.gen(function* () {
      const fake = harness(token => fake.change({ type: 'deliver', hookToken: token }))
      fake.change({ type: 'pause', pause: pause(1, 'a') })

      const first = yield* resume('event-1', 'a', 4).pipe(Effect.provide(fake.layer))
      const retried = yield* resume('event-1', 'a', 9).pipe(Effect.provide(fake.layer))

      expect(fake.resumes).toEqual(['pause-1'])
      expect(first.tailIndex).toBe(4)
      expect(retried.tailIndex).toBe(4)
    })
  )

  it.effect('reports an identical retry as delivered once the workflow moved to a new pause', () =>
    Effect.gen(function* () {
      const fake = harness(() => undefined)
      fake.change({ type: 'pause', pause: pause(1, 'a') })
      yield* resume('event-1', 'a', 4).pipe(Effect.provide(fake.layer))
      // The workflow took the answer (delivery mark lost) and paused again.
      fake.change({ type: 'pause', pause: pause(2, 'b') })

      const retried = yield* resume('event-1', 'a', 9).pipe(Effect.provide(fake.layer))

      expect(retried.tailIndex).toBe(4)
      expect(fake.resumes).toEqual(['pause-1'])
    })
  )

  it.effect('treats HookNotFound as delivered once the pause moved on', () =>
    Effect.gen(function* () {
      const fake = harness(token => {
        // The workflow took the answer and paused again before this resume reached the hook.
        fake.change({ type: 'pause', pause: pause(2, 'b') })

        throw new HookNotFoundError(token)
      })

      fake.change({ type: 'pause', pause: pause(1, 'a') })

      const answer = yield* resume('event-1', 'a', 4).pipe(Effect.provide(fake.layer))

      expect(answer.tailIndex).toBe(4)
      expect(fake.resumes).toEqual(['pause-1'])
    })
  )

  it.effect('fails with WorkflowHitlHookPending after bounded retries while the pause waits', () =>
    Effect.gen(function* () {
      const fake = harness(token => {
        throw new HookNotFoundError(token)
      })

      fake.change({ type: 'pause', pause: pause(1, 'a') })

      const fiber = yield* resume('event-1', 'a', 4).pipe(
        Effect.provide(fake.layer),
        Effect.flip,
        Effect.forkChild
      )

      // One immediate attempt, then one per delay: 250ms, 500ms, 1s, 2s.
      yield* Effect.yieldNow
      expect(fake.resumes).toHaveLength(1)

      for (const [delay, attempts] of [
        [250, 2],
        [500, 3],
        [1000, 4],
        [2000, 5]
      ] as const) {
        yield* TestClock.adjust(delay - 1)
        expect(fake.resumes).toHaveLength(attempts - 1)
        yield* TestClock.adjust(1)
        expect(fake.resumes).toHaveLength(attempts)
      }

      const error = yield* Fiber.join(fiber)

      expect(error._tag).toBe('WorkflowHitlHookPending')
      expect(new Set(fake.resumes)).toEqual(new Set(['pause-1']))
    })
  )

  it.effect('refuses an answer that names no pause without recording it', () =>
    Effect.gen(function* () {
      const fake = harness(() => undefined)
      fake.change({ type: 'pause', pause: pause(1, 'a') })

      const error = yield* resume(undefined, 'a', 4).pipe(Effect.provide(fake.layer), Effect.flip)

      expect(error._tag).toBe('WorkflowHitlAnswerRefused')
      expect(fake.change({ type: 'deliver', hookToken: 'none' }).hitlPause?.answer).toBeNull()
      expect(fake.resumes).toEqual([])
    })
  )
})
