import { Context, Effect, Exit, Layer } from 'effect'
import { makeCoordinator, type Promotable } from './coordinator.ts'
import {
  Inbox,
  type HitlAdmission,
  type HitlDecision,
  type InboxItem,
  type ParkedResponse,
  type PauseDecision
} from './inbox.ts'
import { RunStore } from './store.ts'

export type InterruptReason = 'user' | 'shutdown'

export const defaultMaxResumeAttempts = 10

export type ResumeSuspendedResult = {
  readonly resumed: ReadonlyArray<string>
  readonly exhausted: ReadonlyArray<string>
}

export type DrainContext = {
  readonly drainToken: string
  readonly readyResponses: ReadonlyArray<ParkedResponse>
}

export type Drain = (
  runId: string,
  force: boolean,
  scope: Promotable,
  context: DrainContext
) => Effect.Effect<void, never, Inbox | RunStore>

export type StopDecision =
  | { readonly _tag: 'Interrupted' }
  | { readonly _tag: 'ParkCleared' }
  | { readonly _tag: 'Idle' }

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
  readonly admit: (item: InboxItem) => Effect.Effect<void>
  readonly pause: (
    runId: string,
    requestIds: ReadonlyArray<string>,
    drainToken: string
  ) => Effect.Effect<PauseDecision>
  readonly resumeHitl: (runId: string, admission: HitlAdmission) => Effect.Effect<HitlDecision>
  readonly stop: (runId: string) => Effect.Effect<StopDecision>
}

export class Driver extends Context.Service<Driver, DriverShape>()('@yolk-sdk/harness/Driver') {}

export const makeHarness = <DE, DR, SE, SR, IE, IR>(input: {
  readonly driver: Layer.Layer<Driver, DE, DR>
  readonly store: Layer.Layer<RunStore, SE, SR>
  readonly inbox: Layer.Layer<Inbox, IE, IR>
}): Layer.Layer<Driver | RunStore | Inbox, DE | SE | IE, DR | SR | IR> =>
  Layer.mergeAll(input.driver, input.store, input.inbox)

export const admit = (item: InboxItem) => Effect.flatMap(Driver, driver => driver.admit(item))

export const makeDriverLayer = (options?: {
  readonly drain?: Drain
  readonly maxResumeAttempts?: number
}): Layer.Layer<Driver, never, RunStore | Inbox> =>
  Layer.effect(
    Driver,
    Effect.gen(function* () {
      const store = yield* RunStore
      const inbox = yield* Inbox
      const hostDrain = options?.drain ?? ((_runId, _force, _scope, _context) => Effect.void)
      const maxResumeAttempts = options?.maxResumeAttempts ?? defaultMaxResumeAttempts
      const coordinator = yield* makeCoordinator<string, never, InterruptReason>({
        drain: (runId, force, scope) =>
          inbox.beginDrain(runId).pipe(
            Effect.flatMap(begun => {
              if (begun._tag === 'Skip') return Effect.void
              return Effect.suspend(() =>
                hostDrain(runId, force, scope, {
                  drainToken: begun.drainToken,
                  readyResponses: begun.readyResponses
                })
              ).pipe(
                Effect.provideService(Inbox, inbox),
                Effect.provideService(RunStore, store),
                Effect.onExit(exit => inbox.endDrain(runId, begun.drainToken, Exit.isSuccess(exit)))
              )
            })
          ),
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
          const parked = yield* inbox.parked(runId)
          if (parked !== undefined && !parked.ready) continue
          const count = yield* store.incrementResumeCount(runId)
          if (count > maxResumeAttempts) {
            yield* store.release(runId)
            exhausted.push(runId)
            continue
          }
          const woke = yield* inbox.wakeIfUnblocked(runId, coordinator.wake(runId))
          if (woke) resumed.push(runId)
        }

        return { resumed, exhausted }
      })

      return Driver.of({
        active: coordinator.active,
        isActive: coordinator.isActive,
        run: runId => {
          const continueRun = (): Effect.Effect<void> =>
            inbox.startIfUnblocked(runId, coordinator.captureRun(runId)).pipe(
              Effect.flatMap(ticket => {
                if (ticket === undefined) return Effect.void
                if (ticket._tag === 'Stopping') {
                  return ticket.awaitSettlement.pipe(Effect.andThen(Effect.suspend(continueRun)))
                }
                return ticket.join
              })
            )
          return continueRun()
        },
        wake: (runId, scope = 'input') =>
          inbox.wakeIfUnblocked(runId, coordinator.wake(runId, scope)).pipe(Effect.asVoid),
        interrupt: (runId, interruptOptions) =>
          coordinator.interrupt(runId, interruptOptions?.reason ?? 'user', interruptOptions),
        awaitIdle: coordinator.awaitIdle,
        resumeSuspended,
        admit: item =>
          inbox.enqueueAndWake(
            item,
            coordinator.wake(item.runId, item.delivery === 'steer' ? 'steer' : 'input')
          ),
        pause: (runId, requestIds, drainToken) => inbox.park(runId, requestIds, drainToken),
        resumeHitl: (runId, admission) =>
          inbox.acceptHitl(runId, admission, coordinator.wake(runId, 'input')),
        stop: runId =>
          inbox
            .invalidate(
              runId,
              coordinator
                .terminalStop(runId, 'user')
                .pipe(
                  Effect.map(
                    receipt => receipt._tag === 'Interrupted' || receipt._tag === 'LiveStopping'
                  )
                ),
              store
                .isClaimed(runId)
                .pipe(Effect.flatMap(claimed => (claimed ? store.release(runId) : Effect.void)))
            )
            .pipe(
              Effect.map(result => {
                if (result.interrupted) return { _tag: 'Interrupted' } as const
                if (result.hadPark) return { _tag: 'ParkCleared' } as const
                return { _tag: 'Idle' } as const
              })
            )
      })
    })
  )
