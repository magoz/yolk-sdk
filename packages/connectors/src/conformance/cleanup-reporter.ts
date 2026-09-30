/**
 * Where connector conformance write cases report a cleanup problem that an interruption would
 * otherwise hide. Conformance/testing only.
 *
 * A write case raises `...RestoreFailed` (or an unknown-outcome create) inside an uninterruptible
 * region. When the case fiber was interrupted meanwhile, the run ends as an interruption and that
 * error, with the exact path or page to check by hand, may never reach a report. So, before
 * leaving the region, the case also hands the full message to this reporter. The default logs it
 * with `Effect.logWarning`; live runners wire it to stderr, and tests capture it.
 */
import { Context, Effect, Exit } from 'effect'

export type ConformanceCleanupReporterApi = {
  /** Report one message (the full failure message, including its manual-recovery advice). */
  readonly warn: (message: string) => Effect.Effect<void>
}

export const ConformanceCleanupReporter = Context.Reference<ConformanceCleanupReporterApi>(
  '@yolk-sdk/connectors/conformance/ConformanceCleanupReporter',
  { defaultValue: () => ({ warn: message => Effect.logWarning(message) }) }
)

/**
 * True when the fiber has a pending interruption. Only meaningful inside
 * `Effect.uninterruptibleMask`: it briefly re-enables interruption with `unmask`.
 */
export const interruptPending = (
  unmask: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
): Effect.Effect<boolean> => Effect.exit(unmask(Effect.yieldNow)).pipe(Effect.map(Exit.isFailure))

export const reportCleanupProblem = (error: { readonly message: string }): Effect.Effect<void> =>
  Effect.gen(function* () {
    const reporter = yield* ConformanceCleanupReporter

    yield* reporter.warn(error.message)
  })
