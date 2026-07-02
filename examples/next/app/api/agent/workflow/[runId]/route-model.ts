import {
  workflowReadableResponse,
  workflowStreamResponse,
  type WorkflowReadableOptions,
  type WorkflowReadableRun
} from '../route-model'

export type WorkflowCancelableRun = WorkflowReadableRun & {
  readonly cancel: () => Promise<void>
}

export type WorkflowRunResolver = (runId: string) => WorkflowCancelableRun

export type WorkflowResumeStartIndexParseResult =
  | {
      readonly _tag: 'ValidStartIndex'
      readonly startIndex?: number
    }
  | {
      readonly _tag: 'InvalidStartIndex'
      readonly raw: string
    }

const routeUrlBase = 'http://yolk.local'
const nonnegativeSafeIntegerPattern = /^(0|[1-9]\d*)$/

export const workflowResumeStartIndexFromUrl = (
  url: string
): WorkflowResumeStartIndexParseResult => {
  const raw = new URL(url, routeUrlBase).searchParams.get('startIndex')

  if (raw === null) {
    return { _tag: 'ValidStartIndex' }
  }

  const value = raw.trim()

  if (!nonnegativeSafeIntegerPattern.test(value)) {
    return { _tag: 'InvalidStartIndex', raw }
  }

  const startIndex = Number.parseInt(value, 10)

  return Number.isSafeInteger(startIndex)
    ? { _tag: 'ValidStartIndex', startIndex }
    : { _tag: 'InvalidStartIndex', raw }
}

export const workflowResumeResponse = (
  runId: string,
  getRun: WorkflowRunResolver,
  options?: WorkflowReadableOptions & { readonly tailIndex?: number }
) => workflowStreamResponse(getRun(runId), options)

export const workflowResumeReadableResponse = (
  runId: string,
  readable: ReadableStream<Uint8Array>,
  options?: { readonly tailIndex?: number }
) => workflowReadableResponse(runId, readable, options?.tailIndex)

export const workflowResumeStartIndexAfterTail = (tailIndex: number | undefined) =>
  tailIndex === undefined ? undefined : tailIndex + 1

export const workflowCancelResponse = () => Response.json({ ok: true })
