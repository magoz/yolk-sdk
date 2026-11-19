import { Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import type { AgentEvent, HitlResponse } from '@yolk-sdk/agent/protocol'

/**
 * Request id -> the pause that last asked for it: the `eventId` of the latest
 * `AgentAwaitingInput` holding that request. A durable HITL answer names this pause, because a
 * request id alone is ambiguous: a request pends again under the same id after an invalid answer,
 * and providers reuse tool call ids across turns. Persist it with `Schema.toCodecJson(HitlPauses)`
 * if you keep it across page loads.
 */
export const HitlPauses = Schema.ReadonlyMap(Schema.String, Schema.String)

export type HitlPauses = typeof HitlPauses.Type

export const emptyHitlPauses: HitlPauses = new Map()

/**
 * Records the pause an `AgentAwaitingInput` names for each request it holds; every other event
 * returns `pauses` unchanged. Feed it every event of every stream that reads the run (start, HITL
 * resume, replay), in stream order: the latest pause wins per request. Feed pauses you already saw
 * too (never skip them by `eventId`): a replay from an earlier index re-applies the later pauses
 * after the earlier ones, so it ends at the latest. A pause without an
 * `eventId` names nothing, so its requests forget the earlier pause that held them (an answer then
 * names no pause instead of a stale one).
 */
export const rememberHitlPause = (pauses: HitlPauses, event: AgentEvent): HitlPauses => {
  if (!Predicate.isTagged(event, 'AgentAwaitingInput')) return pauses

  const pauseId = event.eventId

  const changed = event.requests.some(request =>
    pauseId === undefined
      ? pauses.has(request.requestId)
      : pauses.get(request.requestId) !== pauseId
  )

  if (!changed) return pauses

  const next = new Map(pauses)

  for (const request of event.requests) {
    if (pauseId === undefined) next.delete(request.requestId)
    else next.set(request.requestId, pauseId)
  }

  return next
}

/** The pause an answer names: the latest one that asked for its request, if any is known. */
export const hitlPauseFor = (pauses: HitlPauses, response: HitlResponse): string | undefined =>
  pauses.get(response.requestId)
