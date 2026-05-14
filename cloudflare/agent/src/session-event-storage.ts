import { Effect, Layer, Option } from 'effect'
import {
  appendRuntimeSessionEventsToLog,
  latestIncompleteRuntimeRun,
  RunInterrupted,
  SessionConflictError,
  SessionEventStore,
  SessionNotFoundError,
  type RuntimeSessionEventLog
} from '@yolk/agent/runtime'

export const runtimeEventsStorageKey = 'runtime-events'

export type RuntimeEventLogStorage = {
  readonly get: () => Effect.Effect<RuntimeSessionEventLog | undefined>
  readonly put: (log: RuntimeSessionEventLog) => Effect.Effect<void>
}

export const emptyRuntimeEventLog = (sessionId: string): RuntimeSessionEventLog => ({
  sessionId,
  revision: 0,
  events: []
})

export const loadRuntimeEventLogOrEmpty = (sessionId: string, storage: RuntimeEventLogStorage) =>
  storage
    .get()
    .pipe(
      Effect.map(log =>
        Option.getOrElse(Option.fromNullishOr(log), () => emptyRuntimeEventLog(sessionId))
      )
    )

export const makeDurableObjectSessionEventStoreLayer = (
  sessionId: string,
  storage: RuntimeEventLogStorage
) =>
  Layer.succeed(
    SessionEventStore,
    SessionEventStore.of({
      load: () =>
        storage.get().pipe(
          Effect.flatMap(log =>
            Option.match(Option.fromNullishOr(log), {
              onNone: () => Effect.fail(new SessionNotFoundError({ sessionId })),
              onSome: Effect.succeed
            })
          )
        ),
      append: input =>
        Effect.gen(function* () {
          const current = yield* loadRuntimeEventLogOrEmpty(sessionId, storage)

          if (input.expectedRevision !== undefined && input.expectedRevision !== current.revision) {
            return yield* Effect.fail(
              new SessionConflictError({
                sessionId,
                message: `Session revision conflict: expected ${input.expectedRevision}, got ${current.revision}`
              })
            )
          }

          const next = appendRuntimeSessionEventsToLog(current, input)
          yield* storage.put(next)

          return next
        })
    })
  )

export const interruptLatestIncompleteRun = (sessionId: string, storage: RuntimeEventLogStorage) =>
  storage.get().pipe(
    Effect.flatMap(log =>
      Option.match(Option.fromNullishOr(log), {
        onNone: () => Effect.void,
        onSome: current =>
          Option.match(latestIncompleteRuntimeRun(current.events), {
            onNone: () => Effect.void,
            onSome: activeRun =>
              storage.put(
                appendRuntimeSessionEventsToLog(current, {
                  sessionId,
                  expectedRevision: current.revision,
                  events: [RunInterrupted.make({ runId: activeRun.runId })]
                })
              )
          })
      })
    )
  )
