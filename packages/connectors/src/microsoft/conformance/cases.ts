/**
 * Microsoft Graph conformance cases for `@yolk-sdk/conformance/runner`.
 *
 * Each case checks one claim about how Microsoft Graph really behaves where it differs from (or
 * goes beyond) its documentation. Outlook and OneDrive cases run through the REAL connector
 * actions over the connector ports (`ConnectorHttpClient`, `CredentialResolver`) plus the
 * host-supplied `MicrosoftConformanceConfig` seed identities. The connector has no calendar
 * actions yet: the calendar cases send raw Graph v1.0 requests through the same ports, the shared
 * token resolution, and the shared Graph failure mapping, and pin expected Graph behaviour
 * (unverified until a live run) for hosts and the upcoming emulator. The same cases run on replay
 * fixtures, an emulator, or by hand against a practice tenant. None is observed live yet
 * (`observed` absent = unverified).
 *
 * Every write case creates its own calendar event, draft, or folder and registers its id for the
 * restore before any claim runs (the create and the registration run uninterruptibly, so a hanging
 * create cannot be interrupted; nothing here adds a request timeout). The restore then removes it
 * again (also after a failed claim or an interruption), verifies the removal where Graph allows it,
 * and reports (never swallows) a failed restore. A create that succeeds without a recoverable id
 * fails with `MicrosoftConformanceRestoreFailed`, and an ambiguous create failure (transport or
 * decoding failure, no status, or HTTP 5xx) fails with `MicrosoftConformanceActionFailed`
 * (`createOutcome: 'unknown'`): both messages say to remove the item by hand if it exists. No case
 * sends mail or invitations.
 */
import { Cause, Chunk, Context, Data, Duration, Effect, Exit, Option, Predicate, Ref } from 'effect'
import * as Schema from 'effect/Schema'
import {
  ConformanceMismatch,
  defineConformanceCase,
  expectConformance,
  expectEqual,
  type ConformanceCase
} from '@yolk-sdk/conformance/case'
import { sanitizeConformanceMessage } from '@yolk-sdk/conformance/runner'
import { makeCredentialBinding, type CredentialResolver } from '../../credential.ts'
import { ConnectorError } from '../../error.ts'
import type { ConnectorHttpClient } from '../../http.ts'
import { makeIntegration } from '../../integration.ts'
import type { ActionResult } from '../../result.ts'
import {
  OneDriveCopyItemInput,
  OneDriveCopyStatusInput,
  OneDriveCreateFolderInput,
  OneDriveDeleteItemInput,
  OneDriveItemIdInput,
  OneDriveListItemsInput,
  oneDriveCopyItemAction,
  oneDriveCreateFolderAction,
  oneDriveDeleteItemAction,
  oneDriveGetCopyStatusAction,
  oneDriveGetItemAction,
  oneDriveListItemsAction,
  type OneDriveItem
} from '../drive.ts'
import {
  OutlookComposeInput,
  OutlookGetAttachmentInput,
  OutlookListAttachmentsInput,
  OutlookListMessagesInput,
  OutlookSetReadInput,
  OutlookTrashInput,
  outlookCreateDraftAction,
  outlookDeletePermanentlyAction,
  outlookGetAttachmentAction,
  outlookListAttachmentsAction,
  outlookListMessagesAction,
  outlookSetReadAction,
  outlookTrashAction,
  outlookUpdateDraftAction,
  type OutlookAttachmentMetadata,
  type OutlookMessage
} from '../mail.ts'
import { microsoftConnectorId, microsoftOAuthSlotId } from '../oauth.ts'
import {
  calendarActionIds,
  cancelCalendarEvent,
  createCalendarEvent,
  deleteCalendarEvent,
  getCalendarEvent,
  graphInstant,
  graphSevenDigitDateTimePattern,
  isBefore,
  isNonEmptyString,
  isoInstant,
  isoUtcInstantPattern,
  listCalendarRange,
  sameInstant,
  updateCalendarEventSubject,
  type CalendarTarget,
  type GraphEvent
} from './calendar.ts'
import { microsoftCalendarCancelFixture } from './calendar-cancel.ts'
import { microsoftCalendarCreateEventFixture } from './calendar-create-event.ts'
import { microsoftCalendarListRangeFixture } from './calendar-list-range.ts'
import { microsoftCalendarTimestampPrecisionFixture } from './calendar-timestamp-precision.ts'
import { microsoftOneDriveCopyMonitorFixture } from './onedrive-copy-monitor.ts'
import { microsoftOneDriveCreateFolderFixture } from './onedrive-create-folder.ts'
import { microsoftOutlookAttachmentContentIdFixture } from './outlook-attachment-content-id.ts'
import { microsoftOutlookAttachmentsListingFixture } from './outlook-attachments-listing.ts'
import { microsoftOutlookConcurrentWritesFixture } from './outlook-concurrent-writes.ts'
import { microsoftOutlookImmutableIdFixture } from './outlook-immutable-id.ts'
import { microsoftOutlookPagingNextLinkFixture } from './outlook-paging-next-link.ts'

const SeedString = Schema.Trimmed.check(Schema.isNonEmpty())

const IsoUtcInstant = Schema.String.check(Schema.isPattern(isoUtcInstantPattern))

/**
 * Host-supplied seed identities in the practice tenant. Cases never hard-code account data. A case
 * whose required seed is missing fails with a `precondition:` `ConformanceMismatch` before any
 * request.
 */
export const MicrosoftConformanceSeeds = Schema.Struct({
  /**
   * Mailbox (user principal name or id) for the Outlook and calendar cases, sent as
   * `/users/{mailbox}`; absent means the signed-in user (`/me`). When it equals the credential's
   * `accountId`, the connector keeps ordinary (non-Shared) Outlook scopes.
   */
  mailbox: Schema.optionalKey(SeedString),
  /** Calendar for the calendar cases; absent means the default calendar. */
  calendarId: Schema.optionalKey(SeedString),
  /** Start of a range with known events (ISO-8601 UTC, for example `2026-09-21T00:00:00Z`). */
  calendarRangeStart: Schema.optionalKey(IsoUtcInstant),
  /** End (exclusive) of that range. */
  calendarRangeEnd: Schema.optionalKey(IsoUtcInstant),
  /** A known event inside the range, among the first 50 events of the range. */
  calendarEventId: Schema.optionalKey(SeedString),
  /** That event's known start instant (ISO-8601 UTC, at most millisecond precision). */
  calendarEventStart: Schema.optionalKey(IsoUtcInstant),
  /** A message with at least one inline and one regular (non-inline) file attachment. */
  attachmentMessageId: Schema.optionalKey(SeedString),
  /** A mail folder holding more than two messages. */
  pagingFolderId: Schema.optionalKey(SeedString),
  /** Drive for the OneDrive cases (`/drives/{driveId}`); absent means `/me/drive`. Copy needs it. */
  driveId: Schema.optionalKey(SeedString),
  /** A concrete folder id (not `root`) the OneDrive cases create their own folders under. */
  driveParentItemId: Schema.optionalKey(SeedString),
  /** A small file the copy case copies into its own folder. */
  copySourceItemId: Schema.optionalKey(SeedString)
})

export type MicrosoftConformanceSeeds = typeof MicrosoftConformanceSeeds.Type

export type MicrosoftConformanceSeedKey = keyof MicrosoftConformanceSeeds

/** Host-supplied seed identities for the Microsoft conformance cases. */
export class MicrosoftConformanceConfig extends Context.Service<
  MicrosoftConformanceConfig,
  MicrosoftConformanceSeeds
>()('@yolk-sdk/connectors/microsoft/conformance/MicrosoftConformanceConfig') {}

/**
 * Credential reference the cases bind to the `microsoft.oauth` slot. A host `CredentialResolver`
 * (for example `staticCredentialResolverLayer` from `@yolk-sdk/connectors/conformance`) resolves
 * it to a Microsoft `OAuthCredential`.
 */
export const microsoftConformanceCredentialRef = 'microsoft.conformance'

/** The integration every Microsoft conformance case invokes the connector with. */
export const microsoftConformanceIntegration = makeIntegration({
  connectorId: microsoftConnectorId,
  credentialBindings: [
    makeCredentialBinding({
      slotId: microsoftOAuthSlotId,
      credentialRef: microsoftConformanceCredentialRef
    })
  ]
})

const restoreByHandAdvice =
  'remove the case-created item by hand if it still exists (subjects and names start with yolk-conformance).'

/**
 * A connector action (or raw calendar request) returned a failure where the case needed success.
 *
 * `createOutcome: 'unknown'` marks an ambiguous create of a write case's own item (a transport or
 * decoding failure, no status, or HTTP 5xx): Graph may have created the item without the case
 * learning its id, so the message adds the manual-recovery advice. `code` and `status` keep the
 * underlying classification (`transport_failed` or `validation_failed` for a `ConnectorError`).
 */
export class MicrosoftConformanceActionFailed extends Data.TaggedError(
  'MicrosoftConformanceActionFailed'
)<{
  readonly actionId: string
  readonly code: string
  readonly status?: number
  readonly createOutcome?: 'unknown'
}> {
  override get message(): string {
    const status = this.status === undefined ? '' : ` (HTTP ${this.status})`

    const advice =
      this.createOutcome === 'unknown' ? `; the item may exist anyway: ${restoreByHandAdvice}` : ''

    return `${this.actionId} failed: ${this.code}${status}${advice}`
  }
}

/** `text` ending in a period (a truncated `...` summary already does). */
const sentence = (text: string): string => (text.endsWith('.') ? text : `${text}.`)

/**
 * Removing what a write case created failed, or a create succeeded without an id so nothing could
 * be removed automatically. `caseOutcome` says whether the claim itself held before the restore;
 * `claimFailure` is a sanitized summary of why it failed. The item may or may not still exist:
 * check it, and remove it by hand only if it does.
 */
export class MicrosoftConformanceRestoreFailed extends Data.TaggedError(
  'MicrosoftConformanceRestoreFailed'
)<{
  readonly caseId: string
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

    // Conformance reports cap failure messages at 300 characters: the advice comes first so it
    // always survives, and each summary is capped at `failureSummaryLength`.
    return `${this.caseId}: restore failed; ${restoreByHandAdvice} Restore error: ${sentence(this.reason)} ${claim}`
  }
}

export type MicrosoftConformanceError =
  | ConformanceMismatch
  | ConnectorError
  | MicrosoftConformanceActionFailed
  | MicrosoftConformanceRestoreFailed

/** What every Microsoft conformance case requires from the host. */
export type MicrosoftConformanceRequirements =
  | ConnectorHttpClient
  | CredentialResolver
  | MicrosoftConformanceConfig

export type MicrosoftConformanceCase = ConformanceCase<
  MicrosoftConformanceError,
  MicrosoftConformanceRequirements
>

const integration = microsoftConformanceIntegration

/** Synthetic marker every case-created item carries in its subject or name. */
export const microsoftConformanceMarker = 'yolk-conformance'

const requireSeed = <K extends MicrosoftConformanceSeedKey>(key: K) =>
  Effect.gen(function* () {
    const seeds = yield* MicrosoftConformanceConfig
    const value = seeds[key]

    if (value === undefined) {
      return yield* new ConformanceMismatch({
        message: `precondition: MicrosoftConformanceConfig.${key} is not configured`
      })
    }

    return value
  })

const optionalSeed = <K extends MicrosoftConformanceSeedKey>(key: K) =>
  Effect.gen(function* () {
    const seeds = yield* MicrosoftConformanceConfig

    return seeds[key]
  })

const successValue = <A>(
  actionId: string,
  result: ActionResult<A>
): Effect.Effect<A, MicrosoftConformanceActionFailed> => {
  if (Predicate.isTagged(result, 'Success')) {
    return Effect.succeed(result.value)
  }

  const { code, status } = result.error

  return Effect.fail(
    status === undefined
      ? new MicrosoftConformanceActionFailed({ actionId, code })
      : new MicrosoftConformanceActionFailed({ actionId, code, status })
  )
}

/** `'success'`, or the HTTP status of a failed result (`'no-status'` when it has none). */
const outcomeStatus = <A>(result: ActionResult<A>): number | 'success' | 'no-status' =>
  Predicate.isTagged(result, 'Success') ? 'success' : (result.error.status ?? 'no-status')

/** Longest failure summary embedded in a `MicrosoftConformanceRestoreFailed` message. */
const failureSummaryLength = 60

/** `text` cut to `length` characters, ending in `...` when cut. */
const truncated = (text: string, length: number): string =>
  text.length > length ? `${text.slice(0, length - 3).trimEnd()}...` : text

/**
 * `actionId code status` of a failed action, cut in front of the status so the status always
 * survives the cap.
 */
const actionFailureSummary = (error: MicrosoftConformanceActionFailed): string => {
  const status = error.status === undefined ? '' : ` ${error.status}`

  return `${truncated(sanitizeConformanceMessage(`${error.actionId} ${error.code}`), failureSummaryLength - status.length)}${status}`
}

/** Short, sanitized `Tag: message` summary of a failure (credential patterns redacted). */
const failureSummary = (cause: Cause.Cause<unknown>): string => {
  if (Cause.hasInterruptsOnly(cause)) {
    return 'interrupted'
  }

  const error = Cause.findErrorOption(cause)
  const value = Option.isSome(error) ? error.value : Cause.squash(cause)

  if (value instanceof MicrosoftConformanceActionFailed) {
    return actionFailureSummary(value)
  }

  const tag = Predicate.hasProperty(value, '_tag') ? String(value._tag) : 'defect'
  const message = Predicate.hasProperty(value, 'message') ? String(value.message) : ''

  // A mismatch message is case-authored and self-explanatory; other failures keep their tag.
  const raw =
    message.length === 0
      ? tag
      : value instanceof ConformanceMismatch
        ? message
        : `${tag}: ${message}`

  return truncated(sanitizeConformanceMessage(raw), failureSummaryLength)
}

/**
 * The ids a write case must remove. The restore removes every id still pending; a case drops an id
 * only once it has itself verified that the item is gone.
 */
type PendingIds = Ref.Ref<ReadonlyArray<string>>

/** How a write case creates its own item. */
interface OwnItem<T, E, R> {
  /** The action (or raw calendar request) id the create reports failures under. */
  readonly actionId: string
  /** Creates the item remotely and decodes the response. */
  readonly create: Effect.Effect<T, E, R>
  /** The id of the created item, or `undefined` when the create response carries none. */
  readonly idOf: (created: T) => string | undefined
}

/**
 * An ambiguous create failure (transport or decoding failure, no status, or HTTP 5xx) as a
 * `MicrosoftConformanceActionFailed` with `createOutcome: 'unknown'`, keeping its code and status;
 * `undefined` for a failure that proves nothing was created.
 */
const ambiguousCreateFailure = (
  actionId: string,
  error: unknown
): MicrosoftConformanceActionFailed | undefined => {
  if (error instanceof MicrosoftConformanceActionFailed) {
    if (error.status === undefined) {
      return new MicrosoftConformanceActionFailed({
        actionId: error.actionId,
        code: error.code,
        createOutcome: 'unknown'
      })
    }

    return error.status >= 500
      ? new MicrosoftConformanceActionFailed({
          actionId: error.actionId,
          code: error.code,
          status: error.status,
          createOutcome: 'unknown'
        })
      : undefined
  }

  if (
    error instanceof ConnectorError &&
    (error.cause === 'transport_failed' || error.cause === 'validation_failed')
  ) {
    return new MicrosoftConformanceActionFailed({
      actionId,
      code: error.cause,
      createOutcome: 'unknown'
    })
  }

  return undefined
}

/**
 * Create a case-owned item, run `use`, then ALWAYS remove whatever is still pending.
 *
 * The create request, its decoding, and the registration of the id in `pending` run
 * uninterruptibly, so an interruption cannot land between the remote create and the registration
 * the restore relies on (the create itself cannot be interrupted, and there is no request
 * timeout); `use` (the claims) runs interruptibly again. An ambiguous create failure (transport or
 * decoding failure, no status, or HTTP 5xx) may still have created the item: it fails as a
 * `MicrosoftConformanceActionFailed` with `createOutcome: 'unknown'` whose message carries the
 * manual-recovery advice. The restore runs uninterruptibly after `use` succeeds, fails, or is
 * interrupted, and does nothing once `pending` is empty. A failed restore fails the case with `MicrosoftConformanceRestoreFailed`, which says
 * whether the claim itself held and, if not, summarizes why; otherwise the outcome of `use`
 * (including an interruption) is returned unchanged. A create that succeeds without an id leaves
 * nothing to remove automatically: it fails with `MicrosoftConformanceRestoreFailed` too, so the
 * item is removed by hand.
 */
const withOwnItem = <T, A, E1, R1, E, R, E2, R2>(
  caseId: string,
  item: OwnItem<T, E1, R1>,
  use: (created: T, id: string, pending: PendingIds) => Effect.Effect<A, E, R>,
  remove: (ids: ReadonlyArray<string>) => Effect.Effect<void, E2, R2>
): Effect.Effect<
  A,
  E1 | E | MicrosoftConformanceActionFailed | MicrosoftConformanceRestoreFailed,
  R1 | R | R2
> =>
  Effect.gen(function* () {
    const pending: PendingIds = yield* Ref.make<ReadonlyArray<string>>([])

    return yield* Effect.uninterruptibleMask(unmask =>
      Effect.gen(function* () {
        const created = yield* item.create.pipe(
          Effect.mapError(error => ambiguousCreateFailure(item.actionId, error) ?? error)
        )

        const id = item.idOf(created)

        if (id === undefined) {
          return yield* new MicrosoftConformanceRestoreFailed({
            caseId,
            reason: 'the create response carried no id, so nothing was removed',
            caseOutcome: 'claim failed'
          })
        }

        yield* Ref.set(pending, [id])

        const outcome = yield* Effect.exit(unmask(use(created, id, pending)))

        const restored = yield* Effect.exit(
          Ref.get(pending).pipe(
            Effect.flatMap(ids => (ids.length === 0 ? Effect.void : remove(ids)))
          )
        )

        if (Exit.isFailure(restored)) {
          return yield* Exit.isSuccess(outcome)
            ? new MicrosoftConformanceRestoreFailed({
                caseId,
                reason: failureSummary(restored.cause),
                caseOutcome: 'claim held'
              })
            : new MicrosoftConformanceRestoreFailed({
                caseId,
                reason: failureSummary(restored.cause),
                caseOutcome: 'claim failed',
                claimFailure: failureSummary(outcome.cause)
              })
        }

        return yield* outcome
      })
    )
  })

// Calendar: raw Graph requests (the connector has no calendar actions yet).

const calendarTarget = Effect.gen(function* () {
  const target: CalendarTarget = {
    integration,
    mailbox: yield* optionalSeed('mailbox'),
    calendarId: yield* optionalSeed('calendarId')
  }

  return target
})

/** Page size for the seeded calendar range. */
const calendarPageSize = 50

const seededRange = Effect.gen(function* () {
  const start = yield* requireSeed('calendarRangeStart')
  const end = yield* requireSeed('calendarRangeEnd')
  const startInstant = isoInstant(start)
  const endInstant = isoInstant(end)

  if (
    startInstant === undefined ||
    endInstant === undefined ||
    !isBefore(startInstant, endInstant)
  ) {
    return yield* new ConformanceMismatch({
      message: 'precondition: calendarRangeStart must be an ISO UTC instant before calendarRangeEnd'
    })
  }

  return { start, end, startInstant, endInstant }
})

/** The first page of the seeded range, plus the seeded event id. */
const seededRangeEvents = (target: CalendarTarget) =>
  Effect.gen(function* () {
    const range = yield* seededRange
    const eventId = yield* requireSeed('calendarEventId')

    const page = yield* listCalendarRange(target, {
      start: range.start,
      end: range.end,
      top: calendarPageSize
    }).pipe(Effect.flatMap(result => successValue(calendarActionIds.listRange, result)))

    return { range, eventId, page }
  })

export const microsoftCalendarListRangeCase: MicrosoftConformanceCase = defineConformanceCase({
  id: 'microsoft.calendar.list-range-returns-events',
  title: 'A calendar view over a populated range returns its events',
  safety: 'read',
  docs: 'GET /users/{id}/calendars/{id}/calendarView?startDateTime=&endDateTime= returns the occurrences, exceptions, and single instances of events in the range as a `value` array. The connector has no calendar actions yet; this case sends the raw Graph request through the connector ports.',
  wire: 'A range the host seeded with a known event answers 200 with a non-empty `value` that contains that event (an empty 200 for a populated range is the failure mode this case watches for), and every returned event overlaps the requested range when its `start`/`end` are read as UTC instants (`Prefer: outlook.timezone="UTC"`). The seeded event must be among the first 50 events of the range.',
  fixtures: [microsoftCalendarListRangeFixture.id],
  run: Effect.gen(function* () {
    const target = yield* calendarTarget
    const { range, eventId, page } = yield* seededRangeEvents(target)
    const events = page.value

    yield* expectConformance(
      events.length > 0,
      'expected the seeded calendar range to return events; Graph answered an empty success for a populated range',
      { actual: 0 }
    )

    if (!events.some(event => event.id === eventId)) {
      return yield* new ConformanceMismatch({
        message:
          page['@odata.nextLink'] === undefined
            ? 'expected the seeded calendarEventId among the events of the seeded range'
            : 'precondition: the seeded calendarEventId is not among the first 50 events of the range; narrow the range'
      })
    }

    const outside = events.filter(event => {
      const start = graphInstant(event.start)
      const end = graphInstant(event.end)

      return (
        start === undefined ||
        end === undefined ||
        !isBefore(start, range.endInstant) ||
        !isBefore(range.startInstant, end)
      )
    })

    yield* expectConformance(
      outside.length === 0,
      'expected every returned event to overlap the requested range as UTC instants',
      { actual: outside.map(event => event.id ?? null) }
    )
  })
})

export const microsoftCalendarTimestampPrecisionCase: MicrosoftConformanceCase =
  defineConformanceCase({
    id: 'microsoft.calendar.timestamp-precision',
    title: 'Event times carry seven fractional digits and name the seeded instant',
    safety: 'read',
    docs: 'Event `start`/`end` are `dateTimeTimeZone` values: a `dateTime` without offset plus a separate `timeZone`. The docs do not pin the fractional-second format. The connector has no calendar actions yet and performs no instant comparison; this case pins the format for hosts and future calendar actions.',
    wire: 'Under `Prefer: outlook.timezone="UTC"` Graph returns `dateTime` with seven fractional digits and no offset (`2026-09-23T12:00:00.0000000`) and `timeZone: "UTC"`. That string differs from the ISO-8601 instant the host seeded for the event (`2026-09-23T12:00:00Z`) yet names the same instant, and GET of the same event names the same start and end instants as the calendar view. Compare parsed instants (to 100 ns), never strings.',
    fixtures: [microsoftCalendarTimestampPrecisionFixture.id],
    run: Effect.gen(function* () {
      const target = yield* calendarTarget
      const seededStart = yield* requireSeed('calendarEventStart')
      const { eventId, page } = yield* seededRangeEvents(target)
      const listed = page.value.find(event => event.id === eventId)

      if (listed === undefined) {
        return yield* new ConformanceMismatch({
          message:
            'precondition: the seeded calendarEventId is not among the first 50 events of the seeded range'
        })
      }

      const listedStart = listed.start

      yield* expectConformance(
        listedStart !== undefined &&
          graphSevenDigitDateTimePattern.test(listedStart.dateTime) &&
          listedStart.timeZone.toUpperCase() === 'UTC',
        'expected the calendar view start as a seven-digit fractional dateTime in UTC',
        { actual: listedStart?.dateTime ?? null }
      )
      yield* expectConformance(
        sameInstant(graphInstant(listedStart), isoInstant(seededStart)),
        'expected the calendar view start to name the seeded calendarEventStart instant',
        { expected: seededStart, actual: listedStart?.dateTime ?? null }
      )

      const fetched = yield* getCalendarEvent(target, eventId).pipe(
        Effect.flatMap(result => successValue(calendarActionIds.get, result))
      )

      yield* expectConformance(
        fetched.start !== undefined && graphSevenDigitDateTimePattern.test(fetched.start.dateTime),
        'expected GET of the event to return a seven-digit fractional start dateTime',
        { actual: fetched.start?.dateTime ?? null }
      )
      yield* expectConformance(
        sameInstant(graphInstant(fetched.start), graphInstant(listedStart)) &&
          sameInstant(graphInstant(fetched.end), graphInstant(listed.end)),
        'expected GET of the event and the calendar view to name the same start and end instants',
        { expected: listedStart?.dateTime ?? null, actual: fetched.start?.dateTime ?? null }
      )
    })
  })

/** Remove an event that may still exist, then verify GET answers 404. */
const ensureEventAbsent = (target: CalendarTarget, eventId: string) =>
  Effect.gen(function* () {
    const deleted = yield* deleteCalendarEvent(target, eventId)
    const deleteStatus = outcomeStatus(deleted)

    if (deleteStatus !== 'success' && deleteStatus !== 404) {
      return yield* successValue(calendarActionIds.delete, deleted).pipe(Effect.asVoid)
    }

    yield* expectEqual(
      outcomeStatus(yield* getCalendarEvent(target, eventId)),
      404,
      'expected GET of the case-created event to answer 404 after restoring'
    )
  })

/** Remove every pending case-created event. */
const ensureEventsAbsent = (target: CalendarTarget) => (eventIds: ReadonlyArray<string>) =>
  Effect.forEach(eventIds, eventId => ensureEventAbsent(target, eventId), { discard: true })

const eventIdOf = (event: GraphEvent) => (isNonEmptyString(event.id) ? event.id : undefined)

const createEventCaseId = 'microsoft.calendar.create-returns-event-id'

const createEventSubject = `${microsoftConformanceMarker} event: safe to delete`

const updatedEventSubject = `${microsoftConformanceMarker} event (updated): safe to delete`

export const microsoftCalendarCreateEventCase: MicrosoftConformanceCase = defineConformanceCase({
  id: createEventCaseId,
  title: 'Creating an event returns an id that works for get, update, and delete',
  safety: 'write-reversible',
  docs: 'POST /users/{id}/calendars/{id}/events answers 201 Created with the new event object, including its `id`. The connector has no calendar actions yet; this case sends the raw Graph requests through the connector ports.',
  wire: 'The 201 body carries a non-empty `id`; GET with that id returns the same event and subject, PATCH with it returns the updated subject, DELETE with it answers 204, and a later GET answers 404. The case creates its own attendee-free, reminder-free event (so no invitation is sent) and removes it again even when a step fails.',
  fixtures: [microsoftCalendarCreateEventFixture.id],
  run: Effect.gen(function* () {
    const target = yield* calendarTarget

    yield* withOwnItem(
      createEventCaseId,
      {
        actionId: calendarActionIds.create,
        create: createCalendarEvent(target, {
          subject: createEventSubject,
          body: 'Synthetic conformance event; safe to delete.',
          startUtc: '2026-01-05T09:00:00',
          endUtc: '2026-01-05T09:30:00'
        }).pipe(Effect.flatMap(result => successValue(calendarActionIds.create, result))),
        idOf: eventIdOf
      },
      (_created, eventId, pending) =>
        Effect.gen(function* () {
          const fetched = yield* getCalendarEvent(target, eventId).pipe(
            Effect.flatMap(result => successValue(calendarActionIds.get, result))
          )

          yield* expectEqual(
            fetched.id ?? null,
            eventId,
            'expected GET with the created id to return that event'
          )
          yield* expectEqual(
            fetched.subject ?? null,
            createEventSubject,
            'expected GET with the created id to return the created subject'
          )

          const updated = yield* updateCalendarEventSubject(
            target,
            eventId,
            updatedEventSubject
          ).pipe(Effect.flatMap(result => successValue(calendarActionIds.update, result)))

          yield* expectEqual(
            updated.subject ?? null,
            updatedEventSubject,
            'expected PATCH with the created id to return the updated subject'
          )

          yield* deleteCalendarEvent(target, eventId).pipe(
            Effect.flatMap(result => successValue(calendarActionIds.delete, result))
          )

          // Still pending until GET proves the removal: a DELETE success that leaves the event
          // readable must still reach the restore.
          yield* expectEqual(
            outcomeStatus(yield* getCalendarEvent(target, eventId)),
            404,
            'expected GET with the created id to answer 404 after DELETE'
          )
          yield* Ref.set(pending, [])
        }),
      ensureEventsAbsent(target)
    )
  })
})

const cancelCaseId = 'microsoft.calendar.cancel-semantics'

const cancelEventSubject = `${microsoftConformanceMarker} cancel probe: safe to delete`

export const microsoftCalendarCancelCase: MicrosoftConformanceCase = defineConformanceCase({
  id: cancelCaseId,
  title: 'Cancelling an event removes it; a later delete is a no-op or 404',
  safety: 'write-reversible',
  docs: 'POST /users/{id}/events/{id}/cancel lets the organizer send a cancellation and cancel the event; it answers 202 Accepted. The docs do not say what GET and DELETE return afterwards. The connector has no calendar actions yet; this case sends the raw Graph requests through the connector ports.',
  wire: 'On its own created event, cancel answers 2xx; afterwards GET of the event answers 404 (cancel removes the event rather than leaving it with `isCancelled: true`), and DELETE is then a no-op success or 404. The event has no attendees, so no cancellation message is sent; whether Graph accepts cancel for an attendee-free event is part of what a live run establishes. The case removes the event itself whenever cancel did not.',
  fixtures: [microsoftCalendarCancelFixture.id],
  run: Effect.gen(function* () {
    const target = yield* calendarTarget

    yield* withOwnItem(
      cancelCaseId,
      {
        actionId: calendarActionIds.create,
        create: createCalendarEvent(target, {
          subject: cancelEventSubject,
          body: 'Synthetic conformance event; cancelled by the case.',
          startUtc: '2026-01-05T10:00:00',
          endUtc: '2026-01-05T10:30:00'
        }).pipe(Effect.flatMap(result => successValue(calendarActionIds.create, result))),
        idOf: eventIdOf
      },
      (_created, eventId, pending) =>
        Effect.gen(function* () {
          yield* cancelCalendarEvent(target, eventId, 'Synthetic conformance cancellation.').pipe(
            Effect.flatMap(result => successValue(calendarActionIds.cancel, result))
          )

          yield* expectEqual(
            outcomeStatus(yield* getCalendarEvent(target, eventId)),
            404,
            'expected GET to answer 404 after cancel (cancel removes the event)'
          )

          const deleteStatus = outcomeStatus(yield* deleteCalendarEvent(target, eventId))

          yield* expectConformance(
            deleteStatus === 'success' || deleteStatus === 404,
            'expected DELETE after cancel to be a no-op success or 404',
            { actual: deleteStatus }
          )
          yield* Ref.set(pending, [])
        }),
      ensureEventsAbsent(target)
    )
  })
})

// Outlook mail: connector actions.

const listAttachments = (messageId: string, mailbox: string | undefined) =>
  outlookListAttachmentsAction
    .executeTyped({
      integration,
      input: OutlookListAttachmentsInput.make({ messageId, mailbox })
    })
    .pipe(Effect.flatMap(result => successValue(outlookListAttachmentsAction.id, result)))

const getAttachment = (messageId: string, attachmentId: string, mailbox: string | undefined) =>
  outlookGetAttachmentAction
    .executeTyped({
      integration,
      input: OutlookGetAttachmentInput.make({ messageId, attachmentId, mailbox })
    })
    .pipe(Effect.flatMap(result => successValue(outlookGetAttachmentAction.id, result)))

/** The first attachment page of the seeded message (a seeded message fits on one page). */
const seededAttachments = Effect.gen(function* () {
  const messageId = yield* requireSeed('attachmentMessageId')
  const mailbox = yield* optionalSeed('mailbox')
  const listed = yield* listAttachments(messageId, mailbox)

  return { messageId, mailbox, attachments: Chunk.toReadonlyArray(listed.attachments) }
})

const isInlineFile = (attachment: OutlookAttachmentMetadata) =>
  attachment.kind === 'file' && attachment.isInline === true

export const microsoftOutlookAttachmentsListingCase: MicrosoftConformanceCase =
  defineConformanceCase({
    id: 'microsoft.outlook.attachments-listing',
    title: 'Attachment listing returns retrievable ids, including inline attachments',
    safety: 'read',
    docs: 'GET /users/{id}/messages/{id}/attachments lists the attachments of a message; the message `hasAttachments` flag is false for messages that only have inline attachments.',
    wire: '`outlook.list_attachments` on a message with an inline and a regular file attachment returns one entry per attachment with its `id` (not only a count), inline attachments included (`isInline: true`), and every listed file attachment id retrieves the same attachment through `outlook.get_attachment`.',
    fixtures: [microsoftOutlookAttachmentsListingFixture.id],
    run: Effect.gen(function* () {
      const { messageId, mailbox, attachments } = yield* seededAttachments
      const files = attachments.filter(attachment => attachment.kind === 'file')

      yield* expectConformance(
        attachments.length > 0 && attachments.every(attachment => isNonEmptyString(attachment.id)),
        'expected the listing to return attachment ids, not only a count',
        { actual: attachments.length }
      )
      yield* expectConformance(
        attachments.some(isInlineFile),
        'expected the listing to include the inline file attachment (isInline true)'
      )
      yield* expectConformance(
        files.some(attachment => attachment.isInline !== true),
        'precondition: the attachment message needs a regular (non-inline) file attachment'
      )

      for (const listed of files) {
        const { attachment } = yield* getAttachment(messageId, listed.id, mailbox)

        yield* expectEqual(
          attachment.id,
          listed.id,
          'expected the listed id to retrieve the same file attachment'
        )
        yield* expectEqual(
          attachment.isInline ?? null,
          listed.isInline ?? null,
          'expected retrieval to agree with the listing on isInline'
        )
      }
    })
  })

export const microsoftOutlookAttachmentContentIdCase: MicrosoftConformanceCase =
  defineConformanceCase({
    id: 'microsoft.outlook.attachment-content-id',
    title: 'Only individual retrieval provides an inline attachment contentId',
    safety: 'read',
    docs: '`contentId` is a `fileAttachment` property, not a property of the base `attachment` type that the polymorphic attachment collection is selected on.',
    wire: '`outlook.list_attachments` selects base attachment properties only, so no listed attachment carries `contentId`, inline ones included; `outlook.get_attachment` for the inline file attachment returns a non-empty `contentId` for mapping `cid:` references.',
    fixtures: [microsoftOutlookAttachmentContentIdFixture.id],
    run: Effect.gen(function* () {
      const { messageId, mailbox, attachments } = yield* seededAttachments
      const inline = attachments.find(isInlineFile)

      if (inline === undefined) {
        return yield* new ConformanceMismatch({
          message: 'precondition: the attachment message needs an inline file attachment'
        })
      }

      yield* expectConformance(
        attachments.every(attachment => attachment.contentId === undefined),
        'expected no contentId in the attachment listing (base properties only)'
      )

      const { attachment } = yield* getAttachment(messageId, inline.id, mailbox)

      yield* expectConformance(
        isNonEmptyString(attachment.contentId),
        'expected file attachment retrieval to return the inline contentId'
      )
    })
  })

/** Page size for the paging case; the seeded folder holds more messages than this. */
const pagingPageSize = 2

const listFolderPage = (input: {
  readonly mailbox: string | undefined
  readonly folderId: string
  readonly nextLink?: string
}) =>
  outlookListMessagesAction
    .executeTyped({
      integration,
      input: OutlookListMessagesInput.make(
        input.nextLink === undefined
          ? { mailbox: input.mailbox, folderId: input.folderId, top: pagingPageSize }
          : { mailbox: input.mailbox, folderId: input.folderId, nextLink: input.nextLink }
      )
    })
    .pipe(Effect.flatMap(result => successValue(outlookListMessagesAction.id, result)))

export const microsoftOutlookPagingNextLinkCase: MicrosoftConformanceCase = defineConformanceCase({
  id: 'microsoft.outlook.paging-next-link',
  title: 'A folder larger than the page size returns a usable nextLink',
  safety: 'read',
  docs: 'List responses page with `$top` and return `@odata.nextLink` when more results exist; clients follow the link unchanged.',
  wire: '`outlook.list_messages` with `top: 2` on a folder seeded with more than two messages returns two messages and a `nextLink` that passes the connector nextLink validation (same Graph origin, mailbox path, and folder path); following it through `outlook.list_messages` returns at least one further message, none repeated from the first page.',
  fixtures: [microsoftOutlookPagingNextLinkFixture.id],
  run: Effect.gen(function* () {
    const folderId = yield* requireSeed('pagingFolderId')
    const mailbox = yield* optionalSeed('mailbox')
    const first = yield* listFolderPage({ mailbox, folderId })

    yield* expectEqual(
      first.messages.length,
      pagingPageSize,
      'precondition: the paging folder needs more than two messages'
    )

    if (first.nextLink === undefined) {
      return yield* new ConformanceMismatch({
        message: `expected @odata.nextLink for a page of ${pagingPageSize} from a folder seeded with more messages`
      })
    }

    const second = yield* listFolderPage({ mailbox, folderId, nextLink: first.nextLink })
    const firstIds = new Set(first.messages.map(message => message.id))

    yield* expectConformance(
      second.messages.length > 0,
      'expected the nextLink page to return further messages'
    )
    yield* expectConformance(
      second.messages.every(message => !firstIds.has(message.id)),
      'expected the nextLink page to repeat no message from the first page'
    )
  })
})

const draftSubject = `${microsoftConformanceMarker} draft: safe to delete`

/** A case-owned, recipient-free draft (never sent). */
const ownDraft = (
  mailbox: string | undefined
): OwnItem<OutlookMessage, MicrosoftConformanceError, MicrosoftConformanceRequirements> => ({
  actionId: outlookCreateDraftAction.id,
  create: outlookCreateDraftAction
    .executeTyped({
      integration,
      input: OutlookComposeInput.make({
        mailbox,
        to: [],
        subject: draftSubject,
        body: 'Synthetic conformance draft; never sent.',
        contentType: 'text'
      })
    })
    .pipe(Effect.flatMap(result => successValue(outlookCreateDraftAction.id, result))),
  idOf: draft => (isNonEmptyString(draft.id) ? draft.id : undefined)
})

/**
 * Permanently delete the pending ids of a case-owned draft (its original id and, if a move
 * changed it, the id it answered with). At least one must be deleted and every other one must no
 * longer exist.
 */
const deleteDraft = (mailbox: string | undefined) => (messageIds: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const output = yield* outlookDeletePermanentlyAction
      .executeTyped({ integration, input: { messageIds, mailbox } })
      .pipe(Effect.flatMap(result => successValue(outlookDeletePermanentlyAction.id, result)))

    const outcomes = messageIds.map(
      messageId => output.results.find(item => item.messageId === messageId) ?? null
    )

    yield* expectConformance(
      outcomes.some(outcome => outcome?.status === 'succeeded') &&
        outcomes.every(
          outcome =>
            outcome?.status === 'succeeded' ||
            (outcome?.status === 'failed' && outcome.code === 'not_found')
        ),
      'expected the case-created draft to be permanently deleted',
      { actual: outcomes.map(outcome => outcome?.code ?? outcome?.status ?? null) }
    )
  })

const immutableIdCaseId = 'microsoft.outlook.immutable-id-survives-move'

export const microsoftOutlookImmutableIdCase: MicrosoftConformanceCase = defineConformanceCase({
  id: immutableIdCaseId,
  title: 'With the immutable-id preference, a moved message keeps its id',
  safety: 'write-reversible',
  docs: 'Outlook item ids change when an item moves to another folder unless the request sends `Prefer: IdType="ImmutableId"`, which returns ids that stay stable across moves within the mailbox.',
  wire: 'The connector sends `Prefer: IdType="ImmutableId"` on Outlook reads and draft/message writes. A draft created by `outlook.create_draft` and moved to Deleted Items by `outlook.trash` comes back with the SAME id and a different `parentFolderId`, and `outlook.set_read` with the original id still addresses it. The case creates its own recipient-free draft and permanently deletes it again (`outlook.delete_permanently`).',
  fixtures: [microsoftOutlookImmutableIdFixture.id],
  run: Effect.gen(function* () {
    const mailbox = yield* optionalSeed('mailbox')

    yield* withOwnItem(
      immutableIdCaseId,
      ownDraft(mailbox),
      (draft, id, pending) =>
        Effect.gen(function* () {
          // The move request, its decoding, and the registration of the id it answered with run
          // uninterruptibly, BEFORE asserting the id is unchanged: if the move changed the id, the
          // restore must also remove the draft under its new id, even after an interruption.
          const moved = yield* Effect.uninterruptible(
            outlookTrashAction
              .executeTyped({
                integration,
                input: OutlookTrashInput.make({ messageId: id, mailbox })
              })
              .pipe(
                Effect.flatMap(result => successValue(outlookTrashAction.id, result)),
                Effect.tap(({ id: movedId }) =>
                  isNonEmptyString(movedId) && movedId !== id
                    ? Ref.update(pending, ids => [...ids, movedId])
                    : Effect.void
                )
              )
          )

          yield* expectEqual(moved.id, id, 'expected the moved message to keep its immutable id')
          yield* expectConformance(
            isNonEmptyString(moved.parentFolderId) && moved.parentFolderId !== draft.parentFolderId,
            'expected the move to change parentFolderId (the draft actually moved)'
          )

          const touched = yield* outlookSetReadAction
            .executeTyped({
              integration,
              input: OutlookSetReadInput.make({ messageId: id, mailbox, isRead: true })
            })
            .pipe(Effect.flatMap(result => successValue(outlookSetReadAction.id, result)))

          yield* expectEqual(
            touched.id,
            id,
            'expected the original id to still address the moved message'
          )
        }),
      deleteDraft(mailbox)
    )
  })
})

const concurrentCaseId = 'microsoft.outlook.concurrent-writes-same-message'

const concurrentSubjects: ReadonlyArray<string> = [
  `${microsoftConformanceMarker} concurrent write A`,
  `${microsoftConformanceMarker} concurrent write B`
]

/** HTTP statuses a losing concurrent write may answer with. */
const concurrentLosingStatuses: ReadonlyArray<number> = [404, 409]

export const microsoftOutlookConcurrentWritesCase: MicrosoftConformanceCase = defineConformanceCase(
  {
    id: concurrentCaseId,
    title: 'Two concurrent writes to one message: one wins, a loser fails with 409 or 404',
    safety: 'write-reversible',
    docs: 'Graph does not document how concurrent updates of one message resolve; Exchange rejects an update whose change key no longer matches the item.',
    wire: 'Two `outlook.update_draft` PATCHes of one draft sent at once (`Effect.all` with concurrency 2) never both fail: at least one succeeds and returns one of the two sent subjects, and a losing request, if any, fails with HTTP 409 (for example `ErrorIrresolvableConflict`) or 404, never a 5xx or another status. The connector neither retries nor offers compare-and-swap, so hosts must serialize competing writes. The case creates its own recipient-free draft and permanently deletes it again.',
    fixtures: [microsoftOutlookConcurrentWritesFixture.id],
    run: Effect.gen(function* () {
      const mailbox = yield* optionalSeed('mailbox')

      yield* withOwnItem(
        concurrentCaseId,
        ownDraft(mailbox),
        (_draft, id) =>
          Effect.gen(function* () {
            const outcomes = yield* Effect.all(
              concurrentSubjects.map(subject =>
                outlookUpdateDraftAction.executeTyped({
                  integration,
                  input: { messageId: id, mailbox, subject }
                })
              ),
              { concurrency: 2 }
            )

            const winners = outcomes.flatMap(outcome =>
              Predicate.isTagged(outcome, 'Success') ? [outcome.value] : []
            )

            const losers = outcomes.flatMap(outcome =>
              Predicate.isTagged(outcome, 'Failure') ? [outcome.error.status ?? null] : []
            )

            yield* expectConformance(
              winners.length > 0,
              'expected at least one of two concurrent writes to succeed',
              { actual: losers }
            )
            yield* expectConformance(
              losers.every(status => status !== null && concurrentLosingStatuses.includes(status)),
              'expected a losing concurrent write to fail with HTTP 409 or 404',
              { actual: losers }
            )
            yield* expectConformance(
              winners.every(
                winner =>
                  Predicate.isString(winner.subject) && concurrentSubjects.includes(winner.subject)
              ),
              'expected every winning write to return one of the two sent subjects'
            )
          }),
        deleteDraft(mailbox)
      )
    })
  }
)

// OneDrive: connector actions.

/** Children page size, and the page cap when looking for an item among a folder's children. */
const childrenPageSize = 200

const childrenPageCap = 10

/** Every child of a folder, following `nextLink` (bounded by `childrenPageCap`). */
const listChildren = (driveId: string | undefined, parentItemId: string) =>
  Effect.gen(function* () {
    const items: Array<OneDriveItem> = []
    let nextLink: string | undefined

    for (let page = 1; ; page++) {
      const listed = yield* oneDriveListItemsAction
        .executeTyped({
          integration,
          input: OneDriveListItemsInput.make(
            nextLink === undefined
              ? { driveId, parentItemId, top: childrenPageSize }
              : { driveId, parentItemId, nextLink }
          )
        })
        .pipe(Effect.flatMap(result => successValue(oneDriveListItemsAction.id, result)))

      items.push(...listed.items)
      nextLink = listed.nextLink

      if (nextLink === undefined) {
        return items
      }

      if (page >= childrenPageCap) {
        return yield* new ConformanceMismatch({
          message: `precondition: the folder spans more than ${childrenPageCap} pages of ${childrenPageSize} children; use a smaller parent folder`
        })
      }
    }
  })

const createOwnFolder = (driveId: string | undefined, parentItemId: string, name: string) =>
  Effect.gen(function* () {
    const created = yield* oneDriveCreateFolderAction.executeTyped({
      integration,
      input: OneDriveCreateFolderInput.make({
        name,
        driveId,
        parentItemId,
        conflictBehavior: 'fail'
      })
    })

    if (Predicate.isTagged(created, 'Failure') && created.error.status === 409) {
      return yield* new ConformanceMismatch({
        message: `precondition: a folder named "${name}" already exists under driveParentItemId (left by an earlier run?); delete it by hand`
      })
    }

    return yield* successValue(oneDriveCreateFolderAction.id, created)
  })

const getDriveItem = (driveId: string | undefined, itemId: string) =>
  oneDriveGetItemAction.executeTyped({
    integration,
    input: OneDriveItemIdInput.make({ itemId, driveId })
  })

const deleteDriveItem = (driveId: string | undefined, itemId: string) =>
  oneDriveDeleteItemAction.executeTyped({
    integration,
    input: OneDriveDeleteItemInput.make({ itemId, driveId })
  })

/** Remove every pending case-created folder. */
const ensureDriveItemsAbsent = (driveId: string | undefined) => (itemIds: ReadonlyArray<string>) =>
  Effect.forEach(itemIds, itemId => ensureDriveItemAbsent(driveId, itemId), { discard: true })

/** A case-owned folder under the seeded parent. */
const ownFolder = (
  driveId: string | undefined,
  parentItemId: string,
  name: string
): OwnItem<OneDriveItem, MicrosoftConformanceError, MicrosoftConformanceRequirements> => ({
  actionId: oneDriveCreateFolderAction.id,
  create: createOwnFolder(driveId, parentItemId, name),
  idOf: folder => (isNonEmptyString(folder.id) ? folder.id : undefined)
})

/** Remove a case-created folder that may still exist, then verify GET answers 404. */
const ensureDriveItemAbsent = (driveId: string | undefined, itemId: string) =>
  Effect.gen(function* () {
    const deleted = yield* deleteDriveItem(driveId, itemId)
    const deleteStatus = outcomeStatus(deleted)

    if (deleteStatus !== 'success' && deleteStatus !== 404) {
      return yield* successValue(oneDriveDeleteItemAction.id, deleted).pipe(Effect.asVoid)
    }

    yield* expectEqual(
      outcomeStatus(yield* getDriveItem(driveId, itemId)),
      404,
      'expected GET of the case-created folder to answer 404 after restoring'
    )
  })

const createFolderCaseId = 'microsoft.onedrive.create-folder-roundtrip'

const roundtripFolderName = `${microsoftConformanceMarker}-folder`

export const microsoftOneDriveCreateFolderCase: MicrosoftConformanceCase = defineConformanceCase({
  id: createFolderCaseId,
  title: 'A created folder is listed under its parent and deletes cleanly',
  safety: 'write-reversible',
  docs: 'POST /drives/{id}/items/{parent}/children with a `folder` facet creates a folder (201) and honors `@microsoft.graph.conflictBehavior`; DELETE moves the item to the recycle bin (204).',
  wire: '`onedrive.create_folder` (conflict behavior `fail`) under the seeded parent returns a folder item with an id; `onedrive.list_items` of the parent lists that id; `onedrive.delete_item` succeeds; afterwards `onedrive.get_item` answers 404. The case creates its own folder and removes it again even when a step fails (the removed folder stays in the recycle bin).',
  fixtures: [microsoftOneDriveCreateFolderFixture.id],
  run: Effect.gen(function* () {
    const parentItemId = yield* requireSeed('driveParentItemId')
    const driveId = yield* optionalSeed('driveId')

    yield* withOwnItem(
      createFolderCaseId,
      ownFolder(driveId, parentItemId, roundtripFolderName),
      (folder, _folderId, pending) =>
        Effect.gen(function* () {
          yield* expectConformance(
            folder.folder !== undefined && folder.name === roundtripFolderName,
            'expected the created item to be a folder with the requested name'
          )

          const children = yield* listChildren(driveId, parentItemId)

          yield* expectConformance(
            children.some(child => child.id === folder.id),
            'expected the parent listing to include the created folder id'
          )

          yield* deleteDriveItem(driveId, folder.id).pipe(
            Effect.flatMap(result => successValue(oneDriveDeleteItemAction.id, result))
          )

          // Still pending until GET proves the removal: a DELETE success that leaves the folder
          // readable must still reach the restore.
          yield* expectEqual(
            outcomeStatus(yield* getDriveItem(driveId, folder.id)),
            404,
            'expected GET of the deleted folder to answer 404'
          )
          yield* Ref.set(pending, [])
        }),
      ensureDriveItemsAbsent(driveId)
    )
  })
})

const copyCaseId = 'microsoft.onedrive.copy-accepted-monitor'

const copyFolderName = `${microsoftConformanceMarker}-copy`

/** Status polls before the case gives up on a copy, and the pause between them. */
const copyPollCap = 10

const copyPollInterval = Duration.seconds(1)

const terminalCopyStatuses: ReadonlyArray<string> = ['completed', 'failed']

export const microsoftOneDriveCopyMonitorCase: MicrosoftConformanceCase = defineConformanceCase({
  id: copyCaseId,
  title: 'A copy is accepted with one monitor Location and completes',
  safety: 'write-reversible',
  docs: 'POST /drives/{id}/items/{id}/copy answers 202 Accepted with a `Location` header naming a monitor URL; the copy runs asynchronously and the monitor reports its progress.',
  wire: '`onedrive.copy_item` into the case-owned folder answers 202 with exactly one monitor `Location` the connector accepts (a canonical OneDrive or SharePoint monitor URL): acceptance, not completion. Polling it with `onedrive.get_copy_status` (no credentials, no redirects) reaches `completed`, and `onedrive.list_items` of the folder then lists an item with the source name. The case creates its own folder under the seeded parent and deletes it (with the copy) again even when a step fails.',
  fixtures: [microsoftOneDriveCopyMonitorFixture.id],
  run: Effect.gen(function* () {
    const parentItemId = yield* requireSeed('driveParentItemId')
    const driveId = yield* requireSeed('driveId')
    const sourceItemId = yield* requireSeed('copySourceItemId')

    const source = yield* getDriveItem(driveId, sourceItemId).pipe(
      Effect.flatMap(result => successValue(oneDriveGetItemAction.id, result))
    )

    yield* expectConformance(
      source.file !== undefined,
      'precondition: copySourceItemId must be a file'
    )

    yield* withOwnItem(
      copyCaseId,
      ownFolder(driveId, parentItemId, copyFolderName),
      (folder, _folderId) =>
        Effect.gen(function* () {
          const accepted = yield* oneDriveCopyItemAction
            .executeTyped({
              integration,
              input: OneDriveCopyItemInput.make({
                itemId: sourceItemId,
                driveId,
                destinationDriveId: driveId,
                destinationParentItemId: folder.id,
                conflictBehavior: 'fail'
              })
            })
            .pipe(Effect.flatMap(result => successValue(oneDriveCopyItemAction.id, result)))

          let status = 'notStarted'

          for (let poll = 1; poll <= copyPollCap; poll++) {
            const polled = yield* oneDriveGetCopyStatusAction
              .executeTyped({
                integration,
                input: OneDriveCopyStatusInput.make({ monitorUrl: accepted.monitorUrl, driveId })
              })
              .pipe(Effect.flatMap(result => successValue(oneDriveGetCopyStatusAction.id, result)))

            status = polled.status

            if (terminalCopyStatuses.includes(status) || poll === copyPollCap) break

            yield* Effect.sleep(copyPollInterval)
          }

          yield* expectEqual(
            status,
            'completed',
            `expected the copy to complete within ${copyPollCap} status polls`
          )

          const children = yield* listChildren(driveId, folder.id)

          yield* expectConformance(
            children.some(child => child.name === source.name && child.id !== source.id),
            'expected the completed copy in the destination folder under the source name'
          )
        }),
      ensureDriveItemsAbsent(driveId)
    )
  })
})

/** Every Microsoft conformance case, in fixture order. */
export const microsoftConformanceCases: ReadonlyArray<MicrosoftConformanceCase> = [
  microsoftCalendarListRangeCase,
  microsoftCalendarTimestampPrecisionCase,
  microsoftCalendarCreateEventCase,
  microsoftCalendarCancelCase,
  microsoftOutlookAttachmentsListingCase,
  microsoftOutlookAttachmentContentIdCase,
  microsoftOutlookPagingNextLinkCase,
  microsoftOutlookImmutableIdCase,
  microsoftOutlookConcurrentWritesCase,
  microsoftOneDriveCreateFolderCase,
  microsoftOneDriveCopyMonitorCase
]
