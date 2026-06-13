import { describe, expect, it } from 'vitest'
import { getRun, resumeHook, start } from 'workflow/api'
import { WorkflowRunCancelledError } from 'workflow/errors'
import { waitForHook, waitForSleep } from '@workflow/vitest'
import {
  packageCancellableWorkflow,
  packageHitlDirectiveWorkflow,
  packageOwnedDirectiveWorkflow,
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

describe('package-owned workflow directives', () => {
  it('starts a workflow function using the package runtime contract', async () => {
    const run = await start(packageOwnedDirectiveWorkflow, [
      { request: 'request-1', context: 'context-1' }
    ])

    expect(run.runId).toMatch(/^wrun_/)
    await expect(run.returnValue).resolves.toBe('workflow-complete')
    await expect(run.status).resolves.toBe('completed')
  })

  it('streams package-owned step output and resumes by run id', async () => {
    const run = await start(packageStreamWorkflow)

    await expect(run.returnValue).resolves.toBe('stream-complete')

    await expect(collectReadable(run.getReadable<string>())).resolves.toEqual(['first', 'second'])
    await expect(collectReadable(getRun(run.runId).getReadable<string>({ startIndex: 1 }))).resolves.toEqual([
      'second'
    ])
  })

  it('waits on package awaitInput hooks and resumes tool batch', async () => {
    const run = await start(packageHitlDirectiveWorkflow, [
      { request: 'request-1', context: 'context-1' }
    ])
    const hook = await waitForHook(run, { token: 'package-hitl-hook' })

    await resumeHook(hook.token, 'approved')

    await expect(run.returnValue).resolves.toMatchObject({
      _tag: 'Completed',
      state: {
        messages: ['request-1', 'assistant-1', 'result-approval-tool-approved'],
        eventSequence: 9
      }
    })
    await expect(run.status).resolves.toBe('completed')
  })

  it('cancels package-owned workflow runs', async () => {
    const run = await start(packageCancellableWorkflow)

    await waitForSleep(run)
    await getRun(run.runId).cancel()

    await expect(run.status).resolves.toBe('cancelled')
    await expect(run.returnValue).rejects.toSatisfy(WorkflowRunCancelledError.is)
  })
})
