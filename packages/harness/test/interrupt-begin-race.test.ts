import { Context, Deferred, Effect, Fiber, Layer, Scheduler } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { Driver, type Drain, type InterruptReason } from '../src/driver.ts'
import { makeInMemoryHarnessLayer } from '../src/driver/memory.ts'
import { DrainToken, Inbox, makeInMemoryInboxLayer } from '../src/inbox.ts'
import { makeInMemoryRunStoreLayer } from '../src/store.ts'

// Regression tests for #295: an owner that already passed its stopping check
// must not consume the intent of a message admitted after the interrupt, and an
// interrupt between `beginDrain` and `endDrain` must not leave the token live.

type Outcome = {
  readonly taken: ReadonlyArray<string>
  readonly queued: ReadonlyArray<string>
  readonly active: boolean
  readonly takenWithStaleToken: ReadonlyArray<string>
}

const takeAll =
  (taken: Array<string>): Drain =>
  (runId, _force, scope, context) =>
    Effect.gen(function* () {
      const inbox = yield* Inbox

      while (true) {
        const item = yield* inbox.takePromotable(runId, scope, context.drainToken)

        if (item === undefined) return
        taken.push(item.id)
      }
    })

// Real scheduler, no injected yield: only the harness fibers (owner and
// interruption request) get a small `MaxOpsBeforeYield`, so the owner auto-yields
// after its stopping check or between `beginDrain` and `endDrain`. `yields` is
// how many turns the caller gives the owner before interrupting.
const autoYieldScenario = (options: {
  readonly budget: number
  readonly yields: number
  readonly reason: InterruptReason
  readonly steer: boolean
}) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const taken: Array<string> = []

        const harness = makeInMemoryHarnessLayer({ drain: takeAll(taken) }).pipe(
          Layer.provide(Layer.succeed(Scheduler.MaxOpsBeforeYield, options.budget))
        )

        const context = yield* Layer.build(harness)
        const driver = Context.get(context, Driver)
        const inbox = Context.get(context, Inbox)

        yield* driver.admit({ id: 'i1', runId: 'r', delivery: 'input', kind: 'input' })

        for (let turn = 0; turn < options.yields; turn++) yield* Effect.yieldNow

        const interrupting = yield* driver
          .interrupt('r', { reason: options.reason })
          .pipe(Effect.forkChild({ startImmediately: true }))

        if (options.steer) {
          yield* driver.admit({ id: 's1', runId: 'r', delivery: 'steer', kind: 'input' })
        }

        yield* Fiber.join(interrupting)
        yield* driver.awaitIdle('r')

        const queued = (yield* inbox.pending('r')).map(item => item.id)
        const active = yield* driver.isActive('r')
        const takenWithStaleToken: Array<string> = []

        // No drain is live once idle, so no issued token may still dequeue.
        for (let seq = 1; seq <= 8; seq++) {
          const item = yield* inbox.takePromotable('r', 'input', DrainToken.make(`d${seq}`))

          if (item !== undefined) takenWithStaleToken.push(item.id)
        }

        const outcome: Outcome = { taken, queued, active, takenWithStaleToken }

        return outcome
      })
    )
  )

const budgets = Array.from({ length: 40 }, (_, index) => index + 1)

const yieldCounts = Array.from({ length: 12 }, (_, index) => index)

const reasons: ReadonlyArray<InterruptReason> = ['user', 'shutdown']

const sweep = async (steer: boolean) => {
  const broken: Array<string> = []

  for (const reason of reasons) {
    for (const budget of budgets) {
      for (const yields of yieldCounts) {
        const outcome = await autoYieldScenario({ budget, yields, reason, steer })

        if (
          outcome.queued.includes('s1') ||
          outcome.active ||
          outcome.takenWithStaleToken.length > 0
        ) {
          broken.push(`${reason} ${budget}/${yields}: ${JSON.stringify(outcome)}`)
        }
      }
    }
  }

  return broken
}

describe('interrupt racing beginDrain (#295)', () => {
  // Budget 11 with one caller turn is the issue's `c2c-one.ts 11 1`: on the old
  // code the owner consumed the steer's intent, the successor skipped, `s1`
  // stayed queued and drain token `d1` stayed live. This is a fixture tied to that
  // replay: the exact outcome depends on Effect's op counts and the harness's
  // code path, so it may need retuning after an Effect or harness change. The
  // invariant sweeps below are the authority.
  it('budget 11, one turn: the steer admitted after interrupt drains', async () => {
    const outcome = await autoYieldScenario({
      budget: 11,
      yields: 1,
      reason: 'user',
      steer: true
    })

    expect(outcome).toEqual({
      taken: ['s1'],
      queued: ['i1'],
      active: false,
      takenWithStaleToken: []
    })
  })

  it('no budget or timing strands a steer admitted after interrupt', async () => {
    expect(await sweep(true)).toEqual([])
  })

  it('no budget or timing leaves a drain token live after interrupt', async () => {
    expect(await sweep(false)).toEqual([])
  })

  // The owner has passed its stopping check but not yet taken the Inbox gate
  // (`c2-stopping-begin.ts`). `Deferred.succeed` resumes the caller inline, so
  // the caller interrupts and steers before the owner calls the real
  // `beginDrain`; `queuedAtFirstBegin` proves that ordering held.
  it.effect.each(reasons)(
    'a steer admitted while the owner waits to begin is drained (%s)',
    reason =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const taken: Array<string> = []
        const queuedAtFirstBegin: Array<string> = []
        let begins = 0

        const inboxLayer = Layer.effect(
          Inbox,
          Effect.gen(function* () {
            const inner = yield* Inbox

            return Inbox.of({
              ...inner,
              beginDrain: (runId, scope, stopping) =>
                Effect.suspend(() => {
                  begins += 1

                  if (begins > 1) return inner.beginDrain(runId, scope, stopping)

                  return Deferred.succeed(entered, undefined).pipe(
                    Effect.andThen(inner.pending(runId)),
                    Effect.tap(queued =>
                      Effect.sync(() => queuedAtFirstBegin.push(...queued.map(item => item.id)))
                    ),
                    Effect.andThen(inner.beginDrain(runId, scope, stopping))
                  )
                })
            })
          })
        ).pipe(Layer.provide(makeInMemoryInboxLayer()))

        const takeAfterYield: Drain = (runId, force, scope, context) =>
          Effect.yieldNow.pipe(Effect.andThen(takeAll(taken)(runId, force, scope, context)))

        const layer = Driver.coordinatedLayer({ drain: takeAfterYield }).pipe(
          Layer.provideMerge(inboxLayer),
          Layer.provideMerge(makeInMemoryRunStoreLayer())
        )

        yield* Effect.gen(function* () {
          const driver = yield* Driver
          const inbox = yield* Inbox
          yield* driver.admit({ id: 'i1', runId: 'r', delivery: 'input', kind: 'input' })
          yield* Deferred.await(entered)

          const interrupting = yield* driver
            .interrupt('r', { reason })
            .pipe(Effect.forkChild({ startImmediately: true }))

          yield* driver.admit({ id: 's1', runId: 'r', delivery: 'steer', kind: 'input' })
          expect(yield* Fiber.join(interrupting)).toBe(true)
          yield* driver.awaitIdle('r')

          expect(queuedAtFirstBegin).toEqual(['i1', 's1'])
          expect(taken).toEqual(['s1'])
          expect((yield* inbox.pending('r')).map(item => item.id)).toEqual(['i1'])
          expect(yield* driver.isActive('r')).toBe(false)
        }).pipe(Effect.provide(layer))
      })
  )
})
