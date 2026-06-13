import { describe, expect, it } from '@effect/vitest'
import { VoiceToolExecutionResult } from '@yolk-sdk/agent/voice'
import { toOpenAiRealtimeToolExecutionResponse } from './tool-bridge'

describe('toOpenAiRealtimeToolExecutionResponse', () => {
  it('converts voice tool results to OpenAI Realtime output events', () => {
    const response = toOpenAiRealtimeToolExecutionResponse(
      VoiceToolExecutionResult.make({
        toolCallId: 'call_1',
        output: JSON.stringify({ result: '437' })
      })
    )

    expect(response).toEqual({
      event: {
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: 'call_1',
          output: JSON.stringify({ result: '437' })
        }
      }
    })
  })
})
