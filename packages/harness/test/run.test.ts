import { Effect, Layer, Stream } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { ToolDef, UserMessage } from '@yolk/protocol'
import {
  ContextTransformer,
  FauxProvider,
  LoopConfig,
  Reply,
  TestToolExecutor,
  run,
  type LLMRequest
} from '../src'

const BaseLayer = Layer.mergeAll(ContextTransformer.identity, LoopConfig.defaultLayer)

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
          Layer.mergeAll(FauxProvider.layer(Reply.text('ok')), TestToolExecutor.layer({}))
            .pipe(Layer.provideMerge(BaseLayer))
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
    }))

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
    }))

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
    }))

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
    }))

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
      expect(requests).toMatchObject([
        { messages: [{ content: 'context' }, { content: 'hello' }] }
      ])
      expect(events.find(event => event._tag === 'AssistantMessage')).toMatchObject({
        message: { content: 'ok' }
      })
    }))
})
