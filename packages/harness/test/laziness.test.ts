import { Context, Deferred, Effect, Layer } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import type { Promotable } from '../src/coordinator.ts'
import { Driver, makeDriverLayer } from '../src/driver.ts'
import { makeInMemoryDriverLayer, makeInMemoryHarnessLayer } from '../src/driver/memory.ts'
import { makeDurableObjectDriverLayer } from '../src/driver/durable-object.ts'
import { Inbox } from '../src/inbox.ts'
import { RunStore, type DurableRunStoreSnapshot } from '../src/store.ts'

type Drain = (runId: string, force: boolean, scope: Promotable) => Effect.Effect<void>

type DriverBacking = {
  drain: Drain
  max: number
}

const recordDrain =
  (seen: Array<string>, tag: string): Drain =>
  (_runId, _force, _scope) =>
    Effect.suspend(() => {
      seen.push(tag)

      return Effect.void
    })

const trackedDriverOptions = (reads: Array<string>, backing: DriverBacking) => ({
  get drain(): Drain {
    reads.push('drain')

    return backing.drain
  },
  get maxResumeAttempts(): number {
    reads.push('max')

    return backing.max
  }
})

describe('option laziness', () => {
  it.effect('makeDriverLayer reads no options at construction', () =>
    Effect.gen(function* () {
      const reads: Array<string> = []

      const backing: DriverBacking = {
        drain: (_runId, _force, _scope) => Effect.void,
        max: 1
      }

      makeDriverLayer(trackedDriverOptions(reads, backing))

      expect(reads).toEqual([])
    })
  )

  it.effect('makeDriverLayer reads drain then max once at acquisition', () =>
    Effect.gen(function* () {
      const reads: Array<string> = []

      const backing: DriverBacking = {
        drain: (_runId, _force, _scope) => Effect.void,
        max: 1
      }

      const layer = makeDriverLayer(trackedDriverOptions(reads, backing)).pipe(
        Layer.provide(RunStore.inMemoryLayer())
      )

      expect(reads).toEqual([])

      yield* Effect.gen(function* () {
        const driver = yield* Driver
        yield* driver.run('run_lazy')
      }).pipe(Effect.provide(layer))
      expect(reads).toEqual(['drain', 'max'])
    })
  )

  it.effect('makeDriverLayer observes config mutated before build', () =>
    Effect.gen(function* () {
      const seen: Array<string> = []
      const backing: DriverBacking = { drain: recordDrain(seen, 'ran'), max: 1 }

      const layer = makeDriverLayer(trackedDriverOptions([], backing)).pipe(
        Layer.provide(RunStore.inMemoryLayer())
      )

      backing.drain = recordDrain(seen, 'mutated')

      yield* Effect.gen(function* () {
        const driver = yield* Driver
        yield* driver.run('run_mutated')
      }).pipe(Effect.provide(layer))
      expect(seen).toEqual(['mutated'])
    })
  )

  it.effect('memory wrappers read no options at construction', () =>
    Effect.gen(function* () {
      const reads: Array<string> = []

      const backing: DriverBacking = {
        drain: (_runId, _force, _scope) => Effect.void,
        max: 1
      }

      makeInMemoryDriverLayer(trackedDriverOptions(reads, backing))

      makeInMemoryHarnessLayer(trackedDriverOptions(reads, backing))

      expect(reads).toEqual([])
    })
  )

  it.effect('durable wrapper defers storage access and preserves the save receiver', () =>
    Effect.gen(function* () {
      const reads: Array<string> = []

      // `save` touches instance state, so any detached call with the wrong receiver
      // throws instead of persisting. This proves the original options object is kept.
      class Storage {
        saved: Array<DurableRunStoreSnapshot> = []

        get load(): Effect.Effect<DurableRunStoreSnapshot | undefined> {
          reads.push('load')

          return Effect.succeed(undefined)
        }

        save(snapshot: DurableRunStoreSnapshot) {
          reads.push('save')
          this.saved.push(snapshot)

          return Effect.void
        }
      }

      const storage = new Storage()
      const layer = makeDurableObjectDriverLayer(storage)
      expect(reads).toEqual([])

      yield* Effect.gen(function* () {
        const store = yield* RunStore
        yield* store.claim('run_receiver')
        expect(yield* store.isClaimed('run_receiver')).toBe(true)
      }).pipe(Effect.provide(layer))
      expect(reads).toEqual(['load', 'save'])
      expect(storage.saved.map(snapshot => snapshot.claimed)).toEqual([['run_receiver']])
    })
  )
})

describe('memo map identity', () => {
  it.effect('fresh factory layers isolate under one memo map while reused layers memoize', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const memoMap = yield* Layer.makeMemoMap
        const scope = yield* Effect.scope

        const first = Layer.mergeAll(RunStore.inMemoryLayer(), Inbox.layer())
        const second = Layer.mergeAll(RunStore.inMemoryLayer(), Inbox.layer())
        const firstContext = yield* Layer.buildWithMemoMap(first, memoMap, scope)
        const secondContext = yield* Layer.buildWithMemoMap(second, memoMap, scope)
        const firstStore = Context.get(firstContext, RunStore)
        const secondStore = Context.get(secondContext, RunStore)
        const firstInbox = Context.get(firstContext, Inbox)
        const secondInbox = Context.get(secondContext, Inbox)

        yield* firstStore.claim('run_memo')
        yield* firstInbox.enqueue({
          id: 'item_memo',
          runId: 'run_memo',
          delivery: 'input',
          kind: 'input'
        })
        expect(yield* secondStore.isClaimed('run_memo')).toBe(false)
        expect(yield* secondInbox.pending('run_memo')).toHaveLength(0)

        const shared = RunStore.inMemoryLayer()
        const sharedFirst = yield* Layer.buildWithMemoMap(shared, memoMap, scope)
        const sharedSecond = yield* Layer.buildWithMemoMap(shared, memoMap, scope)
        const sharedStoreFirst = Context.get(sharedFirst, RunStore)
        const sharedStoreSecond = Context.get(sharedSecond, RunStore)

        yield* sharedStoreFirst.claim('run_shared_memo')
        expect(yield* sharedStoreSecond.isClaimed('run_shared_memo')).toBe(true)
      })
    )
  )

  it.effect('composed harness shares one store between driver and output under one memo map', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const memoMap = yield* Layer.makeMemoMap
        const scope = yield* Effect.scope

        const started = yield* Deferred.make<void>()

        const first = makeInMemoryHarnessLayer({
          drain: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
        })

        const second = makeInMemoryHarnessLayer()
        const firstContext = yield* Layer.buildWithMemoMap(first, memoMap, scope)
        const secondContext = yield* Layer.buildWithMemoMap(second, memoMap, scope)
        const firstDriver = Context.get(firstContext, Driver)
        const secondDriver = Context.get(secondContext, Driver)
        const firstStore = Context.get(firstContext, RunStore)
        const secondStore = Context.get(secondContext, RunStore)

        yield* firstDriver.wake('run_composed')
        yield* Deferred.await(started)
        expect(yield* firstDriver.isActive('run_composed')).toBe(true)
        expect(yield* firstStore.isClaimed('run_composed')).toBe(true)
        expect(yield* secondDriver.isActive('run_composed')).toBe(false)
        expect(yield* secondStore.isClaimed('run_composed')).toBe(false)

        yield* firstDriver.interrupt('run_composed', { reason: 'user' })
        yield* firstDriver.awaitIdle('run_composed')
        expect(yield* firstStore.isClaimed('run_composed')).toBe(false)
      })
    )
  )
})
