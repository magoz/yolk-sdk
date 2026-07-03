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
  type RuntimeConfig,
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
  ToolDef,
  type HitlResponse,
  type ToolApprovalResponse as ToolApprovalResponseType,
  UserMessage
} from '@yolk-sdk/agent/protocol'
import {
  emptyRuntimeEventLog,
  interruptLatestIncompleteRun,
  loadRuntimeEventLogOrEmpty,
  makeDurableObjectSessionEventStoreLayer,
  type RuntimeEventLogStorage
} from '../src/session-event-storage.ts'
import { propertyOptions } from '../../../test/property/options.ts'

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

const storageEventCommand = Schema.Struct({
  kind: Schema.Literals(['input', 'hitl', 'start', 'complete', 'await', 'fail', 'interrupt']),
  runId: Schema.Literals(['run_1', 'run_2', 'run_3'])
})

const storageCommand = Schema.Struct({
  kind: Schema.Literals(['appendCurrent', 'appendNone', 'appendStale', 'interrupt']),
  event: storageEventCommand
})

const storageCommandsArbitrary = Schema.toArbitrary(Schema.Array(storageCommand))

const wsCommand = Schema.Struct({
  kind: Schema.Literals([
    'connect',
    'startActive',
    'userCurrent',
    'userNone',
    'userStale',
    'hitlCurrent',
    'hitlNone',
    'hitlStale',
    'hitlMismatch',
    'hitlDuplicate'
  ])
})

const wsCommandsArbitrary = Schema.toArbitrary(Schema.Array(wsCommand))

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

const approvalTool = ToolDef.make({
  name: 'weather',
  description: 'Get weather.',
  parameters: {},
  approval: ToolApprovalPolicy.make({ mode: 'manual', reason: 'external lookup' })
})

const wsRuntimeConfig: RuntimeConfig = {
  systemPrompt: 'Cloudflare websocket test agent.',
  tools: [approvalTool],
  model: 'faux-cloudflare'
}

const wsResponses = Array.from({ length: 192 }, (_, index) =>
  index % 2 === 0
    ? Reply.toolCall({
        id: `ws_call_${index}`,
        name: 'weather',
        params: { city: 'Paris' }
      })
    : Reply.text(`ws_done_${index}`)
)

const makeWsLayer = (storage: RuntimeEventLogStorage, requests: Array<LLMRequest>) =>
  Layer.mergeAll(
    ContextTransformer.identity,
    LoopConfig.defaultLayer,
    FauxProvider.layerWithRequests({ responses: wsResponses, requests }),
    TestToolExecutor.layer({ weather: '72F' }),
    makeDurableObjectSessionEventStoreLayer('session_1', storage)
  )

const latestApprovalRequest = (log: RuntimeSessionEventLog) => {
  for (const stored of [...log.events].reverse()) {
    const event = stored.event

    switch (event._tag) {
      case 'RunAwaitingInput':
        return event.requests.find(request => request._tag === 'ToolApprovalRequest')
      case 'RunCompleted':
      case 'RunFailed':
      case 'RunInterrupted':
        return undefined
      case 'HitlResponseAppended':
      case 'InputAppended':
      case 'RunStarted':
        break
    }
  }

  return undefined
}

const responseForApprovalRequest = (request: ToolApprovalRequest): ToolApprovalResponseType =>
  ToolApprovalResponse.make({
    requestId: request.requestId,
    toolCallId: request.toolCallId,
    decision: 'approved',
    source: 'user'
  })

const staleApprovalResponse = (): ToolApprovalResponseType =>
  ToolApprovalResponse.make({
    requestId: 'approval:stale',
    toolCallId: 'stale',
    decision: 'approved',
    source: 'user'
  })

const expectedRevision = (kind: (typeof wsCommand.Type)['kind'], revision: number) => {
  switch (kind) {
    case 'userCurrent':
    case 'hitlCurrent':
      return revision
    case 'userStale':
    case 'hitlStale':
      return revision + 1
    case 'connect':
    case 'startActive':
    case 'userNone':
    case 'hitlNone':
    case 'hitlMismatch':
    case 'hitlDuplicate':
      return undefined
  }
}

const runWsUserInput = (input: {
  readonly storage: RuntimeEventLogStorage
  readonly command: typeof wsCommand.Type
  readonly index: number
}) =>
  Effect.gen(function* () {
    const before = yield* loadRuntimeEventLogOrEmpty('session_1', input.storage)
    const activeRun = latestIncompleteRuntimeRun(before.events)

    if (Option.isSome(activeRun)) {
      return yield* Effect.succeed({ mutated: false })
    }

    const revision = expectedRevision(input.command.kind, before.revision)
    const result = yield* runRuntime(
      {
        _tag: 'AppendInput',
        sessionId: 'session_1',
        input: UserMessage.make({ content: `ws_user_${input.index}` }),
        runId: `ws_user_run_${input.index}`,
        ...(revision === undefined ? {} : { expectedRevision: revision })
      },
      wsRuntimeConfig
    ).pipe(Stream.runCollect, Effect.result)

    return { mutated: result._tag === 'Success' }
  })

const runWsHitlResponse = (input: {
  readonly storage: RuntimeEventLogStorage
  readonly command: typeof wsCommand.Type
  readonly index: number
  readonly response: HitlResponse
}) =>
  Effect.gen(function* () {
    const before = yield* loadRuntimeEventLogOrEmpty('session_1', input.storage)
    const activeRun = latestIncompleteRuntimeRun(before.events)

    if (Option.isSome(activeRun)) {
      return yield* Effect.succeed({ mutated: false })
    }

    const revision = expectedRevision(input.command.kind, before.revision)
    const result = yield* runRuntime(
      {
        _tag: 'AppendHitlResponse',
        sessionId: 'session_1',
        response: input.response,
        runId: `ws_hitl_run_${input.index}`,
        ...(revision === undefined ? {} : { expectedRevision: revision })
      },
      wsRuntimeConfig
    ).pipe(Stream.runCollect, Effect.result)

    return { mutated: result._tag === 'Success' }
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

  it.effect('rejects stale HITL revision without mutating durable log', () =>
    Effect.gen(function* () {
      const sessionId = 'session_1'
      const before = appendRuntimeSessionEventsToLog(emptyRuntimeEventLog(sessionId), {
        sessionId,
        events: [
          InputAppended.make({ message: UserMessage.make({ content: 'approve weather' }) }),
          RunAwaitingInput.make({
            runId: 'run_1',
            requests: [approvalRequest],
            messages: [assistantMessage(1)]
          })
        ]
      })
      const storage = yield* makeStorage(before)
      const requests: Array<LLMRequest> = []
      const result = yield* runRuntime(
        {
          _tag: 'AppendHitlResponse',
          sessionId,
          response: approvalResponse,
          runId: 'run_2',
          expectedRevision: before.revision + 1
        },
        wsRuntimeConfig
      ).pipe(Stream.runCollect, Effect.provide(makeWsLayer(storage, requests)), Effect.result)
      const after = yield* loadRuntimeEventLogOrEmpty(sessionId, storage)

      expect(result).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'SessionConflictError', sessionId }
      })
      expect(after).toEqual(before)
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
        // Cap generated traces so regular test runs stay cheap; stress with PROPERTY_RUNS.
        const commands = generatedCommands.slice(0, 64)
        let expectedLog = emptyRuntimeEventLog(sessionId)

        for (const [index, command] of commands.entries()) {
          if (command.kind === 'interrupt') {
            yield* interruptLatestIncompleteRun(sessionId, storage)
            expectedLog = interruptModelLog(sessionId, expectedLog)
          } else {
            const expectedRevision =
              command.kind === 'appendNone'
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

  it.effect.prop(
    'direct websocket input, reconnect, and HITL sequences preserve durable runtime invariants',
    [wsCommandsArbitrary],
    ([generatedCommands]) =>
      Effect.gen(function* () {
        const storage = yield* makeStorage()
        const requests: Array<LLMRequest> = []
        // Cap generated traces so regular test runs stay cheap; stress with PROPERTY_RUNS.
        const commands = generatedCommands.slice(0, 64)
        let lastAcceptedHitlResponse: HitlResponse | undefined

        yield* Effect.gen(function* () {
          for (const [index, command] of commands.entries()) {
            const before = yield* loadRuntimeEventLogOrEmpty('session_1', storage)

            switch (command.kind) {
              case 'connect': {
                yield* interruptLatestIncompleteRun('session_1', storage)
                const snapshotLog = yield* loadRuntimeEventLogOrEmpty('session_1', storage)
                const expectedLog = interruptModelLog('session_1', before)

                expect(snapshotLog).toEqual(expectedLog)
                expect(replayRuntimeSessionEvents(snapshotLog.events)).toEqual(
                  replayRuntimeSessionEvents(expectedLog.events)
                )
                break
              }
              case 'startActive': {
                const store = yield* SessionEventStore
                const activeRun = latestIncompleteRuntimeRun(before.events)

                if (Option.isNone(activeRun)) {
                  yield* store.append({
                    sessionId: 'session_1',
                    expectedRevision: before.revision,
                    events: [RunStarted.make({ runId: `ws_active_run_${index}` })]
                  })
                }
                break
              }
              case 'userCurrent':
              case 'userNone':
              case 'userStale': {
                const outcome = yield* runWsUserInput({ storage, command, index })
                const after = yield* loadRuntimeEventLogOrEmpty('session_1', storage)

                if (!outcome.mutated) {
                  expect(after).toEqual(before)
                }
                break
              }
              case 'hitlCurrent':
              case 'hitlNone':
              case 'hitlStale':
              case 'hitlMismatch':
              case 'hitlDuplicate': {
                const pending = latestApprovalRequest(before)
                const response =
                  command.kind === 'hitlDuplicate'
                    ? (lastAcceptedHitlResponse ?? staleApprovalResponse())
                    : command.kind === 'hitlMismatch' || pending === undefined
                      ? staleApprovalResponse()
                      : responseForApprovalRequest(pending)
                const outcome = yield* runWsHitlResponse({ storage, command, index, response })
                const after = yield* loadRuntimeEventLogOrEmpty('session_1', storage)

                if (outcome.mutated) {
                  lastAcceptedHitlResponse = response
                } else {
                  expect(after).toEqual(before)
                }
                break
              }
            }

            const actual = yield* loadRuntimeEventLogOrEmpty('session_1', storage)
            expect(actual.revision).toBe(actual.events.length)

            const incomplete = latestIncompleteRuntimeRun(actual.events)
            if (Option.isSome(incomplete)) {
              expect(actual.events.at(-1)?.event._tag).toBe('RunStarted')
            }
          }
        }).pipe(Effect.provide(makeWsLayer(storage, requests)))
      }),
    propertyOptions
  )
})
