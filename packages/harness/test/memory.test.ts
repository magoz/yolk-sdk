import { Deferred, Effect } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { admit, Driver } from '../src/driver.ts'
import { makeInMemoryHarnessLayer } from '../src/driver/memory.ts'
import { Inbox } from '../src/inbox.ts'
import { RunStore } from '../src/store.ts'

describe('in-memory harness', () => {
  it.effect('claims on start and releases on success', () =>
    Effect.gen(function* () {
      const store = yield* RunStore
      const driver = yield* Driver

      yield* driver.run('run_1')

      expect(yield* store.isClaimed('run_1')).toBe(false)
      expect(yield* driver.isActive('run_1')).toBe(false)
    }).pipe(Effect.provide(makeInMemoryHarnessLayer()))
  )

  it.effect('keeps the claim on shutdown interrupt', () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const layer = makeInMemoryHarnessLayer({
        drain: () =>
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)))
      })

      yield* Effect.gen(function* () {
        const store = yield* RunStore
        const driver = yield* Driver

        yield* driver.wake('run_1')
        yield* Deferred.await(started)
        expect(yield* store.isClaimed('run_1')).toBe(true)

        yield* driver.interrupt('run_1', { reason: 'shutdown' })
        yield* Deferred.succeed(release, undefined)
        yield* driver.awaitIdle('run_1')

        expect(yield* store.isClaimed('run_1')).toBe(true)
      }).pipe(Effect.provide(layer))
    })
  )

  it.effect('releases the claim on user interrupt', () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const layer = makeInMemoryHarnessLayer({
        drain: () =>
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)))
      })

      yield* Effect.gen(function* () {
        const store = yield* RunStore
        const driver = yield* Driver
        yield* driver.wake('run_1')
        yield* Deferred.await(started)
        yield* driver.interrupt('run_1', { reason: 'user' })
        yield* Deferred.succeed(release, undefined)
        yield* driver.awaitIdle('run_1')
        expect(yield* store.isClaimed('run_1')).toBe(false)
      }).pipe(Effect.provide(layer))
    })
  )

  it.effect('admit enqueues and wakes the run', () =>
    Effect.gen(function* () {
      const inbox = yield* Inbox
      const driver = yield* Driver
      yield* admit({
        id: 'item_1',
        runId: 'run_1',
        delivery: 'steer',
        kind: 'input'
      })
      yield* driver.awaitIdle('run_1')
      const pending = yield* inbox.pending('run_1')
      expect(pending).toHaveLength(1)
      expect(pending[0]?.id).toBe('item_1')
    }).pipe(Effect.provide(makeInMemoryHarnessLayer()))
  )

  it.effect('resumeSuspended wakes claimed idle runs and exhausts past the budget', () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const layer = makeInMemoryHarnessLayer({
        drain: () =>
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
        maxResumeAttempts: 1
      })

      yield* Effect.gen(function* () {
        const driver = yield* Driver
        const store = yield* RunStore
        yield* driver.wake('run_1')
        yield* Deferred.await(started)
        yield* driver.interrupt('run_1', { reason: 'shutdown' })
        yield* Deferred.succeed(release, undefined)
        yield* driver.awaitIdle('run_1')
        expect(yield* store.isClaimed('run_1')).toBe(true)

        const first = yield* driver.resumeSuspended
        expect(first.resumed).toEqual(['run_1'])
        expect(first.exhausted).toEqual([])
        yield* driver.awaitIdle('run_1')
        expect(yield* store.isClaimed('run_1')).toBe(false)

        yield* store.claim('run_2')
        yield* store.incrementResumeCount('run_2')
        yield* store.incrementResumeCount('run_2')
        const exhausted = yield* driver.resumeSuspended
        expect(exhausted.resumed).toEqual([])
        expect(exhausted.exhausted).toEqual(['run_2'])
        expect(yield* store.isClaimed('run_2')).toBe(false)
      }).pipe(Effect.provide(layer))
    })
  )

  it.effect('inbox promotes steers before queued items at steer scope', () =>
    Effect.gen(function* () {
      const inbox = yield* Inbox
      yield* inbox.enqueue({
        id: 'q1',
        runId: 'run_1',
        delivery: 'queue',
        kind: 'input'
      })
      yield* inbox.enqueue({
        id: 's1',
        runId: 'run_1',
        delivery: 'steer',
        kind: 'input'
      })

      const first = yield* inbox.takePromotable('run_1', 'steer')
      const second = yield* inbox.takePromotable('run_1', 'input')

      expect(first?.id).toBe('s1')
      expect(second?.id).toBe('q1')
    }).pipe(Effect.provide(makeInMemoryHarnessLayer()))
  )
})
