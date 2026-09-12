import { Layer } from 'effect'
import type { Effect } from 'effect'
import { makeDriverLayer, type Driver } from '../driver.ts'
import { makeInMemoryInboxLayer } from '../inbox.ts'
import type { Inbox } from '../inbox.ts'
import { makeSnapshotRunStoreLayer, type DurableRunStoreSnapshot, type RunStore } from '../store.ts'
import type { Promotable } from '../coordinator.ts'

export type { DurableRunStoreSnapshot }

export const makeDurableObjectDriverLayer = (options: {
  readonly load: Effect.Effect<DurableRunStoreSnapshot | undefined>
  readonly save: (snapshot: DurableRunStoreSnapshot) => Effect.Effect<void>
  readonly drain?: (runId: string, force: boolean, scope: Promotable) => Effect.Effect<void>
  readonly maxResumeAttempts?: number
}): Layer.Layer<Driver | RunStore | Inbox> => {
  const store = makeSnapshotRunStoreLayer(options)
  return Layer.mergeAll(
    makeDriverLayer({
      drain: options.drain,
      maxResumeAttempts: options.maxResumeAttempts
    }).pipe(Layer.provide(store)),
    store,
    makeInMemoryInboxLayer()
  )
}
