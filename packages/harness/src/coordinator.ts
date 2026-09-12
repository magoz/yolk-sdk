/**
 * Process-local run coordinator.
 *
 * Port of OpenCode v2 `SessionRunCoordinator` (MIT): one busy period per key,
 * a doorbell that coalesces wakes, and interrupt that claims pending wakes so a
 * dead intent cannot restart. Steering lands at the next drain boundary.
 *
 * @see https://github.com/sst/opencode (packages/core/src/session/run-coordinator.ts)
 */
import { Context, Deferred, Effect, Exit, Fiber, FiberSet, Layer } from 'effect'
import type { Scope } from 'effect'
import { RunStore } from './store.ts'

/** `"input"` subsumes `"steer"` when coalescing wakes. */
export type Promotable = 'input' | 'steer'

/** Why a run execution was interrupted. A `shutdown` interrupt keeps the run claimed. */
export type InterruptReason = 'user' | 'shutdown'

export type Coordinator<Key, E, Reason = never> = {
  readonly active: Effect.Effect<ReadonlySet<Key>>
  readonly isActive: (key: Key) => Effect.Effect<boolean>
  /** Starts an execution while idle, or joins the active execution. */
  readonly run: (key: Key) => Effect.Effect<void, E>
  /** Rings the doorbell: idle starts; active drains again before settling. */
  readonly wake: (key: Key, scope?: Promotable) => Effect.Effect<void>
  /**
   * Stops the active execution and clears its doorbell. No-op when idle.
   * Resolves once interruption is accepted, not when cleanup settles.
   */
  readonly interrupt: (
    key: Key,
    reason?: Reason,
    options?: { readonly awaitSettlement?: boolean }
  ) => Effect.Effect<boolean>
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
            Effect.sync(() => {
              execution.owner = undefined
            }).pipe(
              Effect.andThen(
                options.settled?.(key, exit, execution.interruptionReason) ?? Effect.void
              )
            )
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
      awaitIdle
    }
  })

/**
 * Process-local coordinator for run ids.
 *
 * Owning service for run doorbell state. Acquire it through {@link RunCoordinator.layer},
 * which wires claim-on-start / release-on-settle against the contextual {@link RunStore}:
 * a `user` stop (or a clean exit) releases the claim, while a `shutdown` interrupt keeps
 * it so the run can be resumed after a crash.
 */
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

        return yield* makeCoordinator<string, never, InterruptReason>({
          drain,
          started: runId => store.claim(runId),
          settled: (runId, exit, reason) =>
            reason === 'user' || (reason === undefined && !Exit.hasInterrupts(exit))
              ? store.release(runId)
              : Effect.void
        })
      })
    )
}
