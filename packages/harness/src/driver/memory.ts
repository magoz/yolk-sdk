import { Layer } from 'effect'
import type { Effect } from 'effect'
import { makeDriverLayer, type Driver } from '../driver.ts'
import { makeInMemoryInboxLayer } from '../inbox.ts'
import type { Inbox } from '../inbox.ts'
import { makeInMemoryRunStoreLayer } from '../store.ts'
import type { RunStore } from '../store.ts'
import type { Promotable } from '../coordinator.ts'

export const makeInMemoryDriverLayer = (options?: {
  readonly drain?: (runId: string, force: boolean, scope: Promotable) => Effect.Effect<void>
  readonly maxResumeAttempts?: number
}): Layer.Layer<Driver, never, RunStore> => makeDriverLayer(options)

export const makeInMemoryHarnessLayer = (options?: {
  readonly drain?: (runId: string, force: boolean, scope: Promotable) => Effect.Effect<void>
  readonly maxResumeAttempts?: number
}): Layer.Layer<Driver | RunStore | Inbox> => {
  const store = makeInMemoryRunStoreLayer()
  return Layer.mergeAll(
    makeInMemoryDriverLayer(options).pipe(Layer.provide(store)),
    store,
    makeInMemoryInboxLayer()
  )
}
