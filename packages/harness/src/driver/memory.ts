import { Layer } from 'effect'
import {
  makeDriverLayer,
  type Drain,
  type Driver,
  type DriverLayerOptions,
  type InvalidMaxResumeAttempts
} from '../driver.ts'
import { makeInMemoryInboxLayer, type Inbox } from '../inbox.ts'
import { makeInMemoryRunStoreLayer, type RunStore } from '../store.ts'

export function makeInMemoryDriverLayer(): Layer.Layer<Driver, never, RunStore | Inbox>
export function makeInMemoryDriverLayer(options?: {
  readonly drain?: Drain
  readonly maxResumeAttempts?: undefined
}): Layer.Layer<Driver, never, RunStore | Inbox>
export function makeInMemoryDriverLayer(
  options?: DriverLayerOptions
): Layer.Layer<Driver, InvalidMaxResumeAttempts, RunStore | Inbox>
export function makeInMemoryDriverLayer(options?: DriverLayerOptions) {
  return options === undefined ? makeDriverLayer() : makeDriverLayer(options)
}

export function makeInMemoryHarnessLayer(): Layer.Layer<Driver | RunStore | Inbox>
export function makeInMemoryHarnessLayer(options?: {
  readonly drain?: Drain
  readonly maxResumeAttempts?: undefined
}): Layer.Layer<Driver | RunStore | Inbox>
export function makeInMemoryHarnessLayer(
  options?: DriverLayerOptions
): Layer.Layer<Driver | RunStore | Inbox, InvalidMaxResumeAttempts>
export function makeInMemoryHarnessLayer(options?: DriverLayerOptions) {
  const driver = options === undefined ? makeDriverLayer() : makeDriverLayer(options)
  return driver.pipe(
    Layer.provideMerge(makeInMemoryRunStoreLayer()),
    Layer.provideMerge(makeInMemoryInboxLayer())
  )
}
