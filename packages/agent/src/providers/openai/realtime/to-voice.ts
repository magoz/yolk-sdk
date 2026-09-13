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
import { Match } from 'effect'
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
  return Match.value(event).pipe(
    Match.tag('InputAudioTranscriptionDelta', current => [
      VoiceUserTranscriptDelta.make({ itemId: current.itemId, delta: current.delta })
    ]),
    Match.tag('InputAudioTranscriptionCompleted', current => [
      VoiceUserTranscriptFinal.make({ itemId: current.itemId, text: current.transcript })
    ]),
    Match.tag('OutputAudioTranscriptDelta', current => [
      VoiceAssistantTranscriptDelta.make({
        itemId: current.itemId,
        responseId: current.responseId,
        delta: current.delta
      })
    ]),
    Match.tag('OutputAudioTranscriptDone', current => [
      VoiceAssistantTranscriptFinal.make({
        itemId: current.itemId,
        responseId: current.responseId,
        text: current.transcript
      })
    ]),
    Match.tag('SessionConfigured', current => [
      VoiceSessionOpened.make({
        model: current.model,
        transcriptionModel: current.transcriptionModel,
        transcriptionLanguage: current.transcriptionLanguage
      })
    ]),
    Match.tag('ResponseDone', current =>
      current.status === 'cancelled'
        ? [VoiceInterrupted.make({ responseId: current.responseId })]
        : []
    ),
    Match.tag('FunctionCalls', current => {
      const [first, ...rest] = current.calls.map(call =>
        VoiceToolCall.make({
          callId: call.callId,
          name: call.name,
          argumentsJson: call.argumentsJson
        })
      )

      return first === undefined ? [] : [VoiceToolCallsRequested.make({ calls: [first, ...rest] })]
    }),
    Match.tag('Error', current => [
      VoiceErrorEvent.make({ code: 'provider_error', message: current.message })
    ]),
    Match.tag('Ignored', () => []),
    Match.exhaustive
  )
}
