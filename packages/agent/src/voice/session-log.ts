import * as Schema from 'effect/Schema'
import { ToolCall, ToolResultMessage, type AgentMessage } from '@yolk-sdk/agent/protocol'
import { projectVoiceEvent, StoredVoiceEvent, type VoiceProjectionState } from './projection.ts'
import {
  VoiceToolCallCompleted,
  VoiceToolCallFailed,
  VoiceToolCallsRequested,
  type VoiceToolCall,
  type VoiceToolCallOutcome
} from './protocol.ts'

// --- Server-side session log state -----------------------------------------

export const VOICE_SESSION_LOG_STATE_VERSION = 1

export class VoiceAssistantDraftState extends Schema.Class<VoiceAssistantDraftState>(
  'VoiceAssistantDraftState'
)({
  key: Schema.NullOr(Schema.String),
  text: Schema.String
}) {}

/**
 * Versioned, serializable voice session log state. Hosts persist it between
 * event batches (for example on a session row) and rehydrate through the
 * schema, so folding never has to replay the whole log; bump the version on
 * breaking shape changes so stale persisted state is rejected at decode
 * instead of mis-folding.
 *
 * `seenEventIds` grows with the session; voice sessions are short-lived, so
 * v1 keeps the full set for exact at-least-once dedupe.
 */
export class VoiceSessionLogState extends Schema.Class<VoiceSessionLogState>(
  'VoiceSessionLogState'
)({
  version: Schema.Literal(VOICE_SESSION_LOG_STATE_VERSION),
  seenEventIds: Schema.Array(Schema.String),
  assistantDrafts: Schema.Array(VoiceAssistantDraftState),
  finalizedKeys: Schema.Array(Schema.String),
  turnToolCalls: Schema.Array(ToolCall),
  turnToolResults: Schema.Array(ToolResultMessage)
}) {}

export const emptyVoiceSessionLogState: VoiceSessionLogState = VoiceSessionLogState.make({
  version: VOICE_SESSION_LOG_STATE_VERSION,
  seenEventIds: [],
  assistantDrafts: [],
  finalizedKeys: [],
  turnToolCalls: [],
  turnToolResults: []
})

export type VoiceSessionLogFoldResult = {
  readonly state: VoiceSessionLogState
  /** Durable messages produced by this batch, in append order. */
  readonly messages: ReadonlyArray<AgentMessage>
}

const projectionStateFromLog = (state: VoiceSessionLogState): VoiceProjectionState => ({
  assistantDrafts: state.assistantDrafts,
  finalizedKeys: state.finalizedKeys,
  turnToolCalls: state.turnToolCalls,
  turnToolResults: state.turnToolResults
})

/**
 * Fold a batch of stored voice events into the durable session log state.
 *
 * Pure and replay-safe: events whose `eventId` was already folded are
 * skipped, so at-least-once client delivery and dual client/server logging
 * of tool events (see `voiceToolEventId`) stay idempotent. Hosts run this
 * inside their storage transaction and append the returned messages to the
 * durable transcript; item ordering follows the event order within the
 * batch, which outboxes emit in sequence order.
 */
export const foldStoredVoiceEvents = (
  state: VoiceSessionLogState,
  events: ReadonlyArray<StoredVoiceEvent>
): VoiceSessionLogFoldResult => {
  const seen = new Set(state.seenEventIds)
  let projection = projectionStateFromLog(state)
  const messages: Array<AgentMessage> = []

  for (const stored of events) {
    if (seen.has(stored.eventId)) {
      continue
    }

    seen.add(stored.eventId)
    const result = projectVoiceEvent(projection, stored.event)
    projection = result.state
    messages.push(...result.messages)
  }

  return {
    state: VoiceSessionLogState.make({
      version: VOICE_SESSION_LOG_STATE_VERSION,
      seenEventIds: [...seen],
      assistantDrafts: projection.assistantDrafts.map(draft =>
        VoiceAssistantDraftState.make({ key: draft.key, text: draft.text })
      ),
      finalizedKeys: projection.finalizedKeys,
      turnToolCalls: projection.turnToolCalls,
      turnToolResults: projection.turnToolResults
    }),
    messages
  }
}

// --- Deterministic tool event identity ---------------------------------------

export type VoiceToolEventPhase = 'requested' | 'completed' | 'failed'

/**
 * Deterministic event id for tool lifecycle events, keyed by provider
 * `callId` instead of a stream sequence. Client outbox replays and
 * server-witnessed tool logging (from the host tool endpoint) then dedupe
 * against each other in `foldStoredVoiceEvents`, so the same call is never
 * folded twice regardless of which side records it first.
 */
export const voiceToolEventId = (callId: string, phase: VoiceToolEventPhase) =>
  `tool:${callId}:${phase}`

/**
 * Store a tool lifecycle event under deterministic per-call ids. Batched
 * `ToolCallsRequested` events split into one stored event per call so
 * client-observed batches and server-observed single calls produce
 * identical log entries.
 */
export const storedVoiceToolEvents = (
  event: VoiceToolCallsRequested | VoiceToolCallCompleted | VoiceToolCallFailed
): ReadonlyArray<StoredVoiceEvent> => {
  switch (event._tag) {
    case 'ToolCallsRequested':
      return event.calls.map(call =>
        StoredVoiceEvent.make({
          eventId: voiceToolEventId(call.callId, 'requested'),
          event: VoiceToolCallsRequested.make({ calls: [call] })
        })
      )
    case 'ToolCallCompleted':
      return [
        StoredVoiceEvent.make({ eventId: voiceToolEventId(event.callId, 'completed'), event })
      ]
    case 'ToolCallFailed':
      return [StoredVoiceEvent.make({ eventId: voiceToolEventId(event.callId, 'failed'), event })]
  }
}

/** Matches the controller's model-visible denial message for consistent logs. */
const deniedMessage = (reason: string | undefined) =>
  reason === undefined ? 'Tool was denied.' : `Tool was denied: ${reason}`

/**
 * Server-witnessed tool log entries for one executed tool endpoint call.
 * Hosts append these from the tool route so tool activity is recorded by the
 * server that ran it, not only by the client's replay; deterministic ids make
 * the duplicate side a no-op. `ApprovalRequired` records only the request —
 * the settled outcome is logged by the resumed call.
 */
export const storedToolEventsFromOutcome = (input: {
  readonly call: VoiceToolCall
  readonly outcome: VoiceToolCallOutcome
}): ReadonlyArray<StoredVoiceEvent> => {
  const requested = StoredVoiceEvent.make({
    eventId: voiceToolEventId(input.call.callId, 'requested'),
    event: VoiceToolCallsRequested.make({ calls: [input.call] })
  })

  switch (input.outcome._tag) {
    case 'Executed':
      return [
        requested,
        StoredVoiceEvent.make({
          eventId: voiceToolEventId(input.call.callId, 'completed'),
          event: VoiceToolCallCompleted.make({
            callId: input.call.callId,
            output: input.outcome.output
          })
        })
      ]
    case 'Denied':
      return [
        requested,
        StoredVoiceEvent.make({
          eventId: voiceToolEventId(input.call.callId, 'failed'),
          event: VoiceToolCallFailed.make({
            callId: input.call.callId,
            message: deniedMessage(input.outcome.reason)
          })
        })
      ]
    case 'ApprovalRequired':
      return [requested]
  }
}
