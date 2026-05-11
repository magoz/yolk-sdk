import { Effect } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { TestToolExecutor } from '@yolk/agent-loop/testing'
import { VoiceToolCallRequest, executeVoiceToolCall } from '../src'

describe('executeVoiceToolCall', () => {
  it.effect('executes host tools and returns JSON output', () =>
    Effect.gen(function* () {
      const response = yield* executeVoiceToolCall(
        VoiceToolCallRequest.make({
          callId: 'call_1',
          name: 'echo',
          arguments: JSON.stringify({ value: 'hello' })
        })
      ).pipe(
        Effect.provide(
          TestToolExecutor.layer({
            echo: 'hello'
          })
        )
      )

      expect(response).toEqual({
        toolCallId: 'call_1',
        output: JSON.stringify({ result: 'hello' })
      })
    })
  )

  it.effect('returns invalid argument JSON as tool output', () =>
    Effect.gen(function* () {
      const response = yield* executeVoiceToolCall(
        VoiceToolCallRequest.make({
          callId: 'call_1',
          name: 'echo',
          arguments: '{'
        })
      ).pipe(Effect.provide(TestToolExecutor.layer({})))

      expect(response.toolCallId).toBe('call_1')
      expect(response.output).toContain('Invalid tool arguments JSON')
    })
  )

  it.effect('returns tool errors as JSON output', () =>
    Effect.gen(function* () {
      const response = yield* executeVoiceToolCall(
        VoiceToolCallRequest.make({
          callId: 'call_1',
          name: 'missing',
          arguments: '{}'
        })
      ).pipe(Effect.provide(TestToolExecutor.layer({})))

      expect(response.toolCallId).toBe('call_1')
      expect(response.output).toContain('No canned result for tool: missing')
    })
  )

  it.effect('truncates large voice tool results', () =>
    Effect.gen(function* () {
      const response = yield* executeVoiceToolCall(
        VoiceToolCallRequest.make({
          callId: 'call_1',
          name: 'big',
          arguments: '{}'
        })
      ).pipe(Effect.provide(TestToolExecutor.layer({ big: 'x'.repeat(7000) })))

      expect(response.toolCallId).toBe('call_1')
      expect(response.output).toContain('[truncated for voice; summarize from available excerpt]')
      expect(response.output.length).toBeLessThan(6200)
    })
  )
})
