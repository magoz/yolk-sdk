import { Context, Effect, Exit, Layer } from 'effect'
import { makeCoordinator, type Promotable } from './coordinator.ts'
import { Inbox, type InboxItem } from './inbox.ts'
import { RunStore } from './store.ts'

export type InterruptReason = 'user' | 'shutdown'

export const defaultMaxResumeAttempts = 10

export type ResumeSuspendedResult = {
  readonly resumed: ReadonlyArray<string>
  readonly exhausted: ReadonlyArray<string>
}

export type DriverShape = {
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

export class Driver extends Context.Service<Driver, DriverShape>()('@yolk-sdk/harness/Driver') {}

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

export const makeDriverLayer = (options?: {
  readonly drain?: (runId: string, force: boolean, scope: Promotable) => Effect.Effect<void>
  readonly maxResumeAttempts?: number
}): Layer.Layer<Driver, never, RunStore> =>
  Layer.effect(
    Driver,
    Effect.gen(function* () {
      const store = yield* RunStore
      const drain = options?.drain ?? ((_runId, _force, _scope) => Effect.void)
      const maxResumeAttempts = options?.maxResumeAttempts ?? defaultMaxResumeAttempts
      const coordinator = yield* makeCoordinator<string, never, InterruptReason>({
        drain,
        started: runId => store.claim(runId),
        settled: (runId, exit, reason) =>
          reason === 'user' || (reason === undefined && !Exit.hasInterrupts(exit))
            ? store.release(runId)
            : Effect.void
      })

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
