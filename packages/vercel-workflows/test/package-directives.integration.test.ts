import { Effect, Predicate } from 'effect'
import { describe, expect, it } from 'vitest'
import { getRun, resumeHook, start } from 'workflow/api'
import { HookNotFoundError, WorkflowRunCancelledError } from 'workflow/errors'
import { getWorld } from 'workflow/runtime'
import { waitForHook, waitForSleep } from '@workflow/vitest'
import { VercelAgentWorkflowRunResult } from '@yolk-sdk/vercel-workflows'
import {
  VercelWorkflows,
  type VercelWorkflowsClient,
  type VercelWorkflowFunction
} from '@yolk-sdk/vercel-workflows/effect'
import {
  packageCancellableWorkflow,
  packageHitlDirectiveWorkflow,
  packageHookAnswersWorkflow,
  packageHookConflictWorkflow,
  packageHookOnceWorkflow,
  packageHookSameRunConflictWorkflow,
  packageHookTwoPausesWorkflow,
  packageOwnedDirectiveWorkflow,
  packageStreamHitlWorkflow,
  packageStreamWorkflow
} from './fixtures/workflow-fixture.ts'

const collectReadable = async (readable: ReadableStream<string>) => {
  const chunks: Array<string> = []
  const reader = readable.getReader()

  try {
    for (;;) {
      const result = await reader.read()

      if (result.done) {
        return chunks
      }

      chunks.push(result.value)
    }
  } finally {
    reader.releaseLock()
  }
}

const runWorkflows = <A, E>(effect: Effect.Effect<A, E, VercelWorkflows>) =>
  Effect.runPromise(effect.pipe(Effect.provide(VercelWorkflows.layer)))

const startWorkflow = <TArgs extends unknown[], TResult>(
  workflow: VercelWorkflowFunction<TArgs, TResult>,
  args: TArgs
) =>
  runWorkflows(
    Effect.gen(function* () {
      const workflows = yield* VercelWorkflows

      return yield* workflows.start(workflow, args)
    })
  )

const workflowsEffect = <A, E>(run: (api: VercelWorkflowsClient) => Effect.Effect<A, E>) =>
  runWorkflows(
    Effect.gen(function* () {
      const workflows = yield* VercelWorkflows

      return yield* run(workflows)
    })
  )

describe('package-owned workflow directives', () => {
  it('starts a workflow function using the package runtime contract', async () => {
    const run = await startWorkflow(packageOwnedDirectiveWorkflow, [
      { request: 'request-1', context: 'context-1' }
    ])

    expect(run.runId).toMatch(/^wrun_/)
    await expect(Effect.runPromise(run.returnValue)).resolves.toBe('workflow-complete')
    await expect(Effect.runPromise(run.status)).resolves.toBe('completed')
  })

  it('seeds start attributes on the created run', async () => {
    const run = await workflowsEffect(api =>
      api.start(
        packageOwnedDirectiveWorkflow,
        [{ request: 'request-attributes', context: 'context-attributes' }],
        { attributes: { sessionId: 'session-1', kind: 'chat' } }
      )
    )

    await Effect.runPromise(run.returnValue)
    const world = await getWorld()
    const stored = await world.runs.get(run.runId)

    expect(stored.attributes).toEqual({ sessionId: 'session-1', kind: 'chat' })
  })

  it('fails a start whose attributes the platform rejects', async () => {
    const failure = await workflowsEffect(api =>
      api
        .start(
          packageOwnedDirectiveWorkflow,
          [{ request: 'request-rejected', context: 'context-rejected' }],
          { attributes: { $reserved: 'x' } }
        )
        .pipe(Effect.flip)
    )

    expect(failure.operation).toBe('start')
    expect(failure.cause).toMatchObject({ name: 'FatalError' })
  })

  it('streams package-owned step output and resumes by run id', async () => {
    const run = await startWorkflow(packageStreamWorkflow, [])

    await expect(Effect.runPromise(run.returnValue)).resolves.toBe('stream-complete')

    await expect(
      Effect.runPromise(run.getReadable<string>()).then(collectReadable)
    ).resolves.toEqual(['first', 'second'])
    await expect(
      workflowsEffect(api => api.getReadable<string>(run.runId, { startIndex: 1 })).then(
        collectReadable
      )
    ).resolves.toEqual(['second'])
    await expect(workflowsEffect(api => api.tailIndex(run.runId))).resolves.toBe(1)
  })

  it('waits on package awaitInput hooks and resumes tool batch', async () => {
    const run = await startWorkflow(packageHitlDirectiveWorkflow, [
      { request: 'request-1', context: 'context-1' }
    ])

    const hook = await waitForHook(getRun(run.runId), { token: 'package-hitl-hook' })

    await workflowsEffect(api => api.resumeHook(hook.token, 'approved'))

    const result = await Effect.runPromise(run.returnValue)
    expect(VercelAgentWorkflowRunResult.$is('Completed')(result)).toBe(true)
    expect(result).toMatchObject({
      state: {
        messages: ['request-1', 'assistant-1', 'result-approval-tool-approved', 'assistant-2'],
        eventSequence: 9
      }
    })
    await expect(Effect.runPromise(run.status)).resolves.toBe('completed')
  })

  it('resumes HITL streams after the current tail index', async () => {
    const run = await startWorkflow(packageStreamHitlWorkflow, [])
    const hook = await waitForHook(getRun(run.runId), { token: 'package-stream-hitl-hook' })
    const tailIndex = await workflowsEffect(api => api.tailIndex(run.runId))

    expect(tailIndex).toBe(0)

    await workflowsEffect(api => api.resumeHook(hook.token, 'approved'))
    await expect(Effect.runPromise(run.returnValue)).resolves.toBe('approved')
    await expect(
      workflowsEffect(api =>
        api.getReadable<string>(run.runId, { startIndex: tailIndex + 1 })
      ).then(collectReadable)
    ).resolves.toEqual(['after-approved'])
  })

  // The platform side of `TestWorkflowWorld` hook answers (issues #304, #306).
  it('accepts every answer to a live hook, delivers the first, then answers HookNotFoundError', async () => {
    const token = `package-hook-answers:${crypto.randomUUID()}`
    const run = await start(packageHookAnswersWorkflow, [token])

    await waitForHook(run, { token })
    await resumeHook(token, 'first')
    const holding = await waitForSleep(run)

    // Read once, not yet disposed: the platform accepts the answer and never delivers it.
    await expect(resumeHook(token, 'second')).resolves.toMatchObject({ token })
    await run.wakeUp({ correlationIds: [holding] })

    // The run suspends on its second sleep only after it recorded the hook's disposal.
    const disposed = await waitForSleep(run)

    expect(disposed).not.toBe(holding)
    await expect(resumeHook(token, 'third')).rejects.toSatisfy(HookNotFoundError.is)
    await run.wakeUp({ correlationIds: [disposed] })
    await expect(run.returnValue).resolves.toBe('first')
  })

  it('delivers a late duplicate to the next pause that reuses the token', async () => {
    const token = `package-hook-two-pauses:${crypto.randomUUID()}`
    const run = await start(packageHookTwoPausesWorkflow, [token])

    await waitForHook(run, { token })
    await resumeHook(token, 'answer-for-pause-1')
    // Waits for the second pause's hook (the first one has received its payload).
    await waitForHook(run, { token })
    await resumeHook(token, 'answer-for-pause-1')

    await expect(run.returnValue).resolves.toEqual(['answer-for-pause-1', 'answer-for-pause-1'])
  })

  it('lets a later run reuse the token of an ended run', async () => {
    const token = `package-hook-once:${crypto.randomUUID()}`
    const first = await start(packageHookOnceWorkflow, [token])

    await waitForHook(first, { token })
    await resumeHook(token, 'run-1 answer')
    await expect(first.returnValue).resolves.toBe('run-1 answer')

    const second = await start(packageHookOnceWorkflow, [token])

    await waitForHook(second, { token })
    await resumeHook(token, 'run-2 answer')
    await expect(second.returnValue).resolves.toBe('run-2 answer')
  })

  // The platform side of `TestWorkflowWorld` hook token conflicts (issue #318).
  it("refuses a hook whose token another run's live hook holds", async () => {
    const token = `package-hook-conflict:${crypto.randomUUID()}`
    const holder = await start(packageHookOnceWorkflow, [token])

    await waitForHook(holder, { token })

    const refused = await start(packageHookConflictWorkflow, [token])

    // The platform's message goes on with a link to its docs.
    await expect(refused.returnValue).resolves.toMatch(
      `HookConflictError: Hook token "${token}" is already in use by another workflow (run "${holder.runId}")`
    )

    // The holder's hook is untouched, and its token is free again once its run ends.
    await resumeHook(token, 'holder answer')
    await expect(holder.returnValue).resolves.toBe('holder answer')

    const later = await start(packageHookConflictWorkflow, [token])

    await waitForHook(later, { token })
    await resumeHook(token, 'later answer')
    await expect(later.returnValue).resolves.toBe('answer: later answer')
  })

  it('refuses a second live hook of the same run with the same token', async () => {
    const token = `package-hook-same-run:${crypto.randomUUID()}`
    const run = await start(packageHookSameRunConflictWorkflow, [token])

    await waitForHook(run, { token })
    await resumeHook(token, 'first answer')

    await expect(run.returnValue).resolves.toEqual([
      expect.stringContaining(
        `HookConflictError: Hook token "${token}" is already in use by another workflow (run "${run.runId}")`
      ),
      'first answer'
    ])
  })

  it('cancels package-owned workflow runs', async () => {
    const run = await startWorkflow(packageCancellableWorkflow, [])

    await waitForSleep(getRun(run.runId))
    await workflowsEffect(api => api.cancel(run.runId))

    await expect(Effect.runPromise(run.status)).resolves.toBe('cancelled')
    await expect(Effect.runPromise(run.returnValue)).rejects.toSatisfy(error => {
      expect(Predicate.isTagged(error, 'VercelWorkflowsError')).toBe(true)
      expect(error).toMatchObject({ operation: 'returnValue' })

      return true
    })
    await expect(getRun(run.runId).returnValue).rejects.toSatisfy(WorkflowRunCancelledError.is)
  })
})
