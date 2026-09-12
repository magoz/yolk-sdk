import { Layer } from 'effect'
import type { Effect } from 'effect'
import type { Promotable } from '../coordinator.ts'
import { Driver } from '../driver.ts'
import { Inbox } from '../inbox.ts'
import { RunStore } from '../store.ts'

/**
 * Backward-compatible delegation to the canonical {@link Driver.coordinatedLayer}, which
 * provides a default run coordinator. Keeps the historical `RunStore`-only requirement and
 * reads no options at factory construction.
 */
export const makeInMemoryDriverLayer = (options?: {
  readonly drain?: (runId: string, force: boolean, scope: Promotable) => Effect.Effect<void>
  readonly maxResumeAttempts?: number
}): Layer.Layer<Driver, never, RunStore> => Driver.coordinatedLayer(options)

/**
 * Backward-compatible in-memory harness. Wires the owning layers consciously: one fresh
 * {@link RunStore.inMemoryLayer} instance is shared between the coordinated driver and the
 * merged output, plus a fresh {@link Inbox.layer}. The options reference passes through
 * untouched, so nothing is read at factory construction; each call builds fresh layers so
 * harnesses never share state.
 */
export const makeInMemoryHarnessLayer = (options?: {
  readonly drain?: (runId: string, force: boolean, scope: Promotable) => Effect.Effect<void>
  readonly maxResumeAttempts?: number
}): Layer.Layer<Driver | RunStore | Inbox> => {
  const store = RunStore.inMemoryLayer()

  return Layer.mergeAll(
    Driver.coordinatedLayer(options).pipe(Layer.provide(store)),
    store,
    Inbox.layer()
  )
}
