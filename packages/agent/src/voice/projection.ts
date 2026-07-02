import { Option } from 'effect'
import * as Schema from 'effect/Schema'
import {
  AssistantAgentMessage,
  AssistantTextPart,
  assistantContent,
  contentPreview,
  HostToolCallPart,
  ToolCall,
  ToolResultMessage,
  UserMessage,
  type AgentMessage
} from '@yolk-sdk/agent/protocol'
import { VoiceEvent, type VoiceToolCall } from './protocol.ts'

/**
 * Pure projection state for turning a voice event stream into protocol
 * messages. Assistant text accumulates as a draft; tool call/result pairs
 * accumulate per turn and flush together with the assistant transcript so
 * projected transcripts never contain dangling host tool calls.
 */
export type VoiceProjectionState = {
  readonly assistantDraft: string
  /** Tool calls of the current turn, in provider order. */
  readonly turnToolCalls: ReadonlyArray<ToolCall>
  /** One result message per settled tool call of the current turn. */
  readonly turnToolResults: ReadonlyArray<ToolResultMessage>
}

export type VoiceProjectionResult = {
  readonly state: VoiceProjectionState
  /** Durable messages produced by this event, in append order. */
  readonly messages: ReadonlyArray<AgentMessage>
}

export const emptyVoiceProjectionState: VoiceProjectionState = {
  assistantDraft: '',
  turnToolCalls: [],
  turnToolResults: []
}

const decodeParamsOption = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)

const toolCallParams = (argumentsJson: string): unknown =>
  Option.getOrElse(decodeParamsOption(argumentsJson), () => argumentsJson)

export const protocolToolCallFromVoice = (call: VoiceToolCall): ToolCall =>
  ToolCall.make({
    id: call.callId,
    name: call.name,
    params: toolCallParams(call.argumentsJson)
  })

const settledToolMessages = (state: VoiceProjectionState): ReadonlyArray<AgentMessage> => {
  const settledIds = new Set(state.turnToolResults.map(result => result.toolCallId))
  const settledCalls = state.turnToolCalls.filter(call => settledIds.has(call.id))

  if (settledCalls.length === 0) {
    return []
  }

  const orderedResults = settledCalls.flatMap(call => {
    const result = state.turnToolResults.find(entry => entry.toolCallId === call.id)

    return result === undefined ? [] : [result]
  })

  return [
    AssistantAgentMessage.make({
      parts: [
        AssistantTextPart.make({ content: '' }),
        ...settledCalls.map(call => HostToolCallPart.make({ call }))
      ]
    }),
    ...orderedResults
  ]
}

const flushTurn = (
  state: VoiceProjectionState,
  transcript: string | null
): VoiceProjectionResult => {
  const text = transcript ?? state.assistantDraft
  const toolMessages = settledToolMessages(state)
  const messages =
    text.trim().length === 0
      ? toolMessages
      : [
          ...toolMessages,
          AssistantAgentMessage.make({ parts: [AssistantTextPart.make({ content: text })] })
        ]

  return { state: emptyVoiceProjectionState, messages }
}

/**
 * Project one voice event into durable protocol messages.
 *
 * - `UserTranscriptFinal` becomes a `UserMessage`.
 * - `AssistantTranscriptFinal` flushes the turn: settled tool call/result
 *   pairs first, then the assistant text message.
 * - `Interrupted` and `SessionClosed` flush partial drafts so nothing is
 *   lost and no dangling host tool calls are produced.
 * - Deltas and lifecycle events only update state.
 *
 * Unsettled tool calls (for example approvals still pending when the session
 * ends) are intentionally dropped from the durable transcript; pending HITL
 * requests live in the host session log, not the message transcript.
 */
export const projectVoiceEvent = (
  state: VoiceProjectionState,
  event: VoiceEvent
): VoiceProjectionResult => {
  switch (event._tag) {
    case 'UserTranscriptFinal':
      return { state, messages: [UserMessage.make({ content: event.text })] }
    case 'AssistantTranscriptDelta':
      return {
        state: { ...state, assistantDraft: `${state.assistantDraft}${event.delta}` },
        messages: []
      }
    case 'AssistantTranscriptFinal':
      return flushTurn(state, event.text)
    case 'Interrupted':
    case 'SessionClosed':
      return flushTurn(state, null)
    case 'ToolCallsRequested':
      return {
        state: {
          ...state,
          turnToolCalls: [
            ...state.turnToolCalls,
            ...event.calls.map(call => protocolToolCallFromVoice(call))
          ]
        },
        messages: []
      }
    case 'ToolCallCompleted':
      return {
        state: {
          ...state,
          turnToolResults: [
            ...state.turnToolResults,
            ToolResultMessage.make({ toolCallId: event.callId, content: event.output })
          ]
        },
        messages: []
      }
    case 'ToolCallFailed':
      return {
        state: {
          ...state,
          turnToolResults: [
            ...state.turnToolResults,
            ToolResultMessage.make({
              toolCallId: event.callId,
              content: event.message,
              isError: true
            })
          ]
        },
        messages: []
      }
    case 'SessionOpening':
    case 'SessionOpened':
    case 'AudioInputStarted':
    case 'AudioInputStopped':
    case 'UserTranscriptDelta':
    case 'AssistantAudioStarted':
    case 'AssistantAudioStopped':
    case 'ToolCallExecuting':
    case 'AwaitingInput':
    case 'Error':
      return { state, messages: [] }
  }
}

// --- Reconnect seeding -------------------------------------------------------

export type VoiceSeedText = {
  readonly role: 'user' | 'assistant'
  readonly text: string
}

/**
 * Map a replayed protocol transcript into text seeds for a new provider
 * session. Tool results are omitted; assistant messages seed their visible
 * text only. Reconnect never resumes a provider session: hosts replay these
 * seeds through the controller before the first user turn.
 */
export const voiceSeedTextsFromMessages = (
  messages: ReadonlyArray<AgentMessage>
): ReadonlyArray<VoiceSeedText> =>
  messages.flatMap((message): ReadonlyArray<VoiceSeedText> => {
    switch (message._tag) {
      case 'User': {
        const text = contentPreview(message.content)

        return text.length === 0 ? [] : [{ role: 'user' as const, text }]
      }
      case 'Assistant': {
        const text = contentPreview(assistantContent(message))

        return text.length === 0 ? [] : [{ role: 'assistant' as const, text }]
      }
      case 'ToolResult':
        return []
    }
  })

// --- Durable event ids -------------------------------------------------------

/**
 * Replay-safe durable envelope for voice events. Hosts append these to their
 * session log; clients de-dupe replays by `eventId`, matching text runtime
 * durable stream rules.
 */
export class StoredVoiceEvent extends Schema.Class<StoredVoiceEvent>('StoredVoiceEvent')({
  eventId: Schema.String,
  event: VoiceEvent
}) {}

export const makeVoiceEventId = (streamId: string, sequence: number) => `${streamId}:${sequence}`

export type VoiceEventSequencerState = {
  readonly nextSequence: number
}

export const initialVoiceEventSequencerState: VoiceEventSequencerState = { nextSequence: 0 }

export const sequenceVoiceEvent = (
  streamId: string,
  state: VoiceEventSequencerState,
  event: VoiceEvent
): { readonly stored: StoredVoiceEvent; readonly state: VoiceEventSequencerState } => ({
  stored: StoredVoiceEvent.make({
    eventId: makeVoiceEventId(streamId, state.nextSequence),
    event
  }),
  state: { nextSequence: state.nextSequence + 1 }
})

/** De-dupe replayed stored voice events by `eventId`. */
export const dedupeStoredVoiceEvents = (
  events: ReadonlyArray<StoredVoiceEvent>
): ReadonlyArray<StoredVoiceEvent> => {
  const seen = new Set<string>()

  return events.filter(stored => {
    if (seen.has(stored.eventId)) {
      return false
    }

    seen.add(stored.eventId)

    return true
  })
}
