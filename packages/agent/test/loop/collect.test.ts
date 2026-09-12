import { Effect, Layer, Ref, Stream } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import {
  AgentInputUsage,
  AgentOutputUsage,
  AgentUsage,
  assistantContent,
  assistantReasoningText,
  LLMTextDelta as AgentLLMTextDelta,
  ToolDef,
  UserMessage,
  type AgentEvent,
  type AgentMessage
} from '@yolk-sdk/agent/protocol'
import {
  collectModelTurn,
  collectModelTurnAttempt,
  LLMError,
  LLMProvider,
  LLMReasoningDelta,
  LLMTextDelta,
  makeAgentLoopLayer,
  runModelTurn
} from '../../src/loop'
import { LLMUsage } from '../../src/loop/llm-event'
import { FauxProvider, Reply, type FauxResponse } from '../../src/loop/testing'

const modelTurnLayer = (...responses: ReadonlyArray<FauxResponse>) =>
  makeAgentLoopLayer({
    provider: FauxProvider.layer(...responses)
  })

const assistantMessageFromResult = (message: AgentMessage | undefined) => {
  if (message === undefined || message._tag !== 'Assistant') {
    throw new Error('Expected assistant message')
  }

  return message
}

describe('collectModelTurn', () => {
  it.effect('folds a text reply', () =>
    Effect.gen(function* () {
      const result = yield* collectModelTurn(
        runModelTurn({
          messages: [UserMessage.make({ content: 'hello' })],
          systemPrompt: 'Be brief.',
          tools: [],
          model: 'faux',
          turn: 1
        })
      ).pipe(Effect.provide(modelTurnLayer(Reply.text('ok'))))

      expect(result.stopReason).toBe('stop')
      expect(result.toolCalls).toEqual([])
      expect(result.usage).toEqual(
        AgentUsage.make({
          input: AgentInputUsage.make({ total: 0 }),
          output: AgentOutputUsage.make({ total: 0 })
        })
      )
      expect(assistantContent(assistantMessageFromResult(result.assistantMessage))).toBe('ok')
    })
  )

  it.effect('folds a tool-call reply', () =>
    Effect.gen(function* () {
      const result = yield* collectModelTurn(
        runModelTurn({
          messages: [UserMessage.make({ content: 'what is the weather?' })],
          systemPrompt: 'Use tools when useful.',
          tools: [ToolDef.make({ name: 'weather', description: 'Get weather.', parameters: {} })],
          model: 'faux',
          turn: 1
        })
      ).pipe(
        Effect.provide(
          modelTurnLayer(Reply.toolCall({ id: 'call_1', name: 'weather', params: {} }))
        )
      )

      expect(result.stopReason).toBe('tool_use')
      expect(result.toolCalls).toEqual([expect.objectContaining({ id: 'call_1', name: 'weather' })])
      expect(result.assistantMessage).toBeDefined()
    })
  )

  it.effect('runs onEvent after each fold update in order', () =>
    Effect.gen(function* () {
      const seen = yield* Ref.make<ReadonlyArray<string>>([])
      const result = yield* collectModelTurn(
        runModelTurn({
          messages: [UserMessage.make({ content: 'hello' })],
          systemPrompt: 'Be brief.',
          tools: [],
          model: 'faux',
          turn: 1
        }),
        {
          onEvent: (event: AgentEvent) => Ref.update(seen, tags => [...tags, event._tag])
        }
      ).pipe(Effect.provide(modelTurnLayer(Reply.text('ok'))))

      expect(yield* Ref.get(seen)).toEqual([
        'TurnStart',
        'LLMStreamStart',
        'LLMTextDelta',
        'LLMTextDelta',
        'LLMStreamEnd',
        'AssistantMessage',
        'TurnEnd'
      ])
      expect(result.stopReason).toBe('stop')
      expect(assistantContent(assistantMessageFromResult(result.assistantMessage))).toBe('ok')
    })
  )

  it.effect('adds usage onto initialUsage', () =>
    Effect.gen(function* () {
      const initialUsage = AgentUsage.make({
        input: AgentInputUsage.make({ total: 5 }),
        output: AgentOutputUsage.make({ total: 1 })
      })
      const result = yield* collectModelTurn(
        runModelTurn({
          messages: [UserMessage.make({ content: 'hello' })],
          systemPrompt: 'Be brief.',
          tools: [],
          model: 'faux',
          turn: 1
        }),
        { initialUsage }
      ).pipe(
        Effect.provide(
          modelTurnLayer({
            events: [
              LLMUsage.make({
                usage: AgentUsage.make({
                  input: AgentInputUsage.make({ total: 10 }),
                  output: AgentOutputUsage.make({ total: 3 })
                })
              }),
              ...Reply.text('ok').events
            ]
          })
        )
      )

      expect(result.usage).toEqual(
        AgentUsage.make({
          input: AgentInputUsage.make({ total: 15 }),
          output: AgentOutputUsage.make({ total: 4 })
        })
      )
      expect(result.stopReason).toBe('stop')
    })
  )
})

describe('collectModelTurnAttempt', () => {
  const loopLayer = makeAgentLoopLayer({
    provider: Layer.succeed(
      LLMProvider,
      LLMProvider.of({
        stream: () => Stream.make(LLMTextDelta.make({ text: 'partial' }))
      })
    )
  })

  it.effect('preserves partial text and outputStarted on incomplete streams', () =>
    Effect.gen(function* () {
      const outcome = yield* collectModelTurnAttempt(
        runModelTurn({
          messages: [UserMessage.make({ content: 'hello' })],
          systemPrompt: 'Be brief.',
          tools: [],
          model: 'faux',
          turn: 1
        })
      )

      expect(outcome._tag).toBe('StreamFailed')
      if (outcome._tag !== 'StreamFailed') return
      expect(outcome.error).toMatchObject({
        _tag: 'LLMError',
        responseIssue: 'missing_done'
      })
      expect(outcome.collection.outputStarted).toBe(true)
      expect(outcome.collection.assistantMessage).toBeUndefined()
      if (outcome.collection.partialAssistantMessage?._tag !== 'Assistant') return
      expect(assistantContent(outcome.collection.partialAssistantMessage)).toBe('partial')
    }).pipe(Effect.provide(loopLayer))
  )

  it.effect('distinguishes onEvent sink failures from stream failures', () =>
    Effect.gen(function* () {
      const sinkError = new LLMError({
        cause: 'rate_limit',
        message: 'sink',
        retryable: true
      })
      const outcome = yield* collectModelTurnAttempt(
        runModelTurn({
          messages: [UserMessage.make({ content: 'hello' })],
          systemPrompt: 'Be brief.',
          tools: [],
          model: 'faux',
          turn: 1
        }),
        { onEvent: () => Effect.fail(sinkError) }
      ).pipe(Effect.provide(modelTurnLayer(Reply.text('ok'))))

      expect(outcome._tag).toBe('SinkFailed')
      if (outcome._tag !== 'SinkFailed') return
      expect(outcome.error).toBe(sinkError)
    })
  )

  it.effect('marks reasoning deltas as output started', () =>
    Effect.gen(function* () {
      const outcome = yield* collectModelTurnAttempt(
        runModelTurn({
          messages: [UserMessage.make({ content: 'hello' })],
          systemPrompt: 'Be brief.',
          tools: [],
          model: 'faux',
          turn: 1
        })
      ).pipe(
        Effect.provide(
          makeAgentLoopLayer({
            provider: Layer.succeed(
              LLMProvider,
              LLMProvider.of({
                stream: () => Stream.make(LLMReasoningDelta.make({ text: 'thinking' }))
              })
            )
          })
        )
      )

      expect(outcome._tag).toBe('StreamFailed')
      if (outcome._tag !== 'StreamFailed') return
      expect(outcome.collection.outputStarted).toBe(true)
      expect(outcome.collection.assistantMessage).toBeUndefined()
      if (outcome.collection.partialAssistantMessage?._tag !== 'Assistant') return
      expect(assistantReasoningText(outcome.collection.partialAssistantMessage)).toBe('thinking')
    })
  )

  it.effect('does not treat a forged sink tag as an onEvent failure', () =>
    Effect.gen(function* () {
      const forged = { _tag: 'CollectModelTurnSinkError', error: 'forged' }
      const outcome = yield* collectModelTurnAttempt(Stream.fail(forged))

      expect(outcome._tag).toBe('StreamFailed')
      if (outcome._tag !== 'StreamFailed') return
      expect(outcome.error).toBe(forged)
    })
  )
})

describe('collectModelTurn legacy success', () => {
  it.effect('does not invent assistantMessage from raw deltas', () =>
    Effect.gen(function* () {
      const result = yield* collectModelTurn(
        Stream.make(AgentLLMTextDelta.make({ text: 'partial' }))
      )

      expect(result.assistantMessage).toBeUndefined()
      expect(result.stopReason).toBe('stop')
    })
  )
})
