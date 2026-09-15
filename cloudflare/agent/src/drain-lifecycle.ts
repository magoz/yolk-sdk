import { Cause, Data, Deferred, Effect, Exit, Match, Predicate, Ref, Semaphore } from 'effect'
import type { DriverApi } from '@yolk-sdk/harness/driver'
import { makeDrainOccupancy, type DrainToken, type DrainWork } from './drain-occupancy.ts'

export type LiveToken = DrainToken & {
  readonly socketId: string
}

export type StartResult =
  | { readonly _tag: 'Accepted'; readonly token: LiveToken }
  | { readonly _tag: 'Conflict' }
  | { readonly _tag: 'Stale' }

export const StartResult = Data.taggedEnum<StartResult>()

export const notifyRejectedStart = <E, R>(
  started: StartResult,
  notifyConflict: Effect.Effect<void, E, R>
): Effect.Effect<void, E, R> =>
  Match.value(started).pipe(
    Match.tag('Accepted', () => Effect.void),
    Match.orElse(() => notifyConflict)
  )

type LiveOwner = {
  readonly token: LiveToken
  // Private receipt: succeed with Exit so interrupt fan-out reaches every waiter.
  // Public waiters flatten; this is not a global Effect Deferred fix.
  readonly done: Deferred.Deferred<Exit.Exit<void, unknown>>
}

const awaitDone = (done: Deferred.Deferred<Exit.Exit<void, unknown>>) =>
  Deferred.await(done).pipe(Effect.flatMap(exit => exit))

export type LiveDrainOptions = {
  readonly afterInterrupt?: Effect.Effect<void>
}

const userInterrupt = (driver: DriverApi, sessionId: string) =>
  driver.interrupt(sessionId, { reason: 'user', awaitSettlement: true })

const awaitOwner = (owner: LiveOwner) =>
  awaitDone(owner.done).pipe(
    Effect.exit,
    Effect.flatMap(exit =>
      Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)
        ? Effect.void
        : Effect.failCause(exit.cause)
    )
  )

export const makeLiveDrain = (options?: LiveDrainOptions) =>
  Effect.gen(function* () {
    const occupancy = yield* makeDrainOccupancy()
    const epoch = yield* Ref.make(0)
    const nextId = yield* Ref.make(0)
    const gate = yield* Semaphore.make(1)
    const liveOwner = yield* Ref.make<LiveOwner | undefined>(undefined)
    const reconnecting = yield* Ref.make(false)
    const reconnectGeneration = yield* Ref.make(0)
    const afterInterrupt = options?.afterInterrupt ?? Effect.void

    const withGate = <A, E, R>(effect: Effect.Effect<A, E, R>) => gate.withPermits(1)(effect)

    const casRelease = (token: LiveToken) =>
      withGate(
        Effect.gen(function* () {
          const current = yield* Ref.get(liveOwner)

          if (current === undefined || current.token.id !== token.id) {
            return false
          }

          yield* occupancy.releaseIf(token)
          yield* Ref.set(liveOwner, undefined)

          return true
        })
      )

    const clearReconnectingIf = (generation: number) =>
      withGate(
        Effect.gen(function* () {
          if ((yield* Ref.get(reconnectGeneration)) === generation) {
            yield* Ref.set(reconnecting, false)
          }
        })
      )

    const interruptIfToken = (token: LiveToken, driver: DriverApi, sessionId: string) =>
      withGate(
        Effect.gen(function* () {
          const current = yield* Ref.get(liveOwner)

          if (current === undefined || current.token.id !== token.id) {
            return undefined
          }

          yield* userInterrupt(driver, sessionId)

          return current
        })
      )

    const interruptIfSocket = (socketId: string, driver: DriverApi, sessionId: string) =>
      withGate(
        Effect.gen(function* () {
          const current = yield* Ref.get(liveOwner)

          if (current === undefined || current.token.socketId !== socketId) {
            return undefined
          }

          yield* userInterrupt(driver, sessionId)

          return current
        })
      )

    const admitUnderGate = (prepareEpoch: number, socketId: string, work: DrainWork) =>
      Effect.gen(function* () {
        if ((yield* Ref.get(epoch)) !== prepareEpoch || (yield* Ref.get(reconnecting))) {
          return StartResult.Stale()
        }

        const id = yield* Ref.modify(nextId, current => [current + 1, current + 1] as const)
        const token: LiveToken = { id, socketId }

        if (!(yield* occupancy.occupy(work, token))) {
          return StartResult.Conflict()
        }

        return StartResult.Accepted({ token })
      })

    const registerUnderGate = (
      prepareEpoch: number,
      socketId: string,
      work: DrainWork,
      driver: DriverApi,
      sessionId: string
    ) =>
      Effect.gen(function* () {
        const admitted = yield* admitUnderGate(prepareEpoch, socketId, work)

        if (!Predicate.isTagged(admitted, 'Accepted')) {
          return admitted
        }

        const done = yield* Deferred.make<Exit.Exit<void, unknown>>()
        yield* driver.run(sessionId).pipe(
          Effect.interruptible,
          Effect.exit,
          Effect.flatMap(exit => Deferred.succeed(done, exit)),
          Effect.forkDetach({ startImmediately: true, uninterruptible: false })
        )
        yield* Ref.set(liveOwner, { token: admitted.token, done })

        return admitted
      })

    return {
      beginPrepare: () => Ref.get(epoch),
      runHeld: occupancy.runHeld,
      runOwned: (
        prepareEpoch: number,
        socketId: string,
        work: DrainWork,
        driver: DriverApi,
        sessionId: string
      ) =>
        Effect.uninterruptibleMask(restore =>
          Effect.gen(function* () {
            const started = yield* withGate(
              registerUnderGate(prepareEpoch, socketId, work, driver, sessionId)
            )

            if (!Predicate.isTagged(started, 'Accepted')) {
              return started
            }

            const owner = yield* Ref.get(liveOwner)

            const done =
              owner !== undefined && owner.token.id === started.token.id ? owner.done : undefined

            const exit = yield* restore(
              done === undefined
                ? Effect.void
                : Effect.onInterrupt(awaitDone(done), () =>
                    interruptIfToken(started.token, driver, sessionId).pipe(
                      Effect.flatMap(captured =>
                        captured === undefined ? Effect.void : awaitOwner(captured)
                      )
                    )
                  )
            ).pipe(Effect.exit)

            yield* casRelease(started.token)

            if (Exit.isSuccess(exit)) {
              return started
            }

            return yield* Effect.failCause(exit.cause)
          })
        ),
      reconnect: (driver: DriverApi, sessionId: string, finalize: Effect.Effect<void>) =>
        Effect.uninterruptibleMask(restore =>
          Effect.gen(function* () {
            const captured = yield* withGate(
              Effect.gen(function* () {
                const generation = yield* Ref.modify(
                  reconnectGeneration,
                  current => [current + 1, current + 1] as const
                )

                yield* Ref.update(epoch, current => current + 1)
                yield* Ref.set(reconnecting, true)
                const owner = yield* Ref.get(liveOwner)

                if (owner !== undefined) {
                  yield* userInterrupt(driver, sessionId)
                }

                return { generation, owner }
              })
            )

            yield* restore(
              Effect.gen(function* () {
                if (captured.owner !== undefined) {
                  yield* awaitOwner(captured.owner)
                }

                yield* withGate(
                  Effect.gen(function* () {
                    if ((yield* Ref.get(reconnectGeneration)) !== captured.generation) {
                      return
                    }

                    if (captured.owner !== undefined) {
                      const current = yield* Ref.get(liveOwner)

                      if (current !== undefined && current.token.id === captured.owner.token.id) {
                        yield* occupancy.releaseIf(captured.owner.token)
                        yield* Ref.set(liveOwner, undefined)
                      }
                    }

                    yield* finalize
                  })
                )
              })
            ).pipe(Effect.ensuring(clearReconnectingIf(captured.generation)))
          })
        ),
      closeOwner: (socketId: string, driver: DriverApi, sessionId: string) =>
        Effect.gen(function* () {
          const owner = yield* interruptIfSocket(socketId, driver, sessionId)
          yield* afterInterrupt

          if (owner === undefined) {
            return
          }

          yield* awaitOwner(owner)
          yield* casRelease(owner.token)
        })
    }
  })
