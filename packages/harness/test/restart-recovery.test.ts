import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Ref, Scheduler } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import {
  QuestionAnswer,
  QuestionResponse,
  ToolApprovalPolicy,
  ToolApprovalResponse,
  ToolCall,
  ToolDef,
  type HitlRequest,
  type HitlResponse
} from '@yolk-sdk/agent/protocol'
import { LoopConfig, ToolExecutor } from '@yolk-sdk/agent/loop'
import { TestToolExecutor } from '@yolk-sdk/agent/loop/testing'
import {
  Driver,
  InvalidMaxResumeAttempts,
  makeDriverLayer,
  type Drain,
  type DriverLayerOptions
} from '../src/driver.ts'
import { makeDurableObjectDriverLayer } from '../src/driver/durable-object.ts'
import { makeInMemoryDriverLayer, makeInMemoryHarnessLayer } from '../src/driver/memory.ts'
import { Inbox, makeInMemoryInboxLayer } from '../src/inbox.ts'
import { attemptToolBatch, matchHitlResponse, resumeHitlIfMatched } from '../src/outcome.ts'
import {
  makeInMemoryRunStoreLayer,
  makeSnapshotRunStoreLayer,
  RunStore,
  type DurableRunStoreSnapshot
} from '../src/store.ts'

type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

type LayerE<L> = L extends Layer.Layer<infer _A, infer E, infer _R> ? E : never

type LayerR<L> = L extends Layer.Layer<infer _A, infer _E, infer R> ? R : never

const configuredMax: { readonly maxResumeAttempts?: number } = {}

const maybeMax: number | undefined = undefined

const optionalObject: DriverLayerOptions | undefined = undefined

const forwardDriverOptions = (options?: DriverLayerOptions) => makeDriverLayer(options)

const forwardMemoryOptions = (options?: DriverLayerOptions) => makeInMemoryDriverLayer(options)

const forwardHarnessOptions = (options?: DriverLayerOptions) => makeInMemoryHarnessLayer(options)

const forwardDefaultDriver = (options?: {
  readonly drain?: Drain
  readonly maxResumeAttempts?: undefined
}) => makeDriverLayer(options)

const forwardDefaultMemory = (options?: {
  readonly drain?: Drain
  readonly maxResumeAttempts?: undefined
}) => makeInMemoryDriverLayer(options)

const forwardDefaultHarness = (options?: {
  readonly drain?: Drain
  readonly maxResumeAttempts?: undefined
}) => makeInMemoryHarnessLayer(options)

const durableLoad = Effect.succeed<DurableRunStoreSnapshot | undefined>(undefined)

const durableSave = (_snapshot: DurableRunStoreSnapshot) => Effect.void

const forwardDurableOptions = (options: {
  readonly load: Effect.Effect<DurableRunStoreSnapshot | undefined>
  readonly save: (snapshot: DurableRunStoreSnapshot) => Effect.Effect<void>
  readonly drain?: Drain
  readonly maxResumeAttempts?: number
}) => makeDurableObjectDriverLayer(options)

const _omittedDriver = () => makeDriverLayer()

const _wholeUndefinedDriver = () => makeDriverLayer(undefined)

const _drainOnlyDriver = () => makeDriverLayer({ drain: () => Effect.void })

const _explicitUndefinedDriver = () => makeDriverLayer({ maxResumeAttempts: undefined })

const _numericDriver = () => makeDriverLayer({ maxResumeAttempts: 1 })

const _configuredMaxDriver = () => makeDriverLayer(configuredMax)

const numberOrUndefinedOptions: DriverLayerOptions = { maxResumeAttempts: maybeMax }

const _numberOrUndefinedDriver = () => makeDriverLayer(numberOrUndefinedOptions)

const _omittedMemoryDriver = () => makeInMemoryDriverLayer()

const _wholeUndefinedMemoryDriver = () => makeInMemoryDriverLayer(undefined)

const _numericMemoryDriver = () => makeInMemoryDriverLayer({ maxResumeAttempts: 0 })

const _omittedHarness = () => makeInMemoryHarnessLayer()

const _wholeUndefinedHarness = () => makeInMemoryHarnessLayer(undefined)

const _numericHarness = () => makeInMemoryHarnessLayer({ maxResumeAttempts: 0 })

const _omittedDurable = () => makeDurableObjectDriverLayer({ load: durableLoad, save: durableSave })

const _numericDurable = () =>
  makeDurableObjectDriverLayer({
    load: durableLoad,
    save: durableSave,
    maxResumeAttempts: 2
  })

const _omittedDriverE: Equal<LayerE<ReturnType<typeof _omittedDriver>>, never> = true

const _omittedDriverR: Equal<LayerR<ReturnType<typeof _omittedDriver>>, RunStore | Inbox> = true

const _wholeUndefinedDriverE: Equal<LayerE<ReturnType<typeof _wholeUndefinedDriver>>, never> = true

const _forwardDefaultDriverE: Equal<LayerE<ReturnType<typeof forwardDefaultDriver>>, never> = true

const _drainOnlyDriverE: Equal<LayerE<ReturnType<typeof _drainOnlyDriver>>, never> = true

const _explicitUndefinedDriverE: Equal<
  LayerE<ReturnType<typeof _explicitUndefinedDriver>>,
  never
> = true

const _numericDriverE: Equal<
  LayerE<ReturnType<typeof _numericDriver>>,
  InvalidMaxResumeAttempts
> = true

const _configuredMaxDriverE: Equal<
  LayerE<ReturnType<typeof _configuredMaxDriver>>,
  InvalidMaxResumeAttempts
> = true

const _numberOrUndefinedDriverE: Equal<
  LayerE<ReturnType<typeof _numberOrUndefinedDriver>>,
  InvalidMaxResumeAttempts
> = true

const _forwardDriverE: Equal<
  LayerE<ReturnType<typeof forwardDriverOptions>>,
  InvalidMaxResumeAttempts
> = true

const _forwardDriverR: Equal<
  LayerR<ReturnType<typeof forwardDriverOptions>>,
  RunStore | Inbox
> = true

const _omittedMemoryDriverE: Equal<LayerE<ReturnType<typeof _omittedMemoryDriver>>, never> = true

const _wholeUndefinedMemoryDriverE: Equal<
  LayerE<ReturnType<typeof _wholeUndefinedMemoryDriver>>,
  never
> = true

const _forwardDefaultMemoryE: Equal<LayerE<ReturnType<typeof forwardDefaultMemory>>, never> = true

const _numericMemoryDriverE: Equal<
  LayerE<ReturnType<typeof _numericMemoryDriver>>,
  InvalidMaxResumeAttempts
> = true

const _forwardMemoryE: Equal<
  LayerE<ReturnType<typeof forwardMemoryOptions>>,
  InvalidMaxResumeAttempts
> = true

const _omittedHarnessE: Equal<LayerE<ReturnType<typeof _omittedHarness>>, never> = true

const _omittedHarnessR: Equal<LayerR<ReturnType<typeof _omittedHarness>>, never> = true

const _wholeUndefinedHarnessE: Equal<
  LayerE<ReturnType<typeof _wholeUndefinedHarness>>,
  never
> = true

const _forwardDefaultHarnessE: Equal<LayerE<ReturnType<typeof forwardDefaultHarness>>, never> = true

const _numericHarnessE: Equal<
  LayerE<ReturnType<typeof _numericHarness>>,
  InvalidMaxResumeAttempts
> = true

const _forwardHarnessE: Equal<
  LayerE<ReturnType<typeof forwardHarnessOptions>>,
  InvalidMaxResumeAttempts
> = true

const _omittedDurableE: Equal<LayerE<ReturnType<typeof _omittedDurable>>, never> = true

const _numericDurableE: Equal<
  LayerE<ReturnType<typeof _numericDurable>>,
  InvalidMaxResumeAttempts
> = true

const _forwardDurableE: Equal<
  LayerE<ReturnType<typeof forwardDurableOptions>>,
  InvalidMaxResumeAttempts
> = true

void [
  _omittedDriver(),
  _wholeUndefinedDriver(),
  _drainOnlyDriver(),
  _explicitUndefinedDriver(),
  _numericDriver(),
  _configuredMaxDriver(),
  _numberOrUndefinedDriver(),
  forwardDriverOptions(optionalObject),
  forwardDefaultDriver(undefined),
  _omittedMemoryDriver(),
  _wholeUndefinedMemoryDriver(),
  _numericMemoryDriver(),
  forwardMemoryOptions(optionalObject),
  forwardDefaultMemory(undefined),
  _omittedHarness(),
  _wholeUndefinedHarness(),
  _numericHarness(),
  forwardHarnessOptions(optionalObject),
  forwardDefaultHarness(undefined),
  _omittedDurable(),
  _numericDurable(),
  forwardDurableOptions({
    load: durableLoad,
    save: durableSave,
    maxResumeAttempts: maybeMax
  }),
  _omittedDriverE,
  _omittedDriverR,
  _wholeUndefinedDriverE,
  _forwardDefaultDriverE,
  _drainOnlyDriverE,
  _explicitUndefinedDriverE,
  _numericDriverE,
  _configuredMaxDriverE,
  _numberOrUndefinedDriverE,
  _forwardDriverE,
  _forwardDriverR,
  _omittedMemoryDriverE,
  _wholeUndefinedMemoryDriverE,
  _forwardDefaultMemoryE,
  _numericMemoryDriverE,
  _forwardMemoryE,
  _omittedHarnessE,
  _omittedHarnessR,
  _wholeUndefinedHarnessE,
  _forwardDefaultHarnessE,
  _numericHarnessE,
  _forwardHarnessE,
  _omittedDurableE,
  _numericDurableE,
  _forwardDurableE
]

const makeBacking = (initial?: DurableRunStoreSnapshot) =>
  Ref.make(initial).pipe(
    Effect.map(ref => ({
      load: Ref.get(ref),
      save: (snapshot: DurableRunStoreSnapshot) => Ref.set(ref, snapshot)
    }))
  )

const snapshotLayer = (
  backing: {
    readonly load: Effect.Effect<DurableRunStoreSnapshot | undefined>
    readonly save: (snapshot: DurableRunStoreSnapshot) => Effect.Effect<void>
  },
  drain: Drain,
  options: { readonly maxResumeAttempts?: number } = {},
  wrap: (store: Layer.Layer<RunStore>) => Layer.Layer<RunStore> = store => store
) =>
  makeDriverLayer({ drain, ...options }).pipe(
    Layer.provideMerge(wrap(makeSnapshotRunStoreLayer(backing))),
    Layer.provideMerge(makeInMemoryInboxLayer())
  )

class CompoundFailureId extends Context.Service<CompoundFailureId, string>()('CompoundFailureId') {}

const annotatedDie = (defect: unknown, id: string) =>
  Cause.annotate(Cause.die(defect), Context.make(CompoundFailureId, id))

const annotatedInterrupt = (fiberId: number, id: string) =>
  Cause.annotate(Cause.interrupt(fiberId), Context.make(CompoundFailureId, id))

const expectAnnotatedDie = <E>(cause: Cause.Cause<E>, defect: unknown, id: string) => {
  const found = cause.reasons.filter(Cause.isDieReason).find(reason => reason.defect === defect)
  expect(found).toBeDefined()

  if (found === undefined) return
  expect(found.defect).toBe(defect)
  expect(Context.getOrUndefined(Cause.reasonAnnotations(found), CompoundFailureId)).toBe(id)
}

const expectAnnotatedInterrupt = <E>(cause: Cause.Cause<E>, fiberId: number, id: string) => {
  const found = cause.reasons
    .filter(Cause.isInterruptReason)
    .find(reason => reason.fiberId === fiberId)

  expect(found).toBeDefined()

  if (found === undefined) return
  expect(found.fiberId).toBe(fiberId)
  expect(Context.getOrUndefined(Cause.reasonAnnotations(found), CompoundFailureId)).toBe(id)
}

const makeRequestHoldScheduler = () => {
  const base = new Scheduler.MixedScheduler('async')
  const known = new Set<number>()
  let armed = false
  let holdNext = false
  let skippedNew = 0
  const held: Array<() => void> = []

  const scheduler: Scheduler.Scheduler = {
    executionMode: 'async',
    shouldYield(fiber) {
      if (armed && !known.has(fiber.id)) {
        known.add(fiber.id)

        if (skippedNew === 0) {
          skippedNew = 1

          return base.shouldYield(fiber)
        }

        holdNext = true

        return true
      }

      known.add(fiber.id)

      return base.shouldYield(fiber)
    },
    makeDispatcher() {
      const inner = base.makeDispatcher()

      return {
        scheduleTask(task, priority) {
          if (holdNext) {
            holdNext = false
            held.push(() => inner.scheduleTask(task, priority))
          } else inner.scheduleTask(task, priority)
        },
        flush() {
          inner.flush()
        }
      }
    }
  }

  return {
    scheduler,
    arm: () => {
      armed = true
      skippedNew = 0
    },
    disarm: () => {
      armed = false
    },
    held,
    releaseHeld: () => {
      const tasks = held.splice(0)

      for (const task of tasks) task()
    }
  }
}

describe('restart recovery', () => {
  it.effect('rejects invalid maxResumeAttempts at layer init', () =>
    Effect.gen(function* () {
      const invalid = [-1, 1.5, Number.NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]

      for (const maxResumeAttempts of invalid) {
        const exit = yield* Effect.void.pipe(
          Effect.provide(makeInMemoryHarnessLayer({ maxResumeAttempts })),
          Effect.exit
        )

        expect(exit._tag).toBe('Failure')

        if (exit._tag !== 'Failure') {
          throw new Error('expected InvalidMaxResumeAttempts layer failure')
        }

        const found = Cause.findError(exit.cause)
        expect(found._tag).toBe('Success')

        if (found._tag !== 'Success') {
          throw new Error('expected tagged InvalidMaxResumeAttempts')
        }

        expect(found.success).toBeInstanceOf(InvalidMaxResumeAttempts)
        expect(found.success.maxResumeAttempts).toBe(maxResumeAttempts)
      }
    })
  )

  it.effect('maxResumeAttempts 0 exhausts by release only', () =>
    Effect.gen(function* () {
      const backing = yield* makeBacking({ claimed: ['run_1'], resumes: [] })
      const counts: Array<ReadonlyArray<readonly [string, number]>> = []
      const drains = yield* Ref.make(0)

      const storage = {
        ...backing,
        save: (snapshot: DurableRunStoreSnapshot) =>
          Effect.sync(() => {
            counts.push(snapshot.resumes.map(pair => [...pair] as const))
          }).pipe(Effect.andThen(backing.save(snapshot)))
      }

      yield* Effect.gen(function* () {
        const driver = yield* Driver
        const store = yield* RunStore
        const result = yield* driver.resumeSuspended
        expect(result.resumed).toEqual([])
        expect(result.exhausted).toEqual(['run_1'])
        expect(yield* store.isClaimed('run_1')).toBe(false)
        expect(counts).toEqual([[]])
        expect(yield* Ref.get(drains)).toBe(0)
      }).pipe(
        Effect.provide(
          snapshotLayer(storage, () => Ref.update(drains, count => count + 1), {
            maxResumeAttempts: 0
          })
        )
      )
    })
  )

  it.effect('rebuilds layers against the same snapshot and exhausts the budget', () =>
    Effect.gen(function* () {
      const backing = yield* makeBacking()
      const drains = yield* Ref.make(0)

      const shutdownOnce = () =>
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          yield* Effect.scoped(
            Effect.gen(function* () {
              const driver = yield* Driver
              const store = yield* RunStore

              if (yield* store.isClaimed('run_1')) {
                const resumed = yield* driver.resumeSuspended
                expect(resumed.resumed).toEqual(['run_1'])
              } else {
                yield* driver.wake('run_1')
              }

              yield* Deferred.await(started)
              yield* driver.interrupt('run_1', { reason: 'shutdown' })
              yield* Deferred.succeed(release, undefined)
              yield* driver.awaitIdle('run_1')
              expect(yield* store.isClaimed('run_1')).toBe(true)
            }).pipe(
              Effect.provide(
                makeDurableObjectDriverLayer({
                  ...backing,
                  maxResumeAttempts: 2,
                  drain: () =>
                    Ref.update(drains, count => count + 1).pipe(
                      Effect.andThen(Deferred.succeed(started, undefined)),
                      Effect.andThen(Deferred.await(release))
                    )
                })
              )
            )
          )
        })

      yield* shutdownOnce()
      yield* shutdownOnce()
      yield* shutdownOnce()
      expect(yield* Ref.get(drains)).toBe(3)

      yield* Effect.gen(function* () {
        const driver = yield* Driver
        const store = yield* RunStore
        expect(yield* store.isClaimed('run_1')).toBe(true)
        expect(yield* store.resumeCount('run_1')).toBe(2)
        const exhausted = yield* driver.resumeSuspended
        expect(exhausted.resumed).toEqual([])
        expect(exhausted.exhausted).toEqual(['run_1'])
        expect(yield* store.isClaimed('run_1')).toBe(false)
        const again = yield* driver.resumeSuspended
        expect(again).toEqual({ resumed: [], exhausted: [] })
        expect(yield* Ref.get(drains)).toBe(3)
      }).pipe(
        Effect.provide(
          makeDurableObjectDriverLayer({
            ...backing,
            maxResumeAttempts: 2,
            drain: () => Ref.update(drains, count => count + 1)
          })
        )
      )
    })
  )

  it.effect('concurrent sweeps charge a candidate once', () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const hold = yield* Deferred.make<void>()
      const increments = yield* Ref.make(0)

      const delayedStore = Layer.effect(
        RunStore,
        Effect.gen(function* () {
          const inner = yield* RunStore

          return RunStore.of({
            ...inner,
            incrementResumeCount: runId =>
              Ref.update(increments, count => count + 1).pipe(
                Effect.andThen(Deferred.succeed(entered, undefined)),
                Effect.andThen(Deferred.await(hold)),
                Effect.andThen(inner.incrementResumeCount(runId))
              )
          })
        })
      ).pipe(Layer.provide(makeInMemoryRunStoreLayer()))

      const layer = makeDriverLayer({
        drain: () => Effect.void
      }).pipe(Layer.provideMerge(delayedStore), Layer.provideMerge(makeInMemoryInboxLayer()))

      yield* Effect.gen(function* () {
        const driver = yield* Driver
        const store = yield* RunStore
        yield* store.claim('run_1')
        const first = yield* driver.resumeSuspended.pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        const second = yield* driver.resumeSuspended.pipe(Effect.forkChild)
        yield* Effect.yieldNow
        expect(yield* Ref.get(increments)).toBe(1)
        yield* Deferred.succeed(hold, undefined)
        const reports = [yield* Fiber.join(first), yield* Fiber.join(second)]
        const resumed = reports.flatMap(report => [...report.resumed])
        expect(resumed).toEqual(['run_1'])
        expect(yield* Ref.get(increments)).toBe(1)
        yield* driver.awaitIdle('run_1')
      }).pipe(Effect.provide(layer))
    })
  )

  it.effect('cancellation waiting for the occupied admission gate spends nothing', () =>
    Effect.gen(function* () {
      const backing = yield* makeBacking()
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const scanned = yield* Deferred.make<void>()
      const drains = yield* Ref.make(0)

      const wrap = (base: Layer.Layer<RunStore>) =>
        Layer.effect(
          RunStore,
          Effect.gen(function* () {
            const store = yield* RunStore

            return RunStore.of({
              ...store,
              claimed: store.claimed.pipe(Effect.tap(() => Deferred.succeed(scanned, undefined)))
            })
          })
        ).pipe(Layer.provide(base))

      yield* Effect.gen(function* () {
        const driver = yield* Driver
        const inbox = yield* Inbox
        const store = yield* RunStore
        yield* store.claim('run_1')

        const holder = yield* inbox
          .wakeIfUnblocked(
            'holder',
            'input',
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
          )
          .pipe(Effect.forkChild)

        yield* Deferred.await(entered)
        const sweep = yield* driver.resumeSuspended.pipe(Effect.forkChild)
        yield* Deferred.await(scanned)
        yield* Effect.yieldNow
        yield* Fiber.interrupt(sweep)
        const exit = yield* Fiber.await(sweep)
        expect(Exit.hasInterrupts(exit)).toBe(true)
        expect(yield* store.resumeCount('run_1')).toBe(0)
        expect(yield* store.isClaimed('run_1')).toBe(true)
        const before = yield* Ref.get(drains)
        expect(before).toBe(0)
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(holder)
        const retry = yield* driver.resumeSuspended
        expect(retry.resumed).toEqual(['run_1'])
        yield* driver.awaitIdle('run_1')
        expect(yield* Ref.get(drains)).toBe(1)
      }).pipe(
        Effect.ensuring(Deferred.succeed(release, undefined).pipe(Effect.asVoid)),
        Effect.provide(
          snapshotLayer(backing, () => Ref.update(drains, count => count + 1), {}, wrap)
        )
      )
    })
  )

  it.effect('cancellation waiting for the sweep mutex never reads a new snapshot', () =>
    Effect.gen(function* () {
      const backing = yield* makeBacking()
      const entered = yield* Deferred.make<void>()
      const hold = yield* Deferred.make<void>()
      const reads = yield* Ref.make(0)

      const wrap = (base: Layer.Layer<RunStore>) =>
        Layer.effect(
          RunStore,
          Effect.gen(function* () {
            const store = yield* RunStore

            return RunStore.of({
              ...store,
              claimed: Effect.gen(function* () {
                const count = yield* Ref.get(reads)
                yield* Ref.set(reads, count + 1)

                if (count === 0) {
                  yield* Deferred.succeed(entered, undefined)
                  yield* Deferred.await(hold)
                }

                return yield* store.claimed
              })
            })
          })
        ).pipe(Layer.provide(base))

      yield* Effect.gen(function* () {
        const driver = yield* Driver
        const store = yield* RunStore
        yield* store.claim('run_1')
        const first = yield* driver.resumeSuspended.pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        const second = yield* driver.resumeSuspended.pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* Fiber.interrupt(second)
        const exit = yield* Fiber.await(second)
        expect(Exit.hasInterrupts(exit)).toBe(true)
        expect(yield* Ref.get(reads)).toBe(1)
        expect(yield* store.resumeCount('run_1')).toBe(0)
        yield* Deferred.succeed(hold, undefined)
        const result = yield* Fiber.join(first)
        expect(result.resumed).toEqual(['run_1'])
        expect(yield* Ref.get(reads)).toBe(1)
        yield* driver.awaitIdle('run_1')
      }).pipe(
        Effect.ensuring(Deferred.succeed(hold, undefined).pipe(Effect.asVoid)),
        Effect.provide(snapshotLayer(backing, () => Effect.void, {}, wrap))
      )
    })
  )

  it.effect('admitted snapshot-save cancellation still charges and admits drain', () =>
    Effect.gen(function* () {
      const backing = yield* makeBacking()
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const drains = yield* Ref.make(0)
      let holdOnce = true

      const storage = {
        ...backing,
        save: (snapshot: DurableRunStoreSnapshot) =>
          Effect.suspend(() => {
            if (holdOnce && snapshot.resumes.some(([id, count]) => id === 'run_1' && count === 1)) {
              holdOnce = false

              return Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(backing.save(snapshot))
              )
            }

            return backing.save(snapshot)
          })
      }

      yield* Effect.gen(function* () {
        const driver = yield* Driver
        const store = yield* RunStore
        yield* store.claim('run_1')
        const sweep = yield* driver.resumeSuspended.pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        const cancel = yield* Fiber.interrupt(sweep).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        expect(sweep.pollUnsafe()).toBeUndefined()
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(cancel)
        const exit = yield* Fiber.await(sweep)
        expect(Exit.hasInterrupts(exit)).toBe(true)
        yield* Effect.yieldNow
        expect(yield* store.resumeCount('run_1')).toBe(1)
        expect(yield* store.isClaimed('run_1')).toBe(true)
        expect(yield* Ref.get(drains)).toBe(1)
      }).pipe(
        Effect.ensuring(Deferred.succeed(release, undefined).pipe(Effect.asVoid)),
        Effect.provide(
          snapshotLayer(storage, () =>
            Ref.update(drains, count => count + 1).pipe(Effect.andThen(Effect.never))
          )
        )
      )
    })
  )

  it.effect('stale snapshot after stop does not resurrect an unclaimed id', () =>
    Effect.gen(function* () {
      const backing = yield* makeBacking()
      const captured = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const drains = yield* Ref.make(0)
      let holdOnce = true

      const wrap = (base: Layer.Layer<RunStore>) =>
        Layer.effect(
          RunStore,
          Effect.gen(function* () {
            const store = yield* RunStore

            return RunStore.of({
              ...store,
              claimed: store.claimed.pipe(
                Effect.tap(() =>
                  Effect.suspend(() => {
                    if (!holdOnce) return Effect.void
                    holdOnce = false

                    return Deferred.succeed(captured, undefined).pipe(
                      Effect.andThen(Deferred.await(release))
                    )
                  })
                )
              )
            })
          })
        ).pipe(Layer.provide(base))

      yield* Effect.gen(function* () {
        const driver = yield* Driver
        const store = yield* RunStore
        yield* store.claim('run_1')
        const sweep = yield* driver.resumeSuspended.pipe(Effect.forkChild)
        yield* Deferred.await(captured)
        yield* driver.stop('run_1')
        expect(yield* store.isClaimed('run_1')).toBe(false)
        yield* Deferred.succeed(release, undefined)
        const result = yield* Fiber.join(sweep)
        expect(result.resumed).toEqual([])
        expect(result.exhausted).toEqual([])
        yield* driver.awaitIdle('run_1')
        expect(yield* store.isClaimed('run_1')).toBe(false)
        expect(yield* Ref.get(drains)).toBe(0)
      }).pipe(
        Effect.ensuring(Deferred.succeed(release, undefined).pipe(Effect.asVoid)),
        Effect.provide(
          snapshotLayer(backing, () => Ref.update(drains, count => count + 1), {}, wrap)
        )
      )
    })
  )

  it.effect('stale snapshot recovers a newer idle claimed checkpoint', () =>
    Effect.gen(function* () {
      const backing = yield* makeBacking()
      const captured = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const marker = yield* Ref.make('stale')
      const drains = yield* Ref.make<ReadonlyArray<string>>([])
      let holdOnce = true

      const wrap = (base: Layer.Layer<RunStore>) =>
        Layer.effect(
          RunStore,
          Effect.gen(function* () {
            const store = yield* RunStore

            return RunStore.of({
              ...store,
              claimed: store.claimed.pipe(
                Effect.tap(() =>
                  Effect.suspend(() => {
                    if (!holdOnce) return Effect.void
                    holdOnce = false

                    return Deferred.succeed(captured, undefined).pipe(
                      Effect.andThen(Deferred.await(release))
                    )
                  })
                )
              )
            })
          })
        ).pipe(Layer.provide(base))

      yield* Effect.gen(function* () {
        const driver = yield* Driver
        const store = yield* RunStore
        yield* store.claim('run_1')
        const sweep = yield* driver.resumeSuspended.pipe(Effect.forkChild)
        yield* Deferred.await(captured)
        yield* driver.stop('run_1')
        expect(yield* store.isClaimed('run_1')).toBe(false)
        yield* Ref.set(marker, 'current')
        yield* store.claim('run_1')
        yield* Deferred.succeed(release, undefined)
        const result = yield* Fiber.join(sweep)
        expect(result.resumed).toEqual(['run_1'])
        yield* driver.awaitIdle('run_1')
        expect(yield* Ref.get(drains)).toEqual(['current'])
      }).pipe(
        Effect.ensuring(Deferred.succeed(release, undefined).pipe(Effect.asVoid)),
        Effect.provide(
          snapshotLayer(
            backing,
            () =>
              Ref.get(marker).pipe(
                Effect.flatMap(current => Ref.update(drains, seen => [...seen, current]))
              ),
            {},
            wrap
          )
        )
      )
    })
  )

  it.effect('does not charge a live owner or a blocked park', () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const increments = yield* Ref.make(0)

      const delayedStore = Layer.effect(
        RunStore,
        Effect.gen(function* () {
          const inner = yield* RunStore

          return RunStore.of({
            ...inner,
            incrementResumeCount: runId =>
              Ref.update(increments, count => count + 1).pipe(
                Effect.andThen(inner.incrementResumeCount(runId))
              )
          })
        })
      ).pipe(Layer.provide(makeInMemoryRunStoreLayer()))

      const layer = makeDriverLayer({
        drain: (runId, _force, _scope, context) =>
          Effect.gen(function* () {
            const inbox = yield* Inbox

            if (runId === 'blocked') {
              yield* inbox.park(runId, ['req_a'], context.drainToken)

              return
            }

            yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(release)
          })
      }).pipe(Layer.provideMerge(delayedStore), Layer.provideMerge(makeInMemoryInboxLayer()))

      yield* Effect.gen(function* () {
        const driver = yield* Driver
        const store = yield* RunStore
        yield* driver.wake('live')
        yield* Deferred.await(started)
        yield* driver.wake('blocked')
        yield* driver.awaitIdle('blocked')
        yield* store.claim('blocked')
        const result = yield* driver.resumeSuspended
        expect(result.resumed).toEqual([])
        expect(result.exhausted).toEqual([])
        expect(yield* Ref.get(increments)).toBe(0)
        expect(yield* store.isClaimed('live')).toBe(true)
        expect(yield* store.isClaimed('blocked')).toBe(true)
        yield* Deferred.succeed(release, undefined)
        yield* driver.awaitIdle('live')
      }).pipe(Effect.provide(layer))
    })
  )

  it.effect('skips a settling owner whose claim release is still in flight', () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const releaseDrain = yield* Deferred.make<void>()
      const releaseEntered = yield* Deferred.make<void>()
      const releaseHold = yield* Deferred.make<void>()
      const increments = yield* Ref.make(0)

      const delayedStore = Layer.effect(
        RunStore,
        Effect.gen(function* () {
          const inner = yield* RunStore

          return RunStore.of({
            ...inner,
            incrementResumeCount: runId =>
              Ref.update(increments, count => count + 1).pipe(
                Effect.andThen(inner.incrementResumeCount(runId))
              ),
            release: runId =>
              Deferred.succeed(releaseEntered, undefined).pipe(
                Effect.andThen(Deferred.await(releaseHold)),
                Effect.andThen(inner.release(runId))
              )
          })
        })
      ).pipe(Layer.provide(makeInMemoryRunStoreLayer()))

      const layer = makeDriverLayer({
        drain: () =>
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(releaseDrain)))
      }).pipe(Layer.provideMerge(delayedStore), Layer.provideMerge(makeInMemoryInboxLayer()))

      yield* Effect.gen(function* () {
        const driver = yield* Driver
        const store = yield* RunStore
        yield* driver.wake('run_1')
        yield* Deferred.await(started)
        yield* Deferred.succeed(releaseDrain, undefined)
        yield* Deferred.await(releaseEntered)
        expect(yield* store.isClaimed('run_1')).toBe(true)
        const result = yield* driver.resumeSuspended
        expect(result.resumed).toEqual([])
        expect(yield* Ref.get(increments)).toBe(0)
        yield* Deferred.succeed(releaseHold, undefined)
        yield* driver.awaitIdle('run_1')
        expect(yield* store.isClaimed('run_1')).toBe(false)
      }).pipe(Effect.provide(layer))
    })
  )

  it.effect('failed increment save leaves the claim recoverable and is not reported resumed', () =>
    Effect.gen(function* () {
      const backing = yield* makeBacking()
      const failure = { phase: 'increment' }

      const storage = {
        ...backing,
        save: (snapshot: DurableRunStoreSnapshot) =>
          snapshot.resumes.some(([, count]) => count > 0)
            ? Effect.die(failure)
            : backing.save(snapshot)
      }

      yield* Effect.gen(function* () {
        const driver = yield* Driver
        const store = yield* RunStore
        yield* store.claim('run_1')
        const exit = yield* driver.resumeSuspended.pipe(Effect.exit)
        expect(exit._tag).toBe('Failure')

        if (exit._tag !== 'Failure') {
          throw new Error('expected increment save defect')
        }

        expect(Cause.findDefect(exit.cause)).toMatchObject({
          _tag: 'Success',
          success: failure
        })
        expect(yield* store.isClaimed('run_1')).toBe(true)
        expect(yield* store.resumeCount('run_1')).toBe(0)
        expect(yield* driver.isActive('run_1')).toBe(false)
        expect(yield* backing.load).toEqual({ claimed: ['run_1'], resumes: [] })
      }).pipe(Effect.provide(snapshotLayer(storage, () => Effect.void)))

      yield* Effect.gen(function* () {
        const store = yield* RunStore
        expect(yield* store.isClaimed('run_1')).toBe(true)
        expect(yield* store.resumeCount('run_1')).toBe(0)
      }).pipe(
        Effect.provide(
          makeDurableObjectDriverLayer({
            ...backing,
            drain: () => Effect.void
          })
        )
      )
    })
  )

  it.effect('failed exhaustion release save is not reported exhausted and stays recoverable', () =>
    Effect.gen(function* () {
      const backing = yield* makeBacking()
      const failure = { phase: 'exhaustion' }

      const storage = {
        ...backing,
        save: (snapshot: DurableRunStoreSnapshot) =>
          snapshot.claimed.length === 0 ? Effect.die(failure) : backing.save(snapshot)
      }

      yield* Effect.gen(function* () {
        const driver = yield* Driver
        const store = yield* RunStore
        yield* store.claim('run_1')
        const exit = yield* driver.resumeSuspended.pipe(Effect.exit)
        expect(exit._tag).toBe('Failure')

        if (exit._tag !== 'Failure') {
          throw new Error('expected exhaustion release save defect')
        }

        expect(Cause.findDefect(exit.cause)).toMatchObject({
          _tag: 'Success',
          success: failure
        })
        expect(yield* store.isClaimed('run_1')).toBe(true)
      }).pipe(Effect.provide(snapshotLayer(storage, () => Effect.void, { maxResumeAttempts: 0 })))
    })
  )

  it.effect('failed claim save preserves the prior claim and does not drain', () =>
    Effect.gen(function* () {
      const initial: DurableRunStoreSnapshot = { claimed: ['run_1'], resumes: [['run_1', 2]] }
      const backing = yield* makeBacking(initial)
      const failure = { phase: 'claim' }
      let saves = 0
      const drains = yield* Ref.make(0)

      const storage = {
        ...backing,
        save: (snapshot: DurableRunStoreSnapshot) =>
          Effect.suspend(() => (++saves === 1 ? Effect.die(failure) : backing.save(snapshot)))
      }

      yield* Effect.gen(function* () {
        const driver = yield* Driver
        const store = yield* RunStore
        const exit = yield* driver.run('run_1').pipe(Effect.exit)
        yield* driver.awaitIdle('run_1')
        expect(exit._tag).toBe('Failure')

        if (exit._tag !== 'Failure') {
          throw new Error('expected claim save defect')
        }

        expect(Cause.findDefect(exit.cause)).toMatchObject({
          _tag: 'Success',
          success: failure
        })
        expect(yield* store.isClaimed('run_1')).toBe(true)
        expect(yield* store.resumeCount('run_1')).toBe(2)
        expect(yield* Ref.get(drains)).toBe(0)
        expect(saves).toBe(1)
        expect(yield* backing.load).toEqual(initial)
      }).pipe(Effect.provide(snapshotLayer(storage, () => Ref.update(drains, count => count + 1))))
    })
  )

  it.effect('failed start does not release a never-acquired claim and keeps a successor wake', () =>
    Effect.gen(function* () {
      const backing = yield* makeBacking()
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const failure = { phase: 'never-acquired' }
      const drains = yield* Ref.make(0)
      let claims = 0

      const storage = {
        ...backing,
        save: (snapshot: DurableRunStoreSnapshot) =>
          Effect.suspend(() => {
            if (snapshot.claimed.includes('run_1') && snapshot.resumes.length === 0) {
              claims += 1

              if (claims === 1) {
                return Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(Effect.die(failure))
                )
              }
            }

            return backing.save(snapshot)
          })
      }

      yield* Effect.gen(function* () {
        const driver = yield* Driver
        const store = yield* RunStore
        const waiter = yield* driver.run('run_1').pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        expect(yield* store.isClaimed('run_1')).toBe(false)
        expect(yield* Ref.get(drains)).toBe(0)
        yield* driver.wake('run_1')
        yield* Deferred.succeed(release, undefined)
        const exit = yield* Fiber.await(waiter)
        expect(exit._tag).toBe('Failure')

        if (exit._tag !== 'Failure') {
          throw new Error('expected never-acquired claim defect')
        }

        expect(Cause.findDefect(exit.cause)).toMatchObject({
          _tag: 'Success',
          success: failure
        })
        yield* driver.awaitIdle('run_1')
        expect(yield* Ref.get(drains)).toBe(1)
        expect(yield* store.isClaimed('run_1')).toBe(false)
      }).pipe(
        Effect.ensuring(Deferred.succeed(release, undefined).pipe(Effect.asVoid)),
        Effect.provide(snapshotLayer(storage, () => Ref.update(drains, count => count + 1)))
      )
    })
  )

  it.effect('failed final-release save reaches run and leaves the durable recovery marker', () =>
    Effect.gen(function* () {
      const backing = yield* makeBacking()
      const failure = { phase: 'final-release' }
      let sawClaim = false

      const storage = {
        ...backing,
        save: (snapshot: DurableRunStoreSnapshot) =>
          Effect.suspend(() => {
            if (snapshot.claimed.includes('run_1')) sawClaim = true

            return sawClaim && snapshot.claimed.length === 0
              ? Effect.die(failure)
              : backing.save(snapshot)
          })
      }

      yield* Effect.gen(function* () {
        const driver = yield* Driver
        const store = yield* RunStore
        const exit = yield* driver.run('run_1').pipe(Effect.exit)
        expect(exit._tag).toBe('Failure')

        if (exit._tag !== 'Failure') {
          throw new Error('expected final-release save defect')
        }

        expect(Cause.findDefect(exit.cause)).toMatchObject({
          _tag: 'Success',
          success: failure
        })
        expect(yield* store.isClaimed('run_1')).toBe(true)
        expect(yield* backing.load).toEqual({ claimed: ['run_1'], resumes: [] })
      }).pipe(Effect.provide(snapshotLayer(storage, () => Effect.void)))

      yield* Effect.gen(function* () {
        const store = yield* RunStore
        expect(yield* store.isClaimed('run_1')).toBe(true)
        expect(yield* store.resumeCount('run_1')).toBe(0)
      }).pipe(
        Effect.provide(
          makeDurableObjectDriverLayer({
            ...backing,
            drain: () => Effect.void
          })
        )
      )
    })
  )

  it.effect('delayed recovery accounting does not deadlock ordinary admit', () =>
    Effect.gen(function* () {
      const backing = yield* makeBacking()
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const drainHold = yield* Deferred.make<void>()
      const drains = yield* Ref.make(0)
      const ready = yield* Ref.make<ReadonlyArray<string>>([])
      let holdOnce = true

      const storage = {
        ...backing,
        save: (snapshot: DurableRunStoreSnapshot) =>
          Effect.suspend(() => {
            if (holdOnce && snapshot.resumes.some(([id, count]) => id === 'run_1' && count === 1)) {
              holdOnce = false

              return Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(backing.save(snapshot))
              )
            }

            return backing.save(snapshot)
          })
      }

      yield* Effect.gen(function* () {
        const driver = yield* Driver
        const inbox = yield* Inbox
        const store = yield* RunStore
        yield* store.claim('run_1')
        const sweep = yield* driver.resumeSuspended.pipe(Effect.forkChild)
        yield* Deferred.await(entered)

        const admitting = yield* driver
          .admit({
            id: 'input_1',
            runId: 'run_1',
            delivery: 'input',
            kind: 'input'
          })
          .pipe(Effect.forkChild)

        yield* Effect.yieldNow
        expect(admitting.pollUnsafe()).toBeUndefined()
        expect(yield* inbox.pending('run_1')).toEqual([])
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(admitting)
        const result = yield* Fiber.join(sweep)
        expect(result.resumed).toEqual(['run_1'])
        yield* Deferred.succeed(drainHold, undefined)
        yield* driver.awaitIdle('run_1')
        expect(yield* Ref.get(ready)).toEqual(['input_1'])
        expect(yield* inbox.pending('run_1')).toEqual([])
        expect(yield* Ref.get(drains)).toBeGreaterThanOrEqual(1)
      }).pipe(
        Effect.ensuring(
          Deferred.succeed(release, undefined).pipe(
            Effect.andThen(Deferred.succeed(drainHold, undefined)),
            Effect.asVoid
          )
        ),
        Effect.provide(
          snapshotLayer(storage, (runId, _force, scope, context) =>
            Effect.gen(function* () {
              yield* Ref.update(drains, count => count + 1)
              yield* Deferred.await(drainHold)
              const inbox = yield* Inbox
              const item = yield* inbox.takePromotable(runId, scope, context.drainToken)

              if (item !== undefined) {
                yield* Ref.update(ready, current => [...current, item.id])
              }
            })
          )
        )
      )
    })
  )

  it.effect('exhaustion vs a live successor does not unclaim a live owner', () =>
    Effect.gen(function* () {
      const backing = yield* makeBacking()
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const started = yield* Deferred.make<void>()
      const holdDrain = yield* Deferred.make<void>()
      const drains = yield* Ref.make(0)
      let holdOnce = true

      const storage = {
        ...backing,
        save: (snapshot: DurableRunStoreSnapshot) =>
          Effect.suspend(() => {
            if (holdOnce && snapshot.claimed.length === 0) {
              holdOnce = false

              return Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(backing.save(snapshot))
              )
            }

            return backing.save(snapshot)
          })
      }

      yield* Effect.gen(function* () {
        const driver = yield* Driver
        const store = yield* RunStore
        yield* store.claim('run_1')
        const sweep = yield* driver.resumeSuspended.pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        const successor = yield* driver.run('run_1').pipe(Effect.forkChild)
        yield* Effect.yieldNow
        expect(yield* driver.isActive('run_1')).toBe(false)
        expect(yield* store.isClaimed('run_1')).toBe(true)
        yield* Deferred.succeed(release, undefined)
        const result = yield* Fiber.join(sweep)
        expect(result.exhausted).toEqual(['run_1'])
        yield* Deferred.await(started)
        expect(yield* driver.isActive('run_1')).toBe(true)
        expect(yield* store.isClaimed('run_1')).toBe(true)
        yield* Deferred.succeed(holdDrain, undefined)
        yield* Fiber.join(successor)
        yield* driver.awaitIdle('run_1')
        expect(yield* Ref.get(drains)).toBe(1)
        expect(yield* store.isClaimed('run_1')).toBe(false)
      }).pipe(
        Effect.ensuring(
          Deferred.succeed(release, undefined).pipe(
            Effect.andThen(Deferred.succeed(holdDrain, undefined)),
            Effect.asVoid
          )
        ),
        Effect.provide(
          snapshotLayer(
            storage,
            () =>
              Ref.update(drains, count => count + 1).pipe(
                Effect.andThen(Deferred.succeed(started, undefined)),
                Effect.andThen(Deferred.await(holdDrain))
              ),
            { maxResumeAttempts: 0 }
          )
        )
      )
    })
  )

  it.effect('delayed claim plus user stop lets only the successor drain', () =>
    Effect.gen(function* () {
      const claimEntered = yield* Deferred.make<void>()
      const claimHold = yield* Deferred.make<void>()
      const drains = yield* Ref.make<ReadonlyArray<string>>([])

      const delayedStore = Layer.effect(
        RunStore,
        Effect.gen(function* () {
          const inner = yield* RunStore
          let first = true

          return RunStore.of({
            ...inner,
            claim: runId =>
              Effect.suspend(() => {
                if (!first) return inner.claim(runId)
                first = false

                return Deferred.succeed(claimEntered, undefined).pipe(
                  Effect.andThen(Deferred.await(claimHold)),
                  Effect.andThen(inner.claim(runId))
                )
              })
          })
        })
      ).pipe(Layer.provide(makeInMemoryRunStoreLayer()))

      const layer = makeDriverLayer({
        drain: runId => Ref.update(drains, current => [...current, runId])
      }).pipe(Layer.provideMerge(delayedStore), Layer.provideMerge(makeInMemoryInboxLayer()))

      yield* Effect.gen(function* () {
        const driver = yield* Driver
        yield* driver.wake('run_1')
        yield* Deferred.await(claimEntered)
        yield* driver.stop('run_1')
        yield* driver.wake('run_1')
        yield* Deferred.succeed(claimHold, undefined)
        yield* driver.awaitIdle('run_1')
        expect(yield* Ref.get(drains)).toEqual(['run_1'])
      }).pipe(Effect.provide(layer))
    })
  )

  it.effect('late beginDrain cannot steal successor input after stop', () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let begins = 0

      const taken: Array<{
        readonly begin: number
        readonly item: string | undefined
        readonly token: string
      }> = []

      const inboxLayer = Layer.effect(
        Inbox,
        Effect.gen(function* () {
          const inner = yield* Inbox

          return Inbox.of({
            ...inner,
            beginDrain: (id, scope) =>
              Effect.suspend(() => {
                begins += 1

                return begins === 1
                  ? Deferred.succeed(entered, undefined).pipe(
                      Effect.andThen(Deferred.await(release)),
                      Effect.andThen(inner.beginDrain(id, scope))
                    )
                  : inner.beginDrain(id, scope)
              })
          })
        })
      ).pipe(Layer.provide(makeInMemoryInboxLayer()))

      const layer = makeDriverLayer({
        drain: (id, _force, scope, ctx) =>
          Effect.gen(function* () {
            const inbox = yield* Inbox
            const item = yield* inbox.takePromotable(id, scope, ctx.drainToken)
            taken.push({ begin: begins, item: item?.id, token: ctx.drainToken })
          })
      }).pipe(Layer.provideMerge(inboxLayer), Layer.provideMerge(makeInMemoryRunStoreLayer()))

      yield* Effect.gen(function* () {
        const driver = yield* Driver
        const inbox = yield* Inbox
        yield* driver.wake('r')
        yield* Deferred.await(entered)
        const stop = yield* driver.stop('r')
        expect(stop._tag).toBe('Interrupted')
        yield* driver.admit({
          id: 'successor',
          runId: 'r',
          delivery: 'input',
          kind: 'input'
        })
        yield* Deferred.succeed(release, undefined)
        yield* driver.awaitIdle('r')
        expect(taken.some(entry => entry.begin === 1 && entry.item === 'successor')).toBe(false)
        expect(taken.filter(entry => entry.item === 'successor')).toHaveLength(1)
        expect(yield* inbox.pending('r')).toEqual([])
        expect(yield* driver.isActive('r')).toBe(false)
      }).pipe(
        Effect.ensuring(Deferred.succeed(release, undefined).pipe(Effect.asVoid)),
        Effect.provide(layer)
      )
    })
  )

  const overlappingLateBegin = async (cancelGeneric: boolean) => {
    const hold = makeRequestHoldScheduler()
    let begins = 0

    const taken: Array<{
      readonly begin: number
      readonly item: string | undefined
      readonly token: string
    }> = []

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()

          const inboxLayer = Layer.effect(
            Inbox,
            Effect.gen(function* () {
              const inner = yield* Inbox

              return Inbox.of({
                ...inner,
                beginDrain: (id, scope) =>
                  Effect.suspend(() => {
                    begins += 1

                    return begins === 1
                      ? Deferred.succeed(entered, undefined).pipe(
                          Effect.andThen(Deferred.await(release)),
                          Effect.andThen(inner.beginDrain(id, scope))
                        )
                      : inner.beginDrain(id, scope)
                  })
              })
            })
          ).pipe(Layer.provide(makeInMemoryInboxLayer()))

          const layer = makeDriverLayer({
            drain: (id, _force, scope, ctx) =>
              Effect.gen(function* () {
                const inbox = yield* Inbox
                const item = yield* inbox.takePromotable(id, scope, ctx.drainToken)
                taken.push({ begin: begins, item: item?.id, token: ctx.drainToken })
              })
          }).pipe(Layer.provideMerge(inboxLayer), Layer.provideMerge(makeInMemoryRunStoreLayer()))

          yield* Effect.gen(function* () {
            const driver = yield* Driver
            const inbox = yield* Inbox
            yield* driver.wake('r')
            yield* Deferred.await(entered)
            hold.arm()

            const generic = yield* driver
              .interrupt('r', { reason: 'shutdown' })
              .pipe(Effect.forkChild({ startImmediately: true }))

            hold.disarm()
            expect(hold.held.length).toBeGreaterThan(0)
            expect(generic.pollUnsafe()).toBeUndefined()

            if (cancelGeneric) yield* Fiber.interrupt(generic)

            const stopFiber = yield* driver
              .stop('r')
              .pipe(Effect.forkChild({ startImmediately: true }))

            expect(stopFiber.pollUnsafe()).toBeUndefined()

            const admitting = yield* driver
              .admit({
                id: 'successor',
                runId: 'r',
                delivery: 'input',
                kind: 'input'
              })
              .pipe(Effect.forkChild)

            yield* Effect.yieldNow
            expect(admitting.pollUnsafe()).toBeUndefined()
            yield* Deferred.succeed(release, undefined)
            yield* Effect.yieldNow
            expect(taken.some(entry => entry.begin === 1 && entry.item === 'successor')).toBe(false)
            expect(stopFiber.pollUnsafe()).toBeUndefined()
            expect(admitting.pollUnsafe()).toBeUndefined()
            hold.releaseHeld()
            const stop = yield* Fiber.join(stopFiber)
            expect(stop._tag).toBe('Interrupted')

            if (!cancelGeneric) expect(yield* Fiber.join(generic)).toBe(true)
            yield* Fiber.join(admitting)
            yield* driver.awaitIdle('r')
            expect(taken.some(entry => entry.begin === 1 && entry.item === 'successor')).toBe(false)
            expect(taken.filter(entry => entry.item === 'successor')).toHaveLength(1)
            expect(yield* inbox.pending('r')).toEqual([])
            expect(yield* driver.isActive('r')).toBe(false)
          }).pipe(
            Effect.ensuring(
              Deferred.succeed(release, undefined).pipe(
                Effect.andThen(Effect.sync(() => hold.releaseHeld())),
                Effect.asVoid
              )
            ),
            Effect.provide(layer)
          )
        })
      ).pipe(Effect.provideService(Scheduler.Scheduler, hold.scheduler))
    )

    expect(exit._tag).toBe('Success')
  }

  it('held generic request then terminal stop keeps admission behind the gate', async () => {
    await overlappingLateBegin(false)
  })

  it('canceled generic joiner still lets terminal stop acknowledge the same request', async () => {
    await overlappingLateBegin(true)
  })

  it.effect(
    'stop captures terminalStop under the inbox gate so a stale idle receipt cannot unclaim a live recovery',
    () =>
      Effect.gen(function* () {
        const backing = yield* makeBacking({ claimed: ['r'], resumes: [] })
        const charging = yield* Deferred.make<void>()
        const releaseCharge = yield* Deferred.make<void>()
        const stopping = yield* Deferred.make<void>()
        const allowInvalidate = yield* Deferred.make<void>()
        const started = yield* Deferred.make<void>()
        const inspect = yield* Deferred.make<void>()
        const inspected = yield* Deferred.make<void>()
        const releaseBody = yield* Deferred.make<void>()
        const hostClaims = yield* Ref.make<ReadonlyArray<boolean>>([])
        let holdOnce = true

        const storage = {
          ...backing,
          save: (snapshot: DurableRunStoreSnapshot) =>
            Effect.suspend(() => {
              if (holdOnce && snapshot.resumes.some(([id, n]) => id === 'r' && n === 1)) {
                holdOnce = false

                return Deferred.succeed(charging, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseCharge)),
                  Effect.andThen(backing.save(snapshot))
                )
              }

              return backing.save(snapshot)
            })
        }

        const wrapInbox = Layer.effect(
          Inbox,
          Effect.gen(function* () {
            const inner = yield* Inbox

            return Inbox.of({
              ...inner,
              invalidate: (id, interrupt, release) =>
                Deferred.succeed(stopping, undefined).pipe(
                  Effect.andThen(Deferred.await(allowInvalidate)),
                  Effect.andThen(inner.invalidate(id, interrupt, release))
                )
            })
          })
        ).pipe(Layer.provide(makeInMemoryInboxLayer()))

        yield* Effect.gen(function* () {
          const driver = yield* Driver
          const store = yield* RunStore
          const sweep = yield* driver.resumeSuspended.pipe(Effect.forkChild)
          yield* Deferred.await(charging)
          const stopFiber = yield* driver.stop('r').pipe(Effect.forkChild)
          yield* Deferred.await(stopping)
          yield* Deferred.succeed(releaseCharge, undefined)
          const recovery = yield* Fiber.join(sweep)
          yield* Deferred.await(started)
          yield* Deferred.succeed(allowInvalidate, undefined)
          const stop = yield* Fiber.join(stopFiber)
          yield* Deferred.succeed(inspect, undefined)
          yield* Deferred.await(inspected)
          const claimedWhileLive = yield* store.isClaimed('r')
          yield* Deferred.succeed(releaseBody, undefined)
          yield* driver.awaitIdle('r')
          expect(recovery.resumed).toEqual(['r'])
          expect(stop._tag).toBe('Interrupted')
          expect(claimedWhileLive).toBe(true)
          expect(yield* Ref.get(hostClaims)).toEqual([true])
        }).pipe(
          Effect.ensuring(
            Effect.all([
              Deferred.succeed(releaseCharge, undefined),
              Deferred.succeed(allowInvalidate, undefined),
              Deferred.succeed(inspect, undefined),
              Deferred.succeed(releaseBody, undefined)
            ]).pipe(Effect.asVoid)
          ),
          Effect.provide(
            makeDriverLayer({
              drain: () =>
                Effect.gen(function* () {
                  const store = yield* RunStore
                  yield* Deferred.succeed(started, undefined)
                  yield* Deferred.await(inspect)
                  const claimed = yield* store.isClaimed('r')
                  yield* Ref.update(hostClaims, current => [...current, claimed])
                  yield* Deferred.succeed(inspected, undefined)
                  yield* Deferred.await(releaseBody)
                }).pipe(Effect.uninterruptible)
            }).pipe(
              Layer.provideMerge(makeSnapshotRunStoreLayer(storage)),
              Layer.provideMerge(wrapInbox)
            )
          )
        )
      })
  )

  it.effect('user stop after failed claim save releases leftover claim and does not recover', () =>
    Effect.gen(function* () {
      const initial: DurableRunStoreSnapshot = { claimed: ['r'], resumes: [['r', 1]] }
      const backing = yield* makeBacking(initial)
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const failure = { phase: 'claim' }
      const drains = yield* Ref.make(0)
      let first = true

      const storage = {
        ...backing,
        save: (snapshot: DurableRunStoreSnapshot) =>
          Effect.suspend(() => {
            if (first) {
              first = false

              return Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(Effect.die(failure))
              )
            }

            return backing.save(snapshot)
          })
      }

      yield* Effect.gen(function* () {
        const driver = yield* Driver
        const store = yield* RunStore
        const running = yield* driver.run('r').pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        const stop = yield* driver.stop('r')
        expect(stop._tag).toBe('Interrupted')
        yield* Deferred.succeed(release, undefined)
        const exit = yield* Fiber.await(running)
        expect(exit._tag).toBe('Failure')

        if (exit._tag !== 'Failure') {
          throw new Error('expected claim save defect')
        }

        expect(Cause.findDefect(exit.cause)).toMatchObject({
          _tag: 'Success',
          success: failure
        })
        yield* driver.awaitIdle('r')
        expect(yield* store.isClaimed('r')).toBe(false)
        expect(yield* store.resumeCount('r')).toBe(0)
        expect(yield* backing.load).toEqual({ claimed: [], resumes: [] })
        expect(yield* Ref.get(drains)).toBe(0)
        const recovered = yield* driver.resumeSuspended
        expect(recovered).toEqual({ resumed: [], exhausted: [] })
        yield* driver.awaitIdle('r')
        expect(yield* Ref.get(drains)).toBe(0)
      }).pipe(
        Effect.ensuring(Deferred.succeed(release, undefined).pipe(Effect.asVoid)),
        Effect.provide(snapshotLayer(storage, () => Ref.update(drains, count => count + 1)))
      )
    })
  )

  it.effect('user stop after failed claim save still runs a successor once', () =>
    Effect.gen(function* () {
      const initial: DurableRunStoreSnapshot = { claimed: ['r'], resumes: [['r', 1]] }
      const backing = yield* makeBacking(initial)
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const failure = { phase: 'claim' }
      const drains = yield* Ref.make(0)
      let first = true

      const storage = {
        ...backing,
        save: (snapshot: DurableRunStoreSnapshot) =>
          Effect.suspend(() => {
            if (first) {
              first = false

              return Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(Effect.die(failure))
              )
            }

            return backing.save(snapshot)
          })
      }

      yield* Effect.gen(function* () {
        const driver = yield* Driver
        const store = yield* RunStore
        const running = yield* driver.run('r').pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        const stop = yield* driver.stop('r')
        expect(stop._tag).toBe('Interrupted')
        yield* driver.wake('r')
        yield* Deferred.succeed(release, undefined)
        const exit = yield* Fiber.await(running)
        expect(exit._tag).toBe('Failure')

        if (exit._tag !== 'Failure') {
          throw new Error('expected claim save defect')
        }

        expect(Cause.findDefect(exit.cause)).toMatchObject({
          _tag: 'Success',
          success: failure
        })
        yield* driver.awaitIdle('r')
        expect(yield* Ref.get(drains)).toBe(1)
        expect(yield* store.isClaimed('r')).toBe(false)
      }).pipe(
        Effect.ensuring(Deferred.succeed(release, undefined).pipe(Effect.asVoid)),
        Effect.provide(snapshotLayer(storage, () => Ref.update(drains, count => count + 1)))
      )
    })
  )

  it.effect('shutdown interrupt after failed claim save preserves the prior claim', () =>
    Effect.gen(function* () {
      const initial: DurableRunStoreSnapshot = { claimed: ['r'], resumes: [['r', 1]] }
      const backing = yield* makeBacking(initial)
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const failure = { phase: 'claim' }
      const drains = yield* Ref.make(0)
      let first = true

      const storage = {
        ...backing,
        save: (snapshot: DurableRunStoreSnapshot) =>
          Effect.suspend(() => {
            if (first) {
              first = false

              return Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(Effect.die(failure))
              )
            }

            return backing.save(snapshot)
          })
      }

      yield* Effect.gen(function* () {
        const driver = yield* Driver
        const store = yield* RunStore
        const running = yield* driver.run('r').pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        yield* driver.interrupt('r', { reason: 'shutdown' })
        yield* Deferred.succeed(release, undefined)
        const exit = yield* Fiber.await(running)
        expect(exit._tag).toBe('Failure')
        yield* driver.awaitIdle('r')
        expect(yield* store.isClaimed('r')).toBe(true)
        expect(yield* store.resumeCount('r')).toBe(1)
        expect(yield* Ref.get(drains)).toBe(0)
      }).pipe(
        Effect.ensuring(Deferred.succeed(release, undefined).pipe(Effect.asVoid)),
        Effect.provide(snapshotLayer(storage, () => Ref.update(drains, count => count + 1)))
      )
    })
  )

  it.effect('shutdown then generic user interrupt keeps the leftover claim', () =>
    Effect.gen(function* () {
      const initial: DurableRunStoreSnapshot = { claimed: ['r'], resumes: [['r', 1]] }
      const backing = yield* makeBacking(initial)
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const failure = { phase: 'claim' }
      const drains = yield* Ref.make(0)
      let first = true

      const storage = {
        ...backing,
        save: (snapshot: DurableRunStoreSnapshot) =>
          Effect.suspend(() => {
            if (first) {
              first = false

              return Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(Effect.die(failure))
              )
            }

            return backing.save(snapshot)
          })
      }

      yield* Effect.gen(function* () {
        const driver = yield* Driver
        const store = yield* RunStore
        const running = yield* driver.run('r').pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        yield* driver.interrupt('r', { reason: 'shutdown' })
        yield* driver.interrupt('r', { reason: 'user' })
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.await(running)
        yield* driver.awaitIdle('r')
        expect(yield* store.isClaimed('r')).toBe(true)
        expect(yield* store.resumeCount('r')).toBe(1)
        expect(yield* Ref.get(drains)).toBe(0)
      }).pipe(
        Effect.ensuring(Deferred.succeed(release, undefined).pipe(Effect.asVoid)),
        Effect.provide(snapshotLayer(storage, () => Ref.update(drains, count => count + 1)))
      )
    })
  )

  it.effect('generic user interrupt after failed claim save releases leftover claim', () =>
    Effect.gen(function* () {
      const initial: DurableRunStoreSnapshot = { claimed: ['r'], resumes: [['r', 1]] }
      const backing = yield* makeBacking(initial)
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const failure = { phase: 'claim' }
      let first = true

      const storage = {
        ...backing,
        save: (snapshot: DurableRunStoreSnapshot) =>
          Effect.suspend(() => {
            if (first) {
              first = false

              return Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(Effect.die(failure))
              )
            }

            return backing.save(snapshot)
          })
      }

      yield* Effect.gen(function* () {
        const driver = yield* Driver
        const store = yield* RunStore
        const running = yield* driver.run('r').pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        yield* driver.interrupt('r')
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.await(running)
        yield* driver.awaitIdle('r')
        expect(yield* store.isClaimed('r')).toBe(false)
        expect(yield* backing.load).toEqual({ claimed: [], resumes: [] })
      }).pipe(
        Effect.ensuring(Deferred.succeed(release, undefined).pipe(Effect.asVoid)),
        Effect.provide(snapshotLayer(storage, () => Effect.void))
      )
    })
  )

  it.effect('failed start plus user stop does not release a never-acquired claim', () =>
    Effect.gen(function* () {
      const backing = yield* makeBacking()
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const failure = { phase: 'never-acquired' }
      const saves = yield* Ref.make(0)

      const storage = {
        ...backing,
        save: (snapshot: DurableRunStoreSnapshot) =>
          Effect.suspend(() => {
            if (snapshot.claimed.includes('run_1')) {
              return Ref.update(saves, count => count + 1).pipe(
                Effect.andThen(Deferred.succeed(entered, undefined)),
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(Effect.die(failure))
              )
            }

            return Ref.update(saves, count => count + 1).pipe(
              Effect.andThen(backing.save(snapshot))
            )
          })
      }

      yield* Effect.gen(function* () {
        const driver = yield* Driver
        const store = yield* RunStore
        const running = yield* driver.run('run_1').pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        yield* driver.stop('run_1')
        yield* Deferred.succeed(release, undefined)
        const exit = yield* Fiber.await(running)
        expect(exit._tag).toBe('Failure')

        if (exit._tag !== 'Failure') {
          throw new Error('expected never-acquired claim defect')
        }

        expect(Cause.findDefect(exit.cause)).toMatchObject({
          _tag: 'Success',
          success: failure
        })
        yield* driver.awaitIdle('run_1')
        expect(yield* store.isClaimed('run_1')).toBe(false)
        expect(yield* Ref.get(saves)).toBe(1)
        expect(yield* backing.load).toBeUndefined()
      }).pipe(
        Effect.ensuring(Deferred.succeed(release, undefined).pipe(Effect.asVoid)),
        Effect.provide(snapshotLayer(storage, () => Effect.void))
      )
    })
  )

  it.effect('held leftover release lets successor admit but not start until release settles', () =>
    Effect.gen(function* () {
      const initial: DurableRunStoreSnapshot = { claimed: ['r'], resumes: [['r', 1]] }
      const backing = yield* makeBacking(initial)
      const claimEntered = yield* Deferred.make<void>()
      const claimHold = yield* Deferred.make<void>()
      const releaseEntered = yield* Deferred.make<void>()
      const releaseHold = yield* Deferred.make<void>()
      const successorStarted = yield* Deferred.make<void>()
      const successorHold = yield* Deferred.make<void>()
      const failure = { phase: 'claim' }
      const drains = yield* Ref.make(0)
      let claimOnce = true

      const storage = {
        ...backing,
        save: (snapshot: DurableRunStoreSnapshot) =>
          Effect.suspend(() => {
            if (claimOnce && snapshot.claimed.includes('r') && snapshot.resumes.length > 0) {
              claimOnce = false

              return Deferred.succeed(claimEntered, undefined).pipe(
                Effect.andThen(Deferred.await(claimHold)),
                Effect.andThen(Effect.die(failure))
              )
            }

            if (snapshot.claimed.length === 0) {
              return Deferred.succeed(releaseEntered, undefined).pipe(
                Effect.andThen(Deferred.await(releaseHold)),
                Effect.andThen(backing.save(snapshot))
              )
            }

            return backing.save(snapshot)
          })
      }

      yield* Effect.gen(function* () {
        const driver = yield* Driver
        const store = yield* RunStore
        const inbox = yield* Inbox
        const running = yield* driver.run('r').pipe(Effect.forkChild)
        yield* Deferred.await(claimEntered)
        const stop = yield* driver.stop('r')
        expect(stop._tag).toBe('Interrupted')
        yield* driver.admit({
          id: 'successor',
          runId: 'r',
          delivery: 'input',
          kind: 'input'
        })
        yield* Deferred.succeed(claimHold, undefined)
        yield* Deferred.await(releaseEntered)
        expect(yield* inbox.pending('r')).toHaveLength(1)
        expect(yield* Deferred.isDone(successorStarted)).toBe(false)
        expect(yield* driver.isActive('r')).toBe(true)
        yield* Deferred.succeed(releaseHold, undefined)
        const exit = yield* Fiber.await(running)
        expect(exit._tag).toBe('Failure')

        if (exit._tag !== 'Failure') {
          throw new Error('expected original claim defect')
        }

        expect(Cause.findDefect(exit.cause)).toMatchObject({
          _tag: 'Success',
          success: failure
        })
        yield* Deferred.await(successorStarted)
        expect(yield* store.isClaimed('r')).toBe(true)
        expect(yield* Ref.get(drains)).toBe(1)
        yield* Deferred.succeed(successorHold, undefined)
        yield* driver.awaitIdle('r')
        expect(yield* inbox.pending('r')).toEqual([])
        expect(yield* store.isClaimed('r')).toBe(false)
      }).pipe(
        Effect.ensuring(
          Deferred.succeed(claimHold, undefined).pipe(
            Effect.andThen(Deferred.succeed(releaseHold, undefined)),
            Effect.andThen(Deferred.succeed(successorHold, undefined)),
            Effect.asVoid
          )
        ),
        Effect.provide(
          snapshotLayer(storage, (runId, _force, scope, context) =>
            Effect.gen(function* () {
              yield* Ref.update(drains, count => count + 1)
              yield* Deferred.succeed(successorStarted, undefined)
              const inbox = yield* Inbox
              yield* inbox.takePromotable(runId, scope, context.drainToken)
              yield* Deferred.await(successorHold)
            })
          )
        )
      )
    })
  )

  it.effect('failed leftover release combines original claim and release defects', () =>
    Effect.gen(function* () {
      const initial: DurableRunStoreSnapshot = { claimed: ['r'], resumes: [['r', 1]] }
      const backing = yield* makeBacking(initial)
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const claimFailure = { phase: 'claim' }
      const releaseFailure = { phase: 'release' }
      const claimInterruptFiberId = 7

      const incomingCause = Cause.combine(
        annotatedDie(claimFailure, 'claim'),
        annotatedInterrupt(claimInterruptFiberId, 'claim-interrupt')
      )

      const releaseCause = annotatedDie(releaseFailure, 'release')
      const drains = yield* Ref.make(0)
      let claimOnce = true

      const storage = {
        ...backing,
        save: (snapshot: DurableRunStoreSnapshot) =>
          Effect.suspend(() => {
            if (claimOnce && snapshot.claimed.includes('r') && snapshot.resumes.length > 0) {
              claimOnce = false

              return Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(Effect.failCause(incomingCause))
              )
            }

            if (snapshot.claimed.length === 0) return Effect.failCause(releaseCause)

            return backing.save(snapshot)
          })
      }

      yield* Effect.gen(function* () {
        const driver = yield* Driver
        const store = yield* RunStore
        const running = yield* driver.run('r').pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        yield* driver.stop('r')
        yield* Deferred.succeed(release, undefined)
        const exit = yield* Fiber.await(running)
        expect(exit._tag).toBe('Failure')

        if (exit._tag !== 'Failure') {
          throw new Error('expected combined claim and release defects')
        }

        expect(Cause.hasFails(exit.cause)).toBe(false)
        expectAnnotatedDie(exit.cause, claimFailure, 'claim')
        expectAnnotatedDie(exit.cause, releaseFailure, 'release')
        expectAnnotatedInterrupt(exit.cause, claimInterruptFiberId, 'claim-interrupt')
        yield* driver.awaitIdle('r')
        expect(yield* Ref.get(drains)).toBe(0)
        expect(yield* store.isClaimed('r')).toBe(true)
        expect(yield* store.resumeCount('r')).toBe(1)
        expect(yield* backing.load).toEqual(initial)
        const recovered = yield* driver.resumeSuspended
        expect(recovered.resumed).toEqual(['r'])
        yield* driver.awaitIdle('r')
      }).pipe(
        Effect.ensuring(Deferred.succeed(release, undefined).pipe(Effect.asVoid)),
        Effect.provide(snapshotLayer(storage, () => Ref.update(drains, count => count + 1)))
      )
    })
  )

  it.effect('acquired host mixed Die/Interrupt plus failed release preserves original causes', () =>
    Effect.gen(function* () {
      const initial: DurableRunStoreSnapshot = { claimed: ['r'], resumes: [['r', 1]] }
      const backing = yield* makeBacking(initial)
      const hostEntered = yield* Deferred.make<void>()
      const allowFail = yield* Deferred.make<void>()
      const hostFailure = { phase: 'host' }
      const releaseFailure = { phase: 'release' }
      const hostInterruptFiberId = 42

      const hostCause = Cause.combine(
        annotatedDie(hostFailure, 'host'),
        annotatedInterrupt(hostInterruptFiberId, 'host-interrupt')
      )

      const releaseCause = annotatedDie(releaseFailure, 'release')
      const hostEntries = yield* Ref.make<ReadonlyArray<boolean>>([])

      const storage = {
        ...backing,
        save: (snapshot: DurableRunStoreSnapshot) =>
          Effect.suspend(() => {
            if (snapshot.claimed.length === 0) return Effect.failCause(releaseCause)

            return backing.save(snapshot)
          })
      }

      yield* Effect.gen(function* () {
        const driver = yield* Driver
        const store = yield* RunStore
        const running = yield* driver.run('r').pipe(Effect.forkChild)
        yield* Deferred.await(hostEntered)
        expect(yield* store.isClaimed('r')).toBe(true)
        expect(yield* Ref.get(hostEntries)).toEqual([true])
        const stop = yield* driver.stop('r')
        expect(stop._tag).toBe('Interrupted')
        yield* Deferred.succeed(allowFail, undefined)
        const exit = yield* Fiber.await(running)
        expect(exit._tag).toBe('Failure')

        if (exit._tag !== 'Failure') {
          throw new Error('expected combined host and release causes')
        }

        expect(Cause.hasFails(exit.cause)).toBe(false)
        expectAnnotatedDie(exit.cause, hostFailure, 'host')
        expectAnnotatedDie(exit.cause, releaseFailure, 'release')
        expectAnnotatedInterrupt(exit.cause, hostInterruptFiberId, 'host-interrupt')
        yield* driver.awaitIdle('r')
        expect(yield* store.isClaimed('r')).toBe(true)
        expect(yield* store.resumeCount('r')).toBe(1)
        expect(yield* backing.load).toEqual(initial)
        const recovered = yield* driver.resumeSuspended
        expect(recovered.resumed).toEqual(['r'])
        yield* driver.awaitIdle('r')
      }).pipe(
        Effect.ensuring(Deferred.succeed(allowFail, undefined).pipe(Effect.asVoid)),
        Effect.provide(
          snapshotLayer(storage, () =>
            Effect.gen(function* () {
              const store = yield* RunStore
              const claimed = yield* store.isClaimed('r')
              yield* Ref.update(hostEntries, current => [...current, claimed])
              yield* Deferred.succeed(hostEntered, undefined)
              yield* Deferred.await(allowFail)

              return yield* Effect.failCause(hostCause)
            }).pipe(Effect.uninterruptible)
          )
        )
      )
    })
  )
})

describe('host-owned waiting checkpoint restoration', () => {
  const weatherTool = ToolDef.make({
    name: 'weather',
    description: 'Get weather.',
    parameters: {},
    approval: ToolApprovalPolicy.make({ mode: 'manual', reason: 'external lookup' })
  })

  const questionTool = ToolDef.make({ name: 'question', description: 'Ask', parameters: {} })
  const weatherCall = ToolCall.make({ id: 'call_1', name: 'weather', params: {} })

  const questionCall = ToolCall.make({
    id: 'call_q',
    name: 'question',
    params: {
      questions: [{ id: 'choice', prompt: 'Pick one', options: [{ id: 'a', label: 'A' }] }]
    }
  })

  const tools = [weatherTool, questionTool]
  const calls = [weatherCall, questionCall]

  it.effect('restores sibling waits and replays a persisted partial without tools', () =>
    Effect.gen(function* () {
      const backing = yield* makeBacking()
      const executed = yield* Ref.make<ReadonlyArray<string>>([])

      const completions = yield* Ref.make<
        ReadonlyArray<{ readonly id: string; readonly content: string; readonly isError: boolean }>
      >([])

      const host = yield* Ref.make<
        | {
            readonly requestIds: ReadonlyArray<string>
            readonly requests: ReadonlyArray<HitlRequest>
            readonly payloads: ReadonlyMap<string, HitlResponse>
            readonly completed: boolean
          }
        | undefined
      >(undefined)

      const loopLayer = Layer.mergeAll(
        Layer.effect(
          ToolExecutor,
          Effect.gen(function* () {
            const inner = yield* ToolExecutor

            return ToolExecutor.of({
              execute: call =>
                Ref.update(executed, current => [...current, call.id]).pipe(
                  Effect.andThen(inner.execute(call))
                )
            })
          })
        ).pipe(Layer.provide(TestToolExecutor.layer({ weather: '72F' }))),
        LoopConfig.defaultLayer
      )

      const makeDrain =
        (life: 'first' | 'second' | 'third'): Drain =>
        (runId, _force, _scope, context) =>
          Effect.gen(function* () {
            const inbox = yield* Inbox
            const checkpoint = yield* Ref.get(host)

            if (checkpoint?.completed === true) return

            if (context.readyResponses.length > 0) {
              const hitlResponses = context.readyResponses.flatMap(item => {
                const payload = checkpoint?.payloads.get(item.itemId)

                return payload === undefined ? [] : [payload]
              })

              const outcome = yield* attemptToolBatch(
                { calls, tools, hitlResponses },
                {
                  onEvent: event => {
                    if (event._tag !== 'ToolExecutionCompleted') return Effect.void

                    return Ref.update(completions, current => [
                      ...current,
                      {
                        id: event.call.id,
                        content: String(event.result.content),
                        isError: event.result.isError === true
                      }
                    ])
                  }
                }
              ).pipe(Effect.provide(loopLayer), Effect.orDie)

              expect(outcome._tag).toBe('Completed')

              if (outcome._tag !== 'Completed') {
                throw new Error(`unexpected ready outcome: ${outcome._tag}`)
              }

              yield* Ref.update(host, current =>
                current === undefined ? current : { ...current, completed: true }
              )

              return
            }

            if (life !== 'first' && checkpoint !== undefined) {
              yield* inbox.park(runId, checkpoint.requestIds, context.drainToken)

              return
            }

            const outcome = yield* attemptToolBatch({ calls, tools }).pipe(
              Effect.provide(loopLayer),
              Effect.orDie
            )

            expect(outcome._tag).toBe('AwaitingInput')

            if (outcome._tag !== 'AwaitingInput') {
              throw new Error(`unexpected park outcome: ${outcome._tag}`)
            }

            const parked = yield* inbox.park(
              runId,
              outcome.requests.map(request => request.requestId),
              context.drainToken
            )

            expect(parked._tag).toBe('Parked')

            if (parked._tag !== 'Parked') {
              throw new Error(`unexpected pause decision: ${parked._tag}`)
            }

            yield* Ref.set(host, {
              requestIds: outcome.requests.map(request => request.requestId),
              requests: outcome.requests,
              payloads: new Map(),
              completed: false
            })
          })

      yield* Effect.scoped(
        Effect.gen(function* () {
          const driver = yield* Driver
          const inbox = yield* Inbox
          const store = yield* RunStore
          yield* driver.wake('run_1')
          yield* driver.awaitIdle('run_1')
          expect(yield* store.isClaimed('run_1')).toBe(false)
          const parked = yield* inbox.parked('run_1')
          expect(parked).toBeDefined()

          if (parked === undefined) {
            throw new Error('expected first-lifetime park')
          }

          const checkpoint = yield* Ref.get(host)
          expect(checkpoint).toBeDefined()

          if (checkpoint === undefined) {
            throw new Error('expected host checkpoint after first park')
          }

          const approval = checkpoint.requests.find(
            request => request._tag === 'ToolApprovalRequest'
          )

          expect(approval?._tag).toBe('ToolApprovalRequest')

          if (approval?._tag !== 'ToolApprovalRequest') {
            throw new Error(`unexpected request tag: ${approval?._tag}`)
          }

          const approvalResponse = ToolApprovalResponse.make({
            requestId: approval.requestId,
            toolCallId: approval.toolCallId,
            decision: 'approved',
            source: 'user'
          })

          const accepted = yield* resumeHitlIfMatched({
            pending: checkpoint.requests,
            response: approvalResponse,
            resume: requestId =>
              driver.resumeHitl('run_1', {
                itemId: 'item_a',
                requestId,
                generation: parked.generation
              })
          })

          expect(accepted._tag).toBe('Accepted')
          yield* driver.awaitIdle('run_1')
          yield* Ref.update(host, current =>
            current === undefined
              ? current
              : {
                  ...current,
                  payloads: new Map(current.payloads).set('item_a', approvalResponse)
                }
          )
          expect(yield* Ref.get(executed)).toEqual([])
          expect(yield* store.isClaimed('run_1')).toBe(false)
        }).pipe(
          Effect.provide(
            makeDurableObjectDriverLayer({
              ...backing,
              drain: makeDrain('first')
            })
          )
        )
      )

      yield* Effect.gen(function* () {
        const driver = yield* Driver
        const inbox = yield* Inbox
        const store = yield* RunStore
        const checkpoint = yield* Ref.get(host)
        expect(checkpoint).toBeDefined()

        if (checkpoint === undefined) {
          throw new Error('expected host checkpoint after first lifetime')
        }

        expect(yield* store.isClaimed('run_1')).toBe(false)
        expect(yield* inbox.parked('run_1')).toBeUndefined()
        const sweep = yield* driver.resumeSuspended
        expect(sweep.resumed).toEqual([])
        yield* driver.run('run_1')
        yield* driver.awaitIdle('run_1')
        const parked = yield* inbox.parked('run_1')
        expect(parked).toBeDefined()

        if (parked === undefined) {
          throw new Error('expected restored park')
        }

        expect(yield* Ref.get(executed)).toEqual([])
        const approval = checkpoint.requests.find(request => request._tag === 'ToolApprovalRequest')
        const question = checkpoint.requests.find(request => request._tag === 'QuestionRequest')
        expect(approval?._tag).toBe('ToolApprovalRequest')
        expect(question?._tag).toBe('QuestionRequest')

        if (approval?._tag !== 'ToolApprovalRequest' || question?._tag !== 'QuestionRequest') {
          throw new Error('expected sibling approval and question requests')
        }

        const persisted = checkpoint.payloads.get('item_a')
        expect(persisted?._tag).toBe('ToolApprovalResponse')

        if (persisted?._tag !== 'ToolApprovalResponse') {
          throw new Error(`unexpected persisted payload: ${persisted?._tag}`)
        }

        expect(matchHitlResponse(checkpoint.requests, persisted)).toEqual({
          _tag: 'Match',
          requestId: approval.requestId
        })

        const replayed = yield* resumeHitlIfMatched({
          pending: checkpoint.requests,
          response: persisted,
          resume: requestId =>
            driver.resumeHitl('run_1', {
              itemId: 'item_a',
              requestId,
              generation: parked.generation
            })
        })

        expect(replayed._tag).toBe('Accepted')
        yield* driver.awaitIdle('run_1')
        expect(yield* Ref.get(executed)).toEqual([])
        expect(yield* inbox.parked('run_1')).toBeDefined()

        const mismatchedResponse = ToolApprovalResponse.make({
          requestId: 'missing',
          toolCallId: approval.toolCallId,
          decision: 'approved',
          source: 'user'
        })

        expect(matchHitlResponse(checkpoint.requests, mismatchedResponse)).toEqual({
          _tag: 'Mismatch'
        })

        const mismatch = yield* resumeHitlIfMatched({
          pending: checkpoint.requests,
          response: mismatchedResponse,
          resume: requestId =>
            driver.resumeHitl('run_1', {
              itemId: 'item_bad',
              requestId,
              generation: parked.generation
            })
        })

        expect(mismatch._tag).toBe('Mismatch')
        yield* driver.awaitIdle('run_1')
        expect(yield* Ref.get(executed)).toEqual([])

        const questionResponse = QuestionResponse.make({
          requestId: question.requestId,
          toolCallId: question.toolCallId,
          outcome: 'answered',
          source: 'user',
          answers: [QuestionAnswer.make({ questionId: 'choice', optionIds: ['a'] })]
        })

        yield* Ref.update(host, current =>
          current === undefined
            ? current
            : {
                ...current,
                payloads: new Map(current.payloads).set('item_q', questionResponse)
              }
        )

        const ready = yield* resumeHitlIfMatched({
          pending: checkpoint.requests,
          response: questionResponse,
          resume: requestId =>
            driver.resumeHitl('run_1', {
              itemId: 'item_q',
              requestId,
              generation: parked.generation
            })
        })

        expect(ready._tag).toBe('Ready')
        yield* driver.awaitIdle('run_1')
        expect(yield* Ref.get(executed)).toEqual(['call_1'])
        const completed = yield* Ref.get(completions)
        expect(completed.map(item => item.id).sort()).toEqual(['call_1', 'call_q'])
        const weather = completed.find(item => item.id === 'call_1')
        const answered = completed.find(item => item.id === 'call_q')
        expect(weather?.isError).toBe(false)
        expect(weather?.content).toBe('72F')
        expect(answered?.isError).toBe(false)
        expect(answered?.content.includes('A')).toBe(true)
        expect(yield* inbox.parked('run_1')).toBeUndefined()
      }).pipe(
        Effect.provide(
          makeDurableObjectDriverLayer({
            ...backing,
            drain: makeDrain('second')
          })
        )
      )

      yield* Effect.gen(function* () {
        const driver = yield* Driver
        const inbox = yield* Inbox
        const checkpoint = yield* Ref.get(host)
        expect(checkpoint?.completed).toBe(true)
        const before = yield* Ref.get(executed)
        yield* driver.run('run_1')
        yield* driver.awaitIdle('run_1')
        expect(yield* inbox.parked('run_1')).toBeUndefined()
        expect(yield* Ref.get(executed)).toEqual(before)
        expect(yield* Ref.get(completions)).toHaveLength(2)
      }).pipe(
        Effect.provide(
          makeDurableObjectDriverLayer({
            ...backing,
            drain: makeDrain('third')
          })
        )
      )
    })
  )
})
