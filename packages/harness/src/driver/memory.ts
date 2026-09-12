import { Layer } from 'effect'
import {
  Driver,
  type Drain,
  type DriverLayerOptions,
  type InvalidMaxResumeAttempts
} from '../driver.ts'
import { Inbox } from '../inbox.ts'
import { RunStore } from '../store.ts'

export function makeInMemoryDriverLayer(): Layer.Layer<Driver, never, RunStore | Inbox>
export function makeInMemoryDriverLayer(options?: {
  readonly drain?: Drain
  readonly maxResumeAttempts?: undefined
}): Layer.Layer<Driver, never, RunStore | Inbox>
export function makeInMemoryDriverLayer(
  options?: DriverLayerOptions
): Layer.Layer<Driver, InvalidMaxResumeAttempts, RunStore | Inbox>
export function makeInMemoryDriverLayer(options?: DriverLayerOptions) {
  return options === undefined ? Driver.coordinatedLayer() : Driver.coordinatedLayer(options)
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
  const driver =
    options === undefined ? Driver.coordinatedLayer() : Driver.coordinatedLayer(options)
  return driver.pipe(
    Layer.provideMerge(RunStore.inMemoryLayer()),
    Layer.provideMerge(Inbox.layer())
  )
}
