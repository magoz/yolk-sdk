import { Deferred, Effect, Exit, Fiber, Layer, Ref } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { Driver, makeDriverLayer } from '@yolk-sdk/harness/driver'
import { makeInMemoryHarnessLayer } from '@yolk-sdk/harness/driver/memory'
import { makeInMemoryInboxLayer } from '@yolk-sdk/harness/inbox'
import { RunStore } from '@yolk-sdk/harness/store'
import { makeLiveDrain, notifyRejectedStart } from '../src/drain-lifecycle.ts'

const makeHarnessLayer = (
  live: { readonly runHeld: Effect.Effect<void> },
  storeLayer: Layer.Layer<RunStore>
) =>
  makeDriverLayer({ drain: () => live.runHeld }).pipe(
    Layer.provide(storeLayer),
    Layer.provideMerge(makeInMemoryInboxLayer())
  )

const makeDelayedReleaseStoreLayer = (
  entered: Deferred.Deferred<void>,
  hold: Deferred.Deferred<void>
) =>
  Layer.effect(
    RunStore,
    Effect.gen(function* () {
      const claimed = yield* Ref.make(new Set<string>())
      const resumes = yield* Ref.make(new Map<string, number>())
      return RunStore.of({
        claim: runId => Ref.update(claimed, current => new Set(current).add(runId)),
        release: runId =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(hold)),
            Effect.andThen(
              Effect.zip(
                Ref.update(claimed, current => {
                  const next = new Set(current)
                  next.delete(runId)
                  return next
                }),
                Ref.update(resumes, current => {
                  const next = new Map(current)
                  next.delete(runId)
                  return next
                })
              )
            ),
            Effect.asVoid
          ),
        isClaimed: runId => Ref.get(claimed).pipe(Effect.map(current => current.has(runId))),
        claimed: Ref.get(claimed).pipe(Effect.map(current => new Set(current))),
        incrementResumeCount: runId =>
          Ref.modify(resumes, current => {
            const nextCount = (current.get(runId) ?? 0) + 1
            const next = new Map(current)
            next.set(runId, nextCount)
            return [nextCount, next] as const
          }),
        resumeCount: runId => Ref.get(resumes).pipe(Effect.map(current => current.get(runId) ?? 0))
      })
    })
  )

const makeClaimStoreLayer = (claim: (runId: string) => Effect.Effect<void>) =>
  Layer.effect(
    RunStore,
    Effect.succeed(
      RunStore.of({
        claim,
        release: () => Effect.void,
        isClaimed: () => Effect.succeed(false),
        claimed: Effect.succeed(new Set()),
        incrementResumeCount: () => Effect.succeed(1),
        resumeCount: () => Effect.succeed(0)
      })
    )
  )

describe('makeLiveDrain', () => {
  it.effect('conflicts concurrent runOwned while a drain is live', () =>
    Effect.gen(function* () {
      const live = yield* makeLiveDrain()
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const layer = makeInMemoryHarnessLayer({ drain: () => live.runHeld })

      yield* Effect.gen(function* () {
        const driver = yield* Driver
        const prepare = yield* live.beginPrepare()
        const running = yield* live
          .runOwned(
            prepare,
            'sock_1',
            Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
            driver,
            'run_1'
          )
          .pipe(Effect.forkChild)
        yield* Deferred.await(started)

        const overlapping = yield* live.beginPrepare()
        expect(yield* live.runOwned(overlapping, 'sock_2', Effect.void, driver, 'run_1')).toEqual({
          _tag: 'Conflict'
        })
        expect(yield* driver.isActive('run_1')).toBe(true)

        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(running)

        const after = yield* live.beginPrepare()
        expect((yield* live.runOwned(after, 'sock_3', Effect.void, driver, 'run_1'))._tag).toBe(
          'Accepted'
        )
      }).pipe(Effect.provide(layer))
    })
  )

  it.effect('cancels owned execution when runOwned is interrupted', () =>
    Effect.gen(function* () {
      const live = yield* makeLiveDrain()
      const started = yield* Deferred.make<void>()
      const stillRunning = yield* Ref.make(true)
      const layer = makeInMemoryHarnessLayer({ drain: () => live.runHeld })

      yield* Effect.gen(function* () {
        const driver = yield* Driver
        const prepare = yield* live.beginPrepare()
        const work = Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Ref.set(stillRunning, false))
        )
        const waiting = yield* live
          .runOwned(prepare, 'sock_1', work, driver, 'run_1')
          .pipe(Effect.forkDetach({ startImmediately: true }))
        yield* Deferred.await(started)
        expect(yield* Ref.get(stillRunning)).toBe(true)
        yield* Fiber.interrupt(waiting)
        expect(yield* driver.isActive('run_1')).toBe(false)
        expect(yield* Ref.get(stillRunning)).toBe(false)
        const next = yield* live.beginPrepare()
        expect((yield* live.runOwned(next, 'sock_2', Effect.void, driver, 'run_1'))._tag).toBe(
          'Accepted'
        )
      }).pipe(Effect.provide(layer))
    })
  )

  it.effect('cancelling runOwned during start still cleans up occupancy', () =>
    Effect.gen(function* () {
      const live = yield* makeLiveDrain()
      const layer = makeInMemoryHarnessLayer({ drain: () => live.runHeld })

      yield* Effect.gen(function* () {
        const driver = yield* Driver
        const prepare = yield* live.beginPrepare()
        const waiting = yield* live
          .runOwned(prepare, 'sock_1', Effect.never, driver, 'run_1')
          .pipe(Effect.forkDetach({ startImmediately: true }))
        yield* Fiber.interrupt(waiting)
        const next = yield* live.beginPrepare()
        expect((yield* live.runOwned(next, 'sock_2', Effect.void, driver, 'run_1'))._tag).toBe(
          'Accepted'
        )
      }).pipe(Effect.provide(layer))
    })
  )

  it.effect('reconnect before drain starts still cancels the owned worker', () =>
    Effect.gen(function* () {
      const live = yield* makeLiveDrain()
      const layer = makeInMemoryHarnessLayer({ drain: () => live.runHeld })

      yield* Effect.gen(function* () {
        const driver = yield* Driver
        const prepare = yield* live.beginPrepare()
        const waiting = yield* live
          .runOwned(prepare, 'sock_1', Effect.never, driver, 'run_1')
          .pipe(Effect.forkDetach({ startImmediately: true }))
        yield* live.reconnect(driver, 'run_1', Effect.void)
        yield* Fiber.join(waiting).pipe(Effect.ignoreCause)
        const next = yield* live.beginPrepare()
        expect((yield* live.runOwned(next, 'sock_2', Effect.void, driver, 'run_1'))._tag).toBe(
          'Accepted'
        )
      }).pipe(Effect.provide(layer))
    })
  )

  it.effect('reconnect interrupts live drain and finalizes before new admission', () =>
    Effect.gen(function* () {
      const live = yield* makeLiveDrain()
      const events = yield* Ref.make<ReadonlyArray<string>>([])
      const started = yield* Deferred.make<void>()
      const layer = makeInMemoryHarnessLayer({ drain: () => live.runHeld })

      yield* Effect.gen(function* () {
        const driver = yield* Driver
        const prepare = yield* live.beginPrepare()
        const work = Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Ref.update(events, current => [...current, 'start'])),
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Ref.update(events, current => [...current, 'interrupted']))
        )
        const running = yield* live
          .runOwned(prepare, 'sock_1', work, driver, 'run_1')
          .pipe(Effect.forkChild)
        yield* Deferred.await(started)
        yield* live.reconnect(
          driver,
          'run_1',
          Ref.update(events, current => [...current, 'finalized'])
        )
        yield* Fiber.join(running).pipe(Effect.ignoreCause)

        expect(yield* Ref.get(events)).toContain('interrupted')
        expect(yield* Ref.get(events)).toContain('finalized')
        expect(yield* driver.isActive('run_1')).toBe(false)
      }).pipe(Effect.provide(layer))
    })
  )

  it.effect('clears reconnecting when finalize fails so a later runOwned can proceed', () =>
    Effect.gen(function* () {
      const live = yield* makeLiveDrain()
      const layer = makeInMemoryHarnessLayer({ drain: () => live.runHeld })

      yield* Effect.gen(function* () {
        const driver = yield* Driver
        const exit = yield* live
          .reconnect(driver, 'run_1', Effect.die('finalize failed'))
          .pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        const prepare = yield* live.beginPrepare()
        expect((yield* live.runOwned(prepare, 'sock_1', Effect.void, driver, 'run_1'))._tag).toBe(
          'Accepted'
        )
      }).pipe(Effect.provide(layer))
    })
  )

  it.effect('older reconnect cannot clear reconnecting for a newer reconnect', () =>
    Effect.gen(function* () {
      const live = yield* makeLiveDrain()
      const firstHold = yield* Deferred.make<void>()
      const firstEntered = yield* Deferred.make<void>()
      const layer = makeInMemoryHarnessLayer({ drain: () => live.runHeld })

      yield* Effect.gen(function* () {
        const driver = yield* Driver
        const first = yield* live
          .reconnect(
            driver,
            'run_1',
            Deferred.succeed(firstEntered, undefined).pipe(
              Effect.andThen(Deferred.await(firstHold))
            )
          )
          .pipe(Effect.forkChild)
        yield* Deferred.await(firstEntered)
        const second = yield* live.reconnect(driver, 'run_1', Effect.void).pipe(Effect.forkChild)
        yield* Deferred.succeed(firstHold, undefined)
        yield* Fiber.join(first)
        yield* Fiber.join(second)
        const prepare = yield* live.beginPrepare()
        expect((yield* live.runOwned(prepare, 'sock_1', Effect.void, driver, 'run_1'))._tag).toBe(
          'Accepted'
        )
      }).pipe(Effect.provide(layer))
    })
  )

  it.effect('stale closeOwner cleanup does not interrupt a successor', () =>
    Effect.gen(function* () {
      const pause = yield* Deferred.make<void>()
      const live = yield* makeLiveDrain({ afterInterrupt: Deferred.await(pause) })
      const firstStarted = yield* Deferred.make<void>()
      const secondStarted = yield* Deferred.make<void>()
      const secondRelease = yield* Deferred.make<void>()
      const layer = makeInMemoryHarnessLayer({ drain: () => live.runHeld })

      yield* Effect.gen(function* () {
        const driver = yield* Driver
        const firstPrepare = yield* live.beginPrepare()
        const first = yield* live
          .runOwned(
            firstPrepare,
            'sock_a',
            Deferred.succeed(firstStarted, undefined).pipe(Effect.andThen(Effect.never)),
            driver,
            'run_1'
          )
          .pipe(Effect.forkChild)
        yield* Deferred.await(firstStarted)

        const closing = yield* live.closeOwner('sock_a', driver, 'run_1').pipe(Effect.forkChild)
        yield* Fiber.join(first).pipe(Effect.ignoreCause)

        const secondPrepare = yield* live.beginPrepare()
        const second = yield* live
          .runOwned(
            secondPrepare,
            'sock_b',
            Deferred.succeed(secondStarted, undefined).pipe(
              Effect.andThen(Deferred.await(secondRelease))
            ),
            driver,
            'run_1'
          )
          .pipe(Effect.forkChild)
        yield* Deferred.await(secondStarted)
        expect(yield* driver.isActive('run_1')).toBe(true)

        yield* Deferred.succeed(pause, undefined)
        yield* Fiber.join(closing)
        expect(yield* driver.isActive('run_1')).toBe(true)

        yield* Deferred.succeed(secondRelease, undefined)
        yield* Fiber.join(second)
      }).pipe(Effect.provide(layer))
    })
  )

  it.effect('marks a pre-admission prepare stale after reconnect', () =>
    Effect.gen(function* () {
      const live = yield* makeLiveDrain()
      const layer = makeInMemoryHarnessLayer({ drain: () => live.runHeld })

      yield* Effect.gen(function* () {
        const driver = yield* Driver
        const prepare = yield* live.beginPrepare()
        yield* live.reconnect(driver, 'run_1', Effect.void)
        expect(yield* live.runOwned(prepare, 'sock_1', Effect.void, driver, 'run_1')).toEqual({
          _tag: 'Stale'
        })
      }).pipe(Effect.provide(layer))
    })
  )

  it.effect('does not cancel a new socket run when an old socket closes', () =>
    Effect.gen(function* () {
      const live = yield* makeLiveDrain()
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const layer = makeInMemoryHarnessLayer({ drain: () => live.runHeld })

      yield* Effect.gen(function* () {
        const driver = yield* Driver
        const prepare = yield* live.beginPrepare()
        const running = yield* live
          .runOwned(
            prepare,
            'sock_new',
            Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
            driver,
            'run_1'
          )
          .pipe(Effect.forkChild)
        yield* Deferred.await(started)

        yield* live.closeOwner('sock_old', driver, 'run_1')
        expect(yield* driver.isActive('run_1')).toBe(true)

        yield* live.closeOwner('sock_new', driver, 'run_1')
        yield* Fiber.join(running).pipe(Effect.ignoreCause)
        expect(yield* driver.isActive('run_1')).toBe(false)
      }).pipe(Effect.provide(layer))
    })
  )

  it.effect('reconnect waits for delayed store.release before finalize or successor admit', () =>
    Effect.gen(function* () {
      const live = yield* makeLiveDrain()
      const started = yield* Deferred.make<void>()
      const releaseEntered = yield* Deferred.make<void>()
      const releaseHold = yield* Deferred.make<void>()
      const finalized = yield* Ref.make(false)
      const layer = makeHarnessLayer(
        live,
        makeDelayedReleaseStoreLayer(releaseEntered, releaseHold)
      )

      yield* Effect.gen(function* () {
        const driver = yield* Driver
        const prepare = yield* live.beginPrepare()
        const running = yield* live
          .runOwned(
            prepare,
            'sock_1',
            Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
            driver,
            'run_1'
          )
          .pipe(Effect.forkChild)
        yield* Deferred.await(started)

        const reconnecting = yield* live
          .reconnect(driver, 'run_1', Ref.set(finalized, true))
          .pipe(Effect.forkChild)
        yield* Deferred.await(releaseEntered)

        const successorPrepare = yield* live.beginPrepare()
        const successor = yield* live
          .runOwned(successorPrepare, 'sock_2', Effect.void, driver, 'run_1')
          .pipe(Effect.forkChild)
        expect(reconnecting.pollUnsafe()).toBeUndefined()
        expect(successor.pollUnsafe()).toBeUndefined()
        expect(yield* Ref.get(finalized)).toBe(false)
        expect(yield* driver.isActive('run_1')).toBe(true)

        yield* Deferred.succeed(releaseHold, undefined)
        yield* Fiber.join(reconnecting)
        yield* Fiber.join(running).pipe(Effect.ignoreCause)
        yield* Fiber.join(successor).pipe(Effect.ignoreCause)
        expect(yield* Ref.get(finalized)).toBe(true)
        expect(yield* driver.isActive('run_1')).toBe(false)

        const after = yield* live.beginPrepare()
        expect((yield* live.runOwned(after, 'sock_3', Effect.void, driver, 'run_1'))._tag).toBe(
          'Accepted'
        )
      }).pipe(Effect.provide(layer))
    })
  )

  it.effect(
    'closeOwner waits for delayed store.release before occupancy can admit a successor',
    () =>
      Effect.gen(function* () {
        const live = yield* makeLiveDrain()
        const started = yield* Deferred.make<void>()
        const releaseEntered = yield* Deferred.make<void>()
        const releaseHold = yield* Deferred.make<void>()
        const layer = makeHarnessLayer(
          live,
          makeDelayedReleaseStoreLayer(releaseEntered, releaseHold)
        )

        yield* Effect.gen(function* () {
          const driver = yield* Driver
          const prepare = yield* live.beginPrepare()
          const running = yield* live
            .runOwned(
              prepare,
              'sock_a',
              Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
              driver,
              'run_1'
            )
            .pipe(Effect.forkChild)
          yield* Deferred.await(started)

          const closing = yield* live.closeOwner('sock_a', driver, 'run_1').pipe(Effect.forkChild)
          yield* Deferred.await(releaseEntered)

          const successorPrepare = yield* live.beginPrepare()
          const successor = yield* live
            .runOwned(successorPrepare, 'sock_b', Effect.void, driver, 'run_1')
            .pipe(Effect.forkChild)
          expect(closing.pollUnsafe()).toBeUndefined()
          expect(successor.pollUnsafe()).toBeUndefined()
          expect(yield* driver.isActive('run_1')).toBe(true)

          yield* Deferred.succeed(releaseHold, undefined)
          yield* Fiber.join(closing)
          yield* Fiber.join(running).pipe(Effect.ignoreCause)
          yield* Fiber.join(successor).pipe(Effect.ignoreCause)
          expect(yield* driver.isActive('run_1')).toBe(false)

          const after = yield* live.beginPrepare()
          expect((yield* live.runOwned(after, 'sock_c', Effect.void, driver, 'run_1'))._tag).toBe(
            'Accepted'
          )
        }).pipe(Effect.provide(layer))
      })
  )

  it.effect(
    'caller cancellation waits for delayed store.release before admitting a successor',
    () =>
      Effect.gen(function* () {
        const live = yield* makeLiveDrain()
        const started = yield* Deferred.make<void>()
        const releaseEntered = yield* Deferred.make<void>()
        const releaseHold = yield* Deferred.make<void>()
        const layer = makeHarnessLayer(
          live,
          makeDelayedReleaseStoreLayer(releaseEntered, releaseHold)
        )

        yield* Effect.gen(function* () {
          const driver = yield* Driver
          const prepare = yield* live.beginPrepare()
          const waiting = yield* live
            .runOwned(
              prepare,
              'sock_1',
              Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
              driver,
              'run_1'
            )
            .pipe(Effect.forkDetach({ startImmediately: true }))
          yield* Deferred.await(started)

          const cancelling = yield* Fiber.interrupt(waiting).pipe(Effect.forkChild)
          yield* Deferred.await(releaseEntered)

          const successorPrepare = yield* live.beginPrepare()
          const successor = yield* live
            .runOwned(successorPrepare, 'sock_2', Effect.void, driver, 'run_1')
            .pipe(Effect.forkChild)
          expect(cancelling.pollUnsafe()).toBeUndefined()
          expect(successor.pollUnsafe()).toBeUndefined()
          expect(yield* driver.isActive('run_1')).toBe(true)

          yield* Deferred.succeed(releaseHold, undefined)
          yield* Fiber.join(cancelling)
          yield* Fiber.join(successor).pipe(Effect.ignoreCause)
          expect(yield* driver.isActive('run_1')).toBe(false)

          const after = yield* live.beginPrepare()
          expect((yield* live.runOwned(after, 'sock_3', Effect.void, driver, 'run_1'))._tag).toBe(
            'Accepted'
          )
        }).pipe(Effect.provide(layer))
      })
  )

  it.effect('runOwned fails on a claim defect and releases the slot', () =>
    Effect.gen(function* () {
      const live = yield* makeLiveDrain()
      const attempts = yield* Ref.make(0)
      const layer = makeHarnessLayer(
        live,
        makeClaimStoreLayer(() =>
          Ref.updateAndGet(attempts, current => current + 1).pipe(
            Effect.flatMap(attempt => (attempt === 1 ? Effect.die('claim failed') : Effect.void))
          )
        )
      )

      yield* Effect.gen(function* () {
        const driver = yield* Driver
        const prepare = yield* live.beginPrepare()
        const exit = yield* live
          .runOwned(prepare, 'sock_1', Effect.void, driver, 'run_1')
          .pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        expect(Exit.hasDies(exit)).toBe(true)
        expect(yield* driver.isActive('run_1')).toBe(false)

        const next = yield* live.beginPrepare()
        expect((yield* live.runOwned(next, 'sock_2', Effect.void, driver, 'run_1'))._tag).toBe(
          'Accepted'
        )
      }).pipe(Effect.provide(layer))
    })
  )
})

describe('notifyRejectedStart', () => {
  it.effect(
    'stale prepare after reconnect notifies conflict without running work or interrupting a successor',
    () =>
      Effect.gen(function* () {
        const live = yield* makeLiveDrain()
        const conflicts = yield* Ref.make(0)
        const staleWorkRan = yield* Ref.make(false)
        const successorStarted = yield* Deferred.make<void>()
        const successorRelease = yield* Deferred.make<void>()
        const successorInterrupted = yield* Ref.make(false)
        const layer = makeInMemoryHarnessLayer({ drain: () => live.runHeld })

        yield* Effect.gen(function* () {
          const driver = yield* Driver
          const stalePrepare = yield* live.beginPrepare()
          yield* live.reconnect(driver, 'run_1', Effect.void)

          const successorPrepare = yield* live.beginPrepare()
          const successor = yield* live
            .runOwned(
              successorPrepare,
              'sock_new',
              Deferred.succeed(successorStarted, undefined).pipe(
                Effect.andThen(Deferred.await(successorRelease)),
                Effect.onInterrupt(() => Ref.set(successorInterrupted, true))
              ),
              driver,
              'run_1'
            )
            .pipe(Effect.forkChild)
          yield* Deferred.await(successorStarted)

          const started = yield* live.runOwned(
            stalePrepare,
            'sock_old',
            Ref.set(staleWorkRan, true),
            driver,
            'run_1'
          )
          yield* notifyRejectedStart(
            started,
            Ref.update(conflicts, current => current + 1).pipe(Effect.asVoid)
          )

          expect(started).toEqual({ _tag: 'Stale' })
          expect(yield* Ref.get(conflicts)).toBe(1)
          expect(yield* Ref.get(staleWorkRan)).toBe(false)
          expect(yield* driver.isActive('run_1')).toBe(true)
          expect(yield* Ref.get(successorInterrupted)).toBe(false)

          yield* Deferred.succeed(successorRelease, undefined)
          yield* Fiber.join(successor)
        }).pipe(Effect.provide(layer))
      })
  )

  it.effect(
    'overlapping runOwned notifies conflict without running work or interrupting the live owner',
    () =>
      Effect.gen(function* () {
        const live = yield* makeLiveDrain()
        const conflicts = yield* Ref.make(0)
        const overlappingWorkRan = yield* Ref.make(false)
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const ownerInterrupted = yield* Ref.make(false)
        const layer = makeInMemoryHarnessLayer({ drain: () => live.runHeld })

        yield* Effect.gen(function* () {
          const driver = yield* Driver
          const prepare = yield* live.beginPrepare()
          const running = yield* live
            .runOwned(
              prepare,
              'sock_1',
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.onInterrupt(() => Ref.set(ownerInterrupted, true))
              ),
              driver,
              'run_1'
            )
            .pipe(Effect.forkChild)
          yield* Deferred.await(started)

          const overlappingPrepare = yield* live.beginPrepare()
          const overlapping = yield* live.runOwned(
            overlappingPrepare,
            'sock_2',
            Ref.set(overlappingWorkRan, true),
            driver,
            'run_1'
          )
          yield* notifyRejectedStart(
            overlapping,
            Ref.update(conflicts, current => current + 1).pipe(Effect.asVoid)
          )

          expect(overlapping).toEqual({ _tag: 'Conflict' })
          expect(yield* Ref.get(conflicts)).toBe(1)
          expect(yield* Ref.get(overlappingWorkRan)).toBe(false)
          expect(yield* driver.isActive('run_1')).toBe(true)
          expect(yield* Ref.get(ownerInterrupted)).toBe(false)

          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(running)
        }).pipe(Effect.provide(layer))
      })
  )

  it.effect('accepted runOwned does not notify conflict and runs work', () =>
    Effect.gen(function* () {
      const live = yield* makeLiveDrain()
      const conflicts = yield* Ref.make(0)
      const workRan = yield* Ref.make(false)
      const layer = makeInMemoryHarnessLayer({ drain: () => live.runHeld })

      yield* Effect.gen(function* () {
        const driver = yield* Driver
        const prepare = yield* live.beginPrepare()
        const started = yield* live.runOwned(
          prepare,
          'sock_1',
          Ref.set(workRan, true),
          driver,
          'run_1'
        )
        yield* notifyRejectedStart(
          started,
          Ref.update(conflicts, current => current + 1).pipe(Effect.asVoid)
        )
        expect(started._tag).toBe('Accepted')
        expect(yield* Ref.get(conflicts)).toBe(0)
        expect(yield* Ref.get(workRan)).toBe(true)
      }).pipe(Effect.provide(layer))
    })
  )
})
