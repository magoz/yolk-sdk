import { Effect, Ref } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { admit, Driver, type Drain } from '../src/driver.ts'
import { makeInMemoryHarnessLayer } from '../src/driver/memory.ts'
import { Inbox, type InboxItem } from '../src/inbox.ts'
import { RunStore } from '../src/store.ts'

const input = (id: string): InboxItem => ({ id, runId: 'run_1', delivery: 'input', kind: 'input' })

/** Takes one item per drain and parks on `r1` after taking `i1`. */
const parkOnFirstInput =
  (taken: Ref.Ref<ReadonlyArray<string>>): Drain =>
  (runId, _force, scope, context) =>
    Effect.gen(function* () {
      const inbox = yield* Inbox
      const item = yield* inbox.takePromotable(runId, scope, context.drainToken)

      if (item === undefined) return
      yield* Ref.update(taken, current => [...current, item.id])

      if (item.id === 'i1') yield* inbox.park(runId, ['r1'], context.drainToken)
    })

describe('a park that stops blocking leaves no stranded work', () => {
  // Issue #294: input queued while parked had no pending intent and nothing woke it.
  it.effect('clearPark wakes the run for input admitted while the park blocked', () =>
    Effect.gen(function* () {
      const taken = yield* Ref.make<ReadonlyArray<string>>([])

      yield* Effect.gen(function* () {
        const driver = yield* Driver
        const inbox = yield* Inbox
        const store = yield* RunStore
        yield* admit(input('i1'))
        yield* driver.awaitIdle('run_1')
        const parked = yield* inbox.parked('run_1')
        expect(parked).toBeDefined()

        if (parked === undefined) return
        yield* admit(input('s1'))
        yield* driver.awaitIdle('run_1')
        expect(yield* Ref.get(taken)).toEqual(['i1'])
        expect((yield* inbox.pending('run_1')).map(item => item.id)).toEqual(['s1'])

        expect(yield* driver.clearPark('run_1', parked.generation)).toBe(true)
        yield* driver.awaitIdle('run_1')

        expect(yield* Ref.get(taken)).toEqual(['i1', 's1'])
        expect(yield* inbox.pending('run_1')).toEqual([])
        expect(yield* inbox.parked('run_1')).toBeUndefined()
        expect(yield* store.isClaimed('run_1')).toBe(false)
      }).pipe(Effect.provide(makeInMemoryHarnessLayer({ drain: parkOnFirstInput(taken) })))
    })
  )

  it.effect('clearPark wakes nothing without queued input or a stale generation', () =>
    Effect.gen(function* () {
      const taken = yield* Ref.make<ReadonlyArray<string>>([])
      const wakes = yield* Ref.make(0)
      const wake = Ref.update(wakes, count => count + 1)

      yield* Effect.gen(function* () {
        const driver = yield* Driver
        const inbox = yield* Inbox
        yield* admit(input('i1'))
        yield* driver.awaitIdle('run_1')
        const parked = yield* inbox.parked('run_1')
        expect(parked).toBeDefined()

        if (parked === undefined) return
        expect(yield* driver.clearPark('run_2', parked.generation)).toBe(false)
        expect(yield* inbox.clearPark('run_1', parked.generation, wake)).toBe(true)
        expect(yield* inbox.clearPark('run_1', parked.generation, wake)).toBe(false)
        expect(yield* Ref.get(wakes)).toBe(0)
        expect(yield* driver.isActive('run_1')).toBe(false)
      }).pipe(Effect.provide(makeInMemoryHarnessLayer({ drain: parkOnFirstInput(taken) })))
    })
  )

  // Issue #296: the failed continuation consumed the only pending intent and released the claim.
  it.effect('a Ready continuation defect keeps the claim so resumeSuspended re-delivers it', () =>
    Effect.gen(function* () {
      const taken = yield* Ref.make<ReadonlyArray<string>>([])
      const ready = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([])
      const parkOnFirst = parkOnFirstInput(taken)

      const drain: Drain = (runId, force, scope, context) =>
        context.readyResponses.length === 0
          ? parkOnFirst(runId, force, scope, context)
          : Ref.updateAndGet(ready, current => [
              ...current,
              context.readyResponses.map(response => response.requestId)
            ]).pipe(
              Effect.flatMap(attempts =>
                attempts.length === 1 ? Effect.die('continuation defect') : Effect.void
              )
            )

      yield* Effect.gen(function* () {
        const driver = yield* Driver
        const inbox = yield* Inbox
        const store = yield* RunStore
        yield* admit(input('i1'))
        yield* driver.awaitIdle('run_1')
        const parked = yield* inbox.parked('run_1')
        expect(parked).toBeDefined()

        if (parked === undefined) return

        const decision = yield* driver.resumeHitl('run_1', {
          itemId: 'a1',
          requestId: 'r1',
          generation: parked.generation
        })

        expect(decision._tag).toBe('Ready')
        yield* driver.awaitIdle('run_1')

        // One attempt only: the defect is not retried in a loop.
        expect(yield* Ref.get(ready)).toEqual([['r1']])
        expect((yield* inbox.parked('run_1'))?.ready).toBe(true)
        expect(yield* driver.isActive('run_1')).toBe(false)
        expect(yield* store.isClaimed('run_1')).toBe(true)

        expect(yield* driver.resumeSuspended).toEqual({ resumed: ['run_1'], exhausted: [] })
        yield* driver.awaitIdle('run_1')
        expect(yield* Ref.get(ready)).toEqual([['r1'], ['r1']])
        expect(yield* inbox.parked('run_1')).toBeUndefined()
        expect(yield* store.isClaimed('run_1')).toBe(false)
      }).pipe(Effect.provide(makeInMemoryHarnessLayer({ drain })))
    })
  )

  it.effect('a drain defect without a Ready park still releases the claim', () =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const driver = yield* Driver
        const store = yield* RunStore
        yield* admit(input('i1'))
        yield* driver.awaitIdle('run_1')
        expect(yield* store.isClaimed('run_1')).toBe(false)
        expect(yield* driver.resumeSuspended).toEqual({ resumed: [], exhausted: [] })
      }).pipe(Effect.provide(makeInMemoryHarnessLayer({ drain: () => Effect.die('drain defect') })))
    })
  )
})
