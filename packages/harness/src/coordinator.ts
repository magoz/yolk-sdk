/**
 * Process-local run coordinator.
 *
 * Port of OpenCode v2 `SessionRunCoordinator` (MIT): one busy period per key,
 * a doorbell that coalesces wakes, and interrupt that claims pending wakes so a
 * dead intent cannot restart. Steering lands at the next drain boundary.
 *
 * @see https://github.com/sst/opencode (packages/core/src/session/run-coordinator.ts)
 */
import { Cause, Context, Deferred, Effect, Exit, Fiber, FiberSet, Layer } from 'effect'
import type { Scope } from 'effect'
import { RunStore } from './store.ts'

// Private settlement receipt: succeed the Deferred with Exit as a value so
// interrupt fan-out does not skip Effect 4.0.0-beta.80 Deferred listeners.
// Public waiters flatten that Exit; this is not a global Deferred fix.
const awaitDone = <E>(done: Deferred.Deferred<Exit.Exit<void, E>>): Effect.Effect<void, E> =>
  Deferred.await(done).pipe(Effect.flatMap(exit => exit))

/** `"input"` subsumes `"steer"` when coalescing wakes. */
export type Promotable = 'input' | 'steer'

/** Shutdown retains the claim; explicit user stop releases it after settlement. */
export type InterruptReason = 'user' | 'shutdown'

export type CapturedRun<E> =
  | { readonly _tag: 'Started'; readonly join: Effect.Effect<void, E> }
  | { readonly _tag: 'Joined'; readonly join: Effect.Effect<void, E> }
  | { readonly _tag: 'Stopping'; readonly awaitSettlement: Effect.Effect<void> }

export type StopReceipt =
  | { readonly _tag: 'Idle' }
  | { readonly _tag: 'Interrupted' }
  | { readonly _tag: 'LiveStopping' }
  | { readonly _tag: 'Settling' }

export type Coordinator<Key, E, Reason = never> = {
  readonly active: Effect.Effect<ReadonlySet<Key>>
  readonly isActive: (key: Key) => Effect.Effect<boolean>
  /** Starts an execution while idle, or joins the active execution. */
  readonly run: (key: Key) => Effect.Effect<void, E>
  /**
   * Captures a run waiter without awaiting settlement.
   * Idle starts force=true (`Started`); an active owner is joined (`Joined`),
   * including during natural settlement. A stopping owner yields `Stopping` with a
   * settlement waiter and no start.
   */
  readonly captureRun: (key: Key) => Effect.Effect<CapturedRun<E>>
  /** Rings the doorbell: idle starts; active drains again before settling. */
  readonly wake: (key: Key, scope?: Promotable) => Effect.Effect<void>
  /**
   * Stops the active execution and clears its doorbell. No-op when idle.
   * Resolves once the interruption request is delivered, not when cleanup settles.
   * First accepted `reason` is kept; use `terminalStop` to escalate.
   */
  readonly interrupt: (
    key: Key,
    reason?: Reason,
    options?: { readonly awaitSettlement?: boolean }
  ) => Effect.Effect<boolean>
  /**
   * Terminal stop receipt. Always clears pendingWake. Settling means the owner
   * is already gone and the settled callback is chosen; Driver may release the
   * claim under the Inbox gate. LiveStopping/Interrupted leave release to that
   * owner's future settled callback. LiveStopping joins the same outstanding
   * interruption request rather than forking a second one.
   */
  readonly terminalStop: (key: Key, reason: Reason) => Effect.Effect<StopReceipt>
  /** Resolves once no execution is active. Never starts work. */
  readonly awaitIdle: (key: Key) => Effect.Effect<void>
}

type Execution<E, Reason> = {
  readonly done: Deferred.Deferred<Exit.Exit<void, E>>
  owner?: Fiber.Fiber<void>
  request?: Fiber.Fiber<void>
  scope: Promotable
  pendingWake?: Promotable
  stopping: boolean
  interruptionReason?: Reason
}

const widerScope = (current: Promotable | undefined, next: Promotable): Promotable =>
  current === 'input' || next === 'input' ? 'input' : 'steer'

export const makeCoordinator = <Key, E, Reason = never>(options: {
  readonly drain: (key: Key, force: boolean, scope: Promotable) => Effect.Effect<void, E>
  readonly started?: (key: Key) => Effect.Effect<void>
  readonly settled?: (key: Key, exit: Exit.Exit<void, E>, reason?: Reason) => Effect.Effect<void>
}): Effect.Effect<Coordinator<Key, E, Reason>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const executions = new Map<Key, Execution<E, Reason>>()
    const fork = yield* FiberSet.makeRuntime<never, void, never>()

    const loop = (
      key: Key,
      execution: Execution<E, Reason>,
      force: boolean
    ): Effect.Effect<void, E> =>
      Effect.suspend(() => {
        if (execution.stopping) return Effect.void

        return options.drain(key, force, execution.scope)
      }).pipe(
        Effect.andThen(
          Effect.suspend(() => {
            if (execution.stopping || execution.pendingWake === undefined) return Effect.void
            execution.scope = execution.pendingWake
            execution.pendingWake = undefined

            return Effect.yieldNow.pipe(Effect.andThen(loop(key, execution, false)))
          })
        )
      )

    const settle = (key: Key, execution: Execution<E, Reason>, exit: Exit.Exit<void, E>) => {
      if (execution.pendingWake !== undefined) start(key, false, execution.pendingWake)
      else executions.delete(key)

      return Deferred.succeed(execution.done, exit).pipe(Effect.asVoid)
    }

    const start = (key: Key, force: boolean, scope: Promotable) => {
      const execution: Execution<E, Reason> = {
        done: Deferred.makeUnsafe<Exit.Exit<void, E>>(),
        scope,
        stopping: false
      }

      executions.set(key, execution)
      execution.owner = fork(
        Effect.yieldNow.pipe(
          Effect.andThen(
            Effect.uninterruptible(Effect.suspend(() => options.started?.(key) ?? Effect.void))
          ),
          Effect.andThen(loop(key, execution, force)),
          Effect.onExit(exit =>
            Effect.suspend(() => {
              execution.owner = undefined

              return options.settled?.(key, exit, execution.interruptionReason) ?? Effect.void
            })
          ),
          Effect.onExit(exit => settle(key, execution, exit)),
          Effect.exit,
          Effect.asVoid
        )
      )

      return execution
    }

    const forkInterruptionRequest = (owner: Fiber.Fiber<void>): Fiber.Fiber<void> =>
      fork(Effect.yieldNow.pipe(Effect.andThen(Effect.sync(() => owner.interruptUnsafe()))))

    const interruptNow = (key: Key, reason?: Reason): Effect.Effect<boolean> =>
      Effect.suspend(() => {
        const execution = executions.get(key)

        if (execution === undefined || execution.stopping) return Effect.succeed(false)

        if (execution.owner === undefined) {
          execution.pendingWake = undefined

          return Effect.succeed(false)
        }

        const owner = execution.owner
        execution.stopping = true
        execution.pendingWake = undefined
        execution.interruptionReason = reason
        // Capture the exact old owner and fork the request in this same lazy
        // transition so cancellation cannot leave stopping=true with no request.
        // Initial yield breaks owner -> resumed caller -> owner reentrancy.
        // Join the request fiber only; interruptUnsafe may run interruptible
        // finalizers inline until they suspend. Do not await owner settlement.
        const request = forkInterruptionRequest(owner)
        execution.request = request

        return Fiber.join(request).pipe(Effect.as(true))
      })

    const awaitIdle = (key: Key): Effect.Effect<void> =>
      Effect.suspend(() => {
        const execution = executions.get(key)

        if (execution === undefined) return Effect.void

        return awaitDone(execution.done).pipe(Effect.ignoreCause, Effect.andThen(awaitIdle(key)))
      })

    return {
      active: Effect.sync(() => new Set(executions.keys())),
      isActive: key => Effect.sync(() => executions.has(key)),
      run: key =>
        Effect.suspend(() => {
          const execution = executions.get(key)

          if (execution === undefined) return awaitDone(start(key, true, 'input').done)

          if (!execution.stopping) return awaitDone(execution.done)

          return awaitDone(execution.done).pipe(
            Effect.ignoreCause,
            Effect.andThen(
              Effect.suspend(() => {
                const next = executions.get(key)

                return next === undefined
                  ? awaitDone(start(key, true, 'input').done)
                  : awaitDone(next.done)
              })
            )
          )
        }),
      captureRun: key =>
        Effect.sync(() => {
          const execution = executions.get(key)

          if (execution === undefined) {
            const started = start(key, true, 'input')

            return { _tag: 'Started' as const, join: awaitDone(started.done) }
          }

          if (!execution.stopping) {
            return { _tag: 'Joined' as const, join: awaitDone(execution.done) }
          }

          return {
            _tag: 'Stopping' as const,
            awaitSettlement: awaitDone(execution.done).pipe(Effect.ignoreCause)
          }
        }),
      wake: (key, scope = 'input') =>
        Effect.sync(() => {
          const execution = executions.get(key)

          if (execution !== undefined) {
            execution.pendingWake = widerScope(execution.pendingWake, scope)

            return
          }

          start(key, false, scope)
        }),
      interrupt: (key, reason, options) =>
        Effect.suspend(() => {
          const execution = executions.get(key)

          return interruptNow(key, reason).pipe(
            Effect.tap(() =>
              options?.awaitSettlement === true && execution !== undefined
                ? awaitDone(execution.done).pipe(Effect.ignoreCause)
                : Effect.void
            )
          )
        }),
      terminalStop: (key, reason) =>
        Effect.suspend((): Effect.Effect<StopReceipt> => {
          const execution = executions.get(key)

          if (execution === undefined) return Effect.succeed({ _tag: 'Idle' } as const)
          execution.pendingWake = undefined

          if (execution.owner === undefined) {
            execution.stopping = true

            return Effect.succeed({ _tag: 'Settling' } as const)
          }

          execution.interruptionReason = reason

          if (execution.stopping) {
            const request = execution.request

            return request === undefined
              ? Effect.succeed({ _tag: 'LiveStopping' } as const)
              : Fiber.join(request).pipe(Effect.as({ _tag: 'LiveStopping' } as const))
          }

          const owner = execution.owner
          execution.stopping = true
          const request = forkInterruptionRequest(owner)
          execution.request = request

          return Fiber.join(request).pipe(Effect.as({ _tag: 'Interrupted' } as const))
        }),
      awaitIdle
    }
  })

/** Owning coordinator layer, with per-acquisition claim receipts and settlement policy. */
export class RunCoordinator extends Context.Service<
  RunCoordinator,
  Coordinator<string, never, InterruptReason>
>()('@yolk-sdk/harness/RunCoordinator') {
  static layer = (options?: {
    readonly drain?: (runId: string, force: boolean, scope: Promotable) => Effect.Effect<void>
  }): Layer.Layer<RunCoordinator, never, RunStore> =>
    Layer.effect(
      this,
      Effect.gen(function* () {
        const store = yield* RunStore
        const drain = options?.drain ?? ((_runId, _force, _scope) => Effect.void)
        const acquired = new Set<string>()

        return yield* makeCoordinator<string, never, InterruptReason>({
          drain,
          started: runId =>
            store.claim(runId).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  acquired.add(runId)
                })
              )
            ),
          settled: (runId, exit, reason) =>
            Effect.suspend(() => {
              const owned = acquired.delete(runId)

              if (
                owned &&
                (reason === 'user' || (reason === undefined && !Exit.hasInterrupts(exit)))
              ) {
                return store.release(runId)
              }

              // Acquisition receipt guards automatic failed-start settlement only.
              // Explicit user-terminal authority still releases a leftover claim
              // after this owner has actually settled, matching Idle/Settling stop.
              if (reason === 'user' && !owned) {
                return store
                  .isClaimed(runId)
                  .pipe(Effect.flatMap(claimed => (claimed ? store.release(runId) : Effect.void)))
              }

              return Effect.void
            }).pipe(
              Effect.exit,
              Effect.flatMap(settledExit => {
                if (Exit.isSuccess(settledExit)) return Effect.void

                return Effect.failCause(
                  Exit.isFailure(exit)
                    ? Cause.combine(exit.cause, settledExit.cause)
                    : settledExit.cause
                )
              })
            )
        })
      })
    )
}
