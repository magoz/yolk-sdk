import { Effect, Layer, Option, Ref, Schema, Stream } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { ContextTransformer, LoopConfig, type LLMRequest } from '@yolk-sdk/agent/loop'
import { FauxProvider, Reply, TestToolExecutor } from '@yolk-sdk/agent/loop/testing'
import {
  appendRuntimeSessionEventsToLog,
  HitlResponseAppended,
  InputAppended,
  latestIncompleteRuntimeRun,
  replayRuntimeSessionEvents,
  runRuntime,
  RunAwaitingInput,
  RunCompleted,
  RunFailed,
  RunInterrupted,
  RunStarted,
  SessionEventStore,
  type RuntimeSessionEvent,
  type RuntimeSessionEventLog
} from '@yolk-sdk/agent/runtime'
import {
  AgentError,
  AssistantAgentMessage,
  AssistantTextPart,
  ToolApprovalPolicy,
  ToolApprovalRequest,
  ToolApprovalResponse,
  ToolCall,
  UserMessage
} from '@yolk-sdk/agent/protocol'
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

const propertyRuns = () => {
  const value = process.env.PROPERTY_RUNS

  if (value === undefined) return { fastCheck: { numRuns: 50 } }

  const parsed = Number(value)

  return Number.isInteger(parsed) && parsed > 0
    ? { fastCheck: { numRuns: parsed } }
    : { fastCheck: { numRuns: 50 } }
}

const storageEventCommand = Schema.Struct({
  kind: Schema.Literals(['input', 'hitl', 'start', 'complete', 'await', 'fail', 'interrupt']),
  runId: Schema.Literals(['run_1', 'run_2', 'run_3'])
})

const storageCommand = Schema.Struct({
  kind: Schema.Literals(['appendCurrent', 'appendNone', 'appendStale', 'interrupt']),
  event: storageEventCommand
})

const storageCommandsArbitrary = Schema.toArbitrary(Schema.Array(storageCommand))

const propertyOptions = propertyRuns()

const toolCall = ToolCall.make({ id: 'call_1', name: 'weather', params: { city: 'Paris' } })

const approvalRequest = ToolApprovalRequest.make({
  requestId: 'approval:call_1',
  toolCallId: 'call_1',
  call: toolCall,
  policy: ToolApprovalPolicy.make({ mode: 'manual' })
})

const approvalResponse = ToolApprovalResponse.make({
  requestId: approvalRequest.requestId,
  toolCallId: approvalRequest.toolCallId,
  decision: 'approved',
  source: 'user'
})

const assistantMessage = (index: number) =>
  AssistantAgentMessage.make({
    parts: [AssistantTextPart.make({ content: `assistant_${index}` })]
  })

const runtimeEventForCommand = (
  command: typeof storageEventCommand.Type,
  index: number
): RuntimeSessionEvent => {
  switch (command.kind) {
    case 'input':
      return InputAppended.make({ message: UserMessage.make({ content: `user_${index}` }) })
    case 'hitl':
      return HitlResponseAppended.make({ response: approvalResponse })
    case 'start':
      return RunStarted.make({ runId: command.runId })
    case 'complete':
      return RunCompleted.make({ runId: command.runId, messages: [assistantMessage(index)] })
    case 'await':
      return RunAwaitingInput.make({
        runId: command.runId,
        requests: [approvalRequest],
        messages: [assistantMessage(index)]
      })
    case 'fail':
      return RunFailed.make({
        runId: command.runId,
        error: AgentError.make({ code: 'provider_error', message: 'failed', retryable: true })
      })
    case 'interrupt':
      return RunInterrupted.make({ runId: command.runId })
  }
}

const interruptModelLog = (sessionId: string, log: RuntimeSessionEventLog) =>
  Option.match(latestIncompleteRuntimeRun(log.events), {
    onNone: () => log,
    onSome: activeRun =>
      appendRuntimeSessionEventsToLog(log, {
        sessionId,
        expectedRevision: log.revision,
        events: [RunInterrupted.make({ runId: activeRun.runId })]
      })
  })

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

  it.effect.prop(
    'durable storage append and interrupt semantics match runtime event log model',
    [storageCommandsArbitrary],
    ([generatedCommands]) =>
      Effect.gen(function* () {
        const sessionId = 'session_1'
        const storage = yield* makeStorage()
        const storeLayer = makeDurableObjectSessionEventStoreLayer(sessionId, storage)
        const commands = generatedCommands.slice(0, 64)
        let expectedLog = emptyRuntimeEventLog(sessionId)

        for (const [index, command] of commands.entries()) {
          if (command.kind === 'interrupt') {
            yield* interruptLatestIncompleteRun(sessionId, storage)
            expectedLog = interruptModelLog(sessionId, expectedLog)
          } else {
            const expectedRevision = command.kind === 'appendNone'
              ? undefined
              : command.kind === 'appendCurrent'
                ? expectedLog.revision
                : expectedLog.revision + 1
            const event = runtimeEventForCommand(command.event, index)
            const result = yield* Effect.gen(function* () {
              const store = yield* SessionEventStore

              return yield* store.append({
                sessionId,
                ...(expectedRevision === undefined ? {} : { expectedRevision }),
                events: [event]
              })
            }).pipe(Effect.provide(storeLayer), Effect.result)

            if (command.kind === 'appendStale') {
              expect(result).toMatchObject({
                _tag: 'Failure',
                failure: { _tag: 'SessionConflictError', sessionId }
              })
            } else {
              expectedLog = appendRuntimeSessionEventsToLog(expectedLog, {
                sessionId,
                events: [event]
              })
              expect(result).toMatchObject({ _tag: 'Success' })
            }
          }

          const actual = yield* loadRuntimeEventLogOrEmpty(sessionId, storage)
          expect(actual).toEqual(expectedLog)
          expect(actual.revision).toBe(actual.events.length)
        }
      }),
    propertyOptions
  )
})
