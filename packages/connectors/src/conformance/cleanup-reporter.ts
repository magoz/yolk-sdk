/**
 * Where connector conformance write cases report a cleanup problem that an interruption would
 * otherwise hide. Conformance/testing only.
 *
 * A write case raises `...RestoreFailed` (or an unknown-outcome create) inside an uninterruptible
 * region. When the case fiber was interrupted meanwhile, the run produces no conformance report:
 * the failure may survive as the run's exit, but that depends on the Effect runtime, so the exact
 * path or page to check by hand is not guaranteed to reach the operator that way. Before leaving
 * the region, the case therefore also hands the full message to this reporter. The default logs it
 * with `Effect.logWarning`; live runners wire it to stderr, and tests capture it.
 */
import { Cause, Context, Effect, Exit, Option, Predicate } from 'effect'
import type { ConnectorError } from '../error.ts'
import type { ActionResult } from '../result.ts'

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

/**
 * Fail with `error`, first handing its message to the `ConformanceCleanupReporter` when the fiber
 * was interrupted (`interrupted`, or an interruption still pending): an interruption may otherwise
 * replace this error, and with it the item to check by hand. Only meaningful inside
 * `Effect.uninterruptibleMask`.
 */
export const failReporting = <E extends { readonly message: string }>(
  unmask: <A, E2, R>(effect: Effect.Effect<A, E2, R>) => Effect.Effect<A, E2, R>,
  error: E,
  interrupted = false
): Effect.Effect<never, E> =>
  Effect.gen(function* () {
    if (interrupted || (yield* interruptPending(unmask))) {
      yield* reportCleanupProblem(error)
    }

    return yield* Effect.fail(error)
  })

/**
 * Like `failReporting`, but the report carries `caseId` in front: an action id alone does not say
 * which case left the item when several cases share one write action. The raised error stays
 * unchanged. Only meaningful inside `Effect.uninterruptibleMask`.
 */
export const failReportingForCase = <E extends { readonly message: string }>(
  caseId: string,
  unmask: <A, E2, R>(effect: Effect.Effect<A, E2, R>) => Effect.Effect<A, E2, R>,
  error: E
): Effect.Effect<never, E> =>
  Effect.gen(function* () {
    if (yield* interruptPending(unmask)) {
      yield* reportCleanupProblem({ message: `${caseId}: ${error.message}` })
    }

    return yield* Effect.fail(error)
  })

/** The classification of a failed write: its code, and its HTTP status when it had one. */
export type WriteFailure =
  | { readonly code: string }
  | { readonly code: string; readonly status: number }

/**
 * What one create (or other one-shot write) established, from the exit of its connector action.
 *
 * - `success`: the provider answered 2xx and the answer decoded.
 * - `rejected`: a definitive HTTP 4xx rejection other than 408; nothing was written, so nothing
 *   may be deleted. `result` is the provider failure.
 * - `ambiguous`: a transport or decoding failure (the `ConnectorError` cause, or `defect`), no
 *   status, HTTP 408, or HTTP 5xx; the provider may still have written, even later.
 */
export type WriteOutcome<A> =
  | { readonly kind: 'success'; readonly value: A }
  | {
      readonly kind: 'rejected'
      readonly result: ActionResult<A>
      readonly failure: { readonly code: string; readonly status: number }
    }
  | { readonly kind: 'ambiguous'; readonly failure: WriteFailure }

/** Classify the exit of a write action (see `WriteOutcome`). */
export const classifyWriteExit = <A>(
  exit: Exit.Exit<ActionResult<A>, ConnectorError>
): WriteOutcome<A> => {
  if (Exit.isFailure(exit)) {
    const error = Cause.findErrorOption(exit.cause)

    return {
      kind: 'ambiguous',
      failure: { code: Option.isSome(error) ? error.value.cause : 'defect' }
    }
  }

  const result = exit.value

  if (Predicate.isTagged(result, 'Success')) {
    return { kind: 'success', value: result.value }
  }

  const { code, status } = result.error

  if (status === undefined) {
    return { kind: 'ambiguous', failure: { code } }
  }

  // A 408 is a timeout: the provider may still have processed the write, as after a 5xx.
  return status === 408 || status >= 500
    ? { kind: 'ambiguous', failure: { code, status } }
    : { kind: 'rejected', result, failure: { code, status } }
}
