/**
 * Google Calendar conformance cases (internal module; exported through `cases.ts`). See `cases.ts`
 * for the write-safety contract every write case follows.
 */
import { Effect, Predicate, Ref } from 'effect'
import {
  ConformanceMismatch,
  defineConformanceCase,
  expectConformance,
  expectEqual
} from '@yolk-sdk/conformance/case'
import type { ActionResult } from '../../result.ts'
import {
  googleCalendarCreateEventAction,
  GoogleCalendarCreateEventInput,
  googleCalendarDeleteEventAction,
  GoogleCalendarDeleteEventInput,
  googleCalendarGetEventAction,
  googleCalendarListEventsAction,
  GoogleCalendarEventIdInput,
  GoogleCalendarListEventsInput,
  googleCalendarUpdateEventAction,
  GoogleCalendarUpdateEventInput,
  type GoogleCalendarEvent,
  type GoogleCalendarEventDateTime
} from '../calendar.ts'
import { calendarDeletedGoneFixture } from './calendar-deleted-gone.ts'
import { calendarEventLifecycleFixture } from './calendar-event-lifecycle.ts'
import { calendarListRangeFixture } from './calendar-list-range.ts'
import { calendarConformanceEventEnd, calendarConformanceEventStart } from './synthetic.ts'
import {
  failureOf,
  googleConformanceIntegration as integration,
  outcomeOf,
  requireSeed,
  runText,
  successValue,
  withOwnedWrite,
  type GoogleConformanceCase,
  type Pending
} from './shared.ts'

/** The instant of a timed boundary in milliseconds, or `null` for an all-day or missing one. */
const instantOf = (boundary: GoogleCalendarEventDateTime | undefined): number | null =>
  boundary !== undefined && 'dateTime' in boundary ? Date.parse(boundary.dateTime) : null

const listEvents = (input: ConstructorParameters<typeof GoogleCalendarListEventsInput>[0]) =>
  googleCalendarListEventsAction
    .executeTyped({ integration, input: GoogleCalendarListEventsInput.make(input) })
    .pipe(Effect.flatMap(successValue(googleCalendarListEventsAction.id)))

const getEvent = (calendarId: string, eventId: string) =>
  googleCalendarGetEventAction.executeTyped({
    integration,
    input: GoogleCalendarEventIdInput.make({ calendarId, eventId })
  })

// No `sendUpdates`: conformance events never have attendees, and the cases claim no notification.
const deleteEvent = (calendarId: string, eventId: string) =>
  googleCalendarDeleteEventAction.executeTyped({
    integration,
    input: GoogleCalendarDeleteEventInput.make({ calendarId, eventId })
  })

/** A failure whose status says the event is gone (404 or 410). */
const isGoneFailure = <A>(result: ActionResult<A>): boolean => {
  const status = failureOf(result)?.status

  return status === 404 || status === 410
}

/** A read of a deleted event: 404 or 410, or the event itself with `status: "cancelled"`. */
const readsGone = (result: ActionResult<GoogleCalendarEvent>): boolean =>
  isGoneFailure(result) ||
  (Predicate.isTagged(result, 'Success') && result.value.status === 'cancelled')

// Read case.

const eventPageSize = 2

const pageCap = 10

/** Page size of the single listing the pages are compared with (the Calendar default). */
const singleListingSize = 250

export const calendarListRangeCase: GoogleConformanceCase = defineConformanceCase({
  id: 'google.calendar.list-range-paging',
  title: 'A time-range listing pages through nextPageToken to the same events as one page',
  safety: 'read',
  docs: '`calendar.list_events` sends GET /calendar/v3/calendars/{calendarId}/events with `timeMin`, `timeMax`, `maxResults`, an opaque `pageToken`, `singleEvents`, and `orderBy` passed through unchanged, and decodes `items` (each event with `id`, `status`, `summary`, and `start`/`end` holding exactly one of `date` or `dateTime`) and `nextPageToken`.',
  wire: 'For the seeded calendar and range (3 to 20 events), `calendar.list_events` with `timeMin`/`timeMax`, `singleEvents: true`, `orderBy: "startTime"`, and `maxResults: 250` answers every event on one page (no `nextPageToken`), and every timed event overlaps the range (it starts before `timeMax` and ends after `timeMin`; all-day events are not checked); with `maxResults: 2` each page answers at most two events and a `nextPageToken` while events remain, and feeding the tokens back as `pageToken` lists exactly the same events, none repeated. So a `nextPageToken` missing while events remain, or an event outside the range, fails the case.',
  fixtures: [calendarListRangeFixture.id],
  run: Effect.gen(function* () {
    const calendarId = yield* requireSeed('calendarId')
    const timeMin = yield* requireSeed('eventRangeStart')
    const timeMax = yield* requireSeed('eventRangeEnd')
    const rangeStart = Date.parse(timeMin)
    const rangeEnd = Date.parse(timeMax)

    if (!(rangeStart < rangeEnd)) {
      return yield* new ConformanceMismatch({
        message: 'precondition: eventRangeStart must be before eventRangeEnd'
      })
    }

    const range = {
      calendarId,
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'startTime'
    } as const

    const single = yield* listEvents({ ...range, maxResults: singleListingSize })
    const events = single.items ?? []

    if (
      single.nextPageToken !== undefined ||
      events.length <= eventPageSize ||
      events.length > eventPageSize * pageCap
    ) {
      return yield* new ConformanceMismatch({
        message: `precondition: the event range must hold ${eventPageSize + 1} to ${eventPageSize * pageCap} events`
      })
    }

    const ids: Array<string> = []

    for (const event of events) {
      if (event.id === undefined) {
        return yield* new ConformanceMismatch({
          message: 'expected every listed event to carry an id'
        })
      }

      ids.push(event.id)

      const start = instantOf(event.start)
      const end = instantOf(event.end)

      yield* expectConformance(
        start === null || end === null || (start < rangeEnd && end > rangeStart),
        'expected every listed timed event to overlap the requested time range',
        { actual: event.id }
      )
    }

    const seen: Array<string> = []
    let pageToken: string | undefined

    for (let page = 1; ; page++) {
      const listing = yield* listEvents(
        pageToken === undefined
          ? { ...range, maxResults: eventPageSize }
          : { ...range, maxResults: eventPageSize, pageToken }
      )

      const pageIds = (listing.items ?? []).flatMap(event =>
        event.id === undefined ? [] : [event.id]
      )

      yield* expectConformance(
        pageIds.length <= eventPageSize,
        'expected at most maxResults events on every page',
        { actual: pageIds.length }
      )
      yield* expectConformance(
        pageIds.every((id, index) => !seen.includes(id) && pageIds.indexOf(id) === index),
        'expected no event repeated within or across pages'
      )
      seen.push(...pageIds)

      if (listing.nextPageToken === undefined) {
        break
      }

      if (page >= pageCap) {
        return yield* new ConformanceMismatch({
          message: `expected the listing to end within ${pageCap} pages`
        })
      }

      pageToken = listing.nextPageToken
    }

    yield* expectEqual(
      [...seen].sort(),
      [...ids].sort(),
      'expected the pages to list exactly the events of the single listing'
    )
  })
})

// Write cases.

/** The id of an owned event (a create answer without one is refused before this is read). */
const eventIdOf = (event: GoogleCalendarEvent): string => event.id ?? ''

/** Delete an event that may still exist, by id, then verify it reads gone. */
const ensureEventGone = (calendarId: string, eventId: string) =>
  Effect.gen(function* () {
    const deleted = yield* deleteEvent(calendarId, eventId)

    if (!isGoneFailure(deleted)) {
      yield* successValue(googleCalendarDeleteEventAction.id)(deleted)
    }

    const read = yield* getEvent(calendarId, eventId)

    yield* expectConformance(
      readsGone(read),
      'expected get_event to read the event gone after restoring',
      { actual: outcomeOf(read) }
    )
  })

/** Create one owned event (no attendees, so no invitation) and run `use`; the cleanup deletes it. */
const withOwnEvent = <A, E, R>(
  caseId: string,
  kind: string,
  use: (
    calendarId: string,
    event: GoogleCalendarEvent,
    summary: string,
    pending: Pending
  ) => Effect.Effect<A, E, R>
) =>
  Effect.gen(function* () {
    const calendarId = yield* requireSeed('calendarId')
    const summary = yield* runText(kind, 'synthetic conformance event, safe to delete')

    return yield* withOwnedWrite({
      caseId,
      actionId: googleCalendarCreateEventAction.id,
      create: googleCalendarCreateEventAction.executeTyped({
        integration,
        input: GoogleCalendarCreateEventInput.make({
          calendarId,
          summary,
          description: 'Synthetic conformance event without attendees.',
          start: { dateTime: calendarConformanceEventStart, timeZone: 'UTC' },
          end: { dateTime: calendarConformanceEventEnd, timeZone: 'UTC' }
        })
      }),
      unknownRecovery: `delete the event "${summary}" on ${calendarConformanceEventStart.slice(0, 10)} in calendar ${calendarId} by hand if it exists`,
      refuse: event =>
        Effect.succeed(
          event.id === undefined
            ? `an event without an id titled "${event.summary ?? ''}"`
            : event.summary !== summary || (event.attendees?.length ?? 0) > 0
              ? `event ${event.id} titled "${event.summary ?? ''}"`
              : undefined
        ),
      recovery: event =>
        `delete event ${eventIdOf(event)} in calendar ${calendarId} by hand if it still exists`,
      restore: event => ensureEventGone(calendarId, eventIdOf(event)),
      use: (event, pending) => use(calendarId, event, summary, pending)
    })
  })

const lifecycleCaseId = 'google.calendar.event-lifecycle'

export const calendarEventLifecycleCase: GoogleConformanceCase = defineConformanceCase({
  id: lifecycleCaseId,
  title: 'An event without attendees is created, read, renamed by PATCH, and deleted',
  safety: 'write-reversible',
  docs: '`calendar.create_event` sends POST .../calendars/{calendarId}/events with `summary`, `description`, `location`, `start`, `end`, and `attendees` (undefined fields omitted) and no `sendUpdates`; `calendar.get_event` sends GET .../events/{eventId}; `calendar.update_event` sends PATCH .../events/{eventId} with only the given fields; all three decode `GoogleCalendarEvent`; `calendar.delete_event` sends DELETE .../events/{eventId} and treats any 2xx as deleted without reading the body. 404 maps to `google_not_found`; 410 keeps the action code with its status.',
  wire: '`calendar.create_event` in the seeded calendar with a run-scoped summary, a fixed half hour, and no attendees answers an event with an id, that summary, the requested start and end instants, and no attendees; `calendar.get_event` answers the same id and summary; `calendar.update_event` with a new summary and description answers the new summary and the unchanged start (PATCH leaves omitted fields alone), and `calendar.get_event` reads the new summary; `calendar.delete_event` answers 2xx, and `calendar.get_event` then reads the event gone (404 or 410, or the event with `status: "cancelled"`; unverified: which of them). The event never has attendees, so no invitation or update is ever sent; the case deletes it again, by id, even when a step fails. Nothing remains visible (a deleted event may stay readable as `cancelled`).',
  fixtures: [calendarEventLifecycleFixture.id],
  run: Effect.gen(function* () {
    const renamed = yield* runText('event renamed', 'synthetic conformance event, safe to delete')

    yield* withOwnEvent(lifecycleCaseId, 'event', (calendarId, event, summary, pending) =>
      Effect.gen(function* () {
        const eventId = eventIdOf(event)
        const start = Date.parse(calendarConformanceEventStart)

        yield* expectEqual(
          [instantOf(event.start), instantOf(event.end), event.attendees?.length ?? 0],
          [start, Date.parse(calendarConformanceEventEnd), 0],
          'expected create_event to answer the requested times and no attendees'
        )

        const fetched = yield* getEvent(calendarId, eventId).pipe(
          Effect.flatMap(successValue(googleCalendarGetEventAction.id))
        )

        yield* expectEqual(
          [fetched.id ?? null, fetched.summary ?? null],
          [eventId, summary],
          'expected get_event to answer the created event'
        )

        const updated = yield* googleCalendarUpdateEventAction
          .executeTyped({
            integration,
            input: GoogleCalendarUpdateEventInput.make({
              calendarId,
              eventId,
              summary: renamed,
              description: 'Synthetic conformance event, renamed.'
            })
          })
          .pipe(
            Effect.flatMap(successValue(googleCalendarUpdateEventAction.id)),
            Effect.uninterruptible
          )

        yield* expectEqual(
          [updated.id ?? null, updated.summary ?? null, instantOf(updated.start)],
          [eventId, renamed, start],
          'expected update_event to rename the event and keep its start'
        )

        const reread = yield* getEvent(calendarId, eventId).pipe(
          Effect.flatMap(successValue(googleCalendarGetEventAction.id))
        )

        yield* expectEqual(
          reread.summary ?? null,
          renamed,
          'expected get_event to read the new summary'
        )

        yield* deleteEvent(calendarId, eventId).pipe(
          Effect.flatMap(successValue(googleCalendarDeleteEventAction.id)),
          Effect.uninterruptible
        )

        const gone = yield* getEvent(calendarId, eventId)

        yield* expectConformance(
          readsGone(gone),
          'expected get_event of the deleted event to answer 404 or 410, or status cancelled',
          { actual: outcomeOf(gone) }
        )
        yield* Ref.set(pending, false)
      })
    )
  })
})

const deletedCaseId = 'google.calendar.deleted-event-gone'

export const calendarDeletedGoneCase: GoogleConformanceCase = defineConformanceCase({
  id: deletedCaseId,
  title: 'A deleted event reads gone, and stays gone when deleted again',
  safety: 'write-reversible',
  docs: '`calendar.delete_event` sends DELETE .../calendars/{calendarId}/events/{eventId} and treats any 2xx as deleted without reading the body; a non-2xx answer is a failure with its status (404 `google_not_found`, 410 `calendar_delete_event_failed`). `calendar.get_event` decodes the event, whose optional `status` is kept.',
  wire: 'For an event the case just created in the seeded calendar (run-scoped summary, no attendees), `calendar.delete_event` answers 2xx; `calendar.get_event` then answers 404 or 410, or the event with `status: "cancelled"` (unverified: which of them), never a live event; and deleting it again answers 2xx or a failure with status 404 or 410 (unverified: which; the cleanup accepts any of them), after which `calendar.get_event` still reads it gone. So a deleted event that reads live, before or after the repeated delete, or a repeated delete that fails otherwise, fails the case.',
  fixtures: [calendarDeletedGoneFixture.id],
  run: withOwnEvent(deletedCaseId, 'deleted event', (calendarId, event, _summary, pending) =>
    Effect.gen(function* () {
      const eventId = eventIdOf(event)

      yield* deleteEvent(calendarId, eventId).pipe(
        Effect.flatMap(successValue(googleCalendarDeleteEventAction.id)),
        Effect.uninterruptible
      )

      const gone = yield* getEvent(calendarId, eventId)

      yield* expectConformance(
        readsGone(gone),
        'expected get_event of the deleted event to answer 404 or 410, or status cancelled',
        { actual: outcomeOf(gone) }
      )
      yield* Ref.set(pending, false)

      const again = yield* deleteEvent(calendarId, eventId).pipe(Effect.uninterruptible)

      yield* expectConformance(
        Predicate.isTagged(again, 'Success') || isGoneFailure(again),
        'expected deleting the deleted event again to answer 2xx, 404, or 410',
        { actual: outcomeOf(again) }
      )

      const still = yield* getEvent(calendarId, eventId)

      yield* expectConformance(
        readsGone(still),
        'expected the deleted event to stay gone after the repeated delete',
        { actual: outcomeOf(still) }
      )
    })
  )
})
