import { Cause, Duration, Effect, Fiber, Layer, Ref, Stream } from 'effect'
import { TestClock } from 'effect/testing'
import { describe, expect, it } from '@effect/vitest'
import {
  assistantContent,
  assistantReasoningText,
  ProviderErrorInfo,
  QuestionAnswer,
  QuestionResponse,
  ToolApprovalPolicy,
  ToolApprovalResponse,
  ToolCall,
  ToolDef,
  ToolResult,
  UserMessage
} from '@yolk-sdk/agent/protocol'
import {
  AbortError,
  ContextTransformer,
  LLMError,
  LLMProvider,
  LLMProviderToolResult,
  LLMReasoningDelta,
  LLMDone,
  LLMTextDelta,
  LLMToolInputStart,
  LoopConfig,
  ToolExecutor,
  type LLMEvent
} from '@yolk-sdk/agent/loop'
import { makeContextOverflowRetryProvider } from '@yolk-sdk/agent/compaction'
import { FauxProvider, Reply, TestToolExecutor } from '@yolk-sdk/agent/loop/testing'
import {
  attemptModelTurn,
  attemptToolBatch,
  matchHitlResponse,
  resumeHitlIfMatched
} from '../src/outcome.ts'

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

const turnConfig = {
  messages: [UserMessage.make({ content: 'hello' })],
  systemPrompt: 'Be brief.',
  tools: [] as const,
  model: 'faux',
  turn: 1
}

const rateLimitError = () =>
  new LLMError({
    cause: 'rate_limit',
    message: 'slow down',
    retryable: true
  })

const overflowError = () =>
  new LLMError({
    cause: 'context_overflow',
    message: 'too big',
    retryable: false
  })

const providerLayer = (stream: Stream.Stream<LLMEvent, LLMError | AbortError>) =>
  Layer.mergeAll(
    Layer.succeed(
      LLMProvider,
      LLMProvider.of({
        stream: () => stream
      })
    ),
    noRetryLoopLayer
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

  it.effect('lets runModelTurn consume LoopConfig.maxRetries before classifying', () =>
    Effect.gen(function* () {
      let attempts = 0
      const running = attemptModelTurn(turnConfig).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(
              LLMProvider,
              LLMProvider.of({
                stream: () => {
                  attempts += 1
                  return attempts === 1
                    ? Stream.fail(rateLimitError())
                    : Stream.fromIterable([
                        LLMTextDelta.make({ text: 'ok' }),
                        LLMDone.make({ stopReason: 'stop' })
                      ])
                }
              })
            ),
            Layer.mergeAll(
              ContextTransformer.identity,
              LoopConfig.layer({
                maxTurns: 1,
                maxRetries: 1,
                retryBaseDelayMs: 10,
                toolConcurrency: 1
              })
            )
          )
        )
      )
      const fiber = yield* running.pipe(Effect.forkChild)
      yield* TestClock.adjust(Duration.millis(10))
      const outcome = yield* Fiber.join(fiber)
      expect(outcome._tag).toBe('Completed')
      expect(attempts).toBe(2)
    })
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
      const outcome = yield* attemptModelTurn(turnConfig)

      expect(outcome._tag).toBe('Continue')
      if (outcome._tag !== 'Continue') return
      expect(outcome.error._tag).toBe('LLMError')
      expect(outcome.assistantMessage?._tag).toBe('Assistant')
      if (outcome.assistantMessage?._tag !== 'Assistant') return
      expect(assistantContent(outcome.assistantMessage)).toBe('hi')
    }).pipe(
      Effect.provide(
        providerLayer(
          Stream.make(LLMTextDelta.make({ text: 'hi' })).pipe(
            Stream.concat(Stream.fail(rateLimitError()))
          )
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
      expect(outcome.overflowCompactionAttempt).toBe(1)
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

  it.effect('recovers an empty incomplete stream as RecoverFull', () =>
    Effect.gen(function* () {
      const outcome = yield* attemptModelTurn(turnConfig)

      expect(outcome._tag).toBe('RecoverFull')
      if (outcome._tag !== 'RecoverFull') return
      expect(outcome.error).toMatchObject({
        _tag: 'LLMError',
        cause: 'invalid_response',
        retryable: false,
        responseIssue: 'missing_done'
      })
    }).pipe(Effect.provide(providerLayer(Stream.empty)))
  )

  it.effect('continues an incomplete stream after partial text', () =>
    Effect.gen(function* () {
      const outcome = yield* attemptModelTurn(turnConfig)

      expect(outcome._tag).toBe('Continue')
      if (outcome._tag !== 'Continue') return
      expect(outcome.error).toMatchObject({ responseIssue: 'missing_done', retryable: false })
      if (outcome.assistantMessage?._tag !== 'Assistant') return
      expect(assistantContent(outcome.assistantMessage)).toBe('partial')
      expect(outcome.toolCalls).toEqual([])
    }).pipe(Effect.provide(providerLayer(Stream.make(LLMTextDelta.make({ text: 'partial' })))))
  )

  it.effect('does not recover content-filter terminals', () =>
    Effect.gen(function* () {
      const error = yield* attemptModelTurn(turnConfig).pipe(Effect.flip)

      expect(error).toMatchObject({
        _tag: 'LLMError',
        cause: 'invalid_response',
        retryable: false,
        provider: { providerCode: 'content_filter' }
      })
      expect('responseIssue' in error ? error.responseIssue : undefined).toBeUndefined()
    }).pipe(
      Effect.provide(
        providerLayer(
          Stream.fail(
            new LLMError({
              cause: 'invalid_response',
              message: 'OpenAI response stopped with content_filter',
              retryable: false,
              provider: ProviderErrorInfo.make({
                provider: 'openai',
                kind: 'invalid_response',
                providerCode: 'content_filter'
              })
            })
          )
        )
      )
    )
  )

  it.effect('does not recover multiple Done events as incomplete', () =>
    Effect.gen(function* () {
      const error = yield* attemptModelTurn(turnConfig).pipe(Effect.flip)

      expect(error).toMatchObject({
        _tag: 'LLMError',
        cause: 'invalid_response',
        retryable: false,
        message: 'Expected exactly one LLM done event, received 2'
      })
      expect('responseIssue' in error ? error.responseIssue : undefined).toBeUndefined()
    }).pipe(
      Effect.provide(
        providerLayer(
          Stream.fromIterable([
            LLMTextDelta.make({ text: 'hi' }),
            LLMDone.make({ stopReason: 'stop' }),
            LLMDone.make({ stopReason: 'stop' })
          ])
        )
      )
    )
  )

  it.effect('treats reasoning as published output for overflow and continue', () =>
    Effect.gen(function* () {
      const overflow = yield* attemptModelTurn(turnConfig, {
        compact: () =>
          Effect.succeed({
            _tag: 'Compacted',
            messages: [UserMessage.make({ content: 'nope' })]
          })
      }).pipe(
        Effect.provide(
          providerLayer(
            Stream.make(LLMReasoningDelta.make({ text: 'thinking' })).pipe(
              Stream.concat(Stream.fail(overflowError()))
            )
          )
        ),
        Effect.flip
      )
      expect(overflow).toMatchObject({ _tag: 'LLMError', cause: 'context_overflow' })

      const continued = yield* attemptModelTurn(turnConfig).pipe(
        Effect.provide(
          providerLayer(
            Stream.make(LLMReasoningDelta.make({ text: 'thinking' })).pipe(
              Stream.concat(Stream.fail(rateLimitError()))
            )
          )
        )
      )
      expect(continued._tag).toBe('Continue')
      if (continued._tag !== 'Continue') return
      if (continued.assistantMessage?._tag !== 'Assistant') return
      expect(assistantReasoningText(continued.assistantMessage)).toBe('thinking')
    })
  )

  it.effect('treats provider tool results as published output', () =>
    Effect.gen(function* () {
      const call = ToolCall.make({ id: 'p1', name: 'search', params: {} })
      const error = yield* attemptModelTurn(turnConfig, {
        compact: () =>
          Effect.succeed({
            _tag: 'Compacted',
            messages: [UserMessage.make({ content: 'nope' })]
          })
      }).pipe(
        Effect.provide(
          providerLayer(
            Stream.make(
              LLMProviderToolResult.make({
                call,
                result: ToolResult.make({ toolCallId: 'p1', content: 'hit' })
              })
            ).pipe(Stream.concat(Stream.fail(overflowError())))
          )
        ),
        Effect.flip
      )

      expect(error).toMatchObject({ _tag: 'LLMError', cause: 'context_overflow' })
    })
  )

  it.effect('does not treat incomplete tool input as an executed call', () =>
    Effect.gen(function* () {
      const outcome = yield* attemptModelTurn(turnConfig)

      expect(outcome._tag).toBe('Continue')
      if (outcome._tag !== 'Continue') return
      expect(outcome.toolCalls).toEqual([])
    }).pipe(
      Effect.provide(
        providerLayer(Stream.make(LLMToolInputStart.make({ id: 'call_1', name: 'weather' })))
      )
    )
  )

  it.effect('does not classify onEvent sink errors as provider outcomes', () =>
    Effect.gen(function* () {
      const error = yield* attemptModelTurn(turnConfig, {
        onEvent: () => Effect.fail(rateLimitError())
      }).pipe(Effect.flip)

      expect(error).toMatchObject({ _tag: 'LLMError', cause: 'rate_limit', retryable: true })
    }).pipe(Effect.provide(providerLayer(Stream.make(LLMTextDelta.make({ text: 'partial' })))))
  )

  it.effect('does not classify mixed sink typed+Die causes as recoverable', () =>
    Effect.gen(function* () {
      const typed = rateLimitError()
      const defect = new Error('sink defect')
      const exit = yield* attemptModelTurn(turnConfig, {
        onEvent: () => Effect.failCause(Cause.combine(Cause.fail(typed), Cause.die(defect)))
      }).pipe(Effect.exit)

      expect(exit._tag).toBe('Failure')
      if (exit._tag !== 'Failure') return
      expect(Cause.hasFails(exit.cause)).toBe(true)
      expect(Cause.hasDies(exit.cause)).toBe(true)
      expect(Cause.findError(exit.cause)).toMatchObject({ _tag: 'Success', success: typed })
      expect(Cause.findDefect(exit.cause)).toMatchObject({ _tag: 'Success', success: defect })
    }).pipe(Effect.provide(providerLayer(Stream.make(LLMTextDelta.make({ text: 'partial' })))))
  )

  it.effect('isolates sequential and concurrent Effect reuse', () =>
    Effect.gen(function* () {
      const attempt = attemptModelTurn(turnConfig)
      const afterOutput = Layer.mergeAll(
        Layer.succeed(
          LLMProvider,
          LLMProvider.of({
            stream: () =>
              Stream.make(LLMTextDelta.make({ text: 'partial' })).pipe(
                Stream.concat(Stream.fail(rateLimitError()))
              )
          })
        ),
        noRetryLoopLayer
      )
      const beforeOutput = providerLayer(Stream.fail(rateLimitError()))

      const first = yield* attempt.pipe(Effect.provide(afterOutput))
      const second = yield* attempt.pipe(Effect.provide(beforeOutput))
      expect(first._tag).toBe('Continue')
      expect(second._tag).toBe('Retry')

      const [left, right] = yield* Effect.all(
        [attempt.pipe(Effect.provide(afterOutput)), attempt.pipe(Effect.provide(beforeOutput))],
        { concurrency: 'unbounded' }
      )
      expect(left._tag).toBe('Continue')
      expect(right._tag).toBe('Retry')
    })
  )

  it.effect('compacts once per logical step then treats later overflow as terminal', () =>
    Effect.gen(function* () {
      const compactedMessages = [UserMessage.make({ content: 'summarized' })]
      let compactCalls = 0
      const compact = () => {
        compactCalls += 1
        return Effect.succeed({
          _tag: 'Compacted' as const,
          messages: compactedMessages
        })
      }

      const first = yield* attemptModelTurn(turnConfig, { compact, overflowCompactionAttempt: 0 })
      expect(first._tag).toBe('Compacted')
      if (first._tag !== 'Compacted') return
      expect(first.overflowCompactionAttempt).toBe(1)
      expect(compactCalls).toBe(1)

      const second = yield* attemptModelTurn(turnConfig, {
        compact,
        overflowCompactionAttempt: first.overflowCompactionAttempt
      }).pipe(Effect.flip)
      expect(second).toMatchObject({ _tag: 'LLMError', cause: 'context_overflow' })
      expect(compactCalls).toBe(1)
    }).pipe(Effect.provide(providerLayer(Stream.fail(overflowError()))))
  )

  it.effect('propagates compact Abort and compact failure', () =>
    Effect.gen(function* () {
      const aborted = yield* attemptModelTurn(turnConfig, {
        compact: () => Effect.fail(new AbortError({ reason: 'user' }))
      }).pipe(Effect.flip)
      expect(aborted).toMatchObject({ _tag: 'AbortError', reason: 'user' })

      const failed = yield* attemptModelTurn(turnConfig, {
        compact: () =>
          Effect.fail(
            new LLMError({
              cause: 'provider_error',
              message: 'summarizer down',
              retryable: false
            })
          )
      }).pipe(Effect.flip)
      expect(failed).toMatchObject({ _tag: 'LLMError', cause: 'provider_error' })
    }).pipe(Effect.provide(providerLayer(Stream.fail(overflowError()))))
  )

  it.effect('rejects invalid overflowCompactionAttempt counts', () =>
    Effect.gen(function* () {
      const counts = [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5]
      for (const overflowCompactionAttempt of counts) {
        const error = yield* attemptModelTurn(turnConfig, {
          overflowCompactionAttempt,
          compact: () =>
            Effect.succeed({
              _tag: 'Compacted' as const,
              messages: [UserMessage.make({ content: 'nope' })]
            })
        }).pipe(Effect.flip)
        expect(error).toMatchObject({
          _tag: 'LLMError',
          cause: 'validation_error'
        })
      }
    }).pipe(Effect.provide(providerLayer(Stream.fail(overflowError()))))
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
      expect(outcome.needsContinuation).toBe(true)
      expect(outcome.stopReason).toBe('tool_use')
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

  it.effect('does not execute sibling tools when HITL pending fences the batch', () =>
    Effect.gen(function* () {
      const outcome = yield* attemptToolBatch({
        calls: [
          ToolCall.make({ id: 'call_1', name: 'weather', params: {} }),
          ToolCall.make({
            id: 'question-call',
            name: 'question',
            params: {
              questions: [{ id: 'choice', prompt: 'Pick one', options: [{ id: 'a', label: 'A' }] }]
            }
          })
        ],
        tools: [
          ToolDef.make({ name: 'weather', description: 'Get weather.', parameters: {} }),
          ToolDef.make({ name: 'question', description: 'Ask', parameters: {} })
        ]
      })

      expect(outcome._tag).toBe('AwaitingInput')
      if (outcome._tag !== 'AwaitingInput') return
      expect('toolCalls' in outcome).toBe(false)
    }).pipe(
      Effect.provide(
        Layer.mergeAll(TestToolExecutor.layer({ weather: '72F' }), LoopConfig.defaultLayer)
      )
    )
  )

  it.effect('matchHitlResponse requires kind, request, and tool-call identity', () =>
    Effect.gen(function* () {
      const outcome = yield* attemptToolBatch({
        calls: [
          ToolCall.make({
            id: 'call_1',
            name: 'weather',
            params: {}
          }),
          ToolCall.make({
            id: 'question-call',
            name: 'question',
            params: {
              questions: [{ id: 'choice', prompt: 'Pick one', options: [{ id: 'a', label: 'A' }] }]
            }
          })
        ],
        tools: [
          ToolDef.make({
            name: 'weather',
            description: 'Get weather.',
            parameters: {},
            approval: ToolApprovalPolicy.make({ mode: 'manual' })
          }),
          ToolDef.make({ name: 'question', description: 'Ask', parameters: {} })
        ]
      })
      expect(outcome._tag).toBe('AwaitingInput')
      if (outcome._tag !== 'AwaitingInput') return
      const approval = outcome.requests.find(request => request._tag === 'ToolApprovalRequest')
      const question = outcome.requests.find(request => request._tag === 'QuestionRequest')
      expect(approval !== undefined && question !== undefined).toBe(true)
      if (approval === undefined || question === undefined) return

      expect(
        matchHitlResponse(
          outcome.requests,
          ToolApprovalResponse.make({
            requestId: approval.requestId,
            toolCallId: approval.toolCallId,
            decision: 'approved',
            source: 'user'
          })
        )
      ).toEqual({ _tag: 'Match', requestId: approval.requestId })

      expect(
        matchHitlResponse(
          outcome.requests,
          ToolApprovalResponse.make({
            requestId: approval.requestId,
            toolCallId: 'other-call',
            decision: 'approved',
            source: 'user'
          })
        )._tag
      ).toBe('Mismatch')

      expect(
        matchHitlResponse(
          outcome.requests,
          QuestionResponse.make({
            requestId: question.requestId,
            toolCallId: question.toolCallId,
            outcome: 'answered',
            source: 'user',
            answers: [QuestionAnswer.make({ questionId: 'choice', optionIds: ['a'] })]
          })
        )
      ).toEqual({ _tag: 'Match', requestId: question.requestId })

      const resumed = yield* Ref.make(false)
      const skipped = yield* resumeHitlIfMatched({
        pending: outcome.requests,
        response: ToolApprovalResponse.make({
          requestId: 'missing',
          toolCallId: approval.toolCallId,
          decision: 'approved',
          source: 'user'
        }),
        resume: () => Ref.set(resumed, true).pipe(Effect.as({ _tag: 'Resumed' as const }))
      })
      expect(skipped).toEqual({ _tag: 'Mismatch' })
      expect(yield* Ref.get(resumed)).toBe(false)
    }).pipe(
      Effect.provide(
        Layer.mergeAll(TestToolExecutor.layer({ weather: '72F' }), LoopConfig.defaultLayer)
      )
    )
  )

  it.effect(
    'resumes approval and question through matching hitlResponses without mixed execution',
    () =>
      Effect.gen(function* () {
        const calls = [
          ToolCall.make({ id: 'call_1', name: 'weather', params: {} }),
          ToolCall.make({
            id: 'question-call',
            name: 'question',
            params: {
              questions: [{ id: 'choice', prompt: 'Pick one', options: [{ id: 'a', label: 'A' }] }]
            }
          })
        ]
        const tools = [
          ToolDef.make({
            name: 'weather',
            description: 'Get weather.',
            parameters: {},
            approval: ToolApprovalPolicy.make({ mode: 'manual' })
          }),
          ToolDef.make({ name: 'question', description: 'Ask', parameters: {} })
        ]
        const paused = yield* attemptToolBatch({ calls, tools })
        expect(paused._tag).toBe('AwaitingInput')
        if (paused._tag !== 'AwaitingInput') return
        const approval = paused.requests.find(request => request._tag === 'ToolApprovalRequest')
        const question = paused.requests.find(request => request._tag === 'QuestionRequest')
        expect(approval).toBeDefined()
        expect(question).toBeDefined()
        if (approval === undefined || question === undefined) return

        const partial = yield* attemptToolBatch({
          calls,
          tools,
          hitlResponses: [
            ToolApprovalResponse.make({
              requestId: approval.requestId,
              toolCallId: approval.toolCallId,
              decision: 'approved',
              source: 'user'
            })
          ]
        })
        expect(partial._tag).toBe('AwaitingInput')
        if (partial._tag !== 'AwaitingInput') return
        expect('toolCalls' in partial).toBe(false)

        const completed = yield* attemptToolBatch({
          calls,
          tools,
          hitlResponses: [
            ToolApprovalResponse.make({
              requestId: approval.requestId,
              toolCallId: approval.toolCallId,
              decision: 'approved',
              source: 'user'
            }),
            QuestionResponse.make({
              requestId: question.requestId,
              toolCallId: question.toolCallId,
              outcome: 'answered',
              source: 'user',
              answers: [QuestionAnswer.make({ questionId: 'choice', optionIds: ['a'] })]
            })
          ]
        })
        expect(completed._tag).toBe('Completed')
        if (completed._tag !== 'Completed') return
        expect(completed.toolCalls.some(call => call.id === 'call_1')).toBe(true)
      }).pipe(
        Effect.provide(
          Layer.mergeAll(TestToolExecutor.layer({ weather: '72F' }), LoopConfig.defaultLayer)
        )
      )
  )
})
