import { describe, expect, it } from '@effect/vitest'
import { workflowNdjsonHeaders, workflowStreamResponse, type WorkflowReadableRun } from './route-model'

const encoder = new TextEncoder()

const readResponseText = (response: Response) => response.text()

const makeRun = (runId: string, text: string): WorkflowReadableRun => ({
  runId,
  getReadable: () =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(text))
        controller.close()
      }
    })
})

describe('Workflow route model', () => {
  it('sets NDJSON headers with workflow run id', () => {
    expect(workflowNdjsonHeaders('wrun_123')).toEqual({
      'cache-control': 'no-cache, no-transform',
      'content-type': 'application/x-ndjson; charset=utf-8',
      'x-content-type-options': 'nosniff',
      'x-workflow-run-id': 'wrun_123'
    })
  })

  it('returns run stream with workflow headers', async () => {
    const response = workflowStreamResponse(makeRun('wrun_123', 'event\n'))

    expect(response.status).toBe(200)
    expect(response.headers.get('x-workflow-run-id')).toBe('wrun_123')
    expect(response.headers.get('content-type')).toBe('application/x-ndjson; charset=utf-8')
    await expect(readResponseText(response)).resolves.toBe('event\n')
  })
})
