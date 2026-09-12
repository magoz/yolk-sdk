import { Deferred, Effect, Fiber, Ref } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { makeDrainOccupancy } from '../src/drain-occupancy.ts'

describe('makeDrainOccupancy', () => {
  it.effect('rejects a second occupy until matching releaseIf', () =>
    Effect.gen(function* () {
      const occupancy = yield* makeDrainOccupancy()
      const release = yield* Deferred.make<void>()
      const ran = yield* Ref.make(false)
      const firstToken = { id: 1 }
      const first = yield* occupancy.occupy(
        Deferred.await(release).pipe(Effect.andThen(Ref.set(ran, true))),
        firstToken
      )
      const second = yield* occupancy.occupy(Effect.void, { id: 2 })

      expect(first).toBe(true)
      expect(second).toBe(false)

      const running = yield* occupancy.runHeld.pipe(Effect.forkChild)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(running)
      expect(yield* occupancy.isHeld).toBe(true)
      expect(yield* occupancy.releaseIf({ id: 2 })).toBe(false)
      expect(yield* occupancy.isHeld).toBe(true)
      expect(yield* occupancy.releaseIf(firstToken)).toBe(true)
      expect(yield* occupancy.occupy(Effect.void, { id: 3 })).toBe(true)
    })
  )

  it.effect('releases after occupy without runHeld so the next occupy succeeds', () =>
    Effect.gen(function* () {
      const occupancy = yield* makeDrainOccupancy()
      const token = { id: 1 }
      expect(yield* occupancy.occupy(Effect.void, token)).toBe(true)
      yield* occupancy.releaseIf(token)
      expect(yield* occupancy.occupy(Effect.void, { id: 2 })).toBe(true)
    })
  )
})
