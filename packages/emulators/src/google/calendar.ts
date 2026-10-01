/**
 * Calendar routes of the Google emulator (internal): the time-range event listing with page
 * tokens, and the lifecycle of a run-scoped event without attendees (create, read, PATCH rename,
 * delete to `cancelled`, and the recorded 410 of a repeated delete).
 *
 * Every answer comes from the Calendar fixtures, through the seed or the request, or is minted
 * (event ids, page tokens, `created` / `updated` from the injectable clock). A deleted event stays
 * in the state as `cancelled`, as the fixtures read it back.
 *
 * @experimental
 */
import { Predicate } from 'effect'
import type * as Schema from 'effect/Schema'
import {
  exactBodyKeys,
  exactQuery,
  isNotEmulated,
  notEmulated,
  statefulRoute,
  type EmulatedRequest,
  type NotEmulated
} from '../stateful-emulator.ts'
import {
  answer,
  evidence,
  googleEmulatorApisOrigin,
  googleErrorBody,
  googleJson,
  googleNoContent,
  isRunText,
  listPage,
  pageSize,
  param,
  recordedValue,
  withoutQuery,
  type GoogleRoute
} from './shared.ts'
import {
  eventFields,
  mintedEventId,
  mintedEventIdPattern,
  type GoogleEmulatorCalendar,
  type GoogleEmulatorCalendarEvent,
  type GoogleEmulatorEventBoundary,
  type GoogleEmulatorState
} from './state.ts'

/** Path of the events collection of `{calendarId}`. */
export const calendarEventsPath = '/calendar/v3/calendars/{calendarId}/events'

const listCase = 'google.calendar.list-range-paging'

const lifecycleCase = 'google.calendar.event-lifecycle'

const deletedCase = 'google.calendar.deleted-event-gone'

/** A raw calendar id segment: an address-like id, its `@` percent-encoded once (`%40`). */
const calendarIdSegment = /^[A-Za-z0-9._+-]{1,200}(?:%40[A-Za-z0-9.-]{1,200})?$/

const eventIdSegment = /^[A-Za-z0-9_-]{1,1024}$/

const calendar = (
  method: string,
  path: string,
  write: boolean,
  caseIds: ReadonlyArray<string>,
  withEvent: boolean
) =>
  evidence(
    googleEmulatorApisOrigin,
    method,
    `${calendarEventsPath}${path}`,
    write,
    caseIds,
    withEvent
      ? { calendarId: calendarIdSegment, eventId: eventIdSegment }
      : { calendarId: calendarIdSegment }
  )

// Recorded values.

const createdDescription = 'Synthetic conformance event without attendees.'

const renamedDescription = 'Synthetic conformance event, renamed.'

const eventSummaryRest = 'synthetic conformance event, safe to delete'

/** The fixed half hour every recorded event create sends. */
const recordedStart = { dateTime: '2030-01-07T09:00:00Z', timeZone: 'UTC' }

const recordedEnd = { dateTime: '2030-01-07T09:30:00Z', timeZone: 'UTC' }

const instantPattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/

/**
 * True for an RFC 3339 instant with a `Z` or numeric offset whose components are in range (a real
 * calendar date, hour 0-23, minute and second 0-59, offset hour 0-23 and minute 0-59), checked
 * before `Date.parse`, which would roll an out-of-range component over instead of refusing it.
 */
const isInstant = (text: string): boolean => {
  const parts = instantPattern.exec(text)

  if (parts === null) return false

  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] = parts
    .slice(1)
    .map(part => Number(part ?? '0'))

  if (year === undefined || month === undefined || day === undefined) return false

  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0

  return (
    day >= 1 &&
    day <= days &&
    (hour ?? 24) <= 23 &&
    (minute ?? 60) <= 59 &&
    (second ?? 60) <= 59 &&
    (offsetHour ?? 24) <= 23 &&
    (offsetMinute ?? 60) <= 59 &&
    Number.isFinite(Date.parse(text))
  )
}

// Rendering, in the fixture key order.

type EventHead = {
  readonly kind: string
  readonly etag: string
  readonly id: string
  readonly status: string
  readonly htmlLink: string
  readonly created: string
  readonly updated: string
  readonly summary: string
  description?: string
}

type EventsPage = {
  readonly kind: string
  readonly summary: string
  readonly timeZone: string
  readonly accessRole: string
  readonly items: ReadonlyArray<Schema.Json>
  nextPageToken?: string
}

const renderEvent = (
  state: GoogleEmulatorState,
  owner: GoogleEmulatorCalendar,
  event: GoogleEmulatorCalendarEvent
): Schema.JsonObject => {
  const head: EventHead = {
    kind: 'calendar#event',
    etag: event.etag,
    id: event.id,
    status: event.status,
    htmlLink: event.htmlLink,
    created: event.created,
    updated: event.updated,
    summary: event.summary
  }

  // The fixtures show `description` only on events that have one.
  if (event.description !== undefined) head.description = event.description

  return {
    ...head,
    creator: { email: state.practiceAddress, self: true },
    organizer: { email: owner.id, displayName: owner.summary, self: true },
    start: { ...event.start },
    end: { ...event.end },
    iCalUID: event.iCalUID,
    sequence: event.sequence,
    reminders: { useDefault: true },
    eventType: 'default'
  }
}

/** The instant a boundary starts (an all-day date at midnight UTC), in milliseconds. */
const instant = (boundary: GoogleEmulatorEventBoundary): number =>
  'dateTime' in boundary ? Date.parse(boundary.dateTime) : Date.parse(`${boundary.date}T00:00:00Z`)

const findCalendar = (state: GoogleEmulatorState, id: string) =>
  state.calendars.find(candidate => candidate.id === id)

const findEvent = (state: GoogleEmulatorState, calendarId: string, eventId: string) =>
  state.events.find(event => event.calendarId === calendarId && event.id === eventId)

const isCreatedHere = (event: GoogleEmulatorCalendarEvent): boolean =>
  mintedEventIdPattern.test(event.id)

const replaceEvent = (state: GoogleEmulatorState, next: GoogleEmulatorCalendarEvent) =>
  state.events.map(event =>
    event.calendarId === next.calendarId && event.id === next.id ? next : event
  )

/** The `{ dateTime, timeZone }` boundary a fixture records, exactly. */
const isRecordedBoundary = (
  value: Schema.Json | undefined,
  recorded: { readonly dateTime: string; readonly timeZone: string }
): boolean => {
  const boundary = exactBodyKeys(value, 'boundary', ['dateTime', 'timeZone'])

  return (
    !isNotEmulated(boundary) &&
    boundary.dateTime === recorded.dateTime &&
    boundary.timeZone === recorded.timeZone
  )
}

// Listing.

type ListInput = {
  readonly calendarId: string
  readonly timeMin: string
  readonly timeMax: string
  readonly maxResults: number
  readonly pageToken: string | undefined
}

const listEvents: GoogleRoute = statefulRoute(
  calendar('GET', '', false, [listCase], false),
  'none',
  (request): ListInput | NotEmulated => {
    const query = exactQuery(
      request,
      ['timeMin', 'timeMax', 'maxResults', 'singleEvents', 'orderBy'],
      ['pageToken']
    )

    if (isNotEmulated(query)) return query

    const recorded =
      recordedValue(query, 'singleEvents', 'true') ?? recordedValue(query, 'orderBy', 'startTime')

    if (recorded !== undefined) return recorded

    const timeMin = query['timeMin'] ?? ''
    const timeMax = query['timeMax'] ?? ''

    if (
      !isInstant(timeMin) ||
      !isInstant(timeMax) ||
      !(Date.parse(timeMin) < Date.parse(timeMax))
    ) {
      return notEmulated('timeMin and timeMax must be RFC 3339 instants, timeMin first')
    }

    const maxResults = pageSize(query['maxResults'], 'maxResults', 1, 2500)

    if (isNotEmulated(maxResults)) return maxResults

    const pageToken = query['pageToken']

    return pageToken === ''
      ? notEmulated('an empty pageToken is not emulated')
      : { calendarId: param(request, 'calendarId'), timeMin, timeMax, maxResults, pageToken }
  },
  (state, input, { env }) => {
    const owner = findCalendar(state, input.calendarId)

    if (owner === undefined) return notEmulated('a calendar the state does not hold')

    const from = Date.parse(input.timeMin)
    const to = Date.parse(input.timeMax)

    // By start time (`orderBy=startTime`); `sort` is stable, so equal starts keep the state order.
    const overlapping = state.events
      .filter(
        event =>
          event.calendarId === owner.id && instant(event.start) < to && instant(event.end) > from
      )
      .sort((left, right) => instant(left.start) - instant(right.start))

    // Every recorded listing has events, and none of them is cancelled.
    if (overlapping.length === 0) {
      return notEmulated('a range without events is not emulated (no fixture records one)')
    }

    if (overlapping.some(event => event.status === 'cancelled')) {
      return notEmulated('a range holding a cancelled event is not emulated')
    }

    return listPage(
      env,
      'calendar',
      `calendar\u0000${owner.id}\u0000${input.timeMin}\u0000${input.timeMax}\u0000${input.maxResults}`,
      overlapping.map(event => renderEvent(state, owner, event)),
      input.maxResults,
      input.pageToken,
      env.drills.calendarPageRepeats,
      (page, nextPageToken) => {
        const body: EventsPage = {
          kind: 'calendar#events',
          summary: owner.summary,
          timeZone: owner.timeZone,
          accessRole: owner.accessRole,
          items: [...page]
        }

        // The last page carries no `nextPageToken`.
        if (nextPageToken !== undefined) body.nextPageToken = nextPageToken

        return googleJson(200, body)
      }
    )
  }
)

// The event lifecycle.

type CreateInput = { readonly calendarId: string; readonly summary: string }

const createEvent: GoogleRoute = statefulRoute(
  calendar('POST', '', true, [lifecycleCase, deletedCase], false),
  'json',
  (request): CreateInput | NotEmulated => {
    const body =
      withoutQuery(request) ??
      exactBodyKeys(request.json, 'the event body', ['summary', 'description', 'start', 'end'])

    if (isNotEmulated(body)) return body

    const summary = Predicate.isString(body.summary) ? body.summary : ''

    if (
      !isRunText(summary, 'event', eventSummaryRest) &&
      !isRunText(summary, 'deleted event', eventSummaryRest)
    ) {
      return notEmulated('an event summary other than the recorded run-scoped ones')
    }

    if (body.description !== createdDescription) {
      return notEmulated('an event description other than the recorded one is not emulated')
    }

    return isRecordedBoundary(body.start, recordedStart) &&
      isRecordedBoundary(body.end, recordedEnd)
      ? { calendarId: param(request, 'calendarId'), summary }
      : notEmulated('event times other than the recorded half hour are not emulated')
  },
  (state, input, { env }) => {
    const owner = findCalendar(state, input.calendarId)

    if (owner === undefined) return notEmulated('a calendar the state does not hold')

    return () => {
      // Read the clock before any write: a failing clock writes nothing.
      const at = new Date(env.now()).toISOString()
      const number = state.counters.nextEventNumber
      const id = mintedEventId(number)

      const event: GoogleEmulatorCalendarEvent = {
        calendarId: owner.id,
        id,
        ...eventFields(id),
        status: 'confirmed',
        created: at,
        updated: at,
        summary: input.summary,
        description: createdDescription,
        start: { ...recordedStart },
        end: { ...recordedEnd },
        sequence: 0
      }

      state.counters = { ...state.counters, nextEventNumber: number + 1 }
      state.events = [...state.events, event]

      return googleJson(200, renderEvent(state, owner, event))
    }
  }
)

type EventRef = { readonly calendarId: string; readonly eventId: string }

const eventRef = (request: EmulatedRequest): EventRef => ({
  calendarId: param(request, 'calendarId'),
  eventId: param(request, 'eventId')
})

const getEvent: GoogleRoute = statefulRoute(
  calendar('GET', '/{eventId}', false, [lifecycleCase, deletedCase], true),
  'none',
  request => withoutQuery(request) ?? eventRef(request),
  (state, input) => {
    const owner = findCalendar(state, input.calendarId)
    const event = findEvent(state, input.calendarId, input.eventId)

    return owner === undefined || event === undefined
      ? notEmulated('an event the state does not hold is not emulated')
      : answer(() => googleJson(200, renderEvent(state, owner, event)))
  }
)

type PatchInput = EventRef & { readonly summary: string }

const patchEvent: GoogleRoute = statefulRoute(
  calendar('PATCH', '/{eventId}', true, [lifecycleCase], true),
  'json',
  (request): PatchInput | NotEmulated => {
    const body =
      withoutQuery(request) ??
      exactBodyKeys(request.json, 'the event patch', ['summary', 'description'])

    if (isNotEmulated(body)) return body

    const summary = Predicate.isString(body.summary) ? body.summary : ''

    return isRunText(summary, 'event renamed', eventSummaryRest) &&
      body.description === renamedDescription
      ? { ...eventRef(request), summary }
      : notEmulated('an event patch other than the recorded rename is not emulated')
  },
  (state, input, { env }) => {
    const owner = findCalendar(state, input.calendarId)
    const event = findEvent(state, input.calendarId, input.eventId)

    if (
      owner === undefined ||
      event === undefined ||
      !isCreatedHere(event) ||
      event.status !== 'confirmed'
    ) {
      return notEmulated('renaming anything but a live event created here is not emulated')
    }

    return () => {
      const at = new Date(env.now()).toISOString()

      const next: GoogleEmulatorCalendarEvent = {
        ...event,
        updated: at,
        summary: env.drills.eventPatchKeepsSummary ? event.summary : input.summary,
        description: renamedDescription
      }

      state.events = replaceEvent(state, next)

      return googleJson(200, renderEvent(state, owner, next))
    }
  }
)

const deleteEvent: GoogleRoute = statefulRoute(
  calendar('DELETE', '/{eventId}', true, [lifecycleCase, deletedCase], true),
  'none',
  request => withoutQuery(request) ?? eventRef(request),
  (state, input, { env }) => {
    const event = findEvent(state, input.calendarId, input.eventId)

    if (event === undefined || !isCreatedHere(event)) {
      return notEmulated('deleting anything but an event created here is not emulated')
    }

    // The recorded repeated delete: 410 Gone (the drill answers it as 409).
    if (event.status === 'cancelled') {
      return answer(() =>
        googleJson(
          env.drills.repeatedEventDeleteConflict ? 409 : 410,
          googleErrorBody(410, 'Resource has been deleted', 'deleted', 'GONE')
        )
      )
    }

    return () => {
      const at = new Date(env.now()).toISOString()

      state.events = replaceEvent(state, { ...event, status: 'cancelled', updated: at })

      return googleNoContent()
    }
  }
)

/** The Calendar routes, in manifest order. */
export const calendarRoutes: ReadonlyArray<GoogleRoute> = [
  listEvents,
  createEvent,
  getEvent,
  patchEvent,
  deleteEvent
]
