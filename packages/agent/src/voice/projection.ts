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

export type VoiceAssistantDraft = {
  readonly responseId: string | null
  readonly text: string
}

/**
 * Pure projection state for turning a voice event stream into protocol
 * messages. Assistant text accumulates as per-response drafts so overlapping
 * or back-to-back provider responses never concatenate into one message;
 * tool call/result pairs accumulate per turn and flush together with the
 * assistant transcript so projected transcripts never contain dangling host
 * tool calls.
 */
export type VoiceProjectionState = {
  /** Open assistant drafts keyed by provider response id, in arrival order. */
  readonly assistantDrafts: ReadonlyArray<VoiceAssistantDraft>
  /**
   * Response ids already flushed. Providers can emit multiple final
   * transcript event families (legacy + current names) for one response;
   * replays of a finalized id project no messages.
   */
  readonly finalizedResponseIds: ReadonlyArray<string>
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
  assistantDrafts: [],
  finalizedResponseIds: [],
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

const assistantTextMessages = (texts: ReadonlyArray<string>): ReadonlyArray<AgentMessage> =>
  texts.flatMap(text =>
    text.trim().length === 0
      ? []
      : [AssistantAgentMessage.make({ parts: [AssistantTextPart.make({ content: text })] })]
  )

const markFinalized = (
  finalizedResponseIds: ReadonlyArray<string>,
  drafts: ReadonlyArray<VoiceAssistantDraft>
): ReadonlyArray<string> => [
  ...finalizedResponseIds,
  ...drafts.flatMap(draft => (draft.responseId === null ? [] : [draft.responseId]))
]

const isFinalized = (state: VoiceProjectionState, responseId: string | null) =>
  responseId !== null && state.finalizedResponseIds.includes(responseId)

/** Flush every open draft plus settled tool pairs; ends the turn. */
const flushAllDrafts = (state: VoiceProjectionState): VoiceProjectionResult => ({
  state: {
    ...emptyVoiceProjectionState,
    finalizedResponseIds: markFinalized(state.finalizedResponseIds, state.assistantDrafts)
  },
  messages: [
    ...settledToolMessages(state),
    ...assistantTextMessages(state.assistantDrafts.map(draft => draft.text))
  ]
})

/** Flush one response's transcript plus settled tool pairs; keeps other drafts open. */
const flushResponse = (
  state: VoiceProjectionState,
  responseId: string | null,
  transcript: string | null
): VoiceProjectionResult => {
  const draft = state.assistantDrafts.find(entry => entry.responseId === responseId)
  const remainingDrafts = state.assistantDrafts.filter(entry => entry.responseId !== responseId)
  const text = transcript ?? draft?.text ?? ''

  return {
    state: {
      assistantDrafts: remainingDrafts,
      finalizedResponseIds:
        responseId === null
          ? state.finalizedResponseIds
          : [...state.finalizedResponseIds, responseId],
      turnToolCalls: [],
      turnToolResults: []
    },
    messages: [...settledToolMessages(state), ...assistantTextMessages([text])]
  }
}

/**
 * Deltas for a new response id close every other open draft first: the
 * previous response is complete from the transcript's perspective even if its
 * final event has not arrived (or never arrives). Flushed ids are marked
 * finalized so their late final events project nothing.
 */
const appendDraftDelta = (
  state: VoiceProjectionState,
  responseId: string | null,
  delta: string
): VoiceProjectionResult => {
  const otherDrafts = state.assistantDrafts.filter(entry => entry.responseId !== responseId)
  const currentDraft = state.assistantDrafts.find(entry => entry.responseId === responseId)

  return {
    state: {
      ...state,
      assistantDrafts: [{ responseId, text: `${currentDraft?.text ?? ''}${delta}` }],
      finalizedResponseIds: markFinalized(state.finalizedResponseIds, otherDrafts)
    },
    messages: assistantTextMessages(otherDrafts.map(draft => draft.text))
  }
}

/**
 * Project one voice event into durable protocol messages.
 *
 * - `UserTranscriptFinal` becomes a `UserMessage`.
 * - `AssistantTranscriptDelta` accumulates per response id; a delta for a new
 *   response id flushes the previous response's draft first so back-to-back
 *   responses never concatenate into one message.
 * - `AssistantTranscriptFinal` flushes its response: settled tool call/result
 *   pairs first, then the assistant text message. Finals for already-flushed
 *   response ids project nothing (providers can emit duplicate final event
 *   families for one response).
 * - `Interrupted` and `SessionClosed` flush all partial drafts so nothing is
 *   lost and no dangling host tool calls are produced.
 * - Other lifecycle events only update state.
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
      return isFinalized(state, event.responseId)
        ? { state, messages: [] }
        : appendDraftDelta(state, event.responseId, event.delta)
    case 'AssistantTranscriptFinal':
      return isFinalized(state, event.responseId)
        ? { state, messages: [] }
        : flushResponse(state, event.responseId, event.text)
    case 'Interrupted':
    case 'SessionClosed':
      return flushAllDrafts(state)
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
