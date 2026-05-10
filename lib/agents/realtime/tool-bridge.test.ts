import { Effect } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { CalculatorToolExecutorLayer } from '@/lib/agents/tools/calculator-tool'
import { RealtimeToolCallRequest, executeRealtimeToolCall } from './tool-bridge'

describe('executeRealtimeToolCall', () => {
  it.effect('executes app tools and returns Realtime output event', () =>
    Effect.gen(function* () {
      const response = yield* executeRealtimeToolCall(
        RealtimeToolCallRequest.make({
          callId: 'call_1',
          name: 'calculate',
          arguments: JSON.stringify({ operation: 'multiply', left: 19, right: 23 })
        })
      ).pipe(Effect.provide(CalculatorToolExecutorLayer))

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
    }))

  it.effect('returns tool errors as Realtime output events', () =>
    Effect.gen(function* () {
      const response = yield* executeRealtimeToolCall(
        RealtimeToolCallRequest.make({
          callId: 'call_1',
          name: 'calculate',
          arguments: JSON.stringify({ operation: 'divide', left: 1, right: 0 })
        })
      ).pipe(Effect.provide(CalculatorToolExecutorLayer))

      expect(response.event.item).toMatchObject({
        type: 'function_call_output',
        call_id: 'call_1'
      })
      expect(response.event.item.output).toContain('Cannot divide by zero')
    }))
})
