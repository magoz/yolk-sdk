import { Effect } from 'effect'
import * as Schema from 'effect/Schema'

/**
 * Worker admission. Every Node `FileExtractor` layer in a JavaScript realm (the main thread, or
 * each worker thread or `vm` context that builds the layer) shares one pool of
 * `processWorkerLimit` worker slots, however often the layer is built (a per-request
 * `Effect.provide` builds a new one each time). The pool lives on `globalThis` under a versioned
 * `Symbol.for` key and holds only plain data and plain callbacks, so duplicated copies of this
 * package (and of Effect) in one realm share it. Each layer also has its own pool of
 * `maxConcurrentWorkers` slots (at most `processWorkerLimit`), which can only lower that layer's
 * share. An extraction takes its layer's slot, then a realm slot, and waits for both until its
 * admission deadline; a slot is released only after its worker has terminated.
 *
 * Admission is first come, first served: a freed slot is handed to the longest-waiting extraction
 * whose deadline has not passed, and a new extraction takes a free slot only when nobody waits.
 */

/** Worker slots shared by every layer in the realm. */
export const processWorkerLimit = 4

/**
 * Takes a freed slot for its waiter and returns `true`, or returns `false` when the waiter's
 * deadline has passed (it then fails with `busy`). Either way it leaves the queue. It never runs
 * the waiter's fiber: the resume is deferred to a microtask, so a waiter that finishes at once
 * cannot release (and hand off) again inside this call, and a long queue drains in constant stack.
 */
export type SlotHandOff = () => boolean

/**
 * A counting pool of worker slots with a FIFO queue (a `Set` iterates in insertion order). While
 * anyone waits, every slot is taken: a released slot passes to a waiter without being counted
 * free.
 */
export type SlotPool = {
  readonly capacity: number
  active: number
  readonly waiters: Set<SlotHandOff>
}

export const makeSlotPool = (capacity: number): SlotPool => ({
  capacity,
  active: 0,
  waiters: new Set()
})

/** The version names the hand-off protocol above; a change to it needs a new key. */
const processPoolKey = Symbol.for('@yolk-sdk/extractors/worker-admission/v2')

/** Waiters are only ever added by `withSlot`, in this module or a copy of it. */
const WaiterSet = Schema.declare((value): value is Set<SlotHandOff> => value instanceof Set)

/** The pool's shape, checked when another copy of this module may have created it. */
const isSlotPool = Schema.is(
  Schema.Struct({ capacity: Schema.Number, active: Schema.Number, waiters: WaiterSet })
)

/** The realm-wide pool, created by the first copy of this module that asks for it. */
export const processSlotPool = (): SlotPool => {
  const existing: unknown = Object.getOwnPropertyDescriptor(globalThis, processPoolKey)?.value

  if (isSlotPool(existing)) return existing

  const pool = makeSlotPool(processWorkerLimit)

  Object.defineProperty(globalThis, processPoolKey, { value: pool, configurable: false })

  return pool
}

/** Running and waiting extractions in the realm-wide pool. */
export const processAdmissionSnapshot = () => {
  const pool = processSlotPool()

  return { active: pool.active, waiting: pool.waiters.size }
}

/** Hand the slot to the first waiter that can still take it; otherwise it becomes free. */
const releaseSlot = (pool: SlotPool) => {
  for (const handOff of pool.waiters) if (handOff()) return

  pool.active -= 1
}

/** Whether `deadline` (epoch ms) has passed. */
const expired = (deadline: number) => Date.now() > deadline

/**
 * Run `self` holding one slot of `pool`, waiting for it until `deadline` (epoch ms) and failing
 * with `busy()` after that. The deadline is checked again whenever a slot would be taken, by a new
 * extraction or by a hand-off, so a late wake-up cannot turn an expired wait into admission.
 *
 * Taking a slot and registering its release happen without an interruption point between them,
 * so a slot is never leaked; only the wait is interruptible. A slot handed to a waiter whose
 * fiber is interrupted before it resumes is released again. The wait uses a real timer, not the
 * Effect `Clock`, so a test clock cannot stall it.
 */
export const withSlot =
  <E2>(pool: SlotPool, deadline: number, busy: () => E2) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E | E2, R> =>
    Effect.uninterruptibleMask(restore =>
      Effect.suspend(() => {
        // Set once this fiber owns a slot, before its release is registered.
        let owned = false

        const admission = Effect.callback<boolean>(resume => {
          if (expired(deadline)) return resume(Effect.succeed(false))

          if (pool.active < pool.capacity && pool.waiters.size === 0) {
            pool.active += 1
            owned = true

            return resume(Effect.succeed(true))
          }

          const handOff: SlotHandOff = () => {
            stop()

            if (expired(deadline)) {
              queueMicrotask(() => resume(Effect.succeed(false)))

              return false
            }

            // The slot is this fiber's from here on. If it is interrupted before the deferred
            // resume runs, Effect ignores that resume and `onInterrupt` passes the slot on.
            owned = true
            queueMicrotask(() => resume(Effect.succeed(true)))

            return true
          }

          const timer = setTimeout(() => {
            stop()
            resume(Effect.succeed(false))
          }, deadline - Date.now())

          const stop = () => {
            clearTimeout(timer)
            pool.waiters.delete(handOff)
          }

          pool.waiters.add(handOff)

          return Effect.sync(stop)
        })

        return restore(admission).pipe(
          // Interrupted after a hand-off but before resuming: pass the slot on.
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              if (owned) releaseSlot(pool)
            })
          ),
          Effect.flatMap((admitted): Effect.Effect<A, E | E2, R> =>
            admitted
              ? restore(self).pipe(Effect.ensuring(Effect.sync(() => releaseSlot(pool))))
              : Effect.fail(busy())
          )
        )
      })
    )
