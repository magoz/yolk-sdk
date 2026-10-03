import { describe, expect, it } from '@effect/vitest'
import { Deferred, Effect, Fiber } from 'effect'
import { vi } from 'vitest'
import { makeSlotPool, withSlot } from '../src/node/worker-admission.ts'
import type { SlotPool } from '../src/node/worker-admission.ts'

// The admission pool on its own, with private one-slot pools: no workers and no wall-clock
// assertions. A "run" stands for starting a worker; it records its name and holds its slot until
// its latch opens.

const busy = () => 'busy' as const

const farDeadline = () => Date.now() + 60_000

/** Yield until `pool` has `active` slots taken and `waiting` waiters (forked fibers run later). */
const awaitPool = (pool: SlotPool, active: number, waiting: number) =>
  Effect.gen(function* () {
    while (pool.active !== active || pool.waiters.size !== waiting) yield* Effect.yieldNow
  })

const holder = (pool: SlotPool, deadline: number, name: string, runs: Array<string>) =>
  Effect.gen(function* () {
    const latch = yield* Deferred.make<void>()

    const fiber = yield* Effect.forkChild(
      Effect.sync(() => runs.push(name)).pipe(
        Effect.andThen(Deferred.await(latch)),
        withSlot(pool, deadline, busy)
      )
    )

    return { fiber, release: Deferred.succeed(latch, undefined) }
  })

/** `Date.now` reads `offsetMs` ahead of the real clock until the scope closes. */
const clockAhead = (offsetMs: number) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const now = Date.now.bind(Date)

      return vi.spyOn(Date, 'now').mockImplementation(() => now() + offsetMs)
    }),
    spy => Effect.sync(() => spy.mockRestore())
  )

describe('worker admission', () => {
  it.effect(
    'fails with busy, running nothing, when the deadline has passed and a slot is free',
    () =>
      Effect.gen(function* () {
        const pool = makeSlotPool(1)
        const runs: Array<string> = []

        const result = yield* Effect.sync(() => runs.push('late')).pipe(
          withSlot(pool, Date.now() - 1, busy),
          Effect.flip
        )

        expect(result).toBe('busy')
        expect(runs).toEqual([])
        expect(pool).toMatchObject({ active: 0, waiters: new Set() })
      })
  )

  it.effect('hands a freed slot to the longest waiter, ahead of new arrivals', () =>
    Effect.gen(function* () {
      const pool = makeSlotPool(1)
      const runs: Array<string> = []
      const first = yield* holder(pool, farDeadline(), 'first', runs)

      yield* awaitPool(pool, 1, 0)

      const second = yield* holder(pool, farDeadline(), 'second', runs)

      yield* awaitPool(pool, 1, 1)

      const third = yield* holder(pool, farDeadline(), 'third', runs)

      yield* awaitPool(pool, 1, 2)
      expect(runs).toEqual(['first'])

      // The freed slot passes straight to `second`: it is never counted free, so an extraction
      // arriving now queues behind `third` instead of taking it.
      yield* first.release
      yield* Fiber.join(first.fiber)
      expect(pool.active).toBe(1)

      const fourth = yield* holder(pool, farDeadline(), 'fourth', runs)

      yield* awaitPool(pool, 1, 2)

      for (const next of [second, third, fourth]) {
        yield* next.release
        yield* Fiber.join(next.fiber)
      }

      expect(runs).toEqual(['first', 'second', 'third', 'fourth'])
      expect(pool).toMatchObject({ active: 0, waiters: new Set() })
    })
  )

  it.effect('never admits a waiter woken after its deadline, and passes the slot on', () =>
    Effect.gen(function* () {
      const pool = makeSlotPool(1)
      const runs: Array<string> = []
      const first = yield* holder(pool, farDeadline(), 'first', runs)

      yield* awaitPool(pool, 1, 0)

      // `late` waits until a deadline its timer will not reach during the test; `patient` waits
      // far longer.
      const late = yield* Effect.forkChild(
        Effect.sync(() => runs.push('late')).pipe(
          withSlot(pool, Date.now() + 30_000, busy),
          Effect.flip
        )
      )

      yield* awaitPool(pool, 1, 1)

      const patient = yield* holder(pool, Date.now() + 3_600_000, 'patient', runs)

      yield* awaitPool(pool, 1, 2)

      // The slot frees after `late`'s deadline but before its timer fires.
      yield* clockAhead(60_000)
      yield* first.release

      expect(yield* Fiber.join(late)).toBe('busy')

      yield* Fiber.join(first.fiber)
      yield* patient.release
      yield* Fiber.join(patient.fiber)

      expect(runs).toEqual(['first', 'patient'])
      expect(pool).toMatchObject({ active: 0, waiters: new Set() })
    })
  )

  it.effect('drops an interrupted waiter from the queue without taking a slot', () =>
    Effect.gen(function* () {
      const pool = makeSlotPool(1)
      const runs: Array<string> = []
      const first = yield* holder(pool, farDeadline(), 'first', runs)

      yield* awaitPool(pool, 1, 0)

      const waiting = yield* holder(pool, farDeadline(), 'interrupted', runs)

      yield* awaitPool(pool, 1, 1)
      yield* Fiber.interrupt(waiting.fiber)

      expect(pool).toMatchObject({ active: 1, waiters: new Set() })

      yield* first.release
      yield* Fiber.join(first.fiber)

      expect(runs).toEqual(['first'])
      expect(pool).toMatchObject({ active: 0, waiters: new Set() })
    })
  )
})
