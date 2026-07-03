import {
  VoiceAssistantTranscriptDelta,
  VoiceAssistantTranscriptFinal,
  VoiceErrorEvent,
  VoiceInterrupted,
  VoiceSessionOpened,
  VoiceToolCall,
  VoiceToolCallsRequested,
  VoiceUserTranscriptDelta,
  VoiceUserTranscriptFinal,
  type VoiceEvent
} from '@yolk-sdk/agent/voice'
import type { OpenAiRealtimeServerEvent } from './events.ts'

/**
 * Map a decoded OpenAI Realtime server event into provider-neutral
 * `VoiceEvent`s. `Ignored` and neutral lifecycle events map to an empty
 * array; a single provider event may expand into multiple voice events
 * (parallel function calls).
 */
export const openAiRealtimeServerEventToVoiceEvents = (
  event: OpenAiRealtimeServerEvent
): ReadonlyArray<VoiceEvent> => {
  switch (event._tag) {
    case 'InputAudioTranscriptionDelta':
      return [VoiceUserTranscriptDelta.make({ itemId: event.itemId, delta: event.delta })]
    case 'InputAudioTranscriptionCompleted':
      return [VoiceUserTranscriptFinal.make({ itemId: event.itemId, text: event.transcript })]
    case 'OutputAudioTranscriptDelta':
      return [
        VoiceAssistantTranscriptDelta.make({
          itemId: event.itemId,
          responseId: event.responseId,
          delta: event.delta
        })
      ]
    case 'OutputAudioTranscriptDone':
      return [
        VoiceAssistantTranscriptFinal.make({
          itemId: event.itemId,
          responseId: event.responseId,
          text: event.transcript
        })
      ]
    case 'SessionConfigured':
      return [
        VoiceSessionOpened.make({
          model: event.model,
          transcriptionModel: event.transcriptionModel,
          transcriptionLanguage: event.transcriptionLanguage
        })
      ]
    case 'ResponseDone':
      return event.status === 'cancelled'
        ? [VoiceInterrupted.make({ responseId: event.responseId })]
        : []
    case 'FunctionCalls': {
      const [first, ...rest] = event.calls.map(call =>
        VoiceToolCall.make({
          callId: call.callId,
          name: call.name,
          argumentsJson: call.argumentsJson
        })
      )

      return first === undefined ? [] : [VoiceToolCallsRequested.make({ calls: [first, ...rest] })]
    }
    case 'Error':
      return [VoiceErrorEvent.make({ code: 'provider_error', message: event.message })]
    case 'Ignored':
      return []
  }
}
