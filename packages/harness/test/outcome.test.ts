import { Effect, Layer } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { ToolCall, UserMessage } from '@yolk-sdk/agent/protocol'
import { ContextTransformer, LoopConfig } from '@yolk-sdk/agent/loop'
import { FauxProvider, Reply, TestToolExecutor } from '@yolk-sdk/agent/loop/testing'
import { attemptModelTurn, attemptToolBatch } from '../src/outcome.ts'

const loopLayer = Layer.mergeAll(ContextTransformer.identity, LoopConfig.defaultLayer)

describe('attemptModelTurn', () => {
  it.effect('completes a text turn', () =>
    Effect.gen(function* () {
      const outcome = yield* attemptModelTurn({
        messages: [UserMessage.make({ content: 'hello' })],
        systemPrompt: 'Be brief.',
        tools: [],
        model: 'faux',
        turn: 1
      })

      expect(outcome._tag).toBe('Completed')
      if (outcome._tag !== 'Completed') return
      expect(outcome.needsContinuation).toBe(false)
      expect(outcome.stopReason).toBe('stop')
    }).pipe(Effect.provide(Layer.mergeAll(FauxProvider.layer(Reply.text('ok')), loopLayer)))
  )

  it.effect('marks tool_use as needsContinuation', () =>
    Effect.gen(function* () {
      const outcome = yield* attemptModelTurn({
        messages: [UserMessage.make({ content: 'hello' })],
        systemPrompt: 'Be brief.',
        tools: [],
        model: 'faux',
        turn: 1
      })

      expect(outcome._tag).toBe('Completed')
      if (outcome._tag !== 'Completed') return
      expect(outcome.needsContinuation).toBe(true)
      expect(outcome.toolCalls).toHaveLength(1)
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          FauxProvider.layer(Reply.toolCall({ id: 'call_1', name: 'weather', params: {} })),
          loopLayer
        )
      )
    )
  )
})

describe('attemptToolBatch', () => {
  it.effect('completes executed tools', () =>
    Effect.gen(function* () {
      const outcome = yield* attemptToolBatch({
        calls: [ToolCall.make({ id: 'call_1', name: 'weather', params: {} })]
      })

      expect(outcome._tag).toBe('Completed')
      if (outcome._tag !== 'Completed') return
      expect(outcome.needsContinuation).toBe(false)
    }).pipe(
      Effect.provide(
        Layer.mergeAll(TestToolExecutor.layer({ weather: '72F' }), LoopConfig.defaultLayer)
      )
    )
  )
})
