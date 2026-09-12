import { Context, Effect, Layer } from 'effect'
import { RunCoordinator, type InterruptReason, type Promotable } from './coordinator.ts'
import { Inbox, type InboxItem } from './inbox.ts'
import { RunStore } from './store.ts'

export type { InterruptReason } from './coordinator.ts'

export const defaultMaxResumeAttempts = 10

export type ResumeSuspendedResult = {
  readonly resumed: ReadonlyArray<string>
  readonly exhausted: ReadonlyArray<string>
}

export type DriverApi = {
  readonly active: Effect.Effect<ReadonlySet<string>>
  readonly isActive: (runId: string) => Effect.Effect<boolean>
  readonly run: (runId: string) => Effect.Effect<void>
  readonly wake: (runId: string, scope?: Promotable) => Effect.Effect<void>
  readonly interrupt: (
    runId: string,
    options?: { readonly reason?: InterruptReason; readonly awaitSettlement?: boolean }
  ) => Effect.Effect<boolean>
  readonly awaitIdle: (runId: string) => Effect.Effect<void>
  readonly resumeSuspended: Effect.Effect<ResumeSuspendedResult>
}

export class Driver extends Context.Service<Driver, DriverApi>()('@yolk-sdk/harness/Driver') {
  /**
   * Canonical owning layer for the run driver. Yields the contextual {@link RunStore} and
   * {@link RunCoordinator} so their requirements propagate to the composition root; the
   * single coordinator instance backing this driver is wired consciously by the caller.
   * Each call builds a fresh layer.
   */
  static layer = (options?: {
    readonly maxResumeAttempts?: number
  }): Layer.Layer<Driver, never, RunStore | RunCoordinator> =>
    Layer.effect(
      this,
      Effect.gen(function* () {
        const store = yield* RunStore
        const coordinator = yield* RunCoordinator
        const maxResumeAttempts = options?.maxResumeAttempts ?? defaultMaxResumeAttempts

        const resumeSuspended = Effect.gen(function* () {
          const claimed = yield* store.claimed
          const resumed: Array<string> = []
          const exhausted: Array<string> = []

          for (const runId of claimed) {
            if (yield* coordinator.isActive(runId)) continue
            const count = yield* store.incrementResumeCount(runId)

            if (count > maxResumeAttempts) {
              yield* store.release(runId)
              exhausted.push(runId)
              continue
            }

            yield* coordinator.wake(runId)
            resumed.push(runId)
          }

          return { resumed, exhausted }
        })

        return Driver.of({
          active: coordinator.active,
          isActive: coordinator.isActive,
          run: coordinator.run,
          wake: coordinator.wake,
          interrupt: (runId, interruptOptions) =>
            coordinator.interrupt(runId, interruptOptions?.reason ?? 'user', interruptOptions),
          awaitIdle: coordinator.awaitIdle,
          resumeSuspended
        })
      })
    )

  /**
   * Canonical coordinated driver composition. Captures `options` by reference and reads
   * `drain` before `maxResumeAttempts` at layer acquisition (never at factory
   * construction), matching the historical evaluation order. Builds one coordinator per
   * driver over the contextual store; each call returns a fresh layer.
   */
  static coordinatedLayer = (options?: {
    readonly drain?: (runId: string, force: boolean, scope: Promotable) => Effect.Effect<void>
    readonly maxResumeAttempts?: number
  }): Layer.Layer<Driver, never, RunStore> =>
    Layer.unwrap(
      Effect.gen(function* () {
        const store = yield* RunStore
        const drain = options?.drain ?? ((_runId, _force, _scope) => Effect.void)
        const maxResumeAttempts = options?.maxResumeAttempts ?? defaultMaxResumeAttempts
        const storeLayer = Layer.succeed(RunStore, store)
        const coordinator = RunCoordinator.layer({ drain }).pipe(Layer.provide(storeLayer))

        const driver = Driver.layer({ maxResumeAttempts }).pipe(
          Layer.provide(coordinator),
          Layer.provide(storeLayer)
        )

        return driver
      })
    )
}

export const makeHarness = <DE, DR, SE, SR, IE, IR>(input: {
  readonly driver: Layer.Layer<Driver, DE, DR>
  readonly store: Layer.Layer<RunStore, SE, SR>
  readonly inbox: Layer.Layer<Inbox, IE, IR>
}): Layer.Layer<Driver | RunStore | Inbox, DE | SE | IE, DR | SR | IR> =>
  Layer.mergeAll(input.driver, input.store, input.inbox)

export const admit = (item: InboxItem) =>
  Effect.gen(function* () {
    const inbox = yield* Inbox
    const driver = yield* Driver
    yield* inbox.enqueue(item)
    yield* driver.wake(item.runId, item.delivery === 'steer' ? 'steer' : 'input')
  })

/**
 * Backward-compatible delegation to {@link Driver.coordinatedLayer} with a default run
 * coordinator. Keeps the historical `RunStore`-only requirement and defers all option
 * reads to layer acquisition, so existing callers are unaffected.
 */
export const makeDriverLayer = (options?: {
  readonly drain?: (runId: string, force: boolean, scope: Promotable) => Effect.Effect<void>
  readonly maxResumeAttempts?: number
}): Layer.Layer<Driver, never, RunStore> => Driver.coordinatedLayer(options)
