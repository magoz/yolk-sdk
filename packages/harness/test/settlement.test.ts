import { Deferred, Effect, Fiber, Layer, Scheduler } from 'effect'
import { describe, expect, it } from 'vitest'
import { Driver, makeDriverLayer } from '../src/driver.ts'
import { Inbox, makeInMemoryInboxLayer } from '../src/inbox.ts'
import { makeInMemoryRunStoreLayer, RunStore } from '../src/store.ts'

const makeYieldScheduler = (input: {
  shouldYield: (fiber: { readonly id: number }) => boolean
}): Scheduler.Scheduler => ({
  executionMode: 'async',
  shouldYield: fiber => input.shouldYield(fiber),
  makeDispatcher() {
    const tasks: Array<{ task: () => void; priority: number }> = []
    const flush = () => {
      const batch = tasks.splice(0).sort((a, b) => a.priority - b.priority)
      for (const entry of batch) entry.task()
    }
    return {
      scheduleTask(task, priority) {
        tasks.push({ task, priority })
        queueMicrotask(flush)
      },
      flush
    }
  }
})

const probe = (target: number) => {
  let armed = false
  let fired = false
  let steps = 0
  let ownerId = -1
  let stop = Effect.void
  const scheduler = makeYieldScheduler({
    shouldYield(fiber) {
      if (armed && !fired && fiber.id === ownerId && ++steps === target) {
        fired = true
        queueMicrotask(() => Effect.runFork(stop))
        return true
      }
      return false
    }
  })
  const program = Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const stopped = yield* Deferred.make<void>()
    const observedInbox = Layer.effect(
      Inbox,
      Effect.gen(function* () {
        const inbox = yield* Inbox
        return Inbox.of({
          ...inbox,
          endDrain: (...args) =>
            inbox.endDrain(...args).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  armed = true
                })
              )
            )
        })
      })
    ).pipe(Layer.provide(makeInMemoryInboxLayer()))
    const layer = makeDriverLayer({
      drain: () =>
        Effect.withFiber(fiber => {
          ownerId = fiber.id
          return Effect.uninterruptible(
            Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)))
          )
        })
    }).pipe(Layer.provideMerge(Layer.mergeAll(observedInbox, makeInMemoryRunStoreLayer())))
    return yield* Effect.gen(function* () {
      const driver = yield* Driver
      const store = yield* RunStore
      stop = driver
        .stop('run')
        .pipe(Effect.andThen(Deferred.succeed(stopped, undefined)), Effect.asVoid)
      yield* driver.wake('run')
      yield* Deferred.await(started)
      yield* driver.interrupt('run', { reason: 'shutdown' })
      yield* Deferred.succeed(release, undefined)
      yield* driver.awaitIdle('run')
      if (fired) yield* Deferred.await(stopped)
      const claimed = yield* store.isClaimed('run')
      return { target, steps, fired, claimed }
    }).pipe(Effect.provide(layer))
  }).pipe(Effect.provideService(Scheduler.Scheduler, scheduler))
  return Effect.runPromise(program)
}

describe('terminal settlement', () => {
  it('controlled scheduler stop after shutdown does not leak claims', async () => {
    const leaked: Array<{ target: number; claimed: boolean }> = []
    let fired = 0
    for (let target = 1; target <= 100; target++) {
      const outcome = await probe(target)
      if (outcome.fired) fired += 1
      if (outcome.fired && outcome.claimed) leaked.push({ target: outcome.target, claimed: true })
    }
    expect(fired).toBeGreaterThan(0)
    expect(leaked).toEqual([])
  })

  it('idle leftover stop holds inbox gate until claim release so successor cannot steal', async () => {
    const started = await Effect.runPromise(Deferred.make<void>())
    const release = await Effect.runPromise(Deferred.make<void>())
    const releaseEntered = await Effect.runPromise(Deferred.make<void>())
    const releaseHold = await Effect.runPromise(Deferred.make<void>())
    const successorStarted = await Effect.runPromise(Deferred.make<void>())
    const successorRelease = await Effect.runPromise(Deferred.make<void>())
    const delayedStore = Layer.effect(
      RunStore,
      Effect.gen(function* () {
        const inner = yield* RunStore
        return RunStore.of({
          ...inner,
          release: runId =>
            Deferred.succeed(releaseEntered, undefined).pipe(
              Effect.andThen(Deferred.await(releaseHold)),
              Effect.andThen(inner.release(runId))
            )
        })
      })
    ).pipe(Layer.provide(makeInMemoryRunStoreLayer()))
    const layer = makeDriverLayer({
      drain: () =>
        Effect.gen(function* () {
          if (yield* Deferred.isDone(started)) {
            yield* Deferred.succeed(successorStarted, undefined)
            yield* Deferred.await(successorRelease)
            return
          }
          yield* Deferred.succeed(started, undefined)
          yield* Deferred.await(release)
        })
    }).pipe(Layer.provideMerge(makeInMemoryInboxLayer()), Layer.provideMerge(delayedStore))
    await Effect.runPromise(
      Effect.gen(function* () {
        const driver = yield* Driver
        const store = yield* RunStore
        yield* driver.wake('run')
        yield* Deferred.await(started)
        yield* driver.interrupt('run', { reason: 'shutdown' })
        yield* Deferred.succeed(release, undefined)
        yield* driver.awaitIdle('run')
        const stopping = yield* driver.stop('run').pipe(Effect.forkChild)
        yield* Deferred.await(releaseEntered)
        const waking = yield* driver.wake('run').pipe(Effect.forkChild)
        yield* Effect.yieldNow
        expect(yield* Deferred.isDone(successorStarted)).toBe(false)
        yield* Deferred.succeed(releaseHold, undefined)
        yield* Fiber.join(stopping)
        yield* Deferred.await(successorStarted)
        yield* Fiber.join(waking)
        expect(yield* driver.isActive('run')).toBe(true)
        expect(yield* store.isClaimed('run')).toBe(true)
        yield* Deferred.succeed(successorRelease, undefined)
        yield* driver.awaitIdle('run')
        expect(yield* store.isClaimed('run')).toBe(false)
      }).pipe(Effect.provide(layer))
    )
  })
})
