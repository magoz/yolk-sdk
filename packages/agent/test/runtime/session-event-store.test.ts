import { Effect, Option, Predicate, Result } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import {
  AgentError,
  AssistantAgentMessage,
  AssistantTextPart,
  UserMessage
} from '@yolk-sdk/agent/protocol'
import {
  appendRuntimeSessionEventsToLog,
  InputAppended,
  latestIncompleteRuntimeRun,
  makeInMemorySessionEventStoreLayer,
  replayRuntimeSessionEvents,
  RunCompleted,
  RunFailed,
  RunInterrupted,
  RunStarted,
  SessionEventStore
} from '../../src/runtime'

describe('SessionEventStore', () => {
  it.effect('appends ordered events with revision metadata and replays transcript messages', () =>
    Effect.gen(function* () {
      const store = yield* SessionEventStore
      const input = UserMessage.make({ content: 'hello' })

      const assistant = AssistantAgentMessage.make({
        parts: [AssistantTextPart.make({ content: 'ok' })]
      })

      const first = yield* store.append({
        sessionId: 'session_1',
        expectedRevision: 0,
        events: [InputAppended.make({ message: input }), RunStarted.make({ runId: 'run_1' })]
      })

      const second = yield* store.append({
        sessionId: 'session_1',
        expectedRevision: first.revision,
        events: [RunCompleted.make({ runId: 'run_1', messages: [assistant] })]
      })

      expect(first.revision).toBe(2)
      expect(second.events.map(event => event.id)).toEqual([
        'session_1:1',
        'session_1:2',
        'session_1:3'
      ])
      expect(replayRuntimeSessionEvents(second.events)).toEqual([input, assistant])
    }).pipe(Effect.provide(makeInMemorySessionEventStoreLayer()))
  )

  it.effect('rejects stale expected revisions', () =>
    Effect.gen(function* () {
      const store = yield* SessionEventStore
      yield* store.append({
        sessionId: 'session_1',
        expectedRevision: 0,
        events: [InputAppended.make({ message: UserMessage.make({ content: 'hello' }) })]
      })

      const result = yield* store
        .append({
          sessionId: 'session_1',
          expectedRevision: 0,
          events: [RunStarted.make({ runId: 'run_1' })]
        })
        .pipe(Effect.result)

      expect(Result.isFailure(result)).toBe(true)

      const failure = Option.getOrThrow(Result.getFailure(result))

      if (!Predicate.isTagged(failure, 'SessionConflictError')) {
        throw new Error('Expected SessionConflictError')
      }

      expect(failure.sessionId).toBe('session_1')
    }).pipe(Effect.provide(makeInMemorySessionEventStoreLayer()))
  )

  it.effect('keeps failed and interrupted runs out of replayed transcript', () =>
    Effect.gen(function* () {
      const store = yield* SessionEventStore
      const input = UserMessage.make({ content: 'hello' })

      const log = yield* store.append({
        sessionId: 'session_1',
        events: [
          InputAppended.make({ message: input }),
          RunStarted.make({ runId: 'run_1' }),
          RunFailed.make({
            runId: 'run_1',
            error: AgentError.make({ code: 'provider_error', message: 'failed', retryable: true })
          }),
          RunInterrupted.make({ runId: 'run_2' })
        ]
      })

      expect(replayRuntimeSessionEvents(log.events)).toEqual([input])
    }).pipe(Effect.provide(makeInMemorySessionEventStoreLayer()))
  )

  it('finds the latest started run without a terminal event', () => {
    const log = appendRuntimeSessionEventsToLog(
      {
        sessionId: 'session_1',
        revision: 0,
        events: []
      },
      {
        sessionId: 'session_1',
        events: [
          RunStarted.make({ runId: 'run_1' }),
          RunCompleted.make({ runId: 'run_1', messages: [] }),
          RunStarted.make({ runId: 'run_2' }),
          RunStarted.make({ runId: 'run_3' }),
          RunInterrupted.make({ runId: 'run_3' })
        ]
      }
    )

    const activeRun = latestIncompleteRuntimeRun(log.events)

    expect(activeRun).toEqual(Option.some({ runId: 'run_2', startedRevision: 3 }))
  })

  it('returns none when every started run has a terminal event', () => {
    const log = appendRuntimeSessionEventsToLog(
      {
        sessionId: 'session_1',
        revision: 0,
        events: []
      },
      {
        sessionId: 'session_1',
        events: [
          RunStarted.make({ runId: 'run_1' }),
          RunFailed.make({
            runId: 'run_1',
            error: AgentError.make({ code: 'provider_error', message: 'failed', retryable: true })
          }),
          RunCompleted.make({ runId: 'run_orphan', messages: [] })
        ]
      }
    )

    expect(latestIncompleteRuntimeRun(log.events)).toEqual(Option.none())
  })

  it('ignores orphan terminals and terminals recorded after a later start', () => {
    const log = appendRuntimeSessionEventsToLog(
      {
        sessionId: 'session_1',
        revision: 0,
        events: []
      },
      {
        sessionId: 'session_1',
        events: [
          RunCompleted.make({ runId: 'run_orphan', messages: [] }),
          RunStarted.make({ runId: 'run_1' }),
          RunStarted.make({ runId: 'run_2' }),
          RunFailed.make({
            runId: 'run_1',
            error: AgentError.make({ code: 'provider_error', message: 'failed', retryable: true })
          })
        ]
      }
    )

    expect(latestIncompleteRuntimeRun(log.events)).toEqual(
      Option.some({ runId: 'run_2', startedRevision: 3 })
    )
  })
})
