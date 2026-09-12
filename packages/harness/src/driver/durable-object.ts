import { Layer } from 'effect'
import type { Effect } from 'effect'
import type { Promotable } from '../coordinator.ts'
import { Driver } from '../driver.ts'
import { Inbox } from '../inbox.ts'
import { RunStore, type DurableRunStoreSnapshot } from '../store.ts'

export type { DurableRunStoreSnapshot }

/**
 * Backward-compatible Durable Object harness. Wires the owning layers consciously: one
 * fresh {@link RunStore.snapshotLayer} instance (backed by the original storage options,
 * preserving deferred `load` reads and the `save` receiver) is shared between the
 * coordinated driver and the merged output, plus a fresh {@link Inbox.layer}. The options
 * reference passes through untouched, so nothing is read at factory construction; each
 * call builds fresh layers so harnesses never share state.
 */
export const makeDurableObjectDriverLayer = (options: {
  readonly load: Effect.Effect<DurableRunStoreSnapshot | undefined>
  readonly save: (snapshot: DurableRunStoreSnapshot) => Effect.Effect<void>
  readonly drain?: (runId: string, force: boolean, scope: Promotable) => Effect.Effect<void>
  readonly maxResumeAttempts?: number
}): Layer.Layer<Driver | RunStore | Inbox> => {
  const store = RunStore.snapshotLayer(options)

  return Layer.mergeAll(
    Driver.coordinatedLayer(options).pipe(Layer.provide(store)),
    store,
    Inbox.layer()
  )
}
