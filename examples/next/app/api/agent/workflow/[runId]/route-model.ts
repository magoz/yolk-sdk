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
 * The pause a HITL answer names (`?pause=`): the `eventId` of the `AgentAwaitingInput` it answers.
 * Undefined when absent or blank; the resume refuses such an answer.
 */
export const workflowHitlPauseFromUrl = (url: string) => {
  const pause = new URL(url, routeUrlBase).searchParams.get('pause')?.trim()

  return pause === undefined || pause === '' ? undefined : pause
}

/**
 * 409: the named pause does not take this answer (it already holds another, does not hold the
 * request, is unknown or evicted, or no pause was named). Re-posting it for the same pause cannot
 * succeed; an answer to the request's later pause (once that `AgentAwaitingInput` arrives) can.
 * 503: the answer is recorded but the pause's hook never opened in time; retrying it is safe.
 */
export const workflowHitlResumeErrorResponse = (
  error: WorkflowHitlAnswerRefused | WorkflowHitlHookPending
) =>
  Response.json(
    { error: error.message },
    { status: Predicate.isTagged(error, 'WorkflowHitlAnswerRefused') ? 409 : 503 }
  )
