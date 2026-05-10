import { Effect, Layer, Stream } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { UserMessage } from '@yolk/protocol'
import {
  ContextTransformer,
  FauxProvider,
  LoopConfig,
  Reply,
  TestToolExecutor
} from '@yolk/agent-loop'
import { runRuntime, SessionStore, type SessionSnapshot } from '../src'

const AgentLoopLayer = Layer.mergeAll(
  ContextTransformer.identity,
  LoopConfig.defaultLayer,
  FauxProvider.layer(Reply.text('ok')),
  TestToolExecutor.layer({})
)

describe('runRuntime', () => {
  it.effect('loads session, runs agent loop, and saves transcript', () =>
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

      const eventsChunk = yield* runRuntime({
        sessionId: session.id,
        input: UserMessage.make({ content: 'new' }),
        context: {},
        systemPrompt: 'Be brief.',
        tools: [],
        model: 'faux'
      }).pipe(Stream.runCollect, Effect.provide(Layer.mergeAll(AgentLoopLayer, StoreLayer)))

      expect(Array.from(eventsChunk).map(event => event._tag)).toContain('AgentEnd')
      expect(saved).toHaveLength(1)
      expect(saved[0]?.id).toBe('session_1')
      expect(saved[0]?.messages.map(message => message.content)).toEqual(['old', 'new', 'ok'])
    }))
})
