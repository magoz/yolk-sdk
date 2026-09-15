import { Context, Data, Effect, Exit, Layer, Predicate, Semaphore } from 'effect'
import { StopDecision as stopDecision } from './outcome-constructors-internal.ts'
import { RunCoordinator, type InterruptReason, type Promotable } from './coordinator.ts'
import {
  DrainBegin,
  Inbox,
  RecoveryAttempt,
  type HitlAdmission,
  type HitlDecision,
  type InboxItem,
  type ParkedResponse,
  type PauseDecision
} from './inbox.ts'
import { RunStore } from './store.ts'

export type { InterruptReason } from './coordinator.ts'

export const defaultMaxResumeAttempts = 10

export class InvalidMaxResumeAttempts extends Data.TaggedError('InvalidMaxResumeAttempts')<{
  readonly maxResumeAttempts: number
}> {}

const isValidMaxResumeAttempts = (value: number) => Number.isSafeInteger(value) && value >= 0

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

export type DriverLayerOptions = {
  readonly drain?: Drain
  readonly maxResumeAttempts?: number
}

export type StopDecision =
  | { readonly _tag: 'Interrupted' }
  | { readonly _tag: 'ParkCleared' }
  | { readonly _tag: 'Idle' }

export const StopDecision = stopDecision

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
  readonly admit: (item: InboxItem) => Effect.Effect<void>
  readonly pause: (
    runId: string,
    requestIds: ReadonlyArray<string>,
    drainToken: string
  ) => Effect.Effect<PauseDecision>
  readonly resumeHitl: (runId: string, admission: HitlAdmission) => Effect.Effect<HitlDecision>
  readonly stop: (runId: string) => Effect.Effect<StopDecision>
}

export class Driver extends Context.Service<Driver, DriverApi>()('@yolk-sdk/harness/Driver') {
  static layer(): Layer.Layer<Driver, never, RunStore | Inbox | RunCoordinator>
  static layer(options?: {
    readonly maxResumeAttempts?: undefined
  }): Layer.Layer<Driver, never, RunStore | Inbox | RunCoordinator>
  static layer(
    options?: Pick<DriverLayerOptions, 'maxResumeAttempts'>
  ): Layer.Layer<Driver, InvalidMaxResumeAttempts, RunStore | Inbox | RunCoordinator>
  static layer(options?: Pick<DriverLayerOptions, 'maxResumeAttempts'>) {
    return Layer.effect(
      Driver,
      Effect.gen(function* () {
        const maxResumeAttempts = options?.maxResumeAttempts ?? defaultMaxResumeAttempts

        if (!isValidMaxResumeAttempts(maxResumeAttempts)) {
          return yield* Effect.fail(new InvalidMaxResumeAttempts({ maxResumeAttempts }))
        }

        const store = yield* RunStore
        const inbox = yield* Inbox
        const sweep = yield* Semaphore.make(1)
        const coordinator = yield* RunCoordinator

        const resumeSuspended = sweep.withPermits(1)(
          Effect.gen(function* () {
            const claimed = yield* store.claimed
            const resumed: Array<string> = []
            const exhausted: Array<string> = []

            for (const runId of claimed) {
              const admission = yield* inbox.admitRecovery(
                runId,
                Effect.gen(function* () {
                  if (yield* coordinator.isActive(runId)) return RecoveryAttempt.Skip()

                  if (!(yield* store.isClaimed(runId))) return RecoveryAttempt.Skip()
                  const count = yield* store.resumeCount(runId)

                  if (count >= maxResumeAttempts) {
                    yield* store.release(runId)

                    return RecoveryAttempt.Exhausted()
                  }

                  yield* store.incrementResumeCount(runId)

                  return RecoveryAttempt.Resume()
                }),
                coordinator.wake(runId, 'input')
              )

              if (Predicate.isTagged(admission, 'Resumed')) resumed.push(runId)
              else if (Predicate.isTagged(admission, 'Exhausted')) exhausted.push(runId)
            }

            return { resumed, exhausted }
          })
        )

        return Driver.of({
          active: coordinator.active,
          isActive: coordinator.isActive,
          run: runId => {
            const continueRun = (): Effect.Effect<void> =>
              inbox.startIfUnblocked(runId, coordinator.captureRun(runId)).pipe(
                Effect.flatMap(ticket => {
                  if (ticket === undefined) return Effect.void

                  if (Predicate.isTagged(ticket, 'Stopping')) {
                    return ticket.awaitSettlement.pipe(Effect.andThen(Effect.suspend(continueRun)))
                  }

                  return ticket.join
                })
              )

            return continueRun()
          },
          wake: (runId, scope = 'input') =>
            inbox.wakeIfUnblocked(runId, scope, coordinator.wake(runId, scope)).pipe(Effect.asVoid),
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
                      receipt =>
                        Predicate.isTagged(receipt, 'Interrupted') ||
                        Predicate.isTagged(receipt, 'LiveStopping')
                    )
                  ),
                store
                  .isClaimed(runId)
                  .pipe(Effect.flatMap(claimed => (claimed ? store.release(runId) : Effect.void)))
              )
              .pipe(
                Effect.map(result => {
                  if (result.interrupted) return StopDecision.Interrupted()

                  if (result.hadPark) return StopDecision.ParkCleared()

                  return StopDecision.Idle()
                })
              )
        })
      })
    )
  }

  static coordinatedLayer(): Layer.Layer<Driver, never, RunStore | Inbox>
  static coordinatedLayer(options?: {
    readonly drain?: Drain
    readonly maxResumeAttempts?: undefined
  }): Layer.Layer<Driver, never, RunStore | Inbox>
  static coordinatedLayer(
    options?: DriverLayerOptions
  ): Layer.Layer<Driver, InvalidMaxResumeAttempts, RunStore | Inbox>
  static coordinatedLayer(options?: DriverLayerOptions) {
    return Layer.unwrap(
      Effect.gen(function* () {
        const store = yield* RunStore
        const inbox = yield* Inbox
        // Keep compatibility option reads lazy and in drain/max order.
        const hostDrain = options?.drain ?? ((_runId, _force, _scope, _context) => Effect.void)
        const maxResumeAttempts = options?.maxResumeAttempts ?? defaultMaxResumeAttempts
        const storeLayer = Layer.succeed(RunStore, store)
        const inboxLayer = Layer.succeed(Inbox, inbox)

        const coordinator = RunCoordinator.layer({
          drain: (runId, force, scope) =>
            inbox.beginDrain(runId, scope).pipe(
              Effect.flatMap(begun => {
                if (DrainBegin.$is('Skip')(begun)) return Effect.void

                return Effect.suspend(() =>
                  hostDrain(runId, force, scope, {
                    drainToken: begun.drainToken,
                    readyResponses: begun.readyResponses
                  })
                ).pipe(
                  Effect.provideService(Inbox, inbox),
                  Effect.provideService(RunStore, store),
                  Effect.onExit(exit =>
                    inbox.endDrain(runId, begun.drainToken, Exit.isSuccess(exit))
                  )
                )
              })
            )
        }).pipe(Layer.provide(storeLayer))

        return Driver.layer({ maxResumeAttempts }).pipe(
          Layer.provide(coordinator),
          Layer.provide(storeLayer),
          Layer.provide(inboxLayer)
        )
      })
    )
  }
}

export const makeHarness = <DE, DR, SE, SR, IE, IR>(input: {
  readonly driver: Layer.Layer<Driver, DE, DR>
  readonly store: Layer.Layer<RunStore, SE, SR>
  readonly inbox: Layer.Layer<Inbox, IE, IR>
}): Layer.Layer<Driver | RunStore | Inbox, DE | SE | IE, DR | SR | IR> =>
  Layer.mergeAll(input.driver, input.store, input.inbox)

export const admit = (item: InboxItem) => Effect.flatMap(Driver, driver => driver.admit(item))

export function makeDriverLayer(): Layer.Layer<Driver, never, RunStore | Inbox>
export function makeDriverLayer(options?: {
  readonly drain?: Drain
  readonly maxResumeAttempts?: undefined
}): Layer.Layer<Driver, never, RunStore | Inbox>
export function makeDriverLayer(
  options?: DriverLayerOptions
): Layer.Layer<Driver, InvalidMaxResumeAttempts, RunStore | Inbox>
export function makeDriverLayer(options?: DriverLayerOptions) {
  return options === undefined ? Driver.coordinatedLayer() : Driver.coordinatedLayer(options)
}
