import { describe, expect, it } from '@effect/vitest'
import {
  workflowCancelResponse,
  workflowResumeResponse,
  workflowResumeStartIndexFromUrl,
  workflowResumeStartIndexAfterTail,
  type WorkflowCancelableRun,
  type WorkflowRunResolver
} from './route-model'
import type { WorkflowReadableOptions } from '../route-model'

const encoder = new TextEncoder()

const makeRun = (input: {
  readonly runId: string
  readonly text: string
  readonly onCancel: () => void
  readonly onReadable?: (options: WorkflowReadableOptions | undefined) => void
}): WorkflowCancelableRun => ({
  runId: input.runId,
  getReadable: options => {
    input.onReadable?.(options)

    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(input.text))
        controller.close()
      }
    })
  },
  cancel: async () => {
    input.onCancel()
  }
})

const makeNoopRun = (runId: string, text: string) =>
  makeRun({ runId, text, onCancel: () => undefined })

describe('Workflow run route model', () => {
  it('resumes a run stream by id', async () => {
    const getRun: WorkflowRunResolver = runId => makeNoopRun(runId, 'resume\n')
    const response = workflowResumeResponse('wrun_123', getRun)

    expect(response.status).toBe(200)
    expect(response.headers.get('x-workflow-run-id')).toBe('wrun_123')
    await expect(response.text()).resolves.toBe('resume\n')
  })

  it('resumes HITL streams after the previous tail index', async () => {
    const readableOptions: Array<WorkflowReadableOptions | undefined> = []
    const getRun: WorkflowRunResolver = runId =>
      makeRun({
        runId,
        text: 'resume\n',
        onCancel: () => undefined,
        onReadable: options => readableOptions.push(options)
      })
    const response = workflowResumeResponse('wrun_123', getRun, {
      startIndex: workflowResumeStartIndexAfterTail(3),
      tailIndex: 3
    })

    expect(response.headers.get('x-workflow-stream-tail-index')).toBe('3')
    expect(readableOptions).toEqual([{ startIndex: 4 }])
    await expect(response.text()).resolves.toBe('resume\n')
  })

  it('starts empty HITL streams from index zero', () => {
    expect(workflowResumeStartIndexAfterTail(-1)).toBe(0)
    expect(workflowResumeStartIndexAfterTail(undefined)).toBeUndefined()
  })

  it('parses only nonnegative safe start indexes', () => {
    expect(workflowResumeStartIndexFromUrl('https://example.test/run')).toEqual({
      _tag: 'ValidStartIndex'
    })
    expect(workflowResumeStartIndexFromUrl('/run?startIndex=0')).toEqual({
      _tag: 'ValidStartIndex',
      startIndex: 0
    })
    expect(workflowResumeStartIndexFromUrl('/run?startIndex=42')).toEqual({
      _tag: 'ValidStartIndex',
      startIndex: 42
    })
    expect(workflowResumeStartIndexFromUrl('/run?startIndex=-1')).toEqual({
      _tag: 'InvalidStartIndex',
      raw: '-1'
    })
    expect(workflowResumeStartIndexFromUrl('/run?startIndex=1x')).toEqual({
      _tag: 'InvalidStartIndex',
      raw: '1x'
    })
    expect(workflowResumeStartIndexFromUrl('/run?startIndex=1.5')).toEqual({
      _tag: 'InvalidStartIndex',
      raw: '1.5'
    })
    expect(workflowResumeStartIndexFromUrl('/run?startIndex=9007199254740992')).toEqual({
      _tag: 'InvalidStartIndex',
      raw: '9007199254740992'
    })
  })

  it('cancels a run by id', async () => {
    const cancelledRuns: Array<string> = []
    const getRun: WorkflowRunResolver = runId =>
      makeRun({
        runId,
        text: '',
        onCancel: () => {
          cancelledRuns.push(runId)
        }
      })

    const response = await workflowCancelResponse('wrun_123', getRun)

    expect(cancelledRuns).toEqual(['wrun_123'])
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
  })
})
