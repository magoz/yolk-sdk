import { Effect, Option, Schema } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import {
  AgentError,
  type AgentMessage,
  AssistantAgentMessage,
  AssistantTextPart,
  ToolApprovalRequest,
  ToolApprovalResponse,
  ToolCall,
  ToolApprovalPolicy,
  UserMessage
} from '@yolk-sdk/agent/protocol'
import {
  appendRuntimeSessionEventsToLog,
  HitlResponseAppended,
  InputAppended,
  latestIncompleteRuntimeRun,
  makeInMemorySessionEventStoreLayer,
  replayRuntimeHitlResponses,
  replayRuntimeSessionEvents,
  RunAwaitingInput,
  RunCompleted,
  RunFailed,
  RunInterrupted,
  RunStarted,
  SessionEventStore,
  type RuntimeSessionEvent,
  type RuntimeSessionEventLog
} from '../../src/runtime'
import { propertyOptions } from './property-options'

const runId = Schema.Literals(['run_1', 'run_2', 'run_3'])

const sessionCommand = Schema.Struct({
  kind: Schema.Literals(['input', 'hitl', 'start', 'complete', 'await', 'fail', 'interrupt']),
  runId
})

const sessionCommandsArbitrary = Schema.toArbitrary(Schema.Array(sessionCommand))

const revisionCase = Schema.Struct({
  initialEvents: Schema.Array(sessionCommand),
  staleRevision: Schema.Number
})

const revisionCaseArbitrary = Schema.toArbitrary(revisionCase)

const appendCommand = Schema.Struct({
  expectation: Schema.Literals(['current', 'stale', 'none']),
  event: sessionCommand
})

const appendCommandsArbitrary = Schema.toArbitrary(Schema.Array(appendCommand))

const emptyLog = (): RuntimeSessionEventLog => ({
  sessionId: 'session_1',
  revision: 0,
  events: []
})

const assistantMessage = (index: number) =>
  AssistantAgentMessage.make({
    parts: [AssistantTextPart.make({ content: `assistant_${index}` })]
  })

const userMessage = (index: number) => UserMessage.make({ content: `user_${index}` })

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

const eventForCommand = (
  command: typeof sessionCommand.Type,
  index: number
): RuntimeSessionEvent => {
  switch (command.kind) {
    case 'input':
      return InputAppended.make({ message: userMessage(index) })
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

const eventsForCommands = (commands: ReadonlyArray<typeof sessionCommand.Type>) =>
  commands.map((command, index) => eventForCommand(command, index))

const expectedReplayMessages = (
  commands: ReadonlyArray<typeof sessionCommand.Type>
): ReadonlyArray<AgentMessage> =>
  commands.reduce<Array<AgentMessage>>((messages, command, index) => {
    switch (command.kind) {
      case 'input':
        return [...messages, userMessage(index)]
      case 'complete':
      case 'await':
        return [...messages, assistantMessage(index)]
      case 'hitl':
      case 'start':
      case 'fail':
      case 'interrupt':
        return messages
    }
  }, [])

const expectedHitlResponses = (commands: ReadonlyArray<typeof sessionCommand.Type>) =>
  commands.flatMap(command => command.kind === 'hitl' ? [approvalResponse] : [])

const terminalKinds = new Set(['complete', 'await', 'fail', 'interrupt'])

const expectedLatestIncompleteRun = (commands: ReadonlyArray<typeof sessionCommand.Type>) => {
  const active = new Map<string, number>()

  for (const [index, command] of commands.entries()) {
    const revision = index + 1

    if (command.kind === 'start') {
      active.set(command.runId, revision)
    } else if (terminalKinds.has(command.kind)) {
      active.delete(command.runId)
    }
  }

  const latest = Array.from(active.entries()).sort((left, right) => right[1] - left[1])[0]

  return latest === undefined
    ? Option.none()
    : Option.some({ runId: latest[0], startedRevision: latest[1] })
}

describe('session event property tests', () => {
  it.prop(
    'appended session logs keep revision, replay, and HITL response invariants',
    [sessionCommandsArbitrary],
    ([commands]) => {
      const log = appendRuntimeSessionEventsToLog(emptyLog(), {
        sessionId: 'session_1',
        events: eventsForCommands(commands)
      })

      expect(log.revision).toBe(commands.length)
      expect(log.events.map(event => event.revision)).toEqual(
        commands.map((_, index) => index + 1)
      )
      expect(log.events.map(event => event.id)).toEqual(
        commands.map((_, index) => `session_1:${index + 1}`)
      )
      expect(log.events.every(event => event.sessionId === 'session_1')).toBe(true)
      expect(replayRuntimeSessionEvents(log.events)).toEqual(expectedReplayMessages(commands))
      expect(replayRuntimeHitlResponses(log.events)).toEqual(expectedHitlResponses(commands))
      expect(latestIncompleteRuntimeRun(log.events)).toEqual(expectedLatestIncompleteRun(commands))
    },
    propertyOptions
  )

  it.effect.prop(
    'in-memory store rejects stale revisions without mutation',
    [revisionCaseArbitrary],
    ([input]) =>
      Effect.gen(function* () {
        const store = yield* SessionEventStore
        const initialLog = yield* store.append({
          sessionId: 'session_1',
          expectedRevision: 0,
          events: eventsForCommands(input.initialEvents)
        })
        const staleRevision = initialLog.revision + Math.abs(input.staleRevision) + 1
        const result = yield* store.append({
          sessionId: 'session_1',
          expectedRevision: staleRevision,
          events: [InputAppended.make({ message: UserMessage.make({ content: 'rejected' }) })]
        }).pipe(Effect.result)
        const after = yield* store.load('session_1')

        expect(result).toMatchObject({
          _tag: 'Failure',
          failure: { _tag: 'SessionConflictError', sessionId: 'session_1' }
        })
        expect(after).toEqual(initialLog)
      }).pipe(Effect.provide(makeInMemorySessionEventStoreLayer())),
    propertyOptions
  )

  it.effect.prop(
    'generated append sequences preserve revision and conflict invariants',
    [appendCommandsArbitrary],
    ([commands]) =>
      Effect.gen(function* () {
        const store = yield* SessionEventStore
        let expectedLog = emptyLog()

        for (const [index, command] of commands.entries()) {
          const expectedRevision = command.expectation === 'none'
            ? undefined
            : command.expectation === 'current'
              ? expectedLog.revision
              : expectedLog.revision + 1
          const events = [eventForCommand(command.event, index)]
          const result = yield* store.append({
            sessionId: 'session_1',
            ...(expectedRevision === undefined ? {} : { expectedRevision }),
            events
          }).pipe(Effect.result)

          if (command.expectation === 'stale') {
            expect(result).toMatchObject({
              _tag: 'Failure',
              failure: { _tag: 'SessionConflictError', sessionId: 'session_1' }
            })
          } else {
            expectedLog = appendRuntimeSessionEventsToLog(expectedLog, {
              sessionId: 'session_1',
              events
            })
            expect(result).toMatchObject({ _tag: 'Success' })
          }

          const actual = yield* store.load('session_1')
          expect(actual).toEqual(expectedLog)
          expect(actual.revision).toBe(actual.events.length)
        }
      }).pipe(Effect.provide(makeInMemorySessionEventStoreLayer([emptyLog()]))),
    propertyOptions
  )
})
