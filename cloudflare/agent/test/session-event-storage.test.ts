import { Effect, Layer, Ref, Stream } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { ContextTransformer, LoopConfig, type LLMRequest } from '@yolk-sdk/agent/loop'
import { FauxProvider, Reply, TestToolExecutor } from '@yolk-sdk/agent/loop/testing'
import {
  appendRuntimeSessionEventsToLog,
  InputAppended,
  replayRuntimeSessionEvents,
  runRuntime,
  RunStarted,
  type RuntimeSessionEventLog
} from '@yolk-sdk/agent/runtime'
import { AssistantAgentMessage, AssistantTextPart, UserMessage } from '@yolk-sdk/agent/protocol'
import {
  emptyRuntimeEventLog,
  interruptLatestIncompleteRun,
  loadRuntimeEventLogOrEmpty,
  makeDurableObjectSessionEventStoreLayer,
  type RuntimeEventLogStorage
} from '../src/session-event-storage.ts'

const getRequest = (requests: ReadonlyArray<LLMRequest>, index: number) => {
  const request = requests[index]

  if (request === undefined) {
    throw new Error(`Expected request ${index}`)
  }

  return request
}

const makeStorage = (initial?: RuntimeSessionEventLog) =>
  Effect.gen(function* () {
    const ref = yield* Ref.make<RuntimeSessionEventLog | undefined>(initial)
    const storage: RuntimeEventLogStorage = {
      get: () => Ref.get(ref),
      put: log => Ref.set(ref, log)
    }

    return storage
  })

const makeLoopLayer = (requests: Array<LLMRequest>) =>
  Layer.mergeAll(
    ContextTransformer.identity,
    LoopConfig.defaultLayer,
    FauxProvider.layerWithRequests({
      responses: [Reply.text('first reply'), Reply.text('second reply')],
      requests
    }),
    TestToolExecutor.layer({})
  )

const runtimeConfig = {
  systemPrompt: 'Cloudflare test agent.',
  tools: [],
  model: 'faux-cloudflare'
}

describe('Cloudflare session event storage', () => {
  it.effect('persists multiple append-backed turns in one Durable Object event log', () =>
    Effect.gen(function* () {
      const sessionId = 'session_1'
      const requests: Array<LLMRequest> = []
      const storage = yield* makeStorage()
      const layer = Layer.mergeAll(
        makeLoopLayer(requests),
        makeDurableObjectSessionEventStoreLayer(sessionId, storage)
      )
      const firstInput = UserMessage.make({ content: 'first' })
      const secondInput = UserMessage.make({ content: 'second' })
      const firstAssistant = AssistantAgentMessage.make({
        parts: [AssistantTextPart.make({ content: 'first reply' })]
      })
      const secondAssistant = AssistantAgentMessage.make({
        parts: [AssistantTextPart.make({ content: 'second reply' })]
      })

      yield* Effect.gen(function* () {
        yield* runRuntime(
          { _tag: 'AppendInput', sessionId, input: firstInput, runId: 'run_1' },
          runtimeConfig
        ).pipe(Stream.runCollect)
        yield* runRuntime(
          { _tag: 'AppendInput', sessionId, input: secondInput, runId: 'run_2' },
          runtimeConfig
        ).pipe(Stream.runCollect)
      }).pipe(Effect.provide(layer))

      const log = yield* loadRuntimeEventLogOrEmpty(sessionId, storage)

      expect(getRequest(requests, 0).messages).toEqual([firstInput])
      expect(getRequest(requests, 1).messages).toEqual([firstInput, firstAssistant, secondInput])
      expect(log.revision).toBe(6)
      expect(log.events.map(stored => stored.event._tag)).toEqual([
        'InputAppended',
        'RunStarted',
        'RunCompleted',
        'InputAppended',
        'RunStarted',
        'RunCompleted'
      ])
      expect(replayRuntimeSessionEvents(log.events)).toEqual([
        firstInput,
        firstAssistant,
        secondInput,
        secondAssistant
      ])
    })
  )

  it.effect('marks latest incomplete run interrupted on reconnect without changing replay', () =>
    Effect.gen(function* () {
      const sessionId = 'session_1'
      const input = UserMessage.make({ content: 'interrupted' })
      const initialLog = appendRuntimeSessionEventsToLog(emptyRuntimeEventLog(sessionId), {
        sessionId,
        events: [InputAppended.make({ message: input }), RunStarted.make({ runId: 'run_1' })]
      })
      const storage = yield* makeStorage(initialLog)

      yield* interruptLatestIncompleteRun(sessionId, storage)

      const log = yield* loadRuntimeEventLogOrEmpty(sessionId, storage)

      expect(log.revision).toBe(3)
      expect(log.events.map(stored => stored.event._tag)).toEqual([
        'InputAppended',
        'RunStarted',
        'RunInterrupted'
      ])
      expect(replayRuntimeSessionEvents(log.events)).toEqual([input])
    })
  )
})
