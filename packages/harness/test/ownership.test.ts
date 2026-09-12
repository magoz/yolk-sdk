import { Deferred, Effect, Layer } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { RunCoordinator } from '../src/coordinator.ts'
import { Driver, makeDriverLayer } from '../src/driver.ts'
import { makeInMemoryHarnessLayer } from '../src/driver/memory.ts'
import { Inbox } from '../src/inbox.ts'
import { RunStore, makeInMemoryRunStoreLayer } from '../src/store.ts'

describe('owner layer topology', () => {
  it.effect('fresh owner layers isolate state across factory calls', () =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const store = yield* RunStore
        const inbox = yield* Inbox
        yield* store.claim('run_1')
        yield* inbox.enqueue({ id: 'item_1', runId: 'run_1', delivery: 'input', kind: 'input' })
        expect(yield* store.isClaimed('run_1')).toBe(true)
        expect(yield* inbox.pending('run_1')).toHaveLength(1)
      }).pipe(Effect.provide(Layer.mergeAll(RunStore.inMemoryLayer(), Inbox.layer())))

      yield* Effect.gen(function* () {
        const store = yield* RunStore
        const inbox = yield* Inbox
        expect(yield* store.isClaimed('run_1')).toBe(false)
        expect(yield* inbox.pending('run_1')).toHaveLength(0)
        expect(yield* store.incrementResumeCount('run_1')).toBe(1)
      }).pipe(Effect.provide(Layer.mergeAll(RunStore.inMemoryLayer(), Inbox.layer())))
    })
  )

  it.effect('composed harness shares one store and isolates across factory calls', () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()

      const first = makeInMemoryHarnessLayer({
        drain: () =>
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)))
      })

      const second = makeInMemoryHarnessLayer()

      yield* Effect.gen(function* () {
        const driver = yield* Driver
        const store = yield* RunStore
        const inbox = yield* Inbox
        yield* driver.wake('run_shared')
        yield* Deferred.await(started)
        // The driver, coordinator, and merged store observe the same claim.
        expect(yield* store.isClaimed('run_shared')).toBe(true)
        expect(yield* driver.isActive('run_shared')).toBe(true)
        yield* inbox.enqueue({
          id: 'item_shared',
          runId: 'run_shared',
          delivery: 'input',
          kind: 'input'
        })
        yield* driver.interrupt('run_shared', { reason: 'user' })
        yield* Deferred.succeed(release, undefined)
        yield* driver.awaitIdle('run_shared')
        expect(yield* store.isClaimed('run_shared')).toBe(false)
      }).pipe(Effect.provide(first))

      yield* Effect.gen(function* () {
        const store = yield* RunStore
        const inbox = yield* Inbox
        const driver = yield* Driver
        expect(yield* store.isClaimed('run_shared')).toBe(false)
        expect(yield* inbox.pending('run_shared')).toHaveLength(0)
        expect(yield* driver.isActive('run_shared')).toBe(false)
      }).pipe(Effect.provide(second))
    })
  )

  it.effect('makeDriverLayer compat shares the provided store with shutdown-kept claims', () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const store = makeInMemoryRunStoreLayer()

      const layer = Layer.mergeAll(
        store,
        makeDriverLayer({
          drain: () =>
            Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)))
        }).pipe(Layer.provide(store))
      )

      yield* Effect.gen(function* () {
        const driver = yield* Driver
        const runStore = yield* RunStore
        yield* driver.wake('run_compat')
        yield* Deferred.await(started)
        expect(yield* runStore.isClaimed('run_compat')).toBe(true)
        yield* driver.interrupt('run_compat', { reason: 'shutdown' })
        yield* Deferred.succeed(release, undefined)
        yield* driver.awaitIdle('run_compat')
        expect(yield* runStore.isClaimed('run_compat')).toBe(true)
      }).pipe(Effect.provide(layer))
    })
  )

  it.effect('canonical Driver.layer wires an explicit RunCoordinator', () =>
    Effect.gen(function* () {
      const store = RunStore.inMemoryLayer()

      const layer = Layer.mergeAll(
        store,
        Driver.layer({}).pipe(Layer.provide(RunCoordinator.layer({})), Layer.provide(store))
      )

      yield* Effect.gen(function* () {
        const driver = yield* Driver
        const runStore = yield* RunStore
        yield* driver.run('run_owned')
        expect(yield* runStore.isClaimed('run_owned')).toBe(false)
        expect(yield* driver.isActive('run_owned')).toBe(false)
        const resumed = yield* driver.resumeSuspended
        expect(resumed).toEqual({ resumed: [], exhausted: [] })
      }).pipe(Effect.provide(layer))
    })
  )
})
