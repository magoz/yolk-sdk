import { Deferred, Effect, Fiber, Layer, Ref } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { admit, Driver, makeDriverLayer } from '../src/driver.ts'
import { makeInMemoryHarnessLayer } from '../src/driver/memory.ts'
import { Inbox, makeInMemoryInboxLayer } from '../src/inbox.ts'
import { makeInMemoryRunStoreLayer, RunStore } from '../src/store.ts'

describe('HITL park lifecycle', () => {
  it.effect('parks two siblings, accepts partial without wake, then Ready wakes once', () =>
    Effect.gen(function* () {
      const drains = yield* Ref.make(0)
      const readyItemIds = yield* Ref.make<ReadonlyArray<string>>([])
      const layer = makeInMemoryHarnessLayer({
        drain: (runId, _force, _scope, context) =>
          Effect.gen(function* () {
            yield* Ref.update(drains, count => count + 1)
            if (context.readyResponses.length > 0) {
              yield* Ref.set(
                readyItemIds,
                context.readyResponses.map(response => response.itemId)
              )
              return
            }
            const inbox = yield* Inbox
            yield* inbox.park(runId, ['req_a', 'req_b'], context.drainToken)
          })
      })

      yield* Effect.gen(function* () {
        const driver = yield* Driver
        const inbox = yield* Inbox
        const store = yield* RunStore

        yield* driver.wake('run_1')
        yield* driver.awaitIdle('run_1')

        expect(yield* Ref.get(drains)).toBe(1)
        expect(yield* store.isClaimed('run_1')).toBe(false)
        const parked = yield* inbox.parked('run_1')
        expect(parked).toBeDefined()
        if (parked === undefined) return
        expect(parked.requestIds).toEqual(['req_a', 'req_b'])
        expect(parked.ready).toBe(false)
        expect(parked.responses).toEqual([])
        const generation = parked.generation

        const first = yield* driver.resumeHitl('run_1', {
          itemId: 'item_a',
          requestId: 'req_a',
          generation
        })
        expect(first._tag).toBe('Accepted')
        yield* driver.awaitIdle('run_1')
        expect(yield* Ref.get(drains)).toBe(1)
        const afterFirst = yield* inbox.parked('run_1')
        expect(afterFirst?.responses.map(response => response.itemId)).toEqual(['item_a'])
        expect(afterFirst?.ready).toBe(false)

        const duplicatePartial = yield* driver.resumeHitl('run_1', {
          itemId: 'item_a',
          requestId: 'req_a',
          generation
        })
        expect(duplicatePartial._tag).toBe('Duplicate')
        expect(yield* Ref.get(drains)).toBe(1)

        const stale = yield* driver.resumeHitl('run_1', {
          itemId: 'item_b',
          requestId: 'req_b',
          generation: '0'
        })
        expect(stale._tag).toBe('Stale')
        expect(yield* Ref.get(drains)).toBe(1)

        const unknown = yield* driver.resumeHitl('run_1', {
          itemId: 'item_z',
          requestId: 'req_z',
          generation
        })
        expect(unknown._tag).toBe('UnknownRequest')
        expect(yield* Ref.get(drains)).toBe(1)

        const wrongRun = yield* driver.resumeHitl('run_2', {
          itemId: 'item_b',
          requestId: 'req_b',
          generation
        })
        expect(wrongRun._tag).toBe('NotParked')
        expect(yield* Ref.get(drains)).toBe(1)

        const second = yield* driver.resumeHitl('run_1', {
          itemId: 'item_b',
          requestId: 'req_b',
          generation
        })
        expect(second._tag).toBe('Ready')
        yield* driver.awaitIdle('run_1')
        expect(yield* Ref.get(drains)).toBe(2)
        expect(yield* Ref.get(readyItemIds)).toEqual(['item_a', 'item_b'])
        expect(yield* inbox.parked('run_1')).toBeUndefined()
        expect(yield* store.isClaimed('run_1')).toBe(false)

        const afterReady = yield* driver.resumeHitl('run_1', {
          itemId: 'item_b',
          requestId: 'req_b',
          generation
        })
        expect(afterReady._tag).toBe('NotParked')
        expect(yield* Ref.get(drains)).toBe(2)
      }).pipe(Effect.provide(layer))
    })
  )

  it.effect('stop while parked invalidates responses; new input wakes a successor', () =>
    Effect.gen(function* () {
      const drains = yield* Ref.make(0)
      const layer = makeInMemoryHarnessLayer({
        drain: (runId, _force, _scope, context) =>
          Effect.gen(function* () {
            yield* Ref.update(drains, count => count + 1)
            if (context.readyResponses.length > 0) return
            const inbox = yield* Inbox
            yield* inbox.park(runId, ['req_a'], context.drainToken)
          })
      })

      yield* Effect.gen(function* () {
        const driver = yield* Driver
        const inbox = yield* Inbox
        const store = yield* RunStore

        yield* driver.wake('run_1')
        yield* driver.awaitIdle('run_1')
        const parked = yield* inbox.parked('run_1')
        expect(parked).toBeDefined()
        if (parked === undefined) return
        const generation = parked.generation

        const stopped = yield* driver.stop('run_1')
        expect(stopped._tag).toBe('ParkCleared')
        expect(yield* inbox.parked('run_1')).toBeUndefined()
        expect(yield* store.isClaimed('run_1')).toBe(false)
        expect(yield* Ref.get(drains)).toBe(1)

        const stale = yield* driver.resumeHitl('run_1', {
          itemId: 'item_a',
          requestId: 'req_a',
          generation
        })
        expect(stale._tag).toBe('NotParked')
        expect(yield* Ref.get(drains)).toBe(1)

        yield* admit({
          id: 'input_1',
          runId: 'run_1',
          delivery: 'input',
          kind: 'input'
        })
        yield* driver.awaitIdle('run_1')
        expect(yield* Ref.get(drains)).toBe(2)
        const successorPark = yield* inbox.parked('run_1')
        expect(successorPark?.generation).not.toBe(generation)
        expect(yield* inbox.pending('run_1')).toHaveLength(1)
      }).pipe(Effect.provide(layer))
    })
  )

  it.effect('records input/steer while parked without running the host drain', () =>
    Effect.gen(function* () {
      const drains = yield* Ref.make(0)
      const layer = makeInMemoryHarnessLayer({
        drain: (runId, _force, _scope, context) =>
          Effect.gen(function* () {
            yield* Ref.update(drains, count => count + 1)
            if (context.readyResponses.length > 0) return
            const inbox = yield* Inbox
            yield* inbox.park(runId, ['req_a'], context.drainToken)
          })
      })

      yield* Effect.gen(function* () {
        const driver = yield* Driver
        const inbox = yield* Inbox

        yield* driver.wake('run_1')
        yield* driver.awaitIdle('run_1')
        const parked = yield* inbox.parked('run_1')
        expect(parked).toBeDefined()
        if (parked === undefined) return

        yield* admit({
          id: 'steer_1',
          runId: 'run_1',
          delivery: 'steer',
          kind: 'input'
        })
        yield* driver.awaitIdle('run_1')
        expect(yield* Ref.get(drains)).toBe(1)
        expect(yield* inbox.pending('run_1')).toHaveLength(1)

        yield* driver.resumeHitl('run_1', {
          itemId: 'item_a',
          requestId: 'req_a',
          generation: parked.generation
        })
        yield* driver.awaitIdle('run_1')
        expect(yield* Ref.get(drains)).toBe(2)
        expect(yield* inbox.pending('run_1')).toHaveLength(1)
      }).pipe(Effect.provide(layer))
    })
  )

  it.effect('stop while busy is a user interrupt and fences a late park', () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const latePark = yield* Ref.make<string | undefined>(undefined)
      const layer = makeInMemoryHarnessLayer({
        drain: (runId, _force, _scope, context) =>
          Effect.uninterruptible(
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined)
              yield* Deferred.await(release)
              const inbox = yield* Inbox
              const parked = yield* inbox.park(runId, ['req_a'], context.drainToken)
              yield* Ref.set(latePark, parked._tag)
            })
          )
      })

      yield* Effect.gen(function* () {
        const driver = yield* Driver
        const inbox = yield* Inbox
        const store = yield* RunStore

        yield* driver.wake('run_1')
        yield* Deferred.await(started)
        const stopped = yield* driver.stop('run_1')
        expect(stopped._tag).toBe('Interrupted')
        yield* Deferred.succeed(release, undefined)
        yield* driver.awaitIdle('run_1')

        expect(yield* Ref.get(latePark)).toBe('Stale')
        expect(yield* inbox.parked('run_1')).toBeUndefined()
        expect(yield* store.isClaimed('run_1')).toBe(false)
      }).pipe(Effect.provide(layer))
    })
  )

  it.effect('user stop releases the claim; shutdown interrupt still keeps it', () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const layer = makeInMemoryHarnessLayer({
        drain: () =>
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)))
      })

      yield* Effect.gen(function* () {
        const driver = yield* Driver
        const store = yield* RunStore

        yield* driver.wake('run_1')
        yield* Deferred.await(started)
        yield* driver.stop('run_1')
        yield* Deferred.succeed(release, undefined)
        yield* driver.awaitIdle('run_1')
        expect(yield* store.isClaimed('run_1')).toBe(false)
      }).pipe(Effect.provide(layer))
    })
  )

  it.effect('user stop after shutdown settlement releases the leftover idle claim', () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const layer = makeInMemoryHarnessLayer({
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
        const stopped = yield* driver.stop('run_1')
        expect(stopped._tag).toBe('Idle')
        expect(yield* store.isClaimed('run_1')).toBe(false)
        const resumed = yield* driver.resumeSuspended
        expect(resumed.resumed).toEqual([])
        expect(resumed.exhausted).toEqual([])
        expect(yield* driver.isActive('run_1')).toBe(false)
      }).pipe(Effect.provide(layer))
    })
  )

  it.effect('admit commit survives caller cancellation and does not interrupt a successor', () =>
    Effect.gen(function* () {
      const drains = yield* Ref.make(0)
      const committed = yield* Deferred.make<void>()
      const allowWake = yield* Deferred.make<void>()
      const wrapWake = Layer.effect(
        Inbox,
        Effect.gen(function* () {
          const inner = yield* Inbox
          return Inbox.of({
            enqueue: inner.enqueue,
            takePromotable: inner.takePromotable,
            pending: inner.pending,
            parked: inner.parked,
            park: inner.park,
            acceptHitl: inner.acceptHitl,
            clearPark: inner.clearPark,
            beginDrain: inner.beginDrain,
            endDrain: inner.endDrain,
            invalidate: inner.invalidate,
            enqueueAndWake: (item, wake) =>
              inner.enqueueAndWake(
                item,
                Deferred.succeed(committed, undefined).pipe(
                  Effect.andThen(Deferred.await(allowWake)),
                  Effect.andThen(wake)
                )
              ),
            wakeIfUnblocked: inner.wakeIfUnblocked,
            startIfUnblocked: inner.startIfUnblocked
          })
        })
      )
      const layer = makeDriverLayer({
        drain: () => Ref.update(drains, count => count + 1)
      }).pipe(
        Layer.provideMerge(makeInMemoryRunStoreLayer()),
        Layer.provideMerge(wrapWake.pipe(Layer.provideMerge(makeInMemoryInboxLayer())))
      )

      yield* Effect.gen(function* () {
        const driver = yield* Driver
        const inbox = yield* Inbox

        const fiber = yield* admit({
          id: 'input_1',
          runId: 'run_1',
          delivery: 'input',
          kind: 'input'
        }).pipe(Effect.forkChild)
        yield* Deferred.await(committed)
        const interrupting = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild)
        yield* Deferred.succeed(allowWake, undefined)
        yield* Fiber.join(interrupting)
        yield* driver.awaitIdle('run_1')

        expect(yield* inbox.pending('run_1')).toHaveLength(1)
        expect(yield* Ref.get(drains)).toBe(1)

        yield* driver.wake('run_2')
        yield* driver.awaitIdle('run_2')
        expect(yield* Ref.get(drains)).toBe(2)
        expect(yield* driver.isActive('run_2')).toBe(false)
      }).pipe(Effect.provide(layer))
    })
  )

  it.effect('user stop drops queued items for that run', () =>
    Effect.gen(function* () {
      const layer = makeInMemoryHarnessLayer({
        drain: (runId, _force, _scope, context) =>
          Effect.gen(function* () {
            if (context.readyResponses.length > 0) return
            const inbox = yield* Inbox
            yield* inbox.park(runId, ['req_a'], context.drainToken)
          })
      })

      yield* Effect.gen(function* () {
        const driver = yield* Driver
        const inbox = yield* Inbox
        yield* driver.wake('run_1')
        yield* driver.awaitIdle('run_1')
        expect(yield* inbox.parked('run_1')).toBeDefined()
        yield* admit({
          id: 'queued_1',
          runId: 'run_1',
          delivery: 'input',
          kind: 'input'
        })
        expect(yield* inbox.pending('run_1')).toHaveLength(1)
        yield* driver.stop('run_1')
        expect(yield* inbox.pending('run_1')).toHaveLength(0)
        expect(yield* inbox.parked('run_1')).toBeUndefined()
      }).pipe(Effect.provide(layer))
    })
  )

  it.effect('keeps accepted HITL refs if a Ready drain is interrupted', () =>
    Effect.gen(function* () {
      const startedReady = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const layer = makeInMemoryHarnessLayer({
        drain: (runId, _force, _scope, context) =>
          Effect.gen(function* () {
            if (context.readyResponses.length > 0) {
              yield* Deferred.succeed(startedReady, undefined)
              yield* Deferred.await(release)
              return
            }
            const inbox = yield* Inbox
            yield* inbox.park(runId, ['req_a'], context.drainToken)
          })
      })

      yield* Effect.gen(function* () {
        const driver = yield* Driver
        const inbox = yield* Inbox
        const store = yield* RunStore
        yield* driver.wake('run_1')
        yield* driver.awaitIdle('run_1')
        const parked = yield* inbox.parked('run_1')
        expect(parked).toBeDefined()
        if (parked === undefined) return
        const ready = yield* driver.resumeHitl('run_1', {
          itemId: 'item_a',
          requestId: 'req_a',
          generation: parked.generation
        })
        expect(ready._tag).toBe('Ready')
        yield* Deferred.await(startedReady)
        yield* driver.interrupt('run_1', { reason: 'shutdown' })
        yield* Deferred.succeed(release, undefined)
        yield* driver.awaitIdle('run_1')
        const stillParked = yield* inbox.parked('run_1')
        expect(stillParked).toBeDefined()
        expect(stillParked?.responses).toEqual([{ itemId: 'item_a', requestId: 'req_a' }])
        expect(yield* store.isClaimed('run_1')).toBe(true)
      }).pipe(Effect.provide(layer))
    })
  )

  it.effect('old drain end does not clear HITL answers that arrived while it was still alive', () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const drains = yield* Ref.make(0)
      const readyItemIds = yield* Ref.make<ReadonlyArray<string>>([])
      const layer = makeInMemoryHarnessLayer({
        drain: (runId, _force, _scope, context) =>
          Effect.gen(function* () {
            yield* Ref.update(drains, count => count + 1)
            if (context.readyResponses.length > 0) {
              yield* Ref.set(
                readyItemIds,
                context.readyResponses.map(response => response.itemId)
              )
              return
            }
            const inbox = yield* Inbox
            yield* inbox.park(runId, ['req_a', 'req_b'], context.drainToken)
            yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(release)
          })
      })

      yield* Effect.gen(function* () {
        const driver = yield* Driver
        const inbox = yield* Inbox
        yield* driver.wake('run_1')
        yield* Deferred.await(started)
        const parked = yield* inbox.parked('run_1')
        expect(parked).toBeDefined()
        if (parked === undefined) return
        expect(
          (yield* driver.resumeHitl('run_1', {
            itemId: 'item_a',
            requestId: 'req_a',
            generation: parked.generation
          }))._tag
        ).toBe('Accepted')
        expect(
          (yield* driver.resumeHitl('run_1', {
            itemId: 'item_b',
            requestId: 'req_b',
            generation: parked.generation
          }))._tag
        ).toBe('Ready')
        yield* Deferred.succeed(release, undefined)
        yield* driver.awaitIdle('run_1')
        expect(yield* Ref.get(drains)).toBe(2)
        expect(yield* Ref.get(readyItemIds)).toEqual(['item_a', 'item_b'])
        expect(yield* inbox.parked('run_1')).toBeUndefined()
      }).pipe(Effect.provide(layer))
    })
  )

  it.effect('input admitted during a Ready drain still runs after that drain ends', () =>
    Effect.gen(function* () {
      const readyStarted = yield* Deferred.make<void>()
      const readyRelease = yield* Deferred.make<void>()
      const drains = yield* Ref.make(0)
      const layer = makeInMemoryHarnessLayer({
        drain: (runId, _force, _scope, context) =>
          Effect.gen(function* () {
            yield* Ref.update(drains, count => count + 1)
            if (context.readyResponses.length > 0) {
              yield* Deferred.succeed(readyStarted, undefined)
              yield* Deferred.await(readyRelease)
              return
            }
            const inbox = yield* Inbox
            yield* inbox.park(runId, ['req_a'], context.drainToken)
          })
      })

      yield* Effect.gen(function* () {
        const driver = yield* Driver
        const inbox = yield* Inbox
        yield* driver.wake('run_1')
        yield* driver.awaitIdle('run_1')
        const parked = yield* inbox.parked('run_1')
        expect(parked).toBeDefined()
        if (parked === undefined) return
        expect(
          (yield* driver.resumeHitl('run_1', {
            itemId: 'item_a',
            requestId: 'req_a',
            generation: parked.generation
          }))._tag
        ).toBe('Ready')
        yield* Deferred.await(readyStarted)
        yield* admit({
          id: 'input_after_ready',
          runId: 'run_1',
          delivery: 'input',
          kind: 'input'
        })
        expect(yield* Ref.get(drains)).toBe(2)
        yield* Deferred.succeed(readyRelease, undefined)
        yield* driver.awaitIdle('run_1')
        expect(yield* Ref.get(drains)).toBe(3)
        expect(yield* inbox.pending('run_1')).toHaveLength(1)
      }).pipe(Effect.provide(layer))
    })
  )

  it.effect('explicit run uses force=true and one drain even when settlement is fast', () =>
    Effect.gen(function* () {
      const forces = yield* Ref.make<ReadonlyArray<boolean>>([])
      const layer = makeInMemoryHarnessLayer({
        drain: (_runId, force) => Ref.update(forces, current => [...current, force])
      })
      yield* Effect.gen(function* () {
        const driver = yield* Driver
        yield* driver.run('run_1')
        expect(yield* Ref.get(forces)).toEqual([true])
        yield* driver.wake('run_2')
        yield* driver.awaitIdle('run_2')
        expect(yield* Ref.get(forces)).toEqual([true, false])
        const stopped = yield* driver.stop('run_1')
        expect(stopped._tag).toBe('Idle')
      }).pipe(Effect.provide(layer))
    })
  )

  it.effect('resumeSuspended skips incomplete parks and does not spend resume budget', () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const layer = makeInMemoryHarnessLayer({
        drain: (runId, _force, _scope, context) =>
          Effect.gen(function* () {
            const inbox = yield* Inbox
            yield* inbox.park(runId, ['req_a'], context.drainToken)
            yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(release)
          })
      })
      yield* Effect.gen(function* () {
        const driver = yield* Driver
        const inbox = yield* Inbox
        const store = yield* RunStore
        yield* driver.wake('run_1')
        yield* Deferred.await(started)
        yield* driver.interrupt('run_1', { reason: 'shutdown' })
        yield* Deferred.succeed(release, undefined)
        yield* driver.awaitIdle('run_1')
        expect(yield* store.isClaimed('run_1')).toBe(true)
        const parked = yield* inbox.parked('run_1')
        expect(parked).toBeDefined()
        expect(parked?.ready).toBe(false)
        const result = yield* driver.resumeSuspended
        expect(result.resumed).toEqual([])
        expect(result.exhausted).toEqual([])
        expect(yield* store.resumeCount('run_1')).toBe(0)
        expect(yield* store.isClaimed('run_1')).toBe(true)
      }).pipe(Effect.provide(layer))
    })
  )

  it.effect('clears the drain token after a synchronous drain defect', () =>
    Effect.gen(function* () {
      let captured = ''
      const layer = makeInMemoryHarnessLayer({
        drain: (_runId, _force, _scope, context) => {
          captured = context.drainToken
          throw new Error('sync-defect')
        }
      })
      yield* Effect.gen(function* () {
        const driver = yield* Driver
        const inbox = yield* Inbox
        yield* driver.wake('run_1').pipe(Effect.exit)
        yield* driver.awaitIdle('run_1')
        expect(captured.length).toBeGreaterThan(0)
        const late = yield* inbox.park('run_1', ['req_a'], captured)
        expect(late._tag).toBe('Stale')
        expect(yield* inbox.parked('run_1')).toBeUndefined()
      }).pipe(Effect.provide(layer))
    })
  )

  it.effect('clears the drain token after shutdown interrupt while keeping parked refs', () =>
    Effect.gen(function* () {
      const startedReady = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const token = yield* Ref.make('')
      const layer = makeInMemoryHarnessLayer({
        drain: (runId, _force, _scope, context) =>
          Effect.gen(function* () {
            if (context.readyResponses.length > 0) {
              yield* Ref.set(token, context.drainToken)
              yield* Deferred.succeed(startedReady, undefined)
              yield* Deferred.await(release)
              return
            }
            const inbox = yield* Inbox
            yield* inbox.park(runId, ['req_a'], context.drainToken)
          })
      })
      yield* Effect.gen(function* () {
        const driver = yield* Driver
        const inbox = yield* Inbox
        const store = yield* RunStore
        yield* driver.wake('run_1')
        yield* driver.awaitIdle('run_1')
        const parked = yield* inbox.parked('run_1')
        expect(parked).toBeDefined()
        if (parked === undefined) return
        expect(
          (yield* driver.resumeHitl('run_1', {
            itemId: 'item_a',
            requestId: 'req_a',
            generation: parked.generation
          }))._tag
        ).toBe('Ready')
        yield* Deferred.await(startedReady)
        yield* driver.interrupt('run_1', { reason: 'shutdown' })
        yield* Deferred.succeed(release, undefined)
        yield* driver.awaitIdle('run_1')
        const captured = yield* Ref.get(token)
        expect(captured.length).toBeGreaterThan(0)
        expect((yield* inbox.park('run_1', ['req_z'], captured))._tag).toBe('Stale')
        const stillParked = yield* inbox.parked('run_1')
        expect(stillParked).toBeDefined()
        expect(stillParked?.responses).toEqual([{ itemId: 'item_a', requestId: 'req_a' }])
        expect(yield* store.isClaimed('run_1')).toBe(true)
      }).pipe(Effect.provide(layer))
    })
  )

  it.effect('repeated user-stop keeps the claim until the captured owner settles', () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const layer = makeInMemoryHarnessLayer({
        drain: () =>
          Effect.uninterruptible(
            Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)))
          )
      })
      yield* Effect.gen(function* () {
        const driver = yield* Driver
        const store = yield* RunStore
        yield* driver.wake('run_1')
        yield* Deferred.await(started)
        expect(yield* driver.stop('run_1')).toEqual({ _tag: 'Interrupted' })
        expect(yield* driver.isActive('run_1')).toBe(true)
        expect(yield* store.isClaimed('run_1')).toBe(true)
        yield* driver.stop('run_1')
        expect(yield* driver.isActive('run_1')).toBe(true)
        expect(yield* store.isClaimed('run_1')).toBe(true)
        yield* Deferred.succeed(release, undefined)
        yield* driver.awaitIdle('run_1')
        expect(yield* driver.isActive('run_1')).toBe(false)
        expect(yield* store.isClaimed('run_1')).toBe(false)
      }).pipe(Effect.provide(layer))
    })
  )

  it.effect('shutdown then user-stop releases only when the captured owner settles', () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const layer = makeInMemoryHarnessLayer({
        drain: () =>
          Effect.uninterruptible(
            Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)))
          )
      })
      yield* Effect.gen(function* () {
        const driver = yield* Driver
        const store = yield* RunStore
        yield* driver.wake('run_1')
        yield* Deferred.await(started)
        yield* driver.interrupt('run_1', { reason: 'shutdown' })
        expect(yield* driver.isActive('run_1')).toBe(true)
        expect(yield* store.isClaimed('run_1')).toBe(true)
        yield* driver.stop('run_1')
        expect(yield* driver.isActive('run_1')).toBe(true)
        expect(yield* store.isClaimed('run_1')).toBe(true)
        yield* Deferred.succeed(release, undefined)
        yield* driver.awaitIdle('run_1')
        expect(yield* driver.isActive('run_1')).toBe(false)
        expect(yield* store.isClaimed('run_1')).toBe(false)
      }).pipe(Effect.provide(layer))
    })
  )

  it.effect('user stop then shutdown still releases the claim at owner settlement', () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const layer = makeInMemoryHarnessLayer({
        drain: () =>
          Effect.uninterruptible(
            Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)))
          )
      })
      yield* Effect.gen(function* () {
        const driver = yield* Driver
        const store = yield* RunStore
        yield* driver.wake('run_1')
        yield* Deferred.await(started)
        yield* driver.stop('run_1')
        expect(yield* store.isClaimed('run_1')).toBe(true)
        yield* driver.interrupt('run_1', { reason: 'shutdown' })
        expect(yield* driver.isActive('run_1')).toBe(true)
        expect(yield* store.isClaimed('run_1')).toBe(true)
        yield* Deferred.succeed(release, undefined)
        yield* driver.awaitIdle('run_1')
        expect(yield* driver.isActive('run_1')).toBe(false)
        expect(yield* store.isClaimed('run_1')).toBe(false)
      }).pipe(Effect.provide(layer))
    })
  )

  it.effect('run during stopping waits for the owner then starts a successor drain', () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const forces = yield* Ref.make<ReadonlyArray<boolean>>([])
      const layer = makeInMemoryHarnessLayer({
        drain: (_runId, force) =>
          Ref.update(forces, current => [...current, force]).pipe(
            Effect.flatMap(() =>
              Ref.get(forces).pipe(
                Effect.flatMap(current =>
                  current.length === 1
                    ? Effect.uninterruptible(
                        Deferred.succeed(started, undefined).pipe(
                          Effect.andThen(Deferred.await(release))
                        )
                      )
                    : Effect.void
                )
              )
            )
          )
      })
      yield* Effect.gen(function* () {
        const driver = yield* Driver
        yield* driver.wake('run_1')
        yield* Deferred.await(started)
        yield* driver.stop('run_1')
        const successor = yield* driver.run('run_1').pipe(Effect.forkChild)
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(successor)
        yield* driver.awaitIdle('run_1')
        expect(yield* Ref.get(forces)).toEqual([false, true])
      }).pipe(Effect.provide(layer))
    })
  )

  it.effect('cancelled run wait after stop does not admit a successor drain', () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const drains = yield* Ref.make(0)
      const layer = makeInMemoryHarnessLayer({
        drain: () =>
          Ref.update(drains, count => count + 1).pipe(
            Effect.flatMap(() =>
              Ref.get(drains).pipe(
                Effect.flatMap(count =>
                  count === 1
                    ? Effect.uninterruptible(
                        Deferred.succeed(started, undefined).pipe(
                          Effect.andThen(Deferred.await(release))
                        )
                      )
                    : Effect.void
                )
              )
            )
          )
      })
      yield* Effect.gen(function* () {
        const driver = yield* Driver
        const inbox = yield* Inbox
        yield* driver.wake('run_1')
        yield* Deferred.await(started)
        yield* driver.stop('run_1')
        const waiting = yield* driver.run('run_1').pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* Fiber.interrupt(waiting)
        yield* Deferred.succeed(release, undefined)
        yield* driver.awaitIdle('run_1')
        expect(yield* Ref.get(drains)).toBe(1)
        const begun = yield* inbox.beginDrain('run_1')
        expect(begun._tag).toBe('Skip')
      }).pipe(Effect.provide(layer))
    })
  )

  it.effect('joining an active run does not leave a phantom beginDrain admission', () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const drains = yield* Ref.make(0)
      const layer = makeInMemoryHarnessLayer({
        drain: () =>
          Ref.update(drains, count => count + 1).pipe(
            Effect.andThen(Deferred.succeed(started, undefined)),
            Effect.andThen(Deferred.await(release))
          )
      })
      yield* Effect.gen(function* () {
        const driver = yield* Driver
        const inbox = yield* Inbox
        yield* driver.wake('run_1')
        yield* Deferred.await(started)
        const joiner = yield* driver.run('run_1').pipe(Effect.forkChild)
        yield* Effect.yieldNow
        expect(yield* Ref.get(drains)).toBe(1)
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(joiner)
        yield* driver.awaitIdle('run_1')
        expect(yield* Ref.get(drains)).toBe(1)
        const begun = yield* inbox.beginDrain('run_1')
        expect(begun._tag).toBe('Skip')
      }).pipe(Effect.provide(layer))
    })
  )
})
