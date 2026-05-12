import { Context, Effect, Layer, Ref } from 'effect'
import type { AgentMessage } from '@yolk/protocol'
import { SessionNotFoundError } from './error.ts'
import type { SessionLoadError, SessionSaveError } from './error.ts'

export type SessionSnapshot = {
  readonly id: string
  readonly messages: ReadonlyArray<AgentMessage>
}

export class SessionStore extends Context.Service<
  SessionStore,
  {
    readonly load: (
      sessionId: string
    ) => Effect.Effect<SessionSnapshot, SessionNotFoundError | SessionLoadError>
    readonly save: (snapshot: SessionSnapshot) => Effect.Effect<void, SessionSaveError>
  }
>()('@yolk/agent-runtime/SessionStore') {}

export const makeInMemorySessionStoreLayer = (initial: ReadonlyArray<SessionSnapshot> = []) =>
  Layer.effect(
    SessionStore,
    Effect.gen(function* () {
      const snapshots = yield* Ref.make(new Map(initial.map(snapshot => [snapshot.id, snapshot])))

      return SessionStore.of({
        load: sessionId =>
          Effect.gen(function* () {
            const current = yield* Ref.get(snapshots)

            return yield* Effect.fromNullishOr(current.get(sessionId)).pipe(
              Effect.mapError(() => new SessionNotFoundError({ sessionId }))
            )
          }),
        save: snapshot =>
          Ref.update(snapshots, current => {
            const next = new Map(current)
            next.set(snapshot.id, snapshot)
            return next
          })
      })
    })
  )
