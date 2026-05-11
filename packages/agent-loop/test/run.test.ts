import { Effect, Layer, Option, Stream } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import {
  AgentContentCapabilities,
  AgentModelCapabilities,
  ImagePart,
  ToolDef,
  UserMessage
} from '@yolk/protocol'
import {
  ContextTransformer,
  FauxProvider,
  LLMProvider,
  LLMTextDelta,
  LoopConfig,
  Reply,
  TestToolExecutor,
  run,
  type LLMRequest
} from '../src'

const BaseLayer = Layer.mergeAll(ContextTransformer.identity, LoopConfig.defaultLayer)

const noToolReasoningCapabilities = AgentModelCapabilities.make({
  input: AgentContentCapabilities.make({ text: true, image: false, audio: false }),
  tools: false,
  reasoning: false
})

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

      const assistant = events.find(event => event._tag === 'AssistantMessage')
      expect(assistant).toMatchObject({ message: { content: 'ok' } })
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
      expect(events.find(event => event._tag === 'AssistantMessage')).toMatchObject({
        message: { content: 'ok', reasoning: 'thinking' }
      })
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
        'LLMToolCall',
        'LLMStreamEnd',
        'AssistantMessage',
        'ToolExecutionStart',
        'ToolExecutionEnd',
        'ToolResult',
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
              Layer.mergeAll(ContextTransformer.identity, LoopConfig.layer({ maxTurns: 1 }))
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
        failure: { _tag: 'LLMError', message: 'Tools are not supported by this model' }
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
                      Effect.succeed([UserMessage.make({ content: 'context' }), ...messages])
                  })
                )
              )
            )
          )
        )
      )

      const events = Array.from(eventsChunk)
      expect(requests).toMatchObject([{ messages: [{ content: 'context' }, { content: 'hello' }] }])
      expect(events.find(event => event._tag === 'AssistantMessage')).toMatchObject({
        message: { content: 'ok' }
      })
    })
  )
})
