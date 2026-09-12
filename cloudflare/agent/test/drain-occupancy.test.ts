import { Deferred, Effect, Fiber, Ref } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { makeDrainOccupancy } from '../src/drain-occupancy.ts'

describe('makeDrainOccupancy', () => {
  it.effect('rejects a second occupy until drain finishes', () =>
    Effect.gen(function* () {
      const occupancy = yield* makeDrainOccupancy()
      const release = yield* Deferred.make<void>()
      const ran = yield* Ref.make(false)
      const first = yield* occupancy.occupy(
        Deferred.await(release).pipe(Effect.andThen(Ref.set(ran, true)))
      )
      const second = yield* occupancy.occupy(Effect.void)

      expect(first).toBe(true)
      expect(second).toBe(false)

      const draining = yield* occupancy.drain.pipe(Effect.forkChild)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(draining)

      expect(yield* Ref.get(ran)).toBe(true)
      expect(yield* occupancy.occupy(Effect.void)).toBe(true)
    })
  )
})
