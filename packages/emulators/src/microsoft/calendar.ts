/**
 * Microsoft Graph emulator calendar routes (internal): `calendarView`, event create, get, update,
 * delete, and cancel. Wire shapes follow the synthetic calendar conformance fixtures.
 *
 * Event times are stored in UTC with seven fractional digits and answered in UTC. Every calendar
 * fixture sends `Prefer: outlook.timezone="UTC"`, so every calendar route needs it; without it, or
 * with another time zone, a request is refused (fail closed). Calendar views need `$top` and answer
 * one page (no `$skip`, no `@odata.nextLink`), as the fixtures record them. Events are answered with
 * the fixture fields only (`@odata.etag`, `id`, `subject`, `start`, `end`, `isCancelled`); a create
 * takes the fixture's fields (`subject`, a text `body`, `start`, `end`, `isReminderOn`, `showAs`)
 * and an update only `subject`; anything else, including unknown nested keys, fails closed.
 *
 * @experimental
 */
import { Predicate } from 'effect'
import type * as Schema from 'effect/Schema'
import {
  bodyObject,
  codes,
  collection,
  emptyResponse,
  entity,
  invalidValue,
  jsonResponse,
  metadataContext,
  nestedObject,
  nextChangeKey,
  notEmulated,
  nowTimestamp,
  odataKey,
  padded,
  project,
  resolveUser,
  selectSuffix,
  selectedFields,
  singlePage,
  textBody,
  type MicrosoftApiEnv,
  type RouteHandler,
  type RouteRequest
} from './graph.ts'
import {
  formatLocalDateTime,
  parseInstant,
  type MicrosoftEmulatorEvent,
  type MicrosoftEmulatorState
} from './state.ts'

/** The event fields the fixtures answer (and `$select`). */
const eventFields: ReadonlyArray<string> = ['id', 'subject', 'start', 'end', 'isCancelled']

const showAsValues: ReadonlyArray<MicrosoftEmulatorEvent['showAs']> = [
  'free',
  'tentative',
  'busy',
  'oof',
  'workingElsewhere',
  'unknown'
]

const isShowAs = (value: unknown): value is MicrosoftEmulatorEvent['showAs'] =>
  showAsValues.some(candidate => candidate === value)

const eventTagPrefix = 'DwAAABYAAAAsynthetic'

const renderDateTime = (env: MicrosoftApiEnv, value: string) => {
  const ticks = parseInstant(value, 'forbidden')

  return {
    dateTime:
      ticks === undefined ? value : formatLocalDateTime(ticks, env.drills.timestampPrecisionDigits),
    timeZone: 'UTC'
  }
}

/** The event as the fixtures answer it, in their key order. */
const renderEvent = (env: MicrosoftApiEnv, event: MicrosoftEmulatorEvent): Schema.JsonObject => ({
  '@odata.etag': `W/"${event.changeKey}"`,
  id: event.id,
  subject: event.subject,
  start: renderDateTime(env, event.start),
  end: renderDateTime(env, event.end),
  isCancelled: event.isCancelled
})

/** `users('{userId}')`, the context prefix of every calendar route. */
const userContext = (request: RouteRequest): string =>
  `users${odataKey(request.params.userId ?? '')}`

/** `users('{userId}')/calendars('{calendarId}')`. */
const calendarContext = (request: RouteRequest): string =>
  `${userContext(request)}/calendars${odataKey(request.params.calendarId ?? '')}`

/**
 * Every calendar fixture sends `Prefer: outlook.timezone="UTC"`: a request without it, or with any
 * other time zone, is not emulated.
 */
const timezoneProblem = (request: RouteRequest): Response | undefined => {
  const timezone = request.prefer.timezone

  if (timezone === undefined) {
    return notEmulated(
      request,
      'calendar requests without Prefer: outlook.timezone="UTC" are not emulated.'
    )
  }

  return timezone.toUpperCase() === 'UTC'
    ? undefined
    : notEmulated(request, `outlook.timezone ${timezone} is not emulated (UTC only).`)
}

/** `preference-applied` on reads (which asked for UTC), as the fixtures record it. */
const readHeaders = (request: RouteRequest): HeadersInit => ({
  'preference-applied': `outlook.timezone="${request.prefer.timezone ?? 'UTC'}"`
})

const findCalendar = (state: MicrosoftEmulatorState, request: RouteRequest) =>
  state.calendars.find(calendar => calendar.id === request.params.calendarId)

const calendarNotFound = (request: RouteRequest): Response =>
  request.error(404, codes.mailItemNotFound, 'The specified object was not found in the store.')

const eventNotFound = calendarNotFound

const findEvent = (state: MicrosoftEmulatorState, request: RouteRequest) =>
  state.events.find(event => event.id === request.params.eventId)

/** Ticks of a stored UTC date-time (always readable: the state schema checks the pattern). */
const ticksOf = (value: string): bigint => parseInstant(value, 'forbidden') ?? BigInt(0)

/** The largest calendar view `$top` a fixture sends (`$top=50`, list-range and precision cases). */
const calendarViewMaxTop = 50

/**
 * `GET .../calendars/{calendarId}/calendarView?startDateTime=&endDateTime=`: the events that
 * overlap `[start, end)` (start before the range end and end after the range start), ordered by
 * start, at most `$top` of them (more is not emulated: no fixture pages a calendar view; `$top`
 * is required, at most `calendarViewMaxTop`).
 */
export const calendarView: RouteHandler = (state, request, env) => {
  const user = resolveUser(state, request)

  if (user instanceof Response) return user

  const zone = timezoneProblem(request)

  if (zone !== undefined) return zone

  if (findCalendar(state, request) === undefined) return calendarNotFound(request)

  const rawStart = request.query.get('startDateTime')
  const rawEnd = request.query.get('endDateTime')

  if (rawStart === null || rawEnd === null) {
    return invalidValue(request, 'calendarView needs startDateTime and endDateTime.')
  }

  const start = parseInstant(rawStart, 'optional')
  const end = parseInstant(rawEnd, 'optional')

  if (start === undefined || end === undefined) {
    return invalidValue(request, 'startDateTime and endDateTime must be ISO-8601 date-times.')
  }

  const fields = selectedFields(request, eventFields)

  if (fields instanceof Response) return fields

  const matching = env.drills.calendarRangeEmpty
    ? []
    : state.events
        .filter(
          event =>
            event.calendarId === request.params.calendarId &&
            ticksOf(event.start) < end &&
            ticksOf(event.end) > start
        )
        .sort((left, right) =>
          left.start === right.start
            ? left.id.localeCompare(right.id)
            : left.start < right.start
              ? -1
              : 1
        )

  const page = singlePage(matching, request, calendarViewMaxTop)

  if (page instanceof Response) return page

  return jsonResponse(
    200,
    collection(
      metadataContext(env, `${calendarContext(request)}/calendarView${selectSuffix(fields)}`),
      page.map(event => project(renderEvent(env, event), fields)),
      undefined
    ),
    readHeaders(request)
  )
}

/** A `dateTimeTimeZone` write value in UTC, as a seven-digit local date-time. */
const writeDateTime = (
  request: RouteRequest,
  key: string,
  value: Schema.Json
): string | Response => {
  const dateTimeZone = nestedObject(
    request,
    value,
    ['dateTime', 'timeZone'],
    `${key} { dateTime, timeZone }`
  )

  if (dateTimeZone instanceof Response) return dateTimeZone

  const { dateTime, timeZone } = dateTimeZone

  if (!Predicate.isString(dateTime) || !Predicate.isString(timeZone)) {
    return invalidValue(request, `${key} must be { dateTime, timeZone } with string values.`)
  }

  if (timeZone.toUpperCase() !== 'UTC') {
    return notEmulated(request, `${key}.timeZone ${timeZone} is not emulated (UTC only).`)
  }

  const ticks = parseInstant(dateTime, 'forbidden')

  return ticks === undefined
    ? invalidValue(request, `${key}.dateTime must be a local date-time without offset.`)
    : formatLocalDateTime(ticks, 7)
}

type EventWrite = {
  subject?: string
  bodyContent?: string
  start?: string
  end?: string
  isReminderOn?: boolean
  showAs?: MicrosoftEmulatorEvent['showAs']
}

/** Event create keys, as the create fixture sends them. */
const createEventKeys: ReadonlyArray<string> = [
  'subject',
  'body',
  'start',
  'end',
  'isReminderOn',
  'showAs'
]

/** Event update keys, as the update fixture sends them. */
const updateEventKeys: ReadonlyArray<string> = ['subject']

/** The emulated event fields of a create or update body; attendees and the rest fail closed. */
const eventWrite = (
  request: RouteRequest,
  allowed: ReadonlyArray<string>
): EventWrite | Response => {
  const fields = bodyObject(request, allowed)

  if (fields instanceof Response) return fields

  const write: EventWrite = {}

  for (const [key, value] of Object.entries(fields)) {
    switch (key) {
      case 'subject':
        if (!Predicate.isString(value)) return invalidValue(request, 'subject must be a string.')

        write.subject = value
        break
      case 'body': {
        const content = textBody(request, value)

        if (content instanceof Response) return content

        write.bodyContent = content
        break
      }

      case 'start':
      case 'end': {
        const dateTime = writeDateTime(request, key, value)

        if (dateTime instanceof Response) return dateTime

        write[key] = dateTime
        break
      }

      case 'isReminderOn':
        if (!Predicate.isBoolean(value)) {
          return invalidValue(request, 'isReminderOn must be a boolean.')
        }

        write.isReminderOn = value
        break
      case 'showAs':
        if (!isShowAs(value)) return invalidValue(request, 'showAs is not a Graph freeBusyStatus.')

        write.showAs = value
        break
    }
  }

  return write
}

/**
 * `POST .../calendars/{calendarId}/events`: create a single-instance, attendee-free event (201
 * with the event; the `createOmitsId` drill knob drops its `id`).
 */
export const createEvent: RouteHandler = (state, request, env) => {
  const user = resolveUser(state, request)

  if (user instanceof Response) return user

  const zone = timezoneProblem(request)

  if (zone !== undefined) return zone

  if (findCalendar(state, request) === undefined) return calendarNotFound(request)

  const write = eventWrite(request, createEventKeys)

  if (write instanceof Response) return write

  if (write.start === undefined || write.end === undefined) {
    return invalidValue(request, 'a new event needs start and end.')
  }

  if (write.end < write.start) return invalidValue(request, 'the event end is before its start.')

  let number = state.counters.nextEventNumber
  let id = `AAMkAGI2-synthetic-event-${padded(number, 4)}=`

  while (state.events.some(event => event.id === id)) {
    number += 1
    id = `AAMkAGI2-synthetic-event-${padded(number, 4)}=`
  }

  state.counters = { ...state.counters, nextEventNumber: number + 1 }

  const now = nowTimestamp(env)

  const event: MicrosoftEmulatorEvent = {
    id,
    calendarId: request.params.calendarId ?? '',
    subject: write.subject ?? '',
    bodyContentType: 'text',
    bodyContent: write.bodyContent ?? '',
    start: write.start,
    end: write.end,
    isCancelled: false,
    isReminderOn: write.isReminderOn ?? true,
    showAs: write.showAs ?? 'busy',
    changeKey: nextChangeKey(state, eventTagPrefix),
    createdDateTime: now,
    lastModifiedDateTime: now
  }

  state.events = [...state.events, event]

  const { id: _id, ...withoutId } = renderEvent(env, event)
  const context = metadataContext(env, `${calendarContext(request)}/events/$entity`)

  return jsonResponse(
    201,
    entity(context, env.drills.createOmitsId ? withoutId : renderEvent(env, event))
  )
}

/** `GET /users/{userId}/events/{eventId}` (`$select`). */
export const getEvent: RouteHandler = (state, request, env) => {
  const user = resolveUser(state, request)

  if (user instanceof Response) return user

  const zone = timezoneProblem(request)

  if (zone !== undefined) return zone

  const fields = selectedFields(request, eventFields)

  if (fields instanceof Response) return fields

  const event = findEvent(state, request)

  const context = metadataContext(
    env,
    `${userContext(request)}/events${selectSuffix(fields)}/$entity`
  )

  return event === undefined
    ? eventNotFound(request)
    : jsonResponse(
        200,
        entity(context, project(renderEvent(env, event), fields)),
        readHeaders(request)
      )
}

/** `PATCH /users/{userId}/events/{eventId}`: update `subject`; 200 with the event. */
export const updateEvent: RouteHandler = (state, request, env) => {
  const user = resolveUser(state, request)

  if (user instanceof Response) return user

  const zone = timezoneProblem(request)

  if (zone !== undefined) return zone

  const event = findEvent(state, request)

  if (event === undefined) return eventNotFound(request)

  const write = eventWrite(request, updateEventKeys)

  if (write instanceof Response) return write

  const updated: MicrosoftEmulatorEvent = { ...event, ...write }

  if (updated.end < updated.start) {
    return invalidValue(request, 'the event end is before its start.')
  }

  const stored: MicrosoftEmulatorEvent = {
    ...updated,
    changeKey: nextChangeKey(state, eventTagPrefix),
    lastModifiedDateTime: nowTimestamp(env)
  }

  state.events = state.events.map(candidate => (candidate.id === stored.id ? stored : candidate))

  return jsonResponse(
    200,
    entity(metadataContext(env, `${userContext(request)}/events/$entity`), renderEvent(env, stored))
  )
}

const removeEvent = (state: MicrosoftEmulatorState, id: string): void => {
  state.events = state.events.filter(event => event.id !== id)
}

/** `DELETE /users/{userId}/events/{eventId}`: 204; later reads answer 404. */
export const deleteEvent: RouteHandler = (state, request) => {
  const user = resolveUser(state, request)

  if (user instanceof Response) return user

  const zone = timezoneProblem(request)

  if (zone !== undefined) return zone

  const event = findEvent(state, request)

  if (event === undefined) return eventNotFound(request)

  removeEvent(state, event.id)

  return emptyResponse(204)
}

/**
 * `POST /users/{userId}/events/{eventId}/cancel` (`{ comment? }`): 202 with an empty body, and
 * the event is removed (not kept with `isCancelled: true`), so a later GET or DELETE answers 404,
 * as the cancel fixture records. The emulated events have no attendees: nothing is sent.
 */
export const cancelEvent: RouteHandler = (state, request) => {
  const user = resolveUser(state, request)

  if (user instanceof Response) return user

  const zone = timezoneProblem(request)

  if (zone !== undefined) return zone

  const event = findEvent(state, request)

  if (event === undefined) return eventNotFound(request)

  if (request.body !== undefined) {
    const fields = bodyObject(request, ['comment'])

    if (fields instanceof Response) return fields

    if (fields.comment !== undefined && !Predicate.isString(fields.comment)) {
      return invalidValue(request, 'comment must be a string.')
    }
  }

  removeEvent(state, event.id)

  return emptyResponse(202)
}
