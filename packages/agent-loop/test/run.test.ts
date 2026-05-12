import { Effect, Layer, Option, Stream } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import {
  AgentContentCapabilities,
  assistantContent,
  assistantReasoningText,
  CompactionEnd,
  CompactionStart,
  AgentModelCapabilities,
  ImagePart,
  ToolCall,
  ToolDef,
  ToolResult,
  UserMessage
} from '@yolk/protocol'
import type { AssistantAgentMessage } from '@yolk/protocol'
import {
  ContextTransformer,
  LLMDone,
  LLMError,
  LLMProvider,
  LLMProviderToolResult,
  LLMTextDelta,
  LLMToolInputDelta,
  LLMToolInputStart,
  LLMToolCall,
  LoopConfig,
  run,
  type LLMRequest
} from '../src'
import { FauxProvider, Reply, TestToolExecutor } from '../src/testing'

const BaseLayer = Layer.mergeAll(ContextTransformer.identity, LoopConfig.defaultLayer)

const noToolReasoningCapabilities = AgentModelCapabilities.make({
  input: AgentContentCapabilities.make({ text: true, image: false, audio: false }),
  tools: false,
  reasoning: false
})

const assistantMessageFromEvents = (events: ReadonlyArray<{ readonly _tag: string }>) => {
  const event = events.find(
    (candidate): candidate is { readonly _tag: 'AssistantMessage'; readonly message: AssistantAgentMessage } =>
      candidate._tag === 'AssistantMessage'
  )

  if (event === undefined) {
    throw new Error('Expected assistant message')
  }

  return event.message
}

describe('run', () => {
  it.effect('emits a text-only event sequence', () =>
    Effect.gen(function* () {
      const eventsChunk = yield* run({
        messages: [UserMessage.make({ content: 'hello' })],
        systemPrompt: 'Be brief.',
        tools: [],
        model: 'faux'
      }).pipe(
        Stream.runCollect,
        Effect.provide(
          Layer.mergeAll(FauxProvider.layer(Reply.text('ok')), TestToolExecutor.layer({})).pipe(
            Layer.provideMerge(BaseLayer)
          )
        )
      )

      const events = Array.from(eventsChunk)
      expect(events.map(event => event._tag)).toEqual([
        'AgentStart',
        'TurnStart',
        'LLMStreamStart',
        'LLMTextDelta',
        'LLMTextDelta',
        'LLMStreamEnd',
        'AssistantMessage',
        'TurnEnd',
        'AgentEnd'
      ])

      expect(assistantContent(assistantMessageFromEvents(events))).toBe('ok')
    })
  )

  it.effect('emits reasoning deltas and stores assistant reasoning', () =>
    Effect.gen(function* () {
      const eventsChunk = yield* run({
        messages: [UserMessage.make({ content: 'hello' })],
        systemPrompt: 'Be brief.',
        tools: [],
        model: 'faux'
      }).pipe(
        Stream.runCollect,
        Effect.provide(
          Layer.mergeAll(
            FauxProvider.layer(Reply.reasoningText('thinking', 'ok')),
            TestToolExecutor.layer({})
          ).pipe(Layer.provideMerge(BaseLayer))
        )
      )

      const events = Array.from(eventsChunk)
      expect(events.map(event => event._tag)).toEqual([
        'AgentStart',
        'TurnStart',
        'LLMStreamStart',
        'LLMReasoningDelta',
        'LLMTextDelta',
        'LLMTextDelta',
        'LLMStreamEnd',
        'AssistantMessage',
        'TurnEnd',
        'AgentEnd'
      ])
      const assistant = assistantMessageFromEvents(events)
      expect(assistantContent(assistant)).toBe('ok')
      expect(assistantReasoningText(assistant)).toBe('thinking')
    })
  )

  it.effect('emits LLM deltas before provider completes', () =>
    Effect.gen(function* () {
      const streamingProvider = Layer.succeed(
        LLMProvider,
        LLMProvider.of({
          stream: () =>
            Stream.make(LLMTextDelta.make({ text: 'o' })).pipe(Stream.concat(Stream.never))
        })
      )
      const eventsOption = yield* run({
        messages: [UserMessage.make({ content: 'hello' })],
        systemPrompt: 'Be brief.',
        tools: [],
        model: 'faux'
      }).pipe(
        Stream.take(4),
        Stream.runCollect,
        Effect.provide(
          Layer.mergeAll(streamingProvider, TestToolExecutor.layer({})).pipe(
            Layer.provideMerge(BaseLayer)
          )
        ),
        Effect.timeoutOption('1 second')
      )

      if (Option.isNone(eventsOption)) {
        expect.fail('Expected LLM delta before provider completion')
      }

      const events = Array.from(eventsOption.value)
      expect(events.map(event => event._tag)).toEqual([
        'AgentStart',
        'TurnStart',
        'LLMStreamStart',
        'LLMTextDelta'
      ])
      expect(events[3]).toMatchObject({ text: 'o' })
    })
  )

  it.effect('executes tools and continues until stop', () =>
    Effect.gen(function* () {
      const eventsChunk = yield* run({
        messages: [UserMessage.make({ content: 'what is the weather?' })],
        systemPrompt: 'Use tools when useful.',
        tools: [
          ToolDef.make({
            name: 'weather',
            description: 'Get weather.',
            parameters: {}
          })
        ],
        model: 'faux'
      }).pipe(
        Stream.runCollect,
        Effect.provide(
          Layer.mergeAll(
            FauxProvider.layer(
              Reply.toolCall({ id: 'call_1', name: 'weather', params: { city: 'Paris' } }),
              Reply.text('sunny')
            ),
            TestToolExecutor.layer({ weather: '72F' })
          ).pipe(Layer.provideMerge(BaseLayer))
        )
      )

      const events = Array.from(eventsChunk)
      expect(events.map(event => event._tag)).toEqual([
        'AgentStart',
        'TurnStart',
        'LLMStreamStart',
        'ToolInputEnd',
        'LLMStreamEnd',
        'AssistantMessage',
        'ToolExecutionStarted',
        'ToolExecutionCompleted',
        'TurnEnd',
        'TurnStart',
        'LLMStreamStart',
        'LLMTextDelta',
        'LLMTextDelta',
        'LLMTextDelta',
        'LLMTextDelta',
        'LLMTextDelta',
        'LLMStreamEnd',
        'AssistantMessage',
        'TurnEnd',
        'AgentEnd'
      ])

      const agentEnd = events.find(event => event._tag === 'AgentEnd')
      expect(agentEnd).toMatchObject({ turns: 2 })
    })
  )

  it.effect('streams provider tool input and preserves provider-executed results without local dispatch', () =>
    Effect.gen(function* () {
      const call = ToolCall.make({ id: 'call_1', name: 'web_search', params: { q: 'weather' } })
      const result = ToolResult.make({ toolCallId: call.id, content: 'sunny' })
      const provider = Layer.succeed(
        LLMProvider,
        LLMProvider.of({
          stream: () =>
            Stream.fromIterable([
              LLMToolInputStart.make({ id: call.id, name: call.name }),
              LLMToolInputDelta.make({ id: call.id, delta: '{"q":"weather"}' }),
              LLMProviderToolResult.make({ call, result }),
              LLMDone.make({ stopReason: 'stop' })
            ])
        })
      )

      const eventsChunk = yield* run({
        messages: [UserMessage.make({ content: 'search' })],
        systemPrompt: 'Use hosted tools when useful.',
        tools: [],
        model: 'faux'
      }).pipe(
        Stream.runCollect,
        Effect.provide(
          Layer.mergeAll(provider, TestToolExecutor.layer({ web_search: 'should not run' })).pipe(
            Layer.provideMerge(BaseLayer)
          )
        )
      )

      const events = Array.from(eventsChunk)
      const assistant = assistantMessageFromEvents(events)

      expect(events.map(event => event._tag)).toEqual([
        'AgentStart',
        'TurnStart',
        'LLMStreamStart',
        'ToolInputStart',
        'ToolInputDelta',
        'ProviderToolResult',
        'LLMStreamEnd',
        'AssistantMessage',
        'TurnEnd',
        'AgentEnd'
      ])
      expect(assistant.parts.map(part => part._tag)).toEqual(['ProviderToolCall', 'ProviderToolResult'])
      expect(events.find(event => event._tag === 'ToolExecutionStarted')).toBeUndefined()
    })
  )

  it.effect('fails when faux responses are exhausted', () =>
    Effect.gen(function* () {
      const result = yield* run({
        messages: [UserMessage.make({ content: 'loop' })],
        systemPrompt: 'Use tools forever.',
        tools: [ToolDef.make({ name: 'repeat', description: 'Repeat.', parameters: {} })],
        model: 'faux'
      }).pipe(
        Stream.runCollect,
        Effect.provide(
          Layer.mergeAll(
            FauxProvider.layer(Reply.toolCall({ id: 'call_1', name: 'repeat', params: {} })),
            TestToolExecutor.layer({ repeat: 'again' })
          ).pipe(Layer.provideMerge(BaseLayer))
        ),
        Effect.result
      )

      expect(result).toMatchObject({ _tag: 'Failure', failure: { _tag: 'FauxExhaustedError' } })
    })
  )

  it.effect('fails when max turns is reached', () =>
    Effect.gen(function* () {
      const result = yield* run({
        messages: [UserMessage.make({ content: 'loop' })],
        systemPrompt: 'Use tools forever.',
        tools: [ToolDef.make({ name: 'repeat', description: 'Repeat.', parameters: {} })],
        model: 'faux'
      }).pipe(
        Stream.runCollect,
        Effect.provide(
          Layer.mergeAll(
            FauxProvider.layer(
              Reply.toolCall({ id: 'call_1', name: 'repeat', params: {} }),
              Reply.toolCall({ id: 'call_2', name: 'repeat', params: {} })
            ),
            TestToolExecutor.layer({ repeat: 'again' })
          ).pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                ContextTransformer.identity,
                LoopConfig.layer({ maxTurns: 1, maxRetries: 2, retryBaseDelayMs: 1000 })
              )
            )
          )
        ),
        Effect.result
      )

      expect(result).toMatchObject({ _tag: 'Failure', failure: { _tag: 'AbortError' } })
    })
  )

  it.effect('fails before provider call when input exceeds model capabilities', () =>
    Effect.gen(function* () {
      const requests: Array<LLMRequest> = []
      const result = yield* run({
        messages: [
          UserMessage.make({
            content: [ImagePart.make({ data: 'abc', mimeType: 'image/png' })]
          })
        ],
        systemPrompt: 'Be brief.',
        tools: [],
        model: 'faux',
        capabilities: noToolReasoningCapabilities
      }).pipe(
        Stream.runCollect,
        Effect.provide(
          Layer.mergeAll(
            FauxProvider.layerWithRequests({ responses: [Reply.text('ok')], requests }),
            TestToolExecutor.layer({})
          ).pipe(Layer.provideMerge(BaseLayer))
        ),
        Effect.result
      )

      expect(result).toMatchObject({
        _tag: 'Failure',
        failure: {
          _tag: 'LLMError',
          cause: 'validation_error',
          message: 'Image input is not supported by this model',
          retryable: false
        }
      })
      expect(requests).toEqual([])
    })
  )

  it.effect('fails before provider call when tools are unsupported', () =>
    Effect.gen(function* () {
      const result = yield* run({
        messages: [UserMessage.make({ content: 'hello' })],
        systemPrompt: 'Be brief.',
        tools: [ToolDef.make({ name: 'weather', description: 'Get weather.', parameters: {} })],
        model: 'faux',
        capabilities: noToolReasoningCapabilities
      }).pipe(
        Stream.runCollect,
        Effect.provide(
          Layer.mergeAll(FauxProvider.layer(Reply.text('ok')), TestToolExecutor.layer({})).pipe(
            Layer.provideMerge(BaseLayer)
          )
        ),
        Effect.result
      )

      expect(result).toMatchObject({
        _tag: 'Failure',
        failure: {
          _tag: 'LLMError',
          cause: 'validation_error',
          message: 'Tools are not supported by this model'
        }
      })
    })
  )

  it.effect('transforms context before LLM requests', () =>
    Effect.gen(function* () {
      const requests: Array<LLMRequest> = []
      const eventsChunk = yield* run({
        messages: [UserMessage.make({ content: 'hello' })],
        systemPrompt: 'Be brief.',
        tools: [],
        model: 'faux'
      }).pipe(
        Stream.runCollect,
        Effect.provide(
          Layer.mergeAll(
            FauxProvider.layerWithRequests({ responses: [Reply.text('ok')], requests }),
            TestToolExecutor.layer({})
          ).pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                LoopConfig.defaultLayer,
                Layer.succeed(
                  ContextTransformer,
                  ContextTransformer.of({
                    transform: messages =>
                      Effect.succeed({
                        messages: [UserMessage.make({ content: 'context' }), ...messages],
                        events: []
                      })
                  })
                )
              )
            )
          )
        )
      )

      const events = Array.from(eventsChunk)
      expect(requests).toMatchObject([{ messages: [{ content: 'context' }, { content: 'hello' }] }])
      expect(assistantContent(assistantMessageFromEvents(events))).toBe('ok')
    })
  )

  it.effect('emits context transform lifecycle events', () =>
    Effect.gen(function* () {
      const eventsChunk = yield* run({
        messages: [UserMessage.make({ content: 'hello' })],
        systemPrompt: 'Be brief.',
        tools: [],
        model: 'faux'
      }).pipe(
        Stream.runCollect,
        Effect.provide(
          Layer.mergeAll(FauxProvider.layer(Reply.text('ok')), TestToolExecutor.layer({})).pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                LoopConfig.defaultLayer,
                Layer.succeed(
                  ContextTransformer,
                  ContextTransformer.of({
                    transform: messages =>
                      Effect.succeed({
                        messages,
                        events: [
                          CompactionStart.make({ strategy: 'test' }),
                          CompactionEnd.make({
                            strategy: 'test',
                            beforeTokens: 100,
                            afterTokens: 50
                          })
                        ]
                      })
                  })
                )
              )
            )
          )
        )
      )

      const events = Array.from(eventsChunk)
      expect(events.map(event => event._tag)).toEqual([
        'AgentStart',
        'TurnStart',
        'LLMStreamStart',
        'CompactionStart',
        'CompactionEnd',
        'LLMTextDelta',
        'LLMTextDelta',
        'LLMStreamEnd',
        'AssistantMessage',
        'TurnEnd',
        'AgentEnd'
      ])
    })
  )

  it.effect('emits usage updates and final usage totals', () =>
    Effect.gen(function* () {
      const eventsChunk = yield* run({
        messages: [UserMessage.make({ content: 'hello' })],
        systemPrompt: 'Be brief.',
        tools: [],
        model: 'faux'
      }).pipe(
        Stream.runCollect,
        Effect.provide(
          Layer.mergeAll(
            FauxProvider.layer(Reply.usage({ input: 10, output: 3 })),
            TestToolExecutor.layer({})
          ).pipe(Layer.provideMerge(BaseLayer))
        )
      )

      const events = Array.from(eventsChunk)
      expect(events.map(event => event._tag)).toContain('UsageUpdate')
      expect(events.find(event => event._tag === 'AgentEnd')).toMatchObject({
        usage: { input: { total: 10 }, output: { total: 3 } }
      })
    })
  )

  it.effect('retries retryable provider errors before failing the turn', () =>
    Effect.gen(function* () {
      let calls = 0
      const provider = Layer.succeed(
        LLMProvider,
        LLMProvider.of({
          stream: () => {
            calls++
            if (calls === 1) {
              return Stream.fail(
                new LLMError({
                  cause: 'rate_limit',
                  message: 'slow down',
                  retryable: true
                })
              )
            }

            return Stream.fromIterable(Reply.text('ok').events)
          }
        })
      )

      const eventsChunk = yield* run({
        messages: [UserMessage.make({ content: 'hello' })],
        systemPrompt: 'Be brief.',
        tools: [],
        model: 'faux'
      }).pipe(
        Stream.runCollect,
        Effect.provide(
          Layer.mergeAll(provider, TestToolExecutor.layer({})).pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                ContextTransformer.identity,
                LoopConfig.layer({ maxTurns: 500, maxRetries: 1, retryBaseDelayMs: 0 })
              )
            )
          )
        )
      )

      const events = Array.from(eventsChunk)
      expect(calls).toBe(2)
      expect(events.find(event => event._tag === 'AgentRetry')).toMatchObject({
        attempt: 1,
        reason: 'rate_limit',
        delayMs: 0
      })
      expect(assistantContent(assistantMessageFromEvents(events))).toBe('ok')
    })
  )

  it.effect('fails invalid provider stream without done event', () =>
    Effect.gen(function* () {
      const provider = Layer.succeed(
        LLMProvider,
        LLMProvider.of({
          stream: () => Stream.make(LLMTextDelta.make({ text: 'o' }))
        })
      )

      const result = yield* run({
        messages: [UserMessage.make({ content: 'hello' })],
        systemPrompt: 'Be brief.',
        tools: [],
        model: 'faux'
      }).pipe(
        Stream.runCollect,
        Effect.provide(
          Layer.mergeAll(provider, TestToolExecutor.layer({})).pipe(Layer.provideMerge(BaseLayer))
        ),
        Effect.result
      )

      expect(result).toMatchObject({
        _tag: 'Failure',
        failure: {
          _tag: 'LLMError',
          cause: 'invalid_response',
          message: 'Expected exactly one LLM done event, received 0'
        }
      })
    })
  )

  it.effect('fails invalid provider done reason', () =>
    Effect.gen(function* () {
      const provider = Layer.succeed(
        LLMProvider,
        LLMProvider.of({
          stream: () =>
            Stream.fromIterable([
              LLMToolCall.make({
                call: ToolCall.make({ id: 'call_1', name: 'weather', params: {} })
              }),
              LLMDone.make({ stopReason: 'stop' })
            ])
        })
      )

      const result = yield* run({
        messages: [UserMessage.make({ content: 'hello' })],
        systemPrompt: 'Be brief.',
        tools: [ToolDef.make({ name: 'weather', description: 'Get weather.', parameters: {} })],
        model: 'faux'
      }).pipe(
        Stream.runCollect,
        Effect.provide(
          Layer.mergeAll(provider, TestToolExecutor.layer({ weather: '72F' })).pipe(
            Layer.provideMerge(BaseLayer)
          )
        ),
        Effect.result
      )

      expect(result).toMatchObject({
        _tag: 'Failure',
        failure: {
          _tag: 'LLMError',
          cause: 'invalid_response',
          message: 'LLM done reason must be tool_use'
        }
      })
    })
  )
})
