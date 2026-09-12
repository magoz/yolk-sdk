import { Effect, Layer, Stream } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { ToolCall, ToolDef, UserMessage } from '@yolk-sdk/agent/protocol'
import {
  AbortError,
  ContextTransformer,
  LLMProvider,
  LoopConfig,
  ToolExecutor
} from '@yolk-sdk/agent/loop'
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

  it.effect('keeps AbortError on the error channel', () =>
    Effect.gen(function* () {
      const error = yield* attemptModelTurn({
        messages: [UserMessage.make({ content: 'hello' })],
        systemPrompt: 'Be brief.',
        tools: [],
        model: 'faux',
        turn: 1
      }).pipe(Effect.flip)

      expect(error._tag).toBe('AbortError')
      if (error._tag !== 'AbortError') return
      expect(error.reason).toBe('user')
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(
            LLMProvider,
            LLMProvider.of({
              stream: () => Stream.fail(new AbortError({ reason: 'user' }))
            })
          ),
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

  it.effect('returns AwaitingInput for HITL instead of Failed', () =>
    Effect.gen(function* () {
      const outcome = yield* attemptToolBatch({
        calls: [
          ToolCall.make({
            id: 'question-call',
            name: 'question',
            params: {
              questions: [{ id: 'choice', prompt: 'Pick one', options: [{ id: 'a', label: 'A' }] }]
            }
          })
        ],
        tools: [ToolDef.make({ name: 'question', description: 'Ask', parameters: {} })]
      })

      expect(outcome._tag).toBe('AwaitingInput')
    }).pipe(Effect.provide(Layer.mergeAll(ToolExecutor.unavailable, LoopConfig.defaultLayer)))
  )
})
