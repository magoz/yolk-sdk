import { Context, Effect, Layer, Ref } from 'effect'
import * as Schema from 'effect/Schema'
import { AgentError, AgentMessage } from '@yolk/protocol'
import { SessionConflictError, SessionNotFoundError } from './error.ts'
import type { SessionLoadError, SessionSaveError } from './error.ts'

export type SessionRevision = number

export class InputAppended extends Schema.TaggedClass<InputAppended>()('InputAppended', {
  message: AgentMessage
}) {}

export class RunStarted extends Schema.TaggedClass<RunStarted>()('RunStarted', {
  runId: Schema.String
}) {}

export class RunCompleted extends Schema.TaggedClass<RunCompleted>()('RunCompleted', {
  runId: Schema.String,
  messages: Schema.Array(AgentMessage)
}) {}

export class RunFailed extends Schema.TaggedClass<RunFailed>()('RunFailed', {
  runId: Schema.String,
  error: AgentError
}) {}

export class RunInterrupted extends Schema.TaggedClass<RunInterrupted>()('RunInterrupted', {
  runId: Schema.String
}) {}

export const RuntimeSessionEvent = Schema.Union([
  InputAppended,
  RunStarted,
  RunCompleted,
  RunFailed,
  RunInterrupted
])
export type RuntimeSessionEvent = typeof RuntimeSessionEvent.Type

export type StoredRuntimeSessionEvent = {
  readonly id: string
  readonly sessionId: string
  readonly revision: SessionRevision
  readonly event: RuntimeSessionEvent
}

export type RuntimeSessionEventLog = {
  readonly sessionId: string
  readonly revision: SessionRevision
  readonly events: ReadonlyArray<StoredRuntimeSessionEvent>
}

export type AppendRuntimeSessionEventsInput = {
  readonly sessionId: string
  readonly expectedRevision?: SessionRevision
  readonly events: ReadonlyArray<RuntimeSessionEvent>
}

export class SessionEventStore extends Context.Service<
  SessionEventStore,
  {
    readonly load: (
      sessionId: string
    ) => Effect.Effect<RuntimeSessionEventLog, SessionNotFoundError | SessionLoadError>
    readonly append: (
      input: AppendRuntimeSessionEventsInput
    ) => Effect.Effect<RuntimeSessionEventLog, SessionSaveError | SessionConflictError>
  }
>()('@yolk/agent-runtime/SessionEventStore') {}

export const replayRuntimeSessionEvents = (
  events: ReadonlyArray<StoredRuntimeSessionEvent>
): ReadonlyArray<AgentMessage> =>
  events.flatMap(stored => {
    switch (stored.event._tag) {
      case 'InputAppended':
        return [stored.event.message]
      case 'RunCompleted':
        return stored.event.messages
      case 'RunFailed':
      case 'RunInterrupted':
      case 'RunStarted':
        return []
    }
  })

const emptyLog = (sessionId: string): RuntimeSessionEventLog => ({
  sessionId,
  revision: 0,
  events: []
})

const makeStoredEvents = (
  sessionId: string,
  currentRevision: SessionRevision,
  events: ReadonlyArray<RuntimeSessionEvent>
): ReadonlyArray<StoredRuntimeSessionEvent> =>
  events.map((event, index) => {
    const revision = currentRevision + index + 1

    return {
      id: `${sessionId}:${revision}`,
      sessionId,
      revision,
      event
    }
  })

const appendToLog = (
  current: RuntimeSessionEventLog,
  events: ReadonlyArray<RuntimeSessionEvent>
): RuntimeSessionEventLog => {
  const stored = makeStoredEvents(current.sessionId, current.revision, events)
  const last = stored.at(-1)

  return {
    sessionId: current.sessionId,
    revision: last?.revision ?? current.revision,
    events: [...current.events, ...stored]
  }
}

export const makeInMemorySessionEventStoreLayer = (
  initial: ReadonlyArray<RuntimeSessionEventLog> = []
) =>
  Layer.effect(
    SessionEventStore,
    Effect.gen(function* () {
      const logs = yield* Ref.make(new Map(initial.map(log => [log.sessionId, log])))

      return SessionEventStore.of({
        load: sessionId =>
          Effect.gen(function* () {
            const current = yield* Ref.get(logs)

            return yield* Effect.fromNullishOr(current.get(sessionId)).pipe(
              Effect.mapError(() => new SessionNotFoundError({ sessionId }))
            )
          }),
        append: input =>
          Effect.gen(function* () {
            const current = yield* Ref.get(logs)
            const currentLog = current.get(input.sessionId) ?? emptyLog(input.sessionId)

            if (
              input.expectedRevision !== undefined &&
              input.expectedRevision !== currentLog.revision
            ) {
              return yield* Effect.fail(
                new SessionConflictError({
                  sessionId: input.sessionId,
                  message: `Session revision conflict: expected ${input.expectedRevision}, got ${currentLog.revision}`
                })
              )
            }

            const nextLog = appendToLog(currentLog, input.events)
            yield* Ref.set(logs, new Map([...current, [input.sessionId, nextLog]]))

            return nextLog
          })
      })
    })
  )
