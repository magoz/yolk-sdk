import { Cause, Deferred, Effect, Fiber, Ref, Scheduler } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { makeCoordinator } from '../src/coordinator.ts'

const makeRequestHoldScheduler = () => {
  const base = new Scheduler.MixedScheduler('async')
  const known = new Set<number>()
  let armed = false
  let holdNext = false
  let skippedNew = 0
  const held: Array<() => void> = []

  const scheduler: Scheduler.Scheduler = {
    executionMode: 'async',
    shouldYield(fiber) {
      if (armed && !known.has(fiber.id)) {
        known.add(fiber.id)

        if (skippedNew === 0) {
          skippedNew = 1

          return base.shouldYield(fiber)
        }

        holdNext = true

        return true
      }

      known.add(fiber.id)

      return base.shouldYield(fiber)
    },
    makeDispatcher() {
      const inner = base.makeDispatcher()

      return {
        scheduleTask(task, priority) {
          if (holdNext) {
            holdNext = false
            held.push(() => inner.scheduleTask(task, priority))
          } else inner.scheduleTask(task, priority)
        },
        flush() {
          inner.flush()
        }
      }
    }
  }

  return {
    scheduler,
    arm: () => {
      armed = true
      skippedNew = 0
    },
    disarm: () => {
      armed = false
    },
    held,
    releaseHeld: () => {
      const tasks = held.splice(0)

      for (const task of tasks) task()
    }
  }
}

describe('makeCoordinator', () => {
  it.effect('run starts a drain and joiners share the exit', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const drains = yield* Ref.make(0)

        const coordinator = yield* makeCoordinator<string, never>({
          drain: () => Ref.update(drains, count => count + 1)
        })

        yield* Effect.all([coordinator.run('a'), coordinator.run('a')], {
          concurrency: 'unbounded'
        })

        expect(yield* Ref.get(drains)).toBe(1)
        expect(yield* coordinator.isActive('a')).toBe(false)
      })
    )
  )

  it.effect('wake while active coalesces into a second drain', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const drains = yield* Ref.make(0)
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()

        const coordinator = yield* makeCoordinator<string, never>({
          started: () => Deferred.succeed(started, undefined).pipe(Effect.asVoid),
          drain: () =>
            Ref.update(drains, count => count + 1).pipe(
              Effect.andThen(
                Ref.get(drains).pipe(
                  Effect.flatMap(count => (count === 1 ? Deferred.await(release) : Effect.void))
                )
              )
            )
        })

        yield* coordinator.wake('a')
        yield* Deferred.await(started)
        yield* coordinator.wake('a')
        yield* Deferred.succeed(release, undefined)
        yield* coordinator.awaitIdle('a')

        expect(yield* Ref.get(drains)).toBe(2)
      })
    )
  )

  it.effect('input wake subsumes a pending steer', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scopes = yield* Ref.make<ReadonlyArray<string>>([])
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()

        const coordinator = yield* makeCoordinator<string, never>({
          started: () => Deferred.succeed(started, undefined).pipe(Effect.asVoid),
          drain: (_key, _force, scope) =>
            Ref.update(scopes, current => [...current, scope]).pipe(
              Effect.andThen(
                Ref.get(scopes).pipe(
                  Effect.flatMap(current =>
                    current.length === 1 ? Deferred.await(release) : Effect.void
                  )
                )
              )
            )
        })

        yield* coordinator.wake('a', 'steer')
        yield* Deferred.await(started)
        yield* coordinator.wake('a', 'steer')
        yield* coordinator.wake('a', 'input')
        yield* Deferred.succeed(release, undefined)
        yield* coordinator.awaitIdle('a')

        expect(yield* Ref.get(scopes)).toEqual(['steer', 'input'])
      })
    )
  )

  it.effect('interrupt claims the doorbell so pending wakes do not restart', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const drains = yield* Ref.make(0)
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()

        const coordinator = yield* makeCoordinator<string, never>({
          drain: () =>
            Ref.update(drains, count => count + 1).pipe(
              Effect.andThen(Deferred.succeed(started, undefined)),
              Effect.andThen(Deferred.await(release))
            )
        })

        yield* coordinator.wake('a')
        yield* Deferred.await(started)
        yield* coordinator.wake('a')
        const interrupted = yield* coordinator.interrupt('a')
        yield* Deferred.succeed(release, undefined)
        yield* coordinator.awaitIdle('a')

        expect(interrupted).toBe(true)
        expect(yield* Ref.get(drains)).toBe(1)
      })
    )
  )

  it.effect('awaitIdle waits for successor drains before resolving', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const drains = yield* Ref.make(0)
        const started = yield* Deferred.make<void>()
        const firstRelease = yield* Deferred.make<void>()
        const secondStarted = yield* Deferred.make<void>()
        const secondRelease = yield* Deferred.make<void>()

        const coordinator = yield* makeCoordinator<string, never>({
          started: () => Deferred.succeed(started, undefined).pipe(Effect.asVoid),
          drain: () =>
            Ref.update(drains, count => count + 1).pipe(
              Effect.andThen(Ref.get(drains)),
              Effect.flatMap(count =>
                count === 1
                  ? Deferred.await(firstRelease)
                  : Deferred.succeed(secondStarted, undefined).pipe(
                      Effect.andThen(Deferred.await(secondRelease))
                    )
              )
            )
        })

        yield* coordinator.wake('a')
        yield* Deferred.await(started)
        const idle = yield* coordinator.awaitIdle('a').pipe(Effect.forkChild)
        yield* coordinator.wake('a')
        expect(idle.pollUnsafe()).toBeUndefined()
        yield* Deferred.succeed(firstRelease, undefined)
        yield* Deferred.await(secondStarted)
        expect(idle.pollUnsafe()).toBeUndefined()
        yield* Deferred.succeed(secondRelease, undefined)
        yield* Fiber.join(idle)

        expect(yield* Ref.get(drains)).toBe(2)
      })
    )
  )

  it.effect('different keys run concurrently', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const startedA = yield* Deferred.make<void>()
        const startedB = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()

        const coordinator = yield* makeCoordinator<string, never>({
          drain: key =>
            (key === 'a'
              ? Deferred.succeed(startedA, undefined)
              : Deferred.succeed(startedB, undefined)
            ).pipe(Effect.andThen(Deferred.await(release)))
        })

        yield* coordinator.wake('a')
        yield* coordinator.wake('b')
        yield* Deferred.await(startedA)
        yield* Deferred.await(startedB)
        const active = yield* coordinator.active
        yield* Deferred.succeed(release, undefined)
        yield* coordinator.awaitIdle('a')
        yield* coordinator.awaitIdle('b')

        expect([...active].sort()).toEqual(['a', 'b'])
      })
    )
  )

  it.effect('captureRun during stopping waits without starting a successor', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const drains = yield* Ref.make(0)
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()

        const coordinator = yield* makeCoordinator<string, never>({
          drain: () =>
            Ref.update(drains, count => count + 1).pipe(
              Effect.andThen(Ref.get(drains)),
              Effect.flatMap(count =>
                count === 1
                  ? Effect.uninterruptible(
                      Deferred.succeed(started, undefined).pipe(
                        Effect.andThen(Deferred.await(release))
                      )
                    )
                  : Effect.void
              )
            )
        })

        yield* coordinator.wake('a')
        yield* Deferred.await(started)
        yield* coordinator.interrupt('a')
        const captured = yield* coordinator.captureRun('a')
        expect(captured._tag).toBe('Stopping')

        if (captured._tag !== 'Stopping') return
        const waiter = yield* captured.awaitSettlement.pipe(Effect.forkChild)
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(waiter)
        yield* coordinator.awaitIdle('a')

        expect(yield* Ref.get(drains)).toBe(1)
      })
    )
  )

  it.effect('captureRun during a blocked natural settled hook joins one execution', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const drains = yield* Ref.make(0)
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const settledEntered = yield* Deferred.make<void>()
        const settledHold = yield* Deferred.make<void>()

        const coordinator = yield* makeCoordinator<string, never>({
          drain: () =>
            Ref.update(drains, count => count + 1).pipe(
              Effect.andThen(Deferred.succeed(started, undefined)),
              Effect.andThen(Deferred.await(release))
            ),
          settled: () =>
            Deferred.succeed(settledEntered, undefined).pipe(
              Effect.andThen(Deferred.await(settledHold))
            )
        })

        yield* coordinator.wake('a')
        yield* Deferred.await(started)
        const runner = yield* coordinator.run('a').pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* Effect.yieldNow
        yield* Deferred.succeed(release, undefined)
        yield* Deferred.await(settledEntered)
        const captured = yield* coordinator.captureRun('a')
        expect(captured._tag).toBe('Joined')
        expect(yield* Ref.get(drains)).toBe(1)
        yield* Deferred.succeed(settledHold, undefined)
        yield* Fiber.join(runner)
        expect(yield* Ref.get(drains)).toBe(1)
      })
    )
  )

  it.effect('settled callback defect still completes the run waiter', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()

        const coordinator = yield* makeCoordinator<string, never>({
          drain: () =>
            Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
          settled: () => Effect.die('settled-boom')
        })

        yield* coordinator.wake('a')
        yield* Deferred.await(started)
        yield* Deferred.succeed(release, undefined)
        yield* coordinator.awaitIdle('a')
        expect(yield* coordinator.isActive('a')).toBe(false)
      })
    )
  )

  it.effect('run during stopping waits then starts a force=true successor', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const drains = yield* Ref.make(0)
        const forces = yield* Ref.make<ReadonlyArray<boolean>>([])
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()

        const coordinator = yield* makeCoordinator<string, never>({
          drain: (_key, force) =>
            Ref.update(drains, count => count + 1).pipe(
              Effect.andThen(Ref.update(forces, current => [...current, force])),
              Effect.andThen(Ref.get(drains)),
              Effect.flatMap(count =>
                count === 1
                  ? Effect.uninterruptible(
                      Deferred.succeed(started, undefined).pipe(
                        Effect.andThen(Deferred.await(release))
                      )
                    )
                  : Effect.void
              )
            )
        })

        yield* coordinator.wake('a')
        yield* Deferred.await(started)
        yield* coordinator.interrupt('a')
        const waiter = yield* coordinator.run('a').pipe(Effect.forkChild)
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(waiter)
        yield* coordinator.awaitIdle('a')

        expect(yield* Ref.get(drains)).toBe(2)
        expect(yield* Ref.get(forces)).toEqual([false, true])
      })
    )
  )

  it.effect('keeps the first generic interrupt reason', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const reasons = yield* Ref.make<ReadonlyArray<string | undefined>>([])
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()

        const coordinator = yield* makeCoordinator<string, never, 'user' | 'shutdown'>({
          drain: () =>
            Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
          settled: (_key, _exit, reason) => Ref.update(reasons, current => [...current, reason])
        })

        yield* coordinator.wake('a')
        yield* Deferred.await(started)
        yield* coordinator.interrupt('a', 'shutdown')
        yield* coordinator.interrupt('a', 'user')
        yield* Deferred.succeed(release, undefined)
        yield* coordinator.awaitIdle('a')
        expect(yield* Ref.get(reasons)).toEqual(['shutdown'])
      })
    )
  )

  it.effect('terminal stop escalates a live generic shutdown reason', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const reasons = yield* Ref.make<ReadonlyArray<string | undefined>>([])
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()

        const coordinator = yield* makeCoordinator<string, never, 'user' | 'shutdown'>({
          drain: () =>
            Effect.uninterruptible(
              Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)))
            ),
          settled: (_key, _exit, reason) => Ref.update(reasons, current => [...current, reason])
        })

        yield* coordinator.wake('a')
        yield* Deferred.await(started)
        yield* coordinator.interrupt('a', 'shutdown')
        const receipt = yield* coordinator.terminalStop('a', 'user')
        expect(receipt._tag).toBe('LiveStopping')
        yield* Deferred.succeed(release, undefined)
        yield* coordinator.awaitIdle('a')
        expect(yield* Ref.get(reasons)).toEqual(['user'])
      })
    )
  )

  it.effect('keeps an undefined first generic reason', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const reasons = yield* Ref.make<ReadonlyArray<string | undefined>>([])
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()

        const coordinator = yield* makeCoordinator<string, never, 'user'>({
          drain: () =>
            Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
          settled: (_key, _exit, reason) => Ref.update(reasons, current => [...current, reason])
        })

        yield* coordinator.wake('a')
        yield* Deferred.await(started)
        yield* coordinator.interrupt('a')
        yield* coordinator.interrupt('a', 'user')
        yield* Deferred.succeed(release, undefined)
        yield* coordinator.awaitIdle('a')
        expect(yield* Ref.get(reasons)).toEqual([undefined])
      })
    )
  )

  it.effect('sync started throw settles with original payload and leaves the key idle', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const failure = { phase: 'started-construction' }
        const drains = yield* Ref.make(0)
        let first = true

        const coordinator = yield* makeCoordinator<string, never, 'user'>({
          started: () => {
            if (first) {
              first = false
              throw failure
            }

            return Effect.void
          },
          drain: () => Ref.update(drains, count => count + 1)
        })

        const exit = yield* coordinator.run('r').pipe(Effect.exit)
        expect(exit._tag).toBe('Failure')

        if (exit._tag !== 'Failure') {
          throw new Error('expected started construction defect')
        }

        expect(Cause.findDefect(exit.cause)).toMatchObject({
          _tag: 'Success',
          success: failure
        })
        expect(yield* coordinator.isActive('r')).toBe(false)
        const stop = yield* coordinator.terminalStop('r', 'user')
        expect(stop._tag).toBe('Idle')
        expect(yield* coordinator.isActive('r')).toBe(false)
        yield* coordinator.wake('r')
        yield* coordinator.awaitIdle('r')
        expect(yield* Ref.get(drains)).toBe(1)
      })
    )
  )

  it.effect('repeated terminal stop clears a pending wake without a second drain', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const drains = yield* Ref.make(0)
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()

        const coordinator = yield* makeCoordinator<string, never, 'user'>({
          drain: () =>
            Ref.update(drains, count => count + 1).pipe(
              Effect.andThen(Deferred.succeed(started, undefined)),
              Effect.andThen(Deferred.await(release))
            )
        })

        yield* coordinator.wake('a')
        yield* Deferred.await(started)
        yield* coordinator.terminalStop('a', 'user')
        yield* coordinator.wake('a')
        yield* coordinator.terminalStop('a', 'user')
        yield* Deferred.succeed(release, undefined)
        yield* coordinator.awaitIdle('a')
        expect(yield* Ref.get(drains)).toBe(1)
        yield* coordinator.wake('a')
        yield* coordinator.awaitIdle('a')
        expect(yield* Ref.get(drains)).toBe(2)
      })
    )
  )
})

describe('coordinator drain boundary', () => {
  it('stopped owner does not drain after delayed interrupt delivery', async () => {
    const hold = makeRequestHoldScheduler()
    let attempt = 0
    const drains: Array<{ readonly attempt: number; readonly force: boolean }> = []

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const firstStarted = yield* Deferred.make<void>()
          const releaseFirst = yield* Deferred.make<void>()

          const coordinator = yield* makeCoordinator<string, never, 'user'>({
            started: () =>
              Effect.gen(function* () {
                attempt += 1

                if (attempt === 1) {
                  yield* Deferred.succeed(firstStarted, undefined)
                  yield* Deferred.await(releaseFirst)
                }
              }),
            drain: (_id, force) => Effect.sync(() => drains.push({ attempt, force }))
          })

          yield* coordinator.wake('r')
          yield* Deferred.await(firstStarted)
          hold.arm()

          const stopFiber = yield* coordinator
            .terminalStop('r', 'user')
            .pipe(Effect.forkChild({ startImmediately: true }))

          hold.disarm()
          yield* coordinator.wake('r')
          yield* Deferred.succeed(releaseFirst, undefined)
          yield* Effect.yieldNow
          const beforeDelivery = [...drains]
          expect(stopFiber.pollUnsafe()).toBeUndefined()
          hold.releaseHeld()
          yield* Fiber.join(stopFiber)
          yield* coordinator.awaitIdle('r')
          expect(beforeDelivery.some(entry => entry.attempt === 1)).toBe(false)
          expect(drains.some(entry => entry.attempt === 1)).toBe(false)
          expect(drains.some(entry => entry.attempt === 2)).toBe(true)
        })
      ).pipe(Effect.provideService(Scheduler.Scheduler, hold.scheduler))
    )

    expect(exit._tag).toBe('Success')
  })
})

describe('coordinator interruption request', () => {
  const runAcceptanceWhileHeld = async (mode: 'generic' | 'terminal') => {
    const hold = makeRequestHoldScheduler()

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()

          const coordinator = yield* makeCoordinator<string, never, 'user'>({
            drain: () =>
              Effect.uninterruptible(
                Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)))
              )
          })

          yield* coordinator.wake('a')
          yield* Deferred.await(started)
          hold.arm()

          if (mode === 'generic') {
            const fiber = yield* coordinator
              .interrupt('a', 'user')
              .pipe(Effect.forkChild({ startImmediately: true }))

            hold.disarm()
            expect(hold.held.length).toBeGreaterThan(0)
            expect(fiber.pollUnsafe()).toBeUndefined()
            expect(yield* Deferred.isDone(release)).toBe(false)
            hold.releaseHeld()
            expect(yield* Fiber.join(fiber)).toBe(true)
          } else {
            const fiber = yield* coordinator
              .terminalStop('a', 'user')
              .pipe(Effect.forkChild({ startImmediately: true }))

            hold.disarm()
            expect(hold.held.length).toBeGreaterThan(0)
            expect(fiber.pollUnsafe()).toBeUndefined()
            expect(yield* Deferred.isDone(release)).toBe(false)
            hold.releaseHeld()
            expect(yield* Fiber.join(fiber)).toEqual({ _tag: 'Interrupted' })
          }

          expect(yield* Deferred.isDone(release)).toBe(false)
          expect(yield* coordinator.isActive('a')).toBe(true)
          yield* Deferred.succeed(release, undefined)
          yield* coordinator.awaitIdle('a')
        })
      ).pipe(
        Effect.ensuring(Effect.sync(() => hold.releaseHeld())),
        Effect.provideService(Scheduler.Scheduler, hold.scheduler)
      )
    )

    expect(exit._tag).toBe('Success')
  }

  it('does not accept generic interrupt before request dispatch while masked body remains', async () => {
    await runAcceptanceWhileHeld('generic')
  })

  it('does not accept terminal stop before request dispatch while masked body remains', async () => {
    await runAcceptanceWhileHeld('terminal')
  })

  it('accepts terminal request while independently held masked start remains pending', async () => {
    const hold = makeRequestHoldScheduler()

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>()
          const startHold = yield* Deferred.make<void>()
          const drained = yield* Ref.make(0)

          const coordinator = yield* makeCoordinator<string, never, 'user'>({
            started: () =>
              Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(startHold))),
            drain: () => Ref.update(drained, count => count + 1)
          })

          yield* coordinator.wake('a')
          yield* Deferred.await(started)
          hold.arm()

          const stopFiber = yield* coordinator
            .terminalStop('a', 'user')
            .pipe(Effect.forkChild({ startImmediately: true }))

          hold.disarm()
          expect(hold.held.length).toBeGreaterThan(0)
          expect(stopFiber.pollUnsafe()).toBeUndefined()
          hold.releaseHeld()
          expect(yield* Fiber.join(stopFiber)).toEqual({ _tag: 'Interrupted' })
          expect(yield* Deferred.isDone(startHold)).toBe(false)
          expect(yield* Ref.get(drained)).toBe(0)
          expect(yield* coordinator.isActive('a')).toBe(true)
          yield* Deferred.succeed(startHold, undefined)
          yield* coordinator.awaitIdle('a')
          expect(yield* Ref.get(drained)).toBe(0)
        })
      ).pipe(
        Effect.ensuring(Effect.sync(() => hold.releaseHeld())),
        Effect.provideService(Scheduler.Scheduler, hold.scheduler)
      )
    )

    expect(exit._tag).toBe('Success')
  })

  it('accepts terminal request while independently held masked cleanup remains pending', async () => {
    const hold = makeRequestHoldScheduler()
    const cleanupHold = await Effect.runPromise(Deferred.make<void>())

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>()
          const cleanupEntered = yield* Deferred.make<void>()

          const coordinator = yield* makeCoordinator<string, never, 'user'>({
            drain: () =>
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(
                  Deferred.succeed(cleanupEntered, undefined).pipe(
                    Effect.andThen(Deferred.await(cleanupHold))
                  )
                )
              )
          })

          yield* coordinator.wake('a')
          yield* Deferred.await(started)
          hold.arm()

          const stopFiber = yield* coordinator
            .terminalStop('a', 'user')
            .pipe(Effect.forkChild({ startImmediately: true }))

          hold.disarm()
          expect(hold.held.length).toBeGreaterThan(0)
          expect(stopFiber.pollUnsafe()).toBeUndefined()
          hold.releaseHeld()
          expect(yield* Fiber.join(stopFiber)).toEqual({ _tag: 'Interrupted' })
          yield* Deferred.await(cleanupEntered)
          expect(yield* Deferred.isDone(cleanupHold)).toBe(false)
          expect(yield* coordinator.isActive('a')).toBe(true)
          yield* Deferred.succeed(cleanupHold, undefined)
          yield* coordinator.awaitIdle('a')
        })
      ).pipe(
        Effect.ensuring(
          Deferred.succeed(cleanupHold, undefined).pipe(
            Effect.andThen(Effect.sync(() => hold.releaseHeld())),
            Effect.asVoid
          )
        ),
        Effect.provideService(Scheduler.Scheduler, hold.scheduler)
      )
    )

    expect(exit._tag).toBe('Success')
  })

  it('already-stopping generic returns false without waiting for the outstanding request', async () => {
    const hold = makeRequestHoldScheduler()

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()

          const coordinator = yield* makeCoordinator<string, never, 'user' | 'shutdown'>({
            drain: () =>
              Effect.uninterruptible(
                Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)))
              )
          })

          yield* coordinator.wake('a')
          yield* Deferred.await(started)
          hold.arm()

          const first = yield* coordinator
            .interrupt('a', 'shutdown')
            .pipe(Effect.forkChild({ startImmediately: true }))

          hold.disarm()
          expect(first.pollUnsafe()).toBeUndefined()
          expect(yield* coordinator.interrupt('a', 'user')).toBe(false)
          hold.releaseHeld()
          expect(yield* Fiber.join(first)).toBe(true)
          yield* Deferred.succeed(release, undefined)
          yield* coordinator.awaitIdle('a')
        })
      ).pipe(
        Effect.ensuring(Effect.sync(() => hold.releaseHeld())),
        Effect.provideService(Scheduler.Scheduler, hold.scheduler)
      )
    )

    expect(exit._tag).toBe('Success')
  })

  it('generic cancellation after reservation does not strand the owner', async () => {
    const hold = makeRequestHoldScheduler()

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>()

          const coordinator = yield* makeCoordinator<string, never, 'user'>({
            drain: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
          })

          yield* coordinator.wake('a')
          yield* Deferred.await(started)
          hold.arm()

          const interrupting = yield* coordinator
            .interrupt('a')
            .pipe(Effect.forkChild({ startImmediately: true }))

          hold.disarm()
          expect(hold.held.length).toBeGreaterThan(0)
          yield* Fiber.interrupt(interrupting)
          hold.releaseHeld()
          yield* coordinator.awaitIdle('a')
          expect(yield* coordinator.isActive('a')).toBe(false)
        })
      ).pipe(
        Effect.ensuring(Effect.sync(() => hold.releaseHeld())),
        Effect.provideService(Scheduler.Scheduler, hold.scheduler)
      )
    )

    expect(exit._tag).toBe('Success')
  })

  it('delayed request of an exact old owner cannot interrupt a successor', async () => {
    const hold = makeRequestHoldScheduler()
    const firstRelease = await Effect.runPromise(Deferred.make<void>())
    const successorRelease = await Effect.runPromise(Deferred.make<void>())

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const firstStarted = yield* Deferred.make<void>()
          const successorStarted = yield* Deferred.make<void>()
          const drains = yield* Ref.make(0)

          const coordinator = yield* makeCoordinator<string, never, 'user'>({
            drain: () =>
              Ref.update(drains, count => count + 1).pipe(
                Effect.andThen(Ref.get(drains)),
                Effect.flatMap(count =>
                  count === 1
                    ? Deferred.succeed(firstStarted, undefined).pipe(
                        Effect.andThen(Deferred.await(firstRelease))
                      )
                    : Deferred.succeed(successorStarted, undefined).pipe(
                        Effect.andThen(Deferred.await(successorRelease))
                      )
                )
              )
          })

          yield* coordinator.wake('a')
          yield* Deferred.await(firstStarted)
          hold.arm()

          const interrupting = yield* coordinator
            .interrupt('a')
            .pipe(Effect.forkChild({ startImmediately: true }))

          hold.disarm()
          expect(interrupting.pollUnsafe()).toBeUndefined()
          yield* Deferred.succeed(firstRelease, undefined)
          yield* coordinator.awaitIdle('a')
          yield* coordinator.wake('a')
          yield* Deferred.await(successorStarted)
          hold.releaseHeld()
          expect(yield* Fiber.join(interrupting)).toBe(true)
          expect(yield* coordinator.isActive('a')).toBe(true)
          expect(yield* Deferred.isDone(successorRelease)).toBe(false)
          yield* Deferred.succeed(successorRelease, undefined)
          yield* coordinator.awaitIdle('a')
          expect(yield* Ref.get(drains)).toBe(2)
        })
      ).pipe(
        Effect.ensuring(
          Deferred.succeed(firstRelease, undefined).pipe(
            Effect.andThen(Deferred.succeed(successorRelease, undefined)),
            Effect.andThen(Effect.sync(() => hold.releaseHeld())),
            Effect.asVoid
          )
        ),
        Effect.provideService(Scheduler.Scheduler, hold.scheduler)
      )
    )

    expect(exit._tag).toBe('Success')
  })

  it('awaitSettlement waits only for the captured old done', async () => {
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const successorStarted = yield* Deferred.make<void>()
          const successorRelease = yield* Deferred.make<void>()
          const drains = yield* Ref.make(0)

          const coordinator = yield* makeCoordinator<string, never, 'user'>({
            drain: () =>
              Ref.update(drains, count => count + 1).pipe(
                Effect.andThen(Ref.get(drains)),
                Effect.flatMap(count =>
                  count === 1
                    ? Effect.uninterruptible(
                        Deferred.succeed(started, undefined).pipe(
                          Effect.andThen(Deferred.await(release))
                        )
                      )
                    : Deferred.succeed(successorStarted, undefined).pipe(
                        Effect.andThen(Deferred.await(successorRelease))
                      )
                )
              )
          })

          yield* coordinator.wake('a')
          yield* Deferred.await(started)

          const waiting = yield* coordinator
            .interrupt('a', 'user', { awaitSettlement: true })
            .pipe(Effect.forkChild({ startImmediately: true }))

          yield* coordinator.wake('a')
          expect(waiting.pollUnsafe()).toBeUndefined()
          yield* Deferred.succeed(release, undefined)
          expect(yield* Fiber.join(waiting)).toBe(true)
          yield* Deferred.await(successorStarted)
          expect(yield* Deferred.isDone(successorRelease)).toBe(false)
          expect(yield* coordinator.isActive('a')).toBe(true)
          yield* Deferred.succeed(successorRelease, undefined)
          yield* coordinator.awaitIdle('a')
          expect(yield* Ref.get(drains)).toBe(2)
        })
      )
    )

    expect(exit._tag).toBe('Success')
  })

  it('scope closure with a queued request does not succeed as acknowledgment', async () => {
    const hold = makeRequestHoldScheduler()
    let accepted = false

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>()

          const coordinator = yield* makeCoordinator<string, never, 'user'>({
            drain: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
          })

          yield* coordinator.wake('a')
          yield* Deferred.await(started)
          hold.arm()

          const interrupting = yield* coordinator.interrupt('a').pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                accepted = true
              })
            ),
            Effect.forkChild({ startImmediately: true })
          )

          hold.disarm()
          expect(hold.held.length).toBeGreaterThan(0)
          expect(interrupting.pollUnsafe()).toBeUndefined()
          expect(accepted).toBe(false)
        })
      ).pipe(Effect.provideService(Scheduler.Scheduler, hold.scheduler))
    )

    expect(exit._tag).toBe('Success')
    expect(accepted).toBe(false)
  })
})
