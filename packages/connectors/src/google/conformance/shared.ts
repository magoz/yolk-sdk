/**
 * Shared pieces of the Google conformance cases (internal): the seeds service, the errors, the
 * connector action shorthands, and `withOwnedWrite`, the shared write-ownership helper
 * (`../../conformance/owned-write.ts`) bound to the Google errors. See `cases.ts` for the
 * write-safety contract.
 */
import { Context, Data, Effect, Predicate, Ref, Result } from 'effect'
import * as Schema from 'effect/Schema'
import { ConformanceMismatch, type ConformanceCase } from '@yolk-sdk/conformance/case'
import {
  withOwnedWrite as sharedWithOwnedWrite,
  type OwnedWrite,
  type OwnedWriteErrors,
  type Pending
} from '../../conformance/owned-write.ts'
import { makeCredentialBinding, type CredentialResolver } from '../../credential.ts'
import { ConnectorError } from '../../error.ts'
import { ConnectorHttpClient, type ConnectorHttpResponse } from '../../http.ts'
import { makeIntegration, type ConnectorIntegration } from '../../integration.ts'
import type { ActionResult, ProviderFailure } from '../../result.ts'
import { googleConnectorId, googleOAuthSlotId } from '../oauth.ts'

/** Longest local part an address may have (RFC 5321). */
const localPartMaxLength = 64

/**
 * The practice mailbox the send case writes to: exactly ONE plain addr-spec (`local@domain`), with
 * no display name, no list (comma or semicolon), no angle brackets, no quotes, no whitespace or
 * control characters, a dot-separated local part of at most 64 characters, and a domain of at
 * least two labels; at most 254 characters. Branded, so hosts building `GoogleConformanceConfig`
 * by hand must construct it (`GooglePracticeAddress.make(...)`), and the send case decodes it again
 * before building the message.
 */
export const GooglePracticeAddress = Schema.String.check(
  Schema.isMaxLength(254),
  Schema.isPattern(
    /^[A-Za-z0-9_%+-]+(?:\.[A-Za-z0-9_%+-]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/u
  ),
  Schema.makeFilter(value => value.indexOf('@') <= localPartMaxLength)
).pipe(Schema.brand('GooglePracticeAddress'))

export type GooglePracticeAddress = typeof GooglePracticeAddress.Type

/** A Gmail message or label id (letters, digits, `_`, `-`). */
const GmailId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,100}$/u))

/** A calendar id: `primary` or an address-like id, never dot-only. */
const CalendarId = Schema.String.check(Schema.isPattern(/^(?!\.+$)[A-Za-z0-9._%+@-]{1,200}$/u))

/** An RFC 3339 instant with a `Z` or numeric offset (the only form Calendar accepts as a bound). */
const Instant = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u),
  Schema.makeFilter(value => Number.isFinite(Date.parse(value)))
)

/** A Drive file or folder id (letters, digits, `_`, `-`). */
const DriveId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{10,200}$/u))

/**
 * A run id: `run-` then lower-case letters, digits, and inner hyphens, at most 40 characters, the
 * same shape as the other connector conformance run ids. Branded, like `GooglePracticeAddress`.
 */
export const GoogleConformanceRunId = Schema.String.check(
  Schema.isMaxLength(40),
  Schema.isPattern(/^run-[a-z0-9]+(?:-[a-z0-9]+)*$/u)
).pipe(Schema.brand('GoogleConformanceRunId'))

export type GoogleConformanceRunId = typeof GoogleConformanceRunId.Type

/**
 * Host-supplied seeds for the practice Google account. Cases never hard-code account data. A case
 * whose required seed is missing, or does not decode with this schema (each case decodes every seed
 * it reads again, so a host that bypasses the types is still refused), fails with a `precondition:`
 * `ConformanceMismatch` before any request.
 */
export const GoogleConformanceSeeds = Schema.Struct({
  /**
   * The ONLY address the write-irreversible send case ever sends to: a practice mailbox the owner
   * controls (the practice account's own address works). Never a person's address.
   */
  practiceAddress: Schema.optionalKey(GooglePracticeAddress),
  /** A user label on 3 to 20 practice messages, none of them in Trash or Spam. */
  pagingLabelId: Schema.optionalKey(GmailId),
  /**
   * A practice message with at least one file attachment Gmail stores apart (an `attachmentId`).
   * The metadata-headers case also reads its headers: it needs a `Subject` header and one header
   * other than `Subject` and `From`, which every ordinary message has.
   */
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
   * A practice Drive folder holding 3 to 20 untrashed items (trashed items are not counted), which
   * the token may write into: the folder case creates, trashes, and deletes a folder there.
   */
  driveFolderId: Schema.optionalKey(DriveId),
  /** A practice file directly inside `driveFolderId`. */
  driveFileId: Schema.optionalKey(DriveId),
  /**
   * Invocation-unique segment of every label name, draft subject, sent subject, event summary, and
   * folder name a case writes. Replay uses the fixed synthetic id of the fixtures; the live runner
   * generates a fresh random one per invocation.
   */
  runId: Schema.optionalKey(GoogleConformanceRunId)
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

/** What a seed must be, named in the precondition when it does not decode. */
const seedRules: Readonly<Record<GoogleConformanceSeedKey, string>> = {
  practiceAddress:
    'exactly one plain address local@domain: no display name, list, angle brackets, whitespace, or control characters',
  pagingLabelId: 'a Gmail label id (letters, digits, _ and -)',
  attachmentMessageId: 'a Gmail message id (letters, digits, _ and -)',
  workMessageId: 'a Gmail message id (letters, digits, _ and -)',
  calendarId: 'a calendar id',
  eventRangeStart: 'an RFC 3339 instant with Z or an offset',
  eventRangeEnd: 'an RFC 3339 instant with Z or an offset',
  driveFolderId: 'a Drive id (10 or more letters, digits, _ and -)',
  driveFileId: 'a Drive id (10 or more letters, digits, _ and -)',
  runId: 'run- then lower-case letters, digits, and inner hyphens, at most 40 characters'
}

/**
 * The seed `key`, decoded again with its `GoogleConformanceSeeds` schema (a host may bypass the
 * types), or a `precondition:` mismatch when it is missing or invalid. Never sends a request.
 */
export const requireSeed = <K extends GoogleConformanceSeedKey>(key: K) =>
  Effect.gen(function* () {
    const seeds = yield* GoogleConformanceConfig

    if (seeds[key] === undefined) {
      return yield* new ConformanceMismatch({
        message: `precondition: GoogleConformanceConfig.${key} is not configured`
      })
    }

    const decoded = yield* Schema.decodeUnknownEffect(GoogleConformanceSeeds)({
      [key]: seeds[key]
    }).pipe(Effect.result)

    const value = Result.isSuccess(decoded) ? decoded.success[key] : undefined

    if (value === undefined) {
      return yield* new ConformanceMismatch({
        message: `precondition: GoogleConformanceConfig.${key} must be ${seedRules[key]}`
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

// Owned writes: the shared `withOwnedWrite` (`../../conformance/owned-write.ts`) runs the create,
// its decoding, its classification, the ownership check, and the registration uninterruptibly
// together; the cleanup undoes by id and verifies.

export type { Pending }

const googleWriteErrors: OwnedWriteErrors<
  GoogleConformanceActionFailed,
  GoogleConformanceCleanupRefused,
  GoogleConformanceRestoreFailed
> = {
  actionFailed: fields => new GoogleConformanceActionFailed(fields),
  cleanupRefused: fields => new GoogleConformanceCleanupRefused(fields),
  restoreFailed: fields => new GoogleConformanceRestoreFailed(fields),
  isActionFailed: (value): value is GoogleConformanceActionFailed =>
    value instanceof GoogleConformanceActionFailed,
  // Both event cases share `calendar.create_event`: an unknown-outcome report names the case.
  prefixUnknownReports: true
}

/**
 * Create one owned item, verify it is this run's own (`refuse`, inside the mask, before the
 * registration), run `use`, then ALWAYS undo it while `pending`. A definitive create rejection
 * undoes nothing; an ambiguous one is reported with `unknownRecovery` (with the case id in front
 * when reported during an interruption); a refused answer is never adopted, updated, or deleted. A
 * failed restore fails the case with `GoogleConformanceRestoreFailed`.
 */
export const withOwnedWrite = <T, A, E, R>(
  spec: OwnedWrite<
    T,
    A,
    E,
    R,
    GoogleConformanceRequirements,
    GoogleConformanceRequirements,
    GoogleConformanceRequirements
  >
) => sharedWithOwnedWrite(googleWriteErrors, spec)
