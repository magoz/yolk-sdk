import { Predicate } from 'effect'
import type { AgentEvent, HitlResponse } from '@yolk-sdk/agent/protocol'

/**
 * Request id -> the pause that last asked for it: the `eventId` of the latest
 * `AgentAwaitingInput` holding that request. A Workflow HITL answer names this pause, because a
 * request id alone is ambiguous (a request pends again after an invalid answer, and providers
 * reuse tool call ids across turns).
 */
export type WorkflowHitlPauses = ReadonlyMap<string, string>

export const emptyWorkflowHitlPauses: WorkflowHitlPauses = new Map()

export const rememberWorkflowHitlPause = (
  pauses: WorkflowHitlPauses,
  event: AgentEvent
): WorkflowHitlPauses => {
  if (!Predicate.isTagged(event, 'AgentAwaitingInput') || event.eventId === undefined) return pauses

  const pauseId = event.eventId
  const next = new Map(pauses)

  for (const request of event.requests) next.set(request.requestId, pauseId)

  return next
}

/** The run endpoint for an answer, naming its pause (`?pause=`) when one is known. */
export const workflowHitlResponseEndpoint = (
  runId: string,
  pauses: WorkflowHitlPauses,
  response: HitlResponse
) => {
  const endpoint = `/api/agent/workflow/${encodeURIComponent(runId)}`
  const pauseId = pauses.get(response.requestId)

  return pauseId === undefined ? endpoint : `${endpoint}?pause=${encodeURIComponent(pauseId)}`
}
