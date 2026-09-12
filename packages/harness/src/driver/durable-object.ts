import { Layer } from 'effect'
import type { Effect } from 'effect'
import { makeDriverLayer, type Drain, type Driver } from '../driver.ts'
import { makeInMemoryInboxLayer } from '../inbox.ts'
import type { Inbox } from '../inbox.ts'
import { makeSnapshotRunStoreLayer, type DurableRunStoreSnapshot, type RunStore } from '../store.ts'

export type { DurableRunStoreSnapshot }

export const makeDurableObjectDriverLayer = (options: {
  readonly load: Effect.Effect<DurableRunStoreSnapshot | undefined>
  readonly save: (snapshot: DurableRunStoreSnapshot) => Effect.Effect<void>
  readonly drain?: Drain
  readonly maxResumeAttempts?: number
}): Layer.Layer<Driver | RunStore | Inbox> =>
  makeDriverLayer({
    drain: options.drain,
    maxResumeAttempts: options.maxResumeAttempts
  }).pipe(
    Layer.provideMerge(makeSnapshotRunStoreLayer(options)),
    Layer.provideMerge(makeInMemoryInboxLayer())
  )
