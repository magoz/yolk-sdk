/**
 * The shared write-ownership step of connector conformance write cases (internal; conformance and
 * testing only). The GitHub and Google cases run every create through `withOwnedWrite`; each
 * provider supplies its own error constructors, so the messages stay provider-specific while the
 * create, adoption, restore, and reporting steps live here, once.
 *
 * The create request, its decoding, its classification (`classifyWriteExit`), the ownership check,
 * and the registration of what it created run uninterruptibly together. A definitive rejection (HTTP
 * 4xx other than 408) changed nothing and undoes nothing; an ambiguous outcome (a transport or
 * decoding failure, no status, HTTP 408, or HTTP 5xx) fails with the provider's action failure
 * (`writeOutcome: 'unknown'`) carrying `unknownRecovery`; an answer the ownership check refuses is
 * never adopted. Once adopted, the item is ALWAYS undone (uninterruptibly, also after a failed claim
 * or an interruption) while `pending`; a failed restore fails with the provider's restore failure,
 * which says whether the claim itself held. Cleanup problems raised while the case is being
 * interrupted also go to the `ConformanceCleanupReporter`.
 */
import { Cause, Effect, Exit, Option, Predicate, Ref } from 'effect'
import { ConformanceMismatch } from '@yolk-sdk/conformance/case'
import { sanitizeConformanceMessage } from '@yolk-sdk/conformance/runner'
import type { ConnectorError } from '../error.ts'
import type { ActionResult } from '../result.ts'
import {
  classifyWriteExit,
  failReporting,
  failReportingForCase,
  type WriteFailure
} from './cleanup-reporter.ts'

/** `true` while the cleanup must still undo the created item; a case clears it once it proved it. */
export type Pending = Ref.Ref<boolean>

/** The fields a provider's action failure is built from. */
export type OwnedWriteActionFailure = { readonly actionId: string } & WriteFailure & {
    readonly writeOutcome?: 'unknown'
    readonly recovery?: string
  }

/** The fields a provider's restore failure is built from. */
export type OwnedWriteRestoreFailure =
  | {
      readonly caseId: string
      readonly recovery: string
      readonly reason: string
      readonly caseOutcome: 'claim held'
    }
  | {
      readonly caseId: string
      readonly recovery: string
      readonly reason: string
      readonly caseOutcome: 'claim failed'
      readonly claimFailure: string
    }

/** A provider's action failure, as far as a failure summary reads it. */
export type SummarizedActionFailure = {
  readonly actionId: string
  readonly code: string
  readonly status?: number
}

/** How a provider builds and recognizes its write errors. */
export type OwnedWriteErrors<AF extends { readonly message: string }, CR, RF> = {
  readonly actionFailed: (fields: OwnedWriteActionFailure) => AF
  readonly cleanupRefused: (fields: { readonly caseId: string; readonly item: string }) => CR
  readonly restoreFailed: (fields: OwnedWriteRestoreFailure) => RF
  /** Recognizes the provider's action failure, which a failure summary shortens to its code. */
  readonly isActionFailed: (value: unknown) => value is SummarizedActionFailure
  /**
   * When `true`, an ambiguous create reported during an interruption carries the case id in front
   * (several cases may share one create action); the raised error stays unchanged.
   */
  readonly prefixUnknownReports?: boolean
}

export type OwnedWrite<T, A, E, R, RC, RV, RR> = {
  readonly caseId: string
  readonly actionId: string
  /** The create and its decoding; masked together with the classification and registration. */
  readonly create: Effect.Effect<ActionResult<T>, ConnectorError, RC>
  /** What to check by hand when the create outcome is unknown. */
  readonly unknownRecovery: string
  /**
   * The item, when the answer is not provably this run's own (never adopted, never undone), else
   * `undefined`. Runs inside the mask, before the registration; it may read to verify ownership.
   */
  readonly refuse: (value: T) => Effect.Effect<string | undefined, never, RV>
  /** What to do by hand when the cleanup fails. */
  readonly recovery: (value: T) => string
  /** Undo the created item (by id) and verify it is undone. */
  readonly restore: (value: T) => Effect.Effect<void, unknown, RR>
  readonly use: (value: T, pending: Pending) => Effect.Effect<A, E, R>
}

/** Longest failure summary embedded in a restore failure message. */
const failureSummaryLength = 60

const truncated = (text: string, length: number): string =>
  text.length > length ? `${text.slice(0, length - 3).trimEnd()}...` : text

/** Short, sanitized summary of a failure (credential patterns redacted). */
export const ownedWriteFailureSummary = (
  cause: Cause.Cause<unknown>,
  isActionFailed: (value: unknown) => value is SummarizedActionFailure
): string => {
  if (Cause.hasInterruptsOnly(cause)) {
    return 'interrupted'
  }

  const error = Cause.findErrorOption(cause)
  const value = Option.isSome(error) ? error.value : Cause.squash(cause)

  if (isActionFailed(value)) {
    const status = value.status === undefined ? '' : ` ${value.status}`

    return `${truncated(sanitizeConformanceMessage(`${value.actionId} ${value.code}`), failureSummaryLength - status.length)}${status}`
  }

  const tag = Predicate.hasProperty(value, '_tag') ? String(value._tag) : 'defect'
  const message = Predicate.hasProperty(value, 'message') ? String(value.message) : ''

  const raw =
    message.length === 0
      ? tag
      : value instanceof ConformanceMismatch
        ? message
        : `${tag}: ${message}`

  return truncated(sanitizeConformanceMessage(raw), failureSummaryLength)
}

/**
 * Create one owned item, verify it is the run's own, run `use`, then ALWAYS undo it while `pending`
 * (see the module comment).
 */
export const withOwnedWrite = <
  AF extends { readonly message: string },
  CR extends { readonly message: string },
  RF extends { readonly message: string },
  T,
  A,
  E,
  R,
  RC,
  RV,
  RR
>(
  errors: OwnedWriteErrors<AF, CR, RF>,
  spec: OwnedWrite<T, A, E, R, RC, RV, RR>
): Effect.Effect<A, E | AF | CR | RF, R | RC | RV | RR> =>
  Effect.gen(function* () {
    const pending: Pending = yield* Ref.make(false)

    return yield* Effect.uninterruptibleMask(unmask =>
      Effect.gen(function* () {
        const outcome = classifyWriteExit(yield* Effect.exit(spec.create))

        switch (outcome.kind) {
          case 'rejected':
            return yield* Effect.fail(
              errors.actionFailed({ actionId: spec.actionId, ...outcome.failure })
            )
          case 'ambiguous': {
            const error = errors.actionFailed({
              actionId: spec.actionId,
              ...outcome.failure,
              writeOutcome: 'unknown',
              recovery: spec.unknownRecovery
            })

            return yield* errors.prefixUnknownReports === true
              ? failReportingForCase(spec.caseId, unmask, error)
              : failReporting(unmask, error)
          }

          case 'success':
            break
        }

        const refused = yield* spec.refuse(outcome.value)

        if (refused !== undefined) {
          return yield* failReporting(
            unmask,
            errors.cleanupRefused({ caseId: spec.caseId, item: refused })
          )
        }

        yield* Ref.set(pending, true)

        const used = yield* Effect.exit(unmask(spec.use(outcome.value, pending)))

        const restored = yield* Effect.exit(
          Ref.get(pending).pipe(
            Effect.flatMap(still => (still ? spec.restore(outcome.value) : Effect.void))
          )
        )

        if (Exit.isFailure(restored)) {
          const recovery = spec.recovery(outcome.value)
          const reason = ownedWriteFailureSummary(restored.cause, errors.isActionFailed)

          return yield* failReporting(
            unmask,
            Exit.isSuccess(used)
              ? errors.restoreFailed({
                  caseId: spec.caseId,
                  recovery,
                  reason,
                  caseOutcome: 'claim held'
                })
              : errors.restoreFailed({
                  caseId: spec.caseId,
                  recovery,
                  reason,
                  caseOutcome: 'claim failed',
                  claimFailure: ownedWriteFailureSummary(used.cause, errors.isActionFailed)
                }),
            Exit.isFailure(used) && Cause.hasInterrupts(used.cause)
          )
        }

        return yield* used
      })
    )
  })
