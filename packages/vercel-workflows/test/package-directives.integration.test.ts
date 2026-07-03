import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { getRun } from 'workflow/api'
import { WorkflowRunCancelledError } from 'workflow/errors'
import { waitForHook, waitForSleep } from '@workflow/vitest'
import {
  VercelWorkflows,
  type VercelWorkflowsClient,
  type VercelWorkflowFunction
} from '@yolk-sdk/vercel-workflows/effect'
import {
  packageCancellableWorkflow,
  packageHitlDirectiveWorkflow,
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

    await expect(Effect.runPromise(run.returnValue)).resolves.toMatchObject({
      _tag: 'Completed',
      state: {
        messages: ['request-1', 'assistant-1', 'result-approval-tool-approved'],
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

  it('cancels package-owned workflow runs', async () => {
    const run = await startWorkflow(packageCancellableWorkflow, [])

    await waitForSleep(getRun(run.runId))
    await workflowsEffect(api => api.cancel(run.runId))

    await expect(Effect.runPromise(run.status)).resolves.toBe('cancelled')
    await expect(Effect.runPromise(run.returnValue)).rejects.toMatchObject({
      _tag: 'VercelWorkflowsError',
      operation: 'returnValue'
    })
    await expect(getRun(run.runId).returnValue).rejects.toSatisfy(WorkflowRunCancelledError.is)
  })
})
