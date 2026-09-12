import { Deferred, Effect, Fiber, Ref } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { makeCoordinator } from '../src/coordinator.ts'

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
})
