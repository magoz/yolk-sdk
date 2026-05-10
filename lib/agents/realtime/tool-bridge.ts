import type { VoiceToolExecutionResult } from '@yolk/voice-runtime'

export type RealtimeFunctionCallOutputEvent = {
  readonly type: 'conversation.item.create'
  readonly item: {
    readonly type: 'function_call_output'
    readonly call_id: string
    readonly output: string
  }
}

export type OpenAiRealtimeToolExecutionResponse = {
  readonly event: RealtimeFunctionCallOutputEvent
}

export const makeRealtimeFunctionCallOutputEvent = (
  callId: string,
  output: string
): RealtimeFunctionCallOutputEvent => ({
  type: 'conversation.item.create',
  item: {
    type: 'function_call_output',
    call_id: callId,
    output
  }
})

export const toOpenAiRealtimeToolExecutionResponse = (
  result: VoiceToolExecutionResult
): OpenAiRealtimeToolExecutionResponse => ({
  event: makeRealtimeFunctionCallOutputEvent(result.toolCallId, result.output)
})
