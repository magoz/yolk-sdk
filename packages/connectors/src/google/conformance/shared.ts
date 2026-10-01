/**
 * Shared pieces of the Google conformance cases (internal): the seeds service, the errors, the
 * connector action shorthands, and `withOwnedWrite`, the write-ownership helper every write case
 * runs through. See `cases.ts` for the write-safety contract.
 */
import { Cause, Context, Data, Effect, Exit, Option, Predicate, Ref, Result } from 'effect'
import * as Schema from 'effect/Schema'
import { ConformanceMismatch, type ConformanceCase } from '@yolk-sdk/conformance/case'
import { sanitizeConformanceMessage } from '@yolk-sdk/conformance/runner'
import {
  classifyWriteExit,
  failReporting,
  interruptPending,
  reportCleanupProblem
} from '../../conformance/cleanup-reporter.ts'
import { makeCredentialBinding, type CredentialResolver } from '../../credential.ts'
import { ConnectorError } from '../../error.ts'
import { ConnectorHttpClient, type ConnectorHttpResponse } from '../../http.ts'
import { makeIntegration, type ConnectorIntegration } from '../../integration.ts'
import type { ActionResult, ProviderFailure } from '../../result.ts'
import { googleConnectorId, googleOAuthSlotId } from '../oauth.ts'

/** An email address (the practice mailbox the send case writes to). */
const EmailAddress = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/),
  Schema.isMaxLength(254)
)

/** A Gmail message or label id (letters, digits, `_`, `-`). */
const GmailId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,100}$/))

/** A calendar id: `primary` or an address-like id, never dot-only. */
const CalendarId = Schema.String.check(Schema.isPattern(/^(?!\.+$)[A-Za-z0-9._%+@-]{1,200}$/))

/** An RFC 3339 instant with a `Z` or numeric offset (the only form Calendar accepts as a bound). */
const Instant = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/),
  Schema.makeFilter(value => Number.isFinite(Date.parse(value)))
)

/** A Drive file or folder id (letters, digits, `_`, `-`). */
const DriveId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{10,200}$/))

/**
 * A run id: `run-` then lower-case letters, digits, and inner hyphens, at most 40 characters, the
 * same shape as the other connector conformance run ids.
 */
const RunId = Schema.String.check(
  Schema.isPattern(/^run-[a-z0-9]+(?:-[a-z0-9]+)*$/),
  Schema.isMaxLength(40)
)

/**
 * Host-supplied seeds for the practice Google account. Cases never hard-code account data. A case
 * whose required seed is missing fails with a `precondition:` `ConformanceMismatch` before any
 * request.
 */
export const GoogleConformanceSeeds = Schema.Struct({
  /**
   * The ONLY address the write-irreversible send case ever sends to: a practice mailbox the owner
   * controls (the practice account's own address works). Never a person's address.
   */
  practiceAddress: Schema.optionalKey(EmailAddress),
  /** A user label on 3 to 20 practice messages, none of them in Trash or Spam. */
  pagingLabelId: Schema.optionalKey(GmailId),
  /** A practice message with at least one file attachment Gmail stores apart (an `attachmentId`). */
  attachmentMessageId: Schema.optionalKey(GmailId),
  /**
   * A practice message (not in Trash) the label and trash cases change and restore: they apply and
   * remove a run label, and trash and untrash it. Nobody else should rely on it.
   */
  workMessageId: Schema.optionalKey(GmailId),
  /** A practice calendar the account owns; the event cases create and delete events there. */
  calendarId: Schema.optionalKey(CalendarId),
  /** Start and end of a window holding 3 to 20 events in `calendarId` (RFC 3339 instants). */
  eventRangeStart: Schema.optionalKey(Instant),
  eventRangeEnd: Schema.optionalKey(Instant),
  /**
   * A practice Drive folder holding 3 to 20 items (none trashed matter), which the token may write
   * into: the folder case creates, trashes, and deletes a folder there.
   */
  driveFolderId: Schema.optionalKey(DriveId),
  /** A practice file directly inside `driveFolderId`. */
  driveFileId: Schema.optionalKey(DriveId),
  /**
   * Invocation-unique segment of every label name, draft subject, sent subject, event summary, and
   * folder name a case writes. Replay uses the fixed synthetic id of the fixtures; the live runner
   * generates a fresh random one per invocation.
   */
  runId: Schema.optionalKey(RunId)
})

export type GoogleConformanceSeeds = typeof GoogleConformanceSeeds.Type

export type GoogleConformanceSeedKey = keyof GoogleConformanceSeeds

/** Host-supplied seeds for the Google conformance cases. */
export class GoogleConformanceConfig extends Context.Service<
  GoogleConformanceConfig,
  GoogleConformanceSeeds
>()('@yolk-sdk/connectors/google/conformance/GoogleConformanceConfig') {}

/**
 * Credential reference the cases bind to the `google.oauth` slot (every Gmail, Calendar, and Drive
 * slot shares it). A host `CredentialResolver` resolves it to an OAuth access token for the
 * practice account.
 */
export const googleConformanceCredentialRef = 'google.conformance'

/** The integration every Google conformance case invokes the connector with. */
export const googleConformanceIntegration: ConnectorIntegration = makeIntegration({
  connectorId: googleConnectorId,
  credentialBindings: [
    makeCredentialBinding({
      slotId: googleOAuthSlotId,
      credentialRef: googleConformanceCredentialRef
    })
  ]
})

/** Synthetic marker every case-written name, subject, and summary starts with. */
export const googleConformanceMarker = 'yolk-conformance'

/** Prefix of every run-scoped name, subject, and summary: `yolk-conformance run-`. */
export const googleConformanceRunPrefix = `${googleConformanceMarker} run-`

/**
 * A connector action failed where the case needed success. `code` and `status` keep the underlying
 * classification (a `ConnectorError` cause such as `transport_failed`, or a provider failure code).
 *
 * `writeOutcome: 'unknown'` marks an ambiguous write (a transport or decoding failure, no status,
 * HTTP 408, or HTTP 5xx; for the send also a failure the connector itself calls unconfirmed):
 * Google may have written without the case learning what, so the message carries `recovery`, the
 * exact item to check by hand.
 */
export class GoogleConformanceActionFailed extends Data.TaggedError(
  'GoogleConformanceActionFailed'
)<{
  readonly actionId: string
  readonly code: string
  readonly status?: number
  readonly writeOutcome?: 'unknown'
  readonly recovery?: string
}> {
  override get message(): string {
    const status = this.status === undefined ? '' : ` (HTTP ${this.status})`

    const advice =
      this.writeOutcome === 'unknown'
        ? `; write outcome unknown: ${this.recovery ?? 'check the practice account by hand'}`
        : ''

    return `${this.actionId} failed: ${this.code}${status}${advice}`
  }
}

/**
 * A write answered an item outside the run namespace. The case never undoes anything outside its
 * own namespace, so nothing was changed there: check `item` by hand.
 */
export class GoogleConformanceCleanupRefused extends Data.TaggedError(
  'GoogleConformanceCleanupRefused'
)<{
  readonly caseId: string
  readonly item: string
}> {
  override get message(): string {
    return `${this.caseId}: cleanup refused; a write answered ${this.item}, outside the run namespace, so nothing was undone there; check it by hand.`
  }
}

/** `text` ending in a period (a truncated `...` summary already does). */
const sentence = (text: string): string => (text.endsWith('.') ? text : `${text}.`)

/**
 * Undoing what a write case created failed. `recovery` says what to do by hand; `caseOutcome` says
 * whether the claim itself held before the restore; `claimFailure` is a sanitized summary of why it
 * failed.
 */
export class GoogleConformanceRestoreFailed extends Data.TaggedError(
  'GoogleConformanceRestoreFailed'
)<{
  readonly caseId: string
  readonly recovery: string
  readonly reason: string
  readonly caseOutcome: 'claim held' | 'claim failed'
  readonly claimFailure?: string
}> {
  override get message(): string {
    const claim =
      this.caseOutcome === 'claim held'
        ? 'Claim held first.'
        : this.claimFailure === undefined
          ? 'Claim failed first.'
          : `Claim failed first: ${this.claimFailure}`

    // Conformance reports cap failure messages at 300 characters: the advice comes first.
    return `${this.caseId}: restore failed; ${this.recovery}. Restore error: ${sentence(this.reason)} ${claim}`
  }
}

export type GoogleConformanceError =
  | ConformanceMismatch
  | ConnectorError
  | GoogleConformanceActionFailed
  | GoogleConformanceCleanupRefused
  | GoogleConformanceRestoreFailed

/** What every Google conformance case requires from the host. */
export type GoogleConformanceRequirements =
  | ConnectorHttpClient
  | CredentialResolver
  | GoogleConformanceConfig

export type GoogleConformanceCase = ConformanceCase<
  GoogleConformanceError,
  GoogleConformanceRequirements
>

export const requireSeed = <K extends GoogleConformanceSeedKey>(key: K) =>
  Effect.gen(function* () {
    const seeds = yield* GoogleConformanceConfig
    const value = seeds[key]

    if (value === undefined) {
      return yield* new ConformanceMismatch({
        message: `precondition: GoogleConformanceConfig.${key} is not configured`
      })
    }

    return value
  })

/** `<marker> <runId> <kind>: <text>`, the run-scoped text of a name, subject, or summary. */
export const runText = (kind: string, text: string) =>
  Effect.map(requireSeed('runId'), runId => `${googleConformanceMarker} ${runId} ${kind}: ${text}`)

export const successValue =
  (actionId: string) =>
  <A>(result: ActionResult<A>): Effect.Effect<A, GoogleConformanceActionFailed> => {
    if (Predicate.isTagged(result, 'Success')) {
      return Effect.succeed(result.value)
    }

    const { code, status } = result.error

    return Effect.fail(
      status === undefined
        ? new GoogleConformanceActionFailed({ actionId, code })
        : new GoogleConformanceActionFailed({ actionId, code, status })
    )
  }

/** The provider failure of a result, or `undefined` for a success. */
export const failureOf = <A>(result: ActionResult<A>): ProviderFailure | undefined =>
  Predicate.isTagged(result, 'Failure') ? result.error : undefined

/** `code status` of a result for mismatch details (`success` for a success). */
export const outcomeOf = <A>(result: ActionResult<A>): string => {
  const failure = failureOf(result)

  return failure === undefined ? 'success' : `${failure.code} ${failure.status ?? 'no-status'}`
}

export const isNotFound = <A>(result: ActionResult<A>): boolean =>
  failureOf(result)?.code === 'google_not_found'

/**
 * Decode an untyped action output (`gmail.list`, `gmail.modify_labels`, drafts, trash) with a local
 * schema; a shape mismatch is a `ConformanceMismatch` naming `what`.
 */
export const decodeOutput =
  <A>(schema: Schema.Schema<A> & { readonly DecodingServices: never }, what: string) =>
  (value: unknown): Effect.Effect<A, ConformanceMismatch> =>
    Schema.decodeUnknownEffect(schema)(value).pipe(
      Effect.mapError(() => new ConformanceMismatch({ message: `expected ${what}` }))
    )

/**
 * Decode an untyped write answer inside the masked create: a shape mismatch is a decoding failure
 * (`validation_failed`), so the create classifies as ambiguous, exactly like a connector that
 * could not decode the answer itself.
 */
export const decodeWriteAnswer =
  <A>(schema: Schema.Schema<A> & { readonly DecodingServices: never }, actionId: string) =>
  (result: ActionResult<unknown>): Effect.Effect<ActionResult<A>, ConnectorError> =>
    Predicate.isTagged(result, 'Success')
      ? Schema.decodeUnknownEffect(schema)(result.value).pipe(
          Effect.map(value => ({ ...result, value })),
          Effect.mapError(
            () =>
              new ConnectorError({
                cause: 'validation_failed',
                message: 'Invalid response shape',
                actionId
              })
          )
        )
      : Effect.succeed(result)

/** Longest failure summary embedded in a `GoogleConformanceRestoreFailed` message. */
const failureSummaryLength = 60

const truncated = (text: string, length: number): string =>
  text.length > length ? `${text.slice(0, length - 3).trimEnd()}...` : text

/** Short, sanitized summary of a failure (credential patterns redacted). */
export const failureSummary = (cause: Cause.Cause<unknown>): string => {
  if (Cause.hasInterruptsOnly(cause)) {
    return 'interrupted'
  }

  const error = Cause.findErrorOption(cause)
  const value = Option.isSome(error) ? error.value : Cause.squash(cause)

  if (value instanceof GoogleConformanceActionFailed) {
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
 * Run `effect` with the host's `ConnectorHttpClient` wrapped so every response is observed; the
 * requests and responses are the host's own, unchanged.
 */
export const observed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const http = yield* ConnectorHttpClient
    const responses = yield* Ref.make<ReadonlyArray<ConnectorHttpResponse>>([])

    const observing = ConnectorHttpClient.of({
      request: request =>
        http
          .request(request)
          .pipe(Effect.tap(response => Ref.update(responses, list => [...list, response])))
    })

    const value = yield* effect.pipe(Effect.provideService(ConnectorHttpClient, observing))

    return { value, responses: yield* Ref.get(responses) }
  })

/** Decode a JSON text body with `schema`, or `undefined`. */
export const decodeBody = <A>(
  schema: Schema.Schema<A> & { readonly DecodingServices: never },
  body: string | undefined
): Effect.Effect<A | undefined> =>
  body === undefined
    ? Effect.succeed(undefined)
    : Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(body).pipe(
        Effect.result,
        Effect.map(result => (Result.isSuccess(result) ? result.success : undefined))
      )

/**
 * Fail with an unknown-outcome write `error`, first handing it to the `ConformanceCleanupReporter`
 * with the case id in front when the fiber is being interrupted: the action id alone does not say
 * which case left the item (both event cases share `calendar.create_event`). The raised error stays
 * unchanged. Only meaningful inside `Effect.uninterruptibleMask`.
 */
export const failReportingFor = <E extends { readonly message: string }>(
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

// Owned writes: the create, its decoding, its classification, and the registration run
// uninterruptibly together; the cleanup undoes by id and verifies.

/** `true` while the cleanup must still undo the created item; a case clears it once it proved it. */
export type Pending = Ref.Ref<boolean>

/**
 * Classify a create (see `classifyWriteExit`): no status, a 408 or 5xx, or a transport or decoding
 * failure is ambiguous (the error carries `recovery` for manual checking); any other 4xx is
 * definitive.
 */
const classifyCreate = <A>(
  actionId: string,
  recovery: string,
  exit: Exit.Exit<ActionResult<A>, ConnectorError>
):
  | { readonly kind: 'success'; readonly value: A }
  | { readonly kind: 'rejected'; readonly error: GoogleConformanceActionFailed }
  | { readonly kind: 'ambiguous'; readonly error: GoogleConformanceActionFailed } => {
  const outcome = classifyWriteExit(exit)

  switch (outcome.kind) {
    case 'success':
      return outcome
    case 'rejected':
      return {
        kind: 'rejected',
        error: new GoogleConformanceActionFailed({ actionId, ...outcome.failure })
      }
    case 'ambiguous':
      return {
        kind: 'ambiguous',
        error: new GoogleConformanceActionFailed({
          actionId,
          ...outcome.failure,
          writeOutcome: 'unknown',
          recovery
        })
      }
  }
}

export type OwnedWrite<T, A, E, R> = {
  readonly caseId: string
  readonly actionId: string
  /** The create and its decoding; masked together with the classification and registration. */
  readonly create: Effect.Effect<ActionResult<T>, ConnectorError, GoogleConformanceRequirements>
  /** What to check by hand when the create outcome is unknown. */
  readonly unknownRecovery: string
  /** The item, when the answer lies outside the run namespace (never adopted), else `undefined`. */
  readonly refuse: (value: T) => string | undefined
  /** What to do by hand when the cleanup fails. */
  readonly recovery: (value: T) => string
  /** Undo the created item (by id) and verify it is undone. */
  readonly restore: (
    value: T
  ) => Effect.Effect<void, GoogleConformanceError, GoogleConformanceRequirements>
  readonly use: (value: T, pending: Pending) => Effect.Effect<A, E, R>
}

/**
 * Create one owned item, run `use`, then ALWAYS undo it while `pending` (uninterruptibly, also
 * after a failed claim or an interruption). A definitive create rejection undoes nothing; an
 * ambiguous one is reported with `unknownRecovery`; an answer outside the run namespace is refused.
 * A failed restore fails the case with `GoogleConformanceRestoreFailed`, which says whether the
 * claim itself held; otherwise the outcome of `use` is returned unchanged.
 */
export const withOwnedWrite = <T, A, E, R>(spec: OwnedWrite<T, A, E, R>) =>
  Effect.gen(function* () {
    const pending: Pending = yield* Ref.make(false)

    return yield* Effect.uninterruptibleMask(unmask =>
      Effect.gen(function* () {
        const created = classifyCreate(
          spec.actionId,
          spec.unknownRecovery,
          yield* Effect.exit(spec.create)
        )

        switch (created.kind) {
          case 'rejected':
            return yield* created.error
          case 'ambiguous':
            return yield* failReportingFor(spec.caseId, unmask, created.error)
          case 'success':
            break
        }

        const refused = spec.refuse(created.value)

        if (refused !== undefined) {
          return yield* failReporting(
            unmask,
            new GoogleConformanceCleanupRefused({ caseId: spec.caseId, item: refused })
          )
        }

        yield* Ref.set(pending, true)

        const outcome = yield* Effect.exit(unmask(spec.use(created.value, pending)))

        const restored = yield* Effect.exit(
          Ref.get(pending).pipe(
            Effect.flatMap(still => (still ? spec.restore(created.value) : Effect.void))
          )
        )

        if (Exit.isFailure(restored)) {
          const recovery = spec.recovery(created.value)

          return yield* failReporting(
            unmask,
            Exit.isSuccess(outcome)
              ? new GoogleConformanceRestoreFailed({
                  caseId: spec.caseId,
                  recovery,
                  reason: failureSummary(restored.cause),
                  caseOutcome: 'claim held'
                })
              : new GoogleConformanceRestoreFailed({
                  caseId: spec.caseId,
                  recovery,
                  reason: failureSummary(restored.cause),
                  caseOutcome: 'claim failed',
                  claimFailure: failureSummary(outcome.cause)
                }),
            Exit.isFailure(outcome) && Cause.hasInterrupts(outcome.cause)
          )
        }

        return yield* outcome
      })
    )
  })
