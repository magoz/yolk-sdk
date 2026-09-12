/**
 * Process-local run coordinator.
 *
 * Port of OpenCode v2 `SessionRunCoordinator` (MIT): one busy period per key,
 * a doorbell that coalesces wakes, and interrupt that claims pending wakes so a
 * dead intent cannot restart. Steering lands at the next drain boundary.
 *
 * @see https://github.com/sst/opencode (packages/core/src/session/run-coordinator.ts)
 */
import { Deferred, Effect, Fiber, FiberSet } from 'effect'
import type { Exit, Scope } from 'effect'

/** `"input"` subsumes `"steer"` when coalescing wakes. */
export type Promotable = 'input' | 'steer'

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
   * Resolves once interruption is accepted, not when cleanup settles.
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
   * owner's future settled callback.
   */
  readonly terminalStop: (key: Key, reason: Reason) => Effect.Effect<StopReceipt>
  /** Resolves once no execution is active. Never starts work. */
  readonly awaitIdle: (key: Key) => Effect.Effect<void>
}

type Execution<E, Reason> = {
  readonly done: Deferred.Deferred<void, E>
  owner?: Fiber.Fiber<void>
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
      Effect.suspend(() => options.drain(key, force, execution.scope)).pipe(
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
      return Deferred.done(execution.done, exit).pipe(Effect.asVoid)
    }

    const start = (key: Key, force: boolean, scope: Promotable) => {
      const execution: Execution<E, Reason> = {
        done: Deferred.makeUnsafe<void, E>(),
        scope,
        stopping: false
      }
      executions.set(key, execution)
      execution.owner = fork(
        Effect.yieldNow.pipe(
          Effect.andThen(Effect.uninterruptible(options.started?.(key) ?? Effect.void)),
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

    const interruptNow = (key: Key, reason?: Reason): Effect.Effect<boolean> =>
      Effect.sync(() => {
        const execution = executions.get(key)
        if (execution === undefined || execution.stopping) return false
        if (execution.owner === undefined) {
          execution.pendingWake = undefined
          return false
        }
        execution.stopping = true
        execution.pendingWake = undefined
        execution.interruptionReason = reason
        fork(Fiber.interrupt(execution.owner))
        return true
      })

    const awaitIdle = (key: Key): Effect.Effect<void> =>
      Effect.suspend(() => {
        const execution = executions.get(key)
        if (execution === undefined) return Effect.void
        return Deferred.await(execution.done).pipe(
          Effect.ignoreCause,
          Effect.andThen(awaitIdle(key))
        )
      })

    return {
      active: Effect.sync(() => new Set(executions.keys())),
      isActive: key => Effect.sync(() => executions.has(key)),
      run: key =>
        Effect.suspend(() => {
          const execution = executions.get(key)
          if (execution === undefined) return Deferred.await(start(key, true, 'input').done)
          if (!execution.stopping) return Deferred.await(execution.done)
          return Deferred.await(execution.done).pipe(
            Effect.ignoreCause,
            Effect.andThen(
              Effect.suspend(() => {
                const next = executions.get(key)
                return next === undefined
                  ? Deferred.await(start(key, true, 'input').done)
                  : Deferred.await(next.done)
              })
            )
          )
        }),
      captureRun: key =>
        Effect.sync(() => {
          const execution = executions.get(key)
          if (execution === undefined) {
            const started = start(key, true, 'input')
            return { _tag: 'Started' as const, join: Deferred.await(started.done) }
          }
          if (!execution.stopping) {
            return { _tag: 'Joined' as const, join: Deferred.await(execution.done) }
          }
          return {
            _tag: 'Stopping' as const,
            awaitSettlement: Deferred.await(execution.done).pipe(Effect.ignoreCause)
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
                ? Deferred.await(execution.done).pipe(Effect.ignoreCause)
                : Effect.void
            )
          )
        }),
      terminalStop: (key, reason) =>
        Effect.sync(() => {
          const execution = executions.get(key)
          if (execution === undefined) return { _tag: 'Idle' } as const
          execution.pendingWake = undefined
          if (execution.owner === undefined) {
            execution.stopping = true
            return { _tag: 'Settling' } as const
          }
          execution.interruptionReason = reason
          if (execution.stopping) return { _tag: 'LiveStopping' } as const
          execution.stopping = true
          fork(Fiber.interrupt(execution.owner))
          return { _tag: 'Interrupted' } as const
        }),
      awaitIdle
    }
  })
