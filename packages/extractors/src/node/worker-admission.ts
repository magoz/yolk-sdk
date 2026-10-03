import { Effect } from 'effect'
import * as Schema from 'effect/Schema'

/**
 * Worker admission. Every Node `FileExtractor` layer in a process shares one pool of
 * `processWorkerLimit` worker slots, however often the layer is built (a per-request
 * `Effect.provide` builds a new one each time). The pool lives on `globalThis` under a versioned
 * `Symbol.for` key and holds only plain data and plain callbacks, so duplicated copies of this
 * package (and of Effect) in one process share it. Each layer also has its own pool of
 * `maxConcurrentWorkers` slots (at most `processWorkerLimit`), which can only lower that layer's
 * share. An extraction takes its layer's slot, then a process slot, and waits for both until its
 * admission deadline; a slot is released only after its worker has terminated.
 */

/** Worker slots shared by every layer in the process. */
export const processWorkerLimit = 4

/** A counting pool of worker slots. Waiters re-check the count when woken. */
export type SlotPool = {
  readonly capacity: number
  active: number
  readonly waiters: Set<() => void>
}

export const makeSlotPool = (capacity: number): SlotPool => ({
  capacity,
  active: 0,
  waiters: new Set()
})

const processPoolKey = Symbol.for('@yolk-sdk/extractors/worker-admission/v1')

/** Waiters are only ever added by `waitForSlot`, in this module or a copy of it. */
const WaiterSet = Schema.declare((value): value is Set<() => void> => value instanceof Set)

/** The pool's shape, checked when another copy of this module may have created it. */
const isSlotPool = Schema.is(
  Schema.Struct({ capacity: Schema.Number, active: Schema.Number, waiters: WaiterSet })
)

/** The process-wide pool, created by the first copy of this module that asks for it. */
export const processSlotPool = (): SlotPool => {
  const existing: unknown = Object.getOwnPropertyDescriptor(globalThis, processPoolKey)?.value

  if (isSlotPool(existing)) return existing

  const pool = makeSlotPool(processWorkerLimit)

  Object.defineProperty(globalThis, processPoolKey, { value: pool, configurable: false })

  return pool
}

/** Running and waiting extractions in the process-wide pool. */
export const processAdmissionSnapshot = () => {
  const pool = processSlotPool()

  return { active: pool.active, waiting: pool.waiters.size }
}

const releaseSlot = (pool: SlotPool) => {
  pool.active -= 1

  // Wake every waiter: each re-checks the count, and the ones that lose wait again. A woken
  // waiter that is interrupted before it takes the slot therefore cannot strand it.
  for (const wake of [...pool.waiters]) wake()
}

/**
 * Wait until `pool` may have a free slot (`true`) or `deadline` (epoch ms) passes (`false`). A
 * real timer, not the Effect `Clock`, so a test clock cannot stall it.
 */
const waitForSlot = (pool: SlotPool, deadline: number) =>
  Effect.callback<boolean>(resume => {
    if (pool.active < pool.capacity) return resume(Effect.succeed(true))

    const remaining = deadline - Date.now()

    if (remaining <= 0) return resume(Effect.succeed(false))

    const timer = setTimeout(() => {
      stop()
      resume(Effect.succeed(false))
    }, remaining)

    const wake = () => {
      if (pool.active >= pool.capacity) return

      stop()
      resume(Effect.succeed(true))
    }

    const stop = () => {
      clearTimeout(timer)
      pool.waiters.delete(wake)
    }

    pool.waiters.add(wake)

    return Effect.sync(stop)
  })

/**
 * Run `self` holding one slot of `pool`, waiting for it until `deadline` (epoch ms) and failing
 * with `busy()` after that. Taking the slot and registering its release happen without an
 * interruption point between them, so a slot is never leaked; only the wait is interruptible.
 */
export const withSlot =
  <E2>(pool: SlotPool, deadline: number, busy: () => E2) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E | E2, R> =>
    Effect.uninterruptibleMask(restore => {
      const acquire: Effect.Effect<A, E | E2, R> = Effect.suspend(() => {
        if (pool.active < pool.capacity) {
          pool.active += 1

          return restore(self).pipe(Effect.ensuring(Effect.sync(() => releaseSlot(pool))))
        }

        return restore(waitForSlot(pool, deadline)).pipe(
          Effect.flatMap(free => (free ? acquire : Effect.fail(busy())))
        )
      })

      return acquire
    })
