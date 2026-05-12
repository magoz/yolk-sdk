import { Effect, Layer, Stream } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import {
  AssistantAgentMessage,
  AssistantTextPart,
  UserMessage,
  textOnlyModelCapabilities
} from '@yolk/protocol'
import { ContextTransformer, LoopConfig, type LLMRequest } from '@yolk/agent-loop'
import { FauxProvider, Reply, TestToolExecutor } from '@yolk/agent-loop/testing'
import {
  appendRuntimeSessionEventsToLog,
  InputAppended,
  makeInMemorySessionEventStoreLayer,
  replayRuntimeSessionEvents,
  runRuntime,
  SessionEventStore,
  type RuntimeConfig,
  type RuntimeSessionEventLog,
  type RuntimeTranscript
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

  it.effect('passes reasoning effort and capabilities to the agent loop', () =>
    Effect.gen(function* () {
      const requests: Array<LLMRequest> = []

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
        Effect.provide(makeAgentLoopLayer(requests))
      )

      expect(getFirstRequest(requests).reasoningEffort).toBe('medium')
    })
  )

  it.effect('runs append input mode from replayed session events', () => {
    const requests: Array<LLMRequest> = []
    const old = UserMessage.make({ content: 'old' })
    const input = UserMessage.make({ content: 'new' })
    const initialLog: RuntimeSessionEventLog = {
      sessionId: 'session_1',
      revision: 1,
      events: [
        {
          id: 'session_1:1',
          sessionId: 'session_1',
          revision: 1,
          event: InputAppended.make({ message: old })
        }
      ]
    }
    const layer = Layer.mergeAll(
      makeAgentLoopLayer(requests),
      makeInMemorySessionEventStoreLayer([initialLog])
    )

    return Effect.gen(function* () {
      const eventsChunk = yield* runRuntime(
        {
          _tag: 'AppendInput',
          sessionId: 'session_1',
          input,
          runId: 'run_1',
          expectedRevision: 1
        },
        runtimeConfig
      ).pipe(Stream.runCollect)

      const store = yield* SessionEventStore
      const log = yield* store.load('session_1')
      const assistant = AssistantAgentMessage.make({ parts: [AssistantTextPart.make({ content: 'ok' })] })

      expect(Array.from(eventsChunk).map(event => event._tag)).toContain('AgentEnd')
      expect(getFirstRequest(requests).messages).toEqual([old, input])
      expect(log.events.map(event => event.event._tag)).toEqual([
        'InputAppended',
        'InputAppended',
        'RunStarted',
        'RunCompleted'
      ])
      expect(replayRuntimeSessionEvents(log.events)).toEqual([old, input, assistant])
    }).pipe(Effect.provide(layer))
  })

  it.effect('records run failure in append input mode without completed messages', () => {
    const input = UserMessage.make({ content: 'new' })
    const layer = Layer.mergeAll(makeAgentLoopLayer([], []), makeInMemorySessionEventStoreLayer())

    return Effect.gen(function* () {
      const exit = yield* runRuntime(
        {
          _tag: 'AppendInput',
          sessionId: 'session_1',
          input,
          runId: 'run_1'
        },
        runtimeConfig
      ).pipe(Stream.runCollect, Effect.exit)

      const store = yield* SessionEventStore
      const log = yield* store.load('session_1')

      expect(exit._tag).toBe('Failure')
      expect(log.events.map(event => event.event._tag)).toEqual([
        'InputAppended',
        'RunStarted',
        'RunFailed'
      ])
      expect(replayRuntimeSessionEvents(log.events)).toEqual([input])
    }).pipe(Effect.provide(layer))
  })

  it.effect('rejects append input mode with stale expected revision', () =>
    Effect.gen(function* () {
      const old = UserMessage.make({ content: 'old' })
      const initialLog: RuntimeSessionEventLog = {
        sessionId: 'session_1',
        revision: 1,
        events: [
          {
            id: 'session_1:1',
            sessionId: 'session_1',
            revision: 1,
            event: InputAppended.make({ message: old })
          }
        ]
      }

      const result = yield* runRuntime(
        {
          _tag: 'AppendInput',
          sessionId: 'session_1',
          input: UserMessage.make({ content: 'new' }),
          runId: 'run_1',
          expectedRevision: 0
        },
        runtimeConfig
      ).pipe(
        Stream.runCollect,
        Effect.provide(Layer.mergeAll(makeAgentLoopLayer(), makeInMemorySessionEventStoreLayer([initialLog]))),
        Effect.result
      )

      expect(result).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'SessionConflictError', sessionId: 'session_1' }
      })
    })
  )

  it('appends runtime session events with deterministic revisions', () => {
    const first = UserMessage.make({ content: 'first' })
    const second = UserMessage.make({ content: 'second' })
    const initialLog: RuntimeSessionEventLog = {
      sessionId: 'session_1',
      revision: 1,
      events: [
        {
          id: 'session_1:1',
          sessionId: 'session_1',
          revision: 1,
          event: InputAppended.make({ message: first })
        }
      ]
    }

    const nextLog = appendRuntimeSessionEventsToLog(initialLog, {
      sessionId: 'session_1',
      expectedRevision: 1,
      events: [InputAppended.make({ message: second })]
    })

    expect(nextLog.revision).toBe(2)
    expect(nextLog.events.map(event => event.id)).toEqual(['session_1:1', 'session_1:2'])
    expect(replayRuntimeSessionEvents(nextLog.events)).toEqual([first, second])
  })
})
