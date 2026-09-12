import { Effect, Layer, Ref, Stream } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { ToolCall, ToolDef, UserMessage } from '@yolk-sdk/agent/protocol'
import {
  AbortError,
  ContextTransformer,
  LLMError,
  LLMProvider,
  LLMTextDelta,
  LoopConfig,
  ToolExecutor
} from '@yolk-sdk/agent/loop'
import { makeContextOverflowRetryProvider } from '@yolk-sdk/agent/compaction'
import { FauxProvider, Reply, TestToolExecutor } from '@yolk-sdk/agent/loop/testing'
import { attemptModelTurn, attemptToolBatch } from '../src/outcome.ts'

const loopLayer = Layer.mergeAll(ContextTransformer.identity, LoopConfig.defaultLayer)
const noRetryLoopLayer = Layer.mergeAll(
  ContextTransformer.identity,
  LoopConfig.layer({
    maxTurns: 500,
    maxRetries: 0,
    retryBaseDelayMs: 2000,
    toolConcurrency: 4
  })
)

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

  it.effect('returns Retry for a retryable error before output', () =>
    Effect.gen(function* () {
      const outcome = yield* attemptModelTurn({
        messages: [UserMessage.make({ content: 'hello' })],
        systemPrompt: 'Be brief.',
        tools: [],
        model: 'faux',
        turn: 1
      })

      expect(outcome._tag).toBe('Retry')
      if (outcome._tag !== 'Retry') return
      expect(outcome.error._tag).toBe('LLMError')
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(
            LLMProvider,
            LLMProvider.of({
              stream: () =>
                Stream.fail(
                  new LLMError({
                    cause: 'rate_limit',
                    message: 'slow down',
                    retryable: true
                  })
                )
            })
          ),
          noRetryLoopLayer
        )
      )
    )
  )

  it.effect('returns RecoverFull for invalid_response before output', () =>
    Effect.gen(function* () {
      const outcome = yield* attemptModelTurn({
        messages: [UserMessage.make({ content: 'hello' })],
        systemPrompt: 'Be brief.',
        tools: [],
        model: 'faux',
        turn: 1
      })

      expect(outcome._tag).toBe('RecoverFull')
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(
            LLMProvider,
            LLMProvider.of({
              stream: () =>
                Stream.fail(
                  new LLMError({
                    cause: 'invalid_response',
                    message: 'truncated',
                    retryable: true
                  })
                )
            })
          ),
          noRetryLoopLayer
        )
      )
    )
  )

  it.effect('returns Continue for a retryable error after output started', () =>
    Effect.gen(function* () {
      const outcome = yield* attemptModelTurn({
        messages: [UserMessage.make({ content: 'hello' })],
        systemPrompt: 'Be brief.',
        tools: [],
        model: 'faux',
        turn: 1
      })

      expect(outcome._tag).toBe('Continue')
      if (outcome._tag !== 'Continue') return
      expect(outcome.error._tag).toBe('LLMError')
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(
            LLMProvider,
            LLMProvider.of({
              stream: () =>
                Stream.make(LLMTextDelta.make({ text: 'hi' })).pipe(
                  Stream.concat(
                    Stream.fail(
                      new LLMError({
                        cause: 'rate_limit',
                        message: 'slow down',
                        retryable: true
                      })
                    )
                  )
                )
            })
          ),
          loopLayer
        )
      )
    )
  )

  it.effect('returns Compacted when overflow happens before output and compact succeeds', () =>
    Effect.gen(function* () {
      const compacted = [UserMessage.make({ content: 'summarized' })]
      const outcome = yield* attemptModelTurn(
        {
          messages: [UserMessage.make({ content: 'hello' })],
          systemPrompt: 'Be brief.',
          tools: [],
          model: 'faux',
          turn: 1
        },
        {
          compact: () => Effect.succeed({ _tag: 'Compacted', messages: compacted })
        }
      )

      expect(outcome._tag).toBe('Compacted')
      if (outcome._tag !== 'Compacted') return
      expect(outcome.messages).toEqual(compacted)
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(
            LLMProvider,
            LLMProvider.of({
              stream: () =>
                Stream.fail(
                  new LLMError({
                    cause: 'context_overflow',
                    message: 'too big',
                    retryable: true
                  })
                )
            })
          ),
          loopLayer
        )
      )
    )
  )

  it.effect('fails overflow after output even when compact is provided', () =>
    Effect.gen(function* () {
      const error = yield* attemptModelTurn(
        {
          messages: [UserMessage.make({ content: 'hello' })],
          systemPrompt: 'Be brief.',
          tools: [],
          model: 'faux',
          turn: 1
        },
        {
          compact: () =>
            Effect.succeed({ _tag: 'Compacted', messages: [UserMessage.make({ content: 'nope' })] })
        }
      ).pipe(Effect.flip)

      expect(error._tag).toBe('LLMError')
      if (error._tag !== 'LLMError') return
      expect(error.cause).toBe('context_overflow')
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(
            LLMProvider,
            LLMProvider.of({
              stream: () =>
                Stream.make(LLMTextDelta.make({ text: 'hi' })).pipe(
                  Stream.concat(
                    Stream.fail(
                      new LLMError({
                        cause: 'context_overflow',
                        message: 'too big',
                        retryable: true
                      })
                    )
                  )
                )
            })
          ),
          loopLayer
        )
      )
    )
  )

  it.effect('reuses makeContextOverflowRetryProvider for in-process overflow retry', () =>
    Effect.gen(function* () {
      const provider = yield* makeContextOverflowRetryProvider({
        provider: {
          stream: request =>
            request.messages[0]?._tag === 'User' && request.messages[0].content === 'summarized'
              ? Stream.fromIterable(Reply.text('ok').events)
              : Stream.fail(
                  new LLMError({
                    cause: 'context_overflow',
                    message: 'too big',
                    retryable: true
                  })
                )
        },
        compact: () =>
          Effect.succeed({
            _tag: 'Compacted',
            messages: [UserMessage.make({ content: 'summarized' })]
          })
      })
      const outcome = yield* attemptModelTurn({
        messages: [UserMessage.make({ content: 'hello' })],
        systemPrompt: 'Be brief.',
        tools: [],
        model: 'faux',
        turn: 1
      }).pipe(Effect.provideService(LLMProvider, provider))

      expect(outcome._tag).toBe('Completed')
      if (outcome._tag !== 'Completed') return
      expect(outcome.stopReason).toBe('stop')
    }).pipe(Effect.provide(loopLayer))
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
      expect(outcome.toolCalls).toEqual([
        ToolCall.make({ id: 'call_1', name: 'weather', params: {} })
      ])
    }).pipe(
      Effect.provide(
        Layer.mergeAll(TestToolExecutor.layer({ weather: '72F' }), LoopConfig.defaultLayer)
      )
    )
  )

  it.effect('delivers tool results through onEvent', () =>
    Effect.gen(function* () {
      const events = yield* Ref.make<ReadonlyArray<string>>([])
      yield* attemptToolBatch(
        {
          calls: [ToolCall.make({ id: 'call_1', name: 'weather', params: {} })]
        },
        {
          onEvent: event =>
            event._tag === 'ToolExecutionCompleted'
              ? Ref.update(events, current => [...current, String(event.result.content)])
              : Effect.void
        }
      )

      expect(yield* Ref.get(events)).toEqual(['72F'])
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
