import { Cause, Context, Data, Deferred, Effect, Exit, Fiber, Predicate } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { makeCoordinator, type CapturedRun } from '../src/coordinator.ts'
import { StopReceipt } from '../src/outcome-constructors-internal.ts'

class DrainFail extends Data.TaggedError('DrainFail')<{
  readonly code: string
}> {}

class FanoutAnnotation extends Context.Service<FanoutAnnotation, string>()('FanoutAnnotation') {}

const typedFail = new DrainFail({ code: 'typed' })

const dieDefect = { code: 'defect' }

const expectEffect = <A, E = never, R = never>(_effect: Effect.Effect<A, E, R>) => undefined

const requireJoined = <E>(captured: CapturedRun<E>) => {
  if (!Predicate.isTagged(captured, 'Joined')) {
    throw new Error(`Expected Joined captureRun, got ${captured._tag}`)
  }

  return captured
}

const requireFailReason = <E>(cause: Cause.Cause<E>, label: string) => {
  const found = cause.reasons.find(Cause.isFailReason)

  if (found === undefined) {
    throw new Error(`Expected Fail reason for ${label}`)
  }

  return found
}

const requireDieReason = <E>(cause: Cause.Cause<E>, label: string) => {
  const found = cause.reasons.find(Cause.isDieReason)

  if (found === undefined) {
    throw new Error(`Expected Die reason for ${label}`)
  }

  return found
}

const requireInterruptReason = <E>(cause: Cause.Cause<E>, fiberId: number, label: string) => {
  const found = cause.reasons
    .filter(Cause.isInterruptReason)
    .find(reason => reason.fiberId === fiberId)

  if (found === undefined) {
    throw new Error(`Expected Interrupt reason fiberId ${fiberId} for ${label}`)
  }

  return found
}

const inspectReceivedExits = (
  name: string,
  received: ReadonlyArray<Exit.Exit<void, DrainFail>>,
  expected: Exit.Exit<void, DrainFail>
) => {
  if (received.length === 0) {
    throw new Error(`Expected received exits for ${name}`)
  }

  for (const exit of received) {
    expect(exit).toEqual(expected)

    if (name === 'typed failure') {
      if (!Exit.isFailure(exit)) {
        throw new Error('Expected typed failure exit')
      }

      expect(requireFailReason(exit.cause, name).error).toBe(typedFail)
    }

    if (name === 'die') {
      if (!Exit.isFailure(exit)) {
        throw new Error('Expected die exit')
      }

      expect(requireDieReason(exit.cause, name).defect).toBe(dieDefect)
    }

    if (name === 'interrupt') {
      if (!Exit.isFailure(exit)) {
        throw new Error('Expected interrupt exit')
      }

      const interrupt = requireInterruptReason(exit.cause, 123, name)
      expect(interrupt.fiberId).toBe(123)
      expect(Context.getOrUndefined(Cause.reasonAnnotations(interrupt), FanoutAnnotation)).toBe(
        'int-a'
      )
    }

    if (name === 'mixed annotated interrupt') {
      if (!Exit.isFailure(exit)) {
        throw new Error('Expected mixed failure exit')
      }

      expect(requireFailReason(exit.cause, name).error).toBe(typedFail)
      expect(requireDieReason(exit.cause, name).defect).toBe(dieDefect)
      const interrupt = requireInterruptReason(exit.cause, 456, name)
      expect(interrupt.fiberId).toBe(456)
      expect(Context.getOrUndefined(Cause.reasonAnnotations(interrupt), FanoutAnnotation)).toBe(
        'int-b'
      )
    }
  }
}

const settleCases: ReadonlyArray<{
  readonly name: string
  readonly finish: Effect.Effect<void, DrainFail>
}> = [
  { name: 'success', finish: Effect.void },
  { name: 'typed failure', finish: Effect.fail(typedFail) },
  { name: 'die', finish: Effect.die(dieDefect) },
  {
    name: 'interrupt',
    finish: Effect.failCause(
      Cause.annotate(Cause.interrupt(123), Context.make(FanoutAnnotation, 'int-a'))
    )
  },
  {
    name: 'mixed annotated interrupt',
    finish: Effect.failCause(
      Cause.combine(
        Cause.combine(Cause.fail(typedFail), Cause.die(dieDefect)),
        Cause.annotate(Cause.interrupt(456), Context.make(FanoutAnnotation, 'int-b'))
      )
    )
  }
]

describe('coordinator settlement fanout', () => {
  it.effect(
    'fans exact exits to remaining waiters and does not let a canceled observer consume them',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          for (const settleCase of settleCases) {
            const entered = yield* Deferred.make<void>()
            const hold = yield* Deferred.make<void>()

            const coordinator = yield* makeCoordinator<string, DrainFail>({
              drain: () =>
                Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(hold)),
                  Effect.andThen(settleCase.finish)
                )
            })

            expectEffect<void, DrainFail>(coordinator.run('run_1'))
            expectEffect<void>(coordinator.awaitIdle('run_1'))
            yield* Effect.gen(function* () {
              const first = yield* coordinator.run('run_1').pipe(Effect.exit, Effect.forkChild)
              yield* Deferred.await(entered)

              const second = yield* coordinator
                .run('run_1')
                .pipe(Effect.exit, Effect.forkChild({ startImmediately: true }))

              const captured = requireJoined(yield* coordinator.captureRun('run_1'))
              expectEffect<void, DrainFail>(captured.join)

              const third = yield* captured.join.pipe(
                Effect.exit,
                Effect.forkChild({ startImmediately: true })
              )

              const cancelled = yield* coordinator
                .run('run_1')
                .pipe(Effect.forkChild({ startImmediately: true }))

              const idle = yield* coordinator
                .awaitIdle('run_1')
                .pipe(Effect.forkChild({ startImmediately: true }))

              yield* Fiber.interrupt(cancelled)
              yield* Deferred.succeed(hold, undefined)
              const expected = yield* settleCase.finish.pipe(Effect.exit)

              const received = [
                yield* Fiber.join(first),
                yield* Fiber.join(second),
                yield* Fiber.join(third)
              ]

              inspectReceivedExits(settleCase.name, received, expected)
              const cancelledExit = yield* Fiber.await(cancelled)
              expect(
                Exit.isFailure(cancelledExit) && Cause.hasInterruptsOnly(cancelledExit.cause)
              ).toBe(true)
              yield* Fiber.join(idle)
              expect(yield* coordinator.isActive('run_1')).toBe(false)
            }).pipe(Effect.ensuring(Deferred.done(hold, Exit.void).pipe(Effect.asVoid)))
          }
        })
      )
  )

  it.effect(
    'acknowledges interrupt before held settlement and still fans waiters after release',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>()
          const settling = yield* Deferred.make<void>()
          const hold = yield* Deferred.make<void>()

          const coordinator = yield* makeCoordinator<string, never, string>({
            drain: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
            settled: (_key, _exit, reason) =>
              Effect.gen(function* () {
                expect(reason).toBe('user')
                yield* Deferred.succeed(settling, undefined)
                yield* Deferred.await(hold)
              })
          })

          expectEffect<void>(coordinator.run('run_1'))
          expectEffect<boolean>(coordinator.interrupt('run_1', 'user'))
          expectEffect<boolean>(coordinator.interrupt('run_1', 'user', { awaitSettlement: true }))
          expectEffect<void>(coordinator.awaitIdle('run_1'))
          yield* Effect.gen(function* () {
            const owner = yield* coordinator.run('run_1').pipe(Effect.exit, Effect.forkChild)
            yield* Deferred.await(entered)
            expect(yield* coordinator.interrupt('run_1', 'user')).toBe(true)
            yield* Deferred.await(settling)
            expect(yield* coordinator.isActive('run_1')).toBe(true)
            expect(owner.pollUnsafe()).toBeUndefined()
            expect(yield* coordinator.terminalStop('run_1', 'user')).toEqual(StopReceipt.Settling())

            const waiter1 = yield* coordinator
              .interrupt('run_1', 'user', { awaitSettlement: true })
              .pipe(Effect.forkChild({ startImmediately: true }))

            const waiter2 = yield* coordinator
              .awaitIdle('run_1')
              .pipe(Effect.forkChild({ startImmediately: true }))

            expect(waiter1.pollUnsafe()).toBeUndefined()
            expect(waiter2.pollUnsafe()).toBeUndefined()
            yield* Deferred.succeed(hold, undefined)
            const ownerExit = yield* Fiber.join(owner)
            expect(Exit.isFailure(ownerExit) && Cause.hasInterruptsOnly(ownerExit.cause)).toBe(true)
            expect(yield* Fiber.join(waiter1)).toBe(false)
            yield* Fiber.join(waiter2)
            expect(yield* coordinator.isActive('run_1')).toBe(false)
          }).pipe(Effect.ensuring(Deferred.done(hold, Exit.void).pipe(Effect.asVoid)))
        })
      )
  )
})
