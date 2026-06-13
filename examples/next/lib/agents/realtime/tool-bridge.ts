import type { VoiceToolExecutionResult } from '@yolk-sdk/agent/voice'
import {
  makeOpenAiRealtimeFunctionCallOutputEvent,
  type OpenAiRealtimeConversationItemCreateEvent
} from './openai-realtime-events'

export type RealtimeFunctionCallOutputEvent = OpenAiRealtimeConversationItemCreateEvent

export type OpenAiRealtimeToolExecutionResponse = {
  readonly event: RealtimeFunctionCallOutputEvent
}

export const makeRealtimeFunctionCallOutputEvent = (
  callId: string,
  output: string
): RealtimeFunctionCallOutputEvent => makeOpenAiRealtimeFunctionCallOutputEvent(callId, output)

export const toOpenAiRealtimeToolExecutionResponse = (
  result: VoiceToolExecutionResult
): OpenAiRealtimeToolExecutionResponse => ({
  event: makeRealtimeFunctionCallOutputEvent(result.toolCallId, result.output)
})
