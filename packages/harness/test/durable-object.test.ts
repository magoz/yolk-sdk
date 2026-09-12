import { Deferred, Effect, Ref } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { Driver } from '../src/driver.ts'
import { makeDurableObjectDriverLayer } from '../src/driver/durable-object.ts'
import { RunStore, type DurableRunStoreSnapshot } from '../src/store.ts'

const makeBacking = (initial?: DurableRunStoreSnapshot) =>
  Ref.make(initial).pipe(
    Effect.map(ref => ({
      load: Ref.get(ref),
      save: (snapshot: DurableRunStoreSnapshot) => Ref.set(ref, snapshot)
    }))
  )

describe('durable object driver', () => {
  it.effect('persists claims across driver layers sharing storage', () =>
    Effect.gen(function* () {
      const backing = yield* makeBacking()

      yield* Effect.gen(function* () {
        const store = yield* RunStore
        yield* store.claim('run_1')
        expect(yield* store.isClaimed('run_1')).toBe(true)
      }).pipe(Effect.provide(makeDurableObjectDriverLayer(backing)))

      yield* Effect.gen(function* () {
        const store = yield* RunStore
        expect(yield* store.isClaimed('run_1')).toBe(true)
        expect([...(yield* store.claimed)]).toEqual(['run_1'])
      }).pipe(Effect.provide(makeDurableObjectDriverLayer(backing)))
    })
  )

  it.effect('keeps the persisted claim on shutdown interrupt', () =>
    Effect.gen(function* () {
      const backing = yield* makeBacking()
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const layer = makeDurableObjectDriverLayer({
        ...backing,
        drain: () =>
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)))
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
      }).pipe(Effect.provide(layer))
    })
  )
})
