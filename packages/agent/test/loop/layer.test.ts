import { Effect, Layer, Stream } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { ToolCall, UserMessage } from '@yolk-sdk/agent/protocol'
import {
  ContextTransformer,
  decorateLLMProvider,
  LLMProvider,
  LoopConfig,
  makeAgentLoopLayer,
  runModelTurn,
  ToolExecutor
} from '../../src/loop'
import { FauxProvider, Reply, TestToolExecutor } from '../../src/loop/testing'

describe('makeAgentLoopLayer', () => {
  it.effect('provides all four loop services', () =>
    Effect.gen(function* () {
      yield* LLMProvider
      yield* ToolExecutor
      yield* ContextTransformer
      const config = yield* LoopConfig

      expect(config.maxTurns).toBe(7)
      expect(config.toolConcurrency).toBe(2)
    }).pipe(
      Effect.provide(
        makeAgentLoopLayer({
          provider: FauxProvider.layer(Reply.text('ok')),
          tools: TestToolExecutor.layer({ weather: '72F' }),
          transformer: ContextTransformer.identity,
          config: LoopConfig.layer({
            maxTurns: 7,
            maxRetries: 1,
            retryBaseDelayMs: 10,
            toolConcurrency: 2
          })
        })
      )
    )
  )

  it.effect('defaults transformer, config, and unavailable tools', () =>
    Effect.gen(function* () {
      const transformer = yield* ContextTransformer
      const config = yield* LoopConfig
      const executor = yield* ToolExecutor
      const transformed = yield* transformer.transform([UserMessage.make({ content: 'hello' })])

      const result = yield* executor
        .execute(ToolCall.make({ id: 'call_1', name: 'weather', params: {} }))
        .pipe(Effect.result)

      expect(transformed.events).toEqual([])
      expect(transformed.messages).toHaveLength(1)
      expect(config.maxTurns).toBe(500)
      expect(config.maxRetries).toBe(2)
      expect(config.retryBaseDelayMs).toBe(2000)
      expect(config.toolConcurrency).toBe(4)
      expect(result).toMatchObject({
        _tag: 'Failure',
        failure: {
          _tag: 'ToolError',
          tool: 'weather',
          cause: 'execution'
        }
      })
    }).pipe(
      Effect.provide(
        makeAgentLoopLayer({
          provider: FauxProvider.layer(Reply.text('ok'))
        })
      )
    )
  )
})

describe('decorateLLMProvider', () => {
  it.effect('wraps the provider stream', () =>
    Effect.gen(function* () {
      let streams = 0

      const eventsChunk = yield* runModelTurn({
        messages: [UserMessage.make({ content: 'hello' })],
        systemPrompt: 'Be brief.',
        tools: [],
        model: 'faux',
        turn: 1
      }).pipe(
        Stream.runCollect,
        Effect.provide(
          makeAgentLoopLayer({
            provider: decorateLLMProvider(provider =>
              LLMProvider.of({
                stream: request => {
                  streams += 1

                  return provider.stream(request)
                }
              })
            ).pipe(Layer.provide(FauxProvider.layer(Reply.text('ok'))))
          })
        )
      )

      expect(streams).toBe(1)
      expect(Array.from(eventsChunk).map(event => event._tag)).toEqual([
        'TurnStart',
        'LLMStreamStart',
        'LLMTextDelta',
        'LLMTextDelta',
        'LLMStreamEnd',
        'AssistantMessage',
        'TurnEnd'
      ])
    })
  )

  it.effect('accepts an Effect-returning decorator', () => {
    let streams = 0

    return Effect.gen(function* () {
      const provider = yield* LLMProvider
      yield* provider
        .stream({
          messages: [UserMessage.make({ content: 'hello' })],
          tools: [],
          model: 'faux',
          systemPrompt: 'Be brief.'
        })
        .pipe(Stream.runDrain)

      expect(streams).toBe(1)
    }).pipe(
      Effect.provide(
        decorateLLMProvider(provider =>
          Effect.succeed(
            LLMProvider.of({
              stream: request => {
                streams += 1

                return provider.stream(request)
              }
            })
          )
        ).pipe(Layer.provide(FauxProvider.layer(Reply.text('ok'))))
      )
    )
  })
})
