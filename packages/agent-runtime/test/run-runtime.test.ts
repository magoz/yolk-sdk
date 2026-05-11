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

const makeAgentLoopLayer = (requests: Array<LLMRequest> = []) =>
  Layer.mergeAll(
    ContextTransformer.identity,
    LoopConfig.defaultLayer,
    FauxProvider.layerWithRequests({ responses: [Reply.text('ok')], requests }),
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
      let loadCount = 0
      let saveCount = 0
      const StoreLayer = Layer.succeed(
        SessionStore,
        SessionStore.of({
          load: sessionId =>
            Effect.sync(() => {
              loadCount += 1
              return { id: sessionId, messages: [] }
            }),
          save: () =>
            Effect.sync(() => {
              saveCount += 1
            })
        })
      )
      const messages: RuntimeTranscript = [UserMessage.make({ content: 'client owned transcript' })]

      const eventsChunk = yield* runRuntime(
        {
          _tag: 'Transcript',
          sessionId: 'session_1',
          messages,
          context: {}
        },
        runtimeConfig
      ).pipe(
        Stream.runCollect,
        Effect.provide(Layer.mergeAll(makeAgentLoopLayer(requests), StoreLayer))
      )

      expect(Array.from(eventsChunk).map(event => event._tag)).toContain('AgentEnd')
      expect(loadCount).toBe(0)
      expect(saveCount).toBe(0)
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
          context: {},
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
          input: UserMessage.make({ content: 'new' }),
          context: {}
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
          messages: [UserMessage.make({ content: 'reason about this' })],
          context: {}
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
})
