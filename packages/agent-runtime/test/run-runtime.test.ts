import { Effect, Layer, Stream } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { AssistantAgentMessage, UserMessage, textOnlyModelCapabilities } from '@yolk/protocol'
import { ContextTransformer, LoopConfig, type LLMRequest } from '@yolk/agent-loop'
import { FauxProvider, Reply, TestToolExecutor } from '@yolk/agent-loop/testing'
import {
  runRuntime,
  SessionStore,
  type RuntimeConfig,
  type RuntimeTranscript,
  type SessionSnapshot
} from '../src'

const runtimeConfig: RuntimeConfig = {
  systemPrompt: 'Be brief.',
  tools: [],
  model: 'faux'
}

const makeAgentLoopLayer = (
  requests: Array<LLMRequest> = [],
  responses: Parameters<typeof FauxProvider.layerWithRequests>[0]['responses'] = [Reply.text('ok')]
) =>
  Layer.mergeAll(
    ContextTransformer.identity,
    LoopConfig.defaultLayer,
    FauxProvider.layerWithRequests({ responses, requests }),
    TestToolExecutor.layer({})
  )

const getFirstRequest = (requests: ReadonlyArray<LLMRequest>) => {
  const request = requests[0]

  if (request === undefined) {
    throw new Error('Expected provider request')
  }

  return request
}

describe('runRuntime', () => {
  it.effect('runs transcript mode without loading or saving session state by default', () =>
    Effect.gen(function* () {
      const requests: Array<LLMRequest> = []
      const messages: RuntimeTranscript = [UserMessage.make({ content: 'client owned transcript' })]

      const eventsChunk = yield* runRuntime(
        {
          _tag: 'Transcript',
          sessionId: 'session_1',
          messages
        },
        runtimeConfig
      ).pipe(
        Stream.runCollect,
        Effect.provide(makeAgentLoopLayer(requests))
      )

      expect(Array.from(eventsChunk).map(event => event._tag)).toContain('AgentEnd')
      expect(getFirstRequest(requests).messages).toEqual(messages)
    })
  )

  it.effect('can persist transcript mode after a successful run', () =>
    Effect.gen(function* () {
      const saved: Array<SessionSnapshot> = []
      const StoreLayer = Layer.succeed(
        SessionStore,
        SessionStore.of({
          load: sessionId => Effect.succeed({ id: sessionId, messages: [] }),
          save: snapshot => Effect.sync(() => saved.push(snapshot))
        })
      )
      const messages: RuntimeTranscript = [UserMessage.make({ content: 'persist this transcript' })]

      yield* runRuntime(
        {
          _tag: 'Transcript',
          sessionId: 'session_1',
          messages,
          persist: true
        },
        runtimeConfig
      ).pipe(Stream.runCollect, Effect.provide(Layer.mergeAll(makeAgentLoopLayer(), StoreLayer)))

      expect(saved).toEqual([
        {
          id: 'session_1',
          messages: [
            UserMessage.make({ content: 'persist this transcript' }),
            AssistantAgentMessage.make({ content: 'ok', toolCalls: [] })
          ]
        }
      ])
    })
  )

  it.effect('loads session input mode, runs agent loop, and saves transcript', () =>
    Effect.gen(function* () {
      const saved: Array<SessionSnapshot> = []
      const session = {
        id: 'session_1',
        messages: [UserMessage.make({ content: 'old' })]
      }
      const StoreLayer = Layer.succeed(
        SessionStore,
        SessionStore.of({
          load: () => Effect.succeed(session),
          save: snapshot => Effect.sync(() => saved.push(snapshot))
        })
      )

      const eventsChunk = yield* runRuntime(
        {
          _tag: 'Input',
          sessionId: session.id,
          input: UserMessage.make({ content: 'new' })
        },
        runtimeConfig
      ).pipe(Stream.runCollect, Effect.provide(Layer.mergeAll(makeAgentLoopLayer(), StoreLayer)))

      expect(Array.from(eventsChunk).map(event => event._tag)).toContain('AgentEnd')
      expect(saved).toEqual([
        {
          id: 'session_1',
          messages: [
            UserMessage.make({ content: 'old' }),
            UserMessage.make({ content: 'new' }),
            AssistantAgentMessage.make({ content: 'ok', toolCalls: [] })
          ]
        }
      ])
    })
  )

  it.effect('passes reasoning effort and capabilities to the agent loop', () =>
    Effect.gen(function* () {
      const requests: Array<LLMRequest> = []
      const StoreLayer = Layer.succeed(
        SessionStore,
        SessionStore.of({
          load: sessionId => Effect.succeed({ id: sessionId, messages: [] }),
          save: () => Effect.void
        })
      )

      yield* runRuntime(
        {
          _tag: 'Transcript',
          sessionId: 'session_1',
          messages: [UserMessage.make({ content: 'reason about this' })]
        },
        {
          ...runtimeConfig,
          reasoningEffort: 'medium',
          capabilities: textOnlyModelCapabilities
        }
      ).pipe(
        Stream.runCollect,
        Effect.provide(Layer.mergeAll(makeAgentLoopLayer(requests), StoreLayer))
      )

      expect(getFirstRequest(requests).reasoningEffort).toBe('medium')
    })
  )

  it.effect('does not persist when the loop fails before completion', () =>
    Effect.gen(function* () {
      const saved: Array<SessionSnapshot> = []
      const StoreLayer = Layer.succeed(
        SessionStore,
        SessionStore.of({
          load: sessionId =>
            Effect.succeed({ id: sessionId, messages: [UserMessage.make({ content: 'old' })] }),
          save: snapshot => Effect.sync(() => saved.push(snapshot))
        })
      )

      const exit = yield* runRuntime(
        {
          _tag: 'Input',
          sessionId: 'session_1',
          input: UserMessage.make({ content: 'new' })
        },
        runtimeConfig
      ).pipe(
        Stream.runCollect,
        Effect.provide(Layer.mergeAll(makeAgentLoopLayer([], []), StoreLayer)),
        Effect.exit
      )

      expect(exit._tag).toBe('Failure')
      expect(saved).toEqual([])
    })
  )
})
