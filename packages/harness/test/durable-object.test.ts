import { Deferred, Effect, Fiber, Ref } from 'effect'
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

  it.effect('serializes snapshot saves so a late persist cannot drop a claim', () =>
    Effect.gen(function* () {
      const snapshot = yield* Ref.make<DurableRunStoreSnapshot | undefined>(undefined)
      const firstStarted = yield* Deferred.make<void>()
      const firstRelease = yield* Deferred.make<void>()
      const backing = {
        load: Ref.get(snapshot),
        save: (next: DurableRunStoreSnapshot) =>
          next.claimed.length === 1
            ? Deferred.succeed(firstStarted, undefined).pipe(
                Effect.andThen(Deferred.await(firstRelease)),
                Effect.andThen(Ref.set(snapshot, next))
              )
            : Ref.set(snapshot, next)
      }
      const layer = makeDurableObjectDriverLayer(backing)

      yield* Effect.gen(function* () {
        const store = yield* RunStore
        const first = yield* store.claim('run_a').pipe(Effect.forkChild)
        yield* Deferred.await(firstStarted)
        const second = yield* store.claim('run_b').pipe(Effect.forkChild)
        expect(second.pollUnsafe()).toBeUndefined()
        yield* Deferred.succeed(firstRelease, undefined)
        yield* Fiber.join(first)
        yield* Fiber.join(second)
        expect([...(yield* store.claimed)].sort()).toEqual(['run_a', 'run_b'])
        expect([...((yield* Ref.get(snapshot))?.claimed ?? [])].sort()).toEqual(['run_a', 'run_b'])
      }).pipe(Effect.provide(layer))
    })
  )

  it.effect('does not publish in-memory claims when save fails', () =>
    Effect.gen(function* () {
      const snapshot = yield* Ref.make<DurableRunStoreSnapshot | undefined>(undefined)
      const layer = makeDurableObjectDriverLayer({
        load: Ref.get(snapshot),
        save: () => Effect.die('save failed')
      })

      yield* Effect.gen(function* () {
        const store = yield* RunStore
        const exit = yield* store.claim('run_1').pipe(Effect.exit)
        expect(exit._tag).toBe('Failure')
        expect(yield* store.isClaimed('run_1')).toBe(false)
        expect(yield* Ref.get(snapshot)).toBeUndefined()
      }).pipe(Effect.provide(layer))
    })
  )

  it.effect('finishes delayed save+publish before interruption settles', () =>
    Effect.gen(function* () {
      const snapshot = yield* Ref.make<DurableRunStoreSnapshot | undefined>(undefined)
      const started = yield* Deferred.make<void>()
      const cont = yield* Deferred.make<void>()
      const layer = makeDurableObjectDriverLayer({
        load: Ref.get(snapshot),
        save: next =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(cont)),
            Effect.andThen(Ref.set(snapshot, next))
          )
      })

      yield* Effect.gen(function* () {
        const store = yield* RunStore
        const fiber = yield* store.claim('run_1').pipe(Effect.forkChild)
        yield* Deferred.await(started)
        expect(yield* store.isClaimed('run_1')).toBe(false)
        const interrupting = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild)
        expect(yield* store.isClaimed('run_1')).toBe(false)
        yield* Deferred.succeed(cont, undefined)
        yield* Fiber.join(interrupting)
        expect(yield* store.isClaimed('run_1')).toBe(true)
        yield* store.claim('run_2')
        expect([...(yield* store.claimed)].sort()).toEqual(['run_1', 'run_2'])
        expect([...((yield* Ref.get(snapshot))?.claimed ?? [])].sort()).toEqual(['run_1', 'run_2'])
      }).pipe(Effect.provide(layer))
    })
  )

  it.effect('cancels a claim waiting for the lock without dropping a committed claim', () =>
    Effect.gen(function* () {
      const snapshot = yield* Ref.make<DurableRunStoreSnapshot | undefined>(undefined)
      const started = yield* Deferred.make<void>()
      const cont = yield* Deferred.make<void>()
      const layer = makeDurableObjectDriverLayer({
        load: Ref.get(snapshot),
        save: next =>
          next.claimed.length === 1
            ? Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Deferred.await(cont)),
                Effect.andThen(Ref.set(snapshot, next))
              )
            : Ref.set(snapshot, next)
      })

      yield* Effect.gen(function* () {
        const store = yield* RunStore
        const first = yield* store.claim('run_1').pipe(Effect.forkChild)
        yield* Deferred.await(started)
        const waiting = yield* store.claim('run_2').pipe(Effect.forkChild)
        yield* Fiber.interrupt(waiting)
        yield* Deferred.succeed(cont, undefined)
        yield* Fiber.join(first)
        expect(yield* store.isClaimed('run_1')).toBe(true)
        expect(yield* store.isClaimed('run_2')).toBe(false)
        yield* store.claim('run_3')
        expect([...(yield* store.claimed)].sort()).toEqual(['run_1', 'run_3'])
      }).pipe(Effect.provide(layer))
    })
  )

  it.effect('keeps the persisted claim after the driver scope closes', () =>
    Effect.gen(function* () {
      const backing = yield* makeBacking()
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const layer = makeDurableObjectDriverLayer({
        ...backing,
        drain: () =>
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)))
      })

      yield* Effect.scoped(
        Effect.gen(function* () {
          const driver = yield* Driver
          yield* driver.wake('run_1')
          yield* Deferred.await(started)
        }).pipe(Effect.provide(layer))
      )
      yield* Deferred.succeed(release, undefined)

      yield* Effect.gen(function* () {
        const store = yield* RunStore
        expect(yield* store.isClaimed('run_1')).toBe(true)
      }).pipe(Effect.provide(makeDurableObjectDriverLayer(backing)))
    })
  )
})
