import { Data, Predicate } from 'effect'
import type {
  WorkflowHitlAnswerRefused,
  WorkflowHitlHookPending
} from '@/lib/services/agent-workflow/hitl-resume'
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

export type WorkflowResumeStartIndexParseResult = Data.TaggedEnum<{
  readonly ValidStartIndex: {
    readonly startIndex?: number
  }
  readonly InvalidStartIndex: {
    readonly raw: string
  }
}>

export const WorkflowResumeStartIndexParseResult =
  Data.taggedEnum<WorkflowResumeStartIndexParseResult>()

const routeUrlBase = 'http://yolk.local'

const nonnegativeSafeIntegerPattern = /^(0|[1-9]\d*)$/

export const workflowResumeStartIndexFromUrl = (
  url: string
): WorkflowResumeStartIndexParseResult => {
  const raw = new URL(url, routeUrlBase).searchParams.get('startIndex')

  if (raw === null) {
    return WorkflowResumeStartIndexParseResult.ValidStartIndex({})
  }

  const value = raw.trim()

  if (!nonnegativeSafeIntegerPattern.test(value)) {
    return WorkflowResumeStartIndexParseResult.InvalidStartIndex({ raw })
  }

  const startIndex = Number.parseInt(value, 10)

  return Number.isSafeInteger(startIndex)
    ? WorkflowResumeStartIndexParseResult.ValidStartIndex({ startIndex })
    : WorkflowResumeStartIndexParseResult.InvalidStartIndex({ raw })
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

/**
 * 409: no pause takes this answer (a different answer to the pause, or no pending request
 * matches); retrying it cannot succeed. 503: the answer is recorded but the pause's hook never
 * opened in time; retrying the same answer is safe.
 */
export const workflowHitlResumeErrorResponse = (
  error: WorkflowHitlAnswerRefused | WorkflowHitlHookPending
) =>
  Response.json(
    { error: error.message },
    { status: Predicate.isTagged(error, 'WorkflowHitlAnswerRefused') ? 409 : 503 }
  )
