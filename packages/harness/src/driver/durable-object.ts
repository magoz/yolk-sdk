import { Layer } from 'effect'
import type { Effect } from 'effect'
import { Driver, type Drain, type InvalidMaxResumeAttempts } from '../driver.ts'
import { Inbox } from '../inbox.ts'
import { RunStore, type DurableRunStoreSnapshot } from '../store.ts'

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
  return Driver.coordinatedLayer(options).pipe(
    Layer.provideMerge(RunStore.snapshotLayer(options)),
    Layer.provideMerge(Inbox.layer())
  )
}
