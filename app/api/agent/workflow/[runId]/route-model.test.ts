import { describe, expect, it } from '@effect/vitest'
import {
  workflowCancelResponse,
  workflowResumeResponse,
  type WorkflowCancelableRun,
  type WorkflowRunResolver
} from './route-model'

const encoder = new TextEncoder()

const makeRun = (runId: string, text: string, onCancel: () => void): WorkflowCancelableRun => ({
  runId,
  getReadable: () =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(text))
        controller.close()
      }
    }),
  cancel: async () => {
    onCancel()
  }
})

describe('Workflow run route model', () => {
  it('resumes a run stream by id', async () => {
    const getRun: WorkflowRunResolver = runId => makeRun(runId, 'resume\n', () => undefined)
    const response = workflowResumeResponse('wrun_123', getRun)

    expect(response.status).toBe(200)
    expect(response.headers.get('x-workflow-run-id')).toBe('wrun_123')
    await expect(response.text()).resolves.toBe('resume\n')
  })

  it('cancels a run by id', async () => {
    const cancelledRuns: Array<string> = []
    const getRun: WorkflowRunResolver = runId =>
      makeRun(runId, '', () => {
        cancelledRuns.push(runId)
      })

    const response = await workflowCancelResponse('wrun_123', getRun)

    expect(cancelledRuns).toEqual(['wrun_123'])
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
  })
})
