import { Effect, Fiber, Layer, Ref, Stream } from 'effect'
import { TestClock } from 'effect/testing'
import { describe, expect, it } from '@effect/vitest'
import { AgentInputUsage, AgentOutputUsage, AgentUsage, ToolCall } from '@yolk-sdk/agent/protocol'
import {
  completeText,
  LLMDone,
  LLMProvider,
  LLMReasoningDelta,
  LLMTextDelta,
  LLMToolCall,
  LLMUsage,
  type LLMEvent,
  type LLMRequest
} from '../../src/loop'
import { FauxProvider, Reply } from '../../src/loop/testing'

const completeTextRequest: LLMRequest = {
  model: 'faux',
  systemPrompt: 'Be concise.',
  messages: [],
  tools: []
}

const usageEvent = (input: number, output: number): LLMEvent =>
  LLMUsage.make({
    usage: AgentUsage.make({
      input: AgentInputUsage.make({ total: input }),
      output: AgentOutputUsage.make({ total: output })
    })
  })

const interrupts = (events: ReadonlyArray<LLMEvent>, interrupted: Ref.Ref<boolean>) =>
  Layer.succeed(
    LLMProvider,
    LLMProvider.of({
      stream: () => Stream.fromIterable(events).pipe(Stream.ensuring(Ref.set(interrupted, true)))
    })
  )

describe('completeText', () => {
  it.effect('aggregates text, ignores reasoning and tool calls, and sums usage', () =>
    Effect.gen(function* () {
      const requests: Array<LLMRequest> = []

      const result = yield* completeText({ ...completeTextRequest, maxOutputTokens: 50 }, {}).pipe(
        Effect.provide(
          FauxProvider.layerWithRequests({
            requests,
            responses: [
              {
                events: [
                  LLMTextDelta.make({ text: 'Hello' }),
                  LLMReasoningDelta.make({ text: 'private thinking' }),
                  usageEvent(10, 5),
                  LLMToolCall.make({
                    call: ToolCall.make({ id: 'call-1', name: 'search', params: {} })
                  }),
                  LLMTextDelta.make({ text: ' world' }),
                  usageEvent(4, 7),
                  LLMDone.make({ stopReason: 'stop' })
                ]
              }
            ]
          })
        )
      )

      expect(result).toEqual({
        text: 'Hello world',
        usage: AgentUsage.make({
          input: AgentInputUsage.make({ total: 14 }),
          output: AgentOutputUsage.make({ total: 12 })
        }),
        finishReason: 'stop',
        truncated: false
      })
      expect(requests[0]?.maxOutputTokens).toBe(50)
    })
  )

  it.effect('reports tool_use finish reasons while discarding tool calls', () =>
    Effect.gen(function* () {
      const result = yield* completeText(completeTextRequest).pipe(
        Effect.provide(
          FauxProvider.layer({
            events: [
              LLMToolCall.make({
                call: ToolCall.make({ id: 'call-1', name: 'search', params: { query: 'yolk' } })
              }),
              LLMDone.make({ stopReason: 'tool_use' })
            ]
          })
        )
      )

      expect(result).toEqual({
        text: '',
        usage: AgentUsage.make({
          input: AgentInputUsage.make({ total: 0 }),
          output: AgentOutputUsage.make({ total: 0 })
        }),
        finishReason: 'tool_use',
        truncated: false
      })
    })
  )

  it.effect('maxCharacters slices the boundary delta and interrupts the stream', () =>
    Effect.gen(function* () {
      const interrupted = yield* Ref.make(false)

      const events = Array.from({ length: 20 }, (_, index) =>
        LLMTextDelta.make({ text: `word-${index} ` })
      )

      const result = yield* completeText(completeTextRequest, { maxCharacters: 10 }).pipe(
        Effect.provide(interrupts(events, interrupted))
      )

      expect(result.truncated).toBe(true)
      expect(result.text).toBe('word-0 wor')
      expect(result.text.length).toBeLessThanOrEqual(10)
      expect(yield* Ref.get(interrupted)).toBe(true)
    })
  )

  it.effect('timeout interrupts a hanging stream and returns text so far', () =>
    Effect.gen(function* () {
      const interrupted = yield* Ref.make(false)

      const layer = Layer.succeed(
        LLMProvider,
        LLMProvider.of({
          stream: () =>
            Stream.concat(Stream.make(LLMTextDelta.make({ text: 'ab' })), Stream.never).pipe(
              Stream.ensuring(Ref.set(interrupted, true))
            )
        })
      )

      const fiber = yield* Effect.forkChild(
        completeText(completeTextRequest, { timeout: '1 minute' }).pipe(Effect.provide(layer))
      )

      yield* TestClock.adjust('1 minute')

      const result = yield* Fiber.join(fiber)

      expect(result.text).toBe('ab')
      expect(result.truncated).toBe(true)
      expect(result.finishReason).toBeUndefined()
      expect(yield* Ref.get(interrupted)).toBe(true)
    })
  )

  it.effect('propagates provider errors typed', () =>
    Effect.gen(function* () {
      const error = yield* completeText(completeTextRequest).pipe(
        Effect.provide(FauxProvider.layer()),
        Effect.flip
      )

      expect(error._tag).toBe('FauxExhaustedError')
    })
  )

  it.effect('fails invalid maxCharacters with a validation error', () =>
    Effect.gen(function* () {
      const error = yield* completeText(completeTextRequest, { maxCharacters: 0 }).pipe(
        Effect.provide(FauxProvider.layer(Reply.text('hi'))),
        Effect.flip
      )

      expect(error).toMatchObject({ _tag: 'LLMError', cause: 'validation_error' })
    })
  )
})
