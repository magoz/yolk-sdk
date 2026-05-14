import { describe, expect, it } from 'vitest'
import { getRun, start } from 'workflow/api'
import { WorkflowRunCancelledError } from 'workflow/errors'
import { waitForSleep } from '@workflow/vitest'
import {
  packageCancellableWorkflow,
  packageOwnedDirectiveWorkflow,
  packageStreamWorkflow
} from '../src/workflow-fixture.ts'

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
  it('starts a workflow function exported from the package source', async () => {
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

  it('cancels package-owned workflow runs', async () => {
    const run = await start(packageCancellableWorkflow)

    await waitForSleep(run)
    await getRun(run.runId).cancel()

    await expect(run.status).resolves.toBe('cancelled')
    await expect(run.returnValue).rejects.toSatisfy(WorkflowRunCancelledError.is)
  })
})
