import { Effect, Layer } from 'effect'
import { SessionStore, type SessionSnapshot } from '@yolk/agent-runtime'

export type VolatileSessionStorage = Map<string, SessionSnapshot>

const globalSnapshots: VolatileSessionStorage = new Map()

export const makeVolatileSessionStoreLayer = (
  snapshots: VolatileSessionStorage = globalSnapshots
) =>
  Layer.succeed(
    SessionStore,
    SessionStore.of({
      load: sessionId =>
        Effect.sync(() => snapshots.get(sessionId) ?? { id: sessionId, messages: [] }),
      save: snapshot =>
        Effect.sync(() => {
          snapshots.set(snapshot.id, snapshot)
        })
    })
  )

export const VolatileSessionStoreLayer = makeVolatileSessionStoreLayer()
