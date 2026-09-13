import { Layer } from 'effect'
import type { Effect } from 'effect'
import {
  makeDriverLayer,
  type Drain,
  type Driver,
  type InvalidMaxResumeAttempts
} from '../driver.ts'
import { makeInMemoryInboxLayer } from '../inbox.ts'
import type { Inbox } from '../inbox.ts'
import { makeSnapshotRunStoreLayer, type DurableRunStoreSnapshot, type RunStore } from '../store.ts'

export type { DurableRunStoreSnapshot }

type DurableObjectDriverBase = {
  readonly load: Effect.Effect<DurableRunStoreSnapshot | undefined>
  readonly save: (snapshot: DurableRunStoreSnapshot) => Effect.Effect<void>
  readonly drain?: Drain
}

export function makeDurableObjectDriverLayer(
  options: DurableObjectDriverBase & { readonly maxResumeAttempts?: undefined }
): Layer.Layer<Driver | RunStore | Inbox>
export function makeDurableObjectDriverLayer(
  options: DurableObjectDriverBase & { readonly maxResumeAttempts?: number }
): Layer.Layer<Driver | RunStore | Inbox, InvalidMaxResumeAttempts>
export function makeDurableObjectDriverLayer(
  options: DurableObjectDriverBase & { readonly maxResumeAttempts?: number }
) {
  return makeDriverLayer(options).pipe(
    Layer.provideMerge(makeSnapshotRunStoreLayer(options)),
    Layer.provideMerge(makeInMemoryInboxLayer())
  )
}
