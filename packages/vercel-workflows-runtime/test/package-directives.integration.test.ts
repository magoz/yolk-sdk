import { describe, expect, it } from 'vitest'
import { start } from 'workflow/api'
import { packageOwnedDirectiveWorkflow } from '../src/workflow-fixture.ts'

describe('package-owned workflow directives', () => {
  it('starts a workflow function exported from the package source', async () => {
    const run = await start(packageOwnedDirectiveWorkflow, [
      { request: 'request-1', context: 'context-1' }
    ])

    expect(run.runId).toMatch(/^wrun_/)
    await expect(run.returnValue).resolves.toBe('workflow-complete')
    await expect(run.status).resolves.toBe('completed')
  })
})
