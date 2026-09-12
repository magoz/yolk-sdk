import { Layer } from 'effect'
import { makeDriverLayer, type Drain, type Driver } from '../driver.ts'
import { makeInMemoryInboxLayer, type Inbox } from '../inbox.ts'
import { makeInMemoryRunStoreLayer, type RunStore } from '../store.ts'

export const makeInMemoryDriverLayer = (options?: {
  readonly drain?: Drain
  readonly maxResumeAttempts?: number
}): Layer.Layer<Driver, never, RunStore | Inbox> => makeDriverLayer(options)

export const makeInMemoryHarnessLayer = (options?: {
  readonly drain?: Drain
  readonly maxResumeAttempts?: number
}): Layer.Layer<Driver | RunStore | Inbox> =>
  makeDriverLayer(options).pipe(
    Layer.provideMerge(makeInMemoryRunStoreLayer()),
    Layer.provideMerge(makeInMemoryInboxLayer())
  )
