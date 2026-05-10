import { Effect, Layer } from 'effect'
import { SessionStore } from '@yolk/agent-runtime'

export const StatelessSessionStoreLayer = Layer.succeed(
  SessionStore,
  SessionStore.of({
    load: sessionId => Effect.succeed({ id: sessionId, messages: [] }),
    save: () => Effect.void
  })
)
