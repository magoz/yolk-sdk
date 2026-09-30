/**
 * INTERNAL Microsoft Graph calendar helpers for the Microsoft conformance cases. Not exported.
 *
 * The Microsoft connector has no calendar actions yet. These helpers send raw Graph v1.0 calendar
 * requests through the real connector ports (`ConnectorHttpClient`, `CredentialResolver` via
 * `resolveMicrosoftAccessToken`) and map non-2xx responses through the shared Graph failure
 * mapping, so the calendar cases pin expected Graph behaviour (unverified until a live run) for hosts
 * and the upcoming emulator.
 * The calendar slot hints and the instant helpers stay internal to the conformance module.
 */
import { Effect, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import { CredentialSlot } from '../../credential.ts'
import { ConnectorHttpClient, ConnectorHttpRequest, decodeJsonResponse } from '../../http.ts'
import type { ConnectorIntegration } from '../../integration.ts'
import { ActionResult } from '../../result.ts'
import { microsoftAuthorizationHeaders, microsoftOAuthSlotId } from '../oauth.ts'
import {
  isMicrosoftSuccessStatus,
  microsoftGraphApiBaseUrl,
  microsoftProviderFailure,
  resolveMicrosoftAccessToken
} from '../shared.ts'

/** Conformance-only consent hints on the shared `microsoft.oauth` binding. */
const calendarReadSlot = CredentialSlot.make({
  id: microsoftOAuthSlotId,
  kind: 'oauth',
  requiredScopes: ['https://graph.microsoft.com/Calendars.Read']
})

const calendarWriteSlot = CredentialSlot.make({
  id: microsoftOAuthSlotId,
  kind: 'oauth',
  requiredScopes: ['https://graph.microsoft.com/Calendars.ReadWrite']
})

/** Graph `dateTimeTimeZone`: a local date-time without offset plus a separate time zone name. */
export const GraphDateTimeTimeZone = Schema.Struct({
  dateTime: Schema.String,
  timeZone: Schema.String
})

export type GraphDateTimeTimeZone = typeof GraphDateTimeTimeZone.Type

/** The calendar event fields the cases read. `id` is optional so a missing id is a claim failure. */
export const GraphEvent = Schema.Struct({
  id: Schema.optional(Schema.String),
  subject: Schema.optional(Schema.NullOr(Schema.String)),
  start: Schema.optional(GraphDateTimeTimeZone),
  end: Schema.optional(GraphDateTimeTimeZone),
  isCancelled: Schema.optional(Schema.Boolean)
})

export type GraphEvent = typeof GraphEvent.Type

const GraphEventCollection = Schema.Struct({
  value: Schema.Array(GraphEvent),
  '@odata.nextLink': Schema.optional(Schema.String)
})

export type GraphEventCollection = typeof GraphEventCollection.Type

export type CalendarTarget = {
  readonly integration: ConnectorIntegration
  /** Mailbox (`/users/{mailbox}`), or the signed-in user (`/me`) when absent. */
  readonly mailbox: string | undefined
  /** Calendar id (`/calendars/{id}`), or the default calendar (`/calendar`) when absent. */
  readonly calendarId: string | undefined
}

const mailboxRoot = (target: CalendarTarget) =>
  `${microsoftGraphApiBaseUrl}${target.mailbox === undefined ? '/me' : `/users/${encodeURIComponent(target.mailbox)}`}`

const calendarRoot = (target: CalendarTarget) =>
  `${mailboxRoot(target)}${target.calendarId === undefined ? '/calendar' : `/calendars/${encodeURIComponent(target.calendarId)}`}`

const eventUrl = (target: CalendarTarget, eventId: string) =>
  `${mailboxRoot(target)}/events/${encodeURIComponent(eventId)}`

const eventSelect = 'id,subject,start,end,isCancelled'

/** Every calendar request asks Graph to express event times in UTC. */
const utcPreference = 'outlook.timezone="UTC"'

type CalendarRequest = {
  readonly target: CalendarTarget
  readonly write: boolean
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  readonly url: string
  readonly body?: unknown
  readonly code: string
  readonly message: string
}

const sendCalendarRequest = (request: CalendarRequest) =>
  Effect.gen(function* () {
    const token = yield* resolveMicrosoftAccessToken(
      request.target.integration,
      request.write ? calendarWriteSlot : calendarReadSlot
    )

    const http = yield* ConnectorHttpClient

    const headers =
      request.body === undefined
        ? {
            ...microsoftAuthorizationHeaders(token),
            accept: 'application/json',
            prefer: utcPreference
          }
        : {
            ...microsoftAuthorizationHeaders(token),
            accept: 'application/json',
            'content-type': 'application/json',
            prefer: utcPreference
          }

    return yield* http.request(
      request.body === undefined
        ? ConnectorHttpRequest.make({ method: request.method, url: request.url, headers })
        : ConnectorHttpRequest.make({
            method: request.method,
            url: request.url,
            headers,
            body: JSON.stringify(request.body)
          })
    )
  })

/** A JSON-answering calendar request; non-2xx responses become `ActionResult` failures. */
const calendarJson = <A>(
  request: CalendarRequest,
  schema: Schema.Schema<A> & { readonly DecodingServices: never }
) =>
  Effect.gen(function* () {
    const response = yield* sendCalendarRequest(request)

    if (!isMicrosoftSuccessStatus(response.status)) {
      return yield* microsoftProviderFailure({
        code: request.code,
        message: request.message,
        status: response.status,
        headers: response.headers,
        body: response.body
      })
    }

    return ActionResult.success(yield* decodeJsonResponse(schema, response))
  })

/** A calendar request whose success carries no body (204 delete, 202 cancel). */
const calendarNoContent = (request: CalendarRequest) =>
  Effect.gen(function* () {
    const response = yield* sendCalendarRequest(request)

    if (!isMicrosoftSuccessStatus(response.status)) {
      return yield* microsoftProviderFailure({
        code: request.code,
        message: request.message,
        status: response.status,
        headers: response.headers,
        body: response.body
      })
    }

    return ActionResult.success({ status: response.status })
  })

export const calendarActionIds = {
  listRange: 'microsoft.conformance.calendar_view',
  create: 'microsoft.conformance.create_event',
  get: 'microsoft.conformance.get_event',
  update: 'microsoft.conformance.update_event',
  delete: 'microsoft.conformance.delete_event',
  cancel: 'microsoft.conformance.cancel_event'
} as const

/** `GET .../calendarView` for `[start, end)`: one page of at most `top` events. */
export const listCalendarRange = (
  target: CalendarTarget,
  range: { readonly start: string; readonly end: string; readonly top: number }
) => {
  const params = new URLSearchParams({
    startDateTime: range.start,
    endDateTime: range.end,
    $select: eventSelect,
    $top: String(range.top)
  })

  return calendarJson(
    {
      target,
      write: false,
      method: 'GET',
      url: `${calendarRoot(target)}/calendarView?${params.toString()}`,
      code: 'microsoft_calendar_view_failed',
      message: 'Microsoft Graph calendar view failed'
    },
    GraphEventCollection
  )
}

export type NewCalendarEvent = {
  readonly subject: string
  readonly body: string
  /** UTC local date-times without offset, for example `2026-01-05T09:00:00`. */
  readonly startUtc: string
  readonly endUtc: string
}

/** `POST .../events` in the target calendar: a reminder-free, attendee-free event. */
export const createCalendarEvent = (target: CalendarTarget, event: NewCalendarEvent) =>
  calendarJson(
    {
      target,
      write: true,
      method: 'POST',
      url: `${calendarRoot(target)}/events`,
      body: {
        subject: event.subject,
        body: { contentType: 'text', content: event.body },
        start: { dateTime: event.startUtc, timeZone: 'UTC' },
        end: { dateTime: event.endUtc, timeZone: 'UTC' },
        isReminderOn: false,
        showAs: 'free'
      },
      code: 'microsoft_create_event_failed',
      message: 'Microsoft Graph create event failed'
    },
    GraphEvent
  )

export const getCalendarEvent = (target: CalendarTarget, eventId: string) =>
  calendarJson(
    {
      target,
      write: false,
      method: 'GET',
      url: `${eventUrl(target, eventId)}?${new URLSearchParams({ $select: eventSelect }).toString()}`,
      code: 'microsoft_get_event_failed',
      message: 'Microsoft Graph get event failed'
    },
    GraphEvent
  )

export const updateCalendarEventSubject = (
  target: CalendarTarget,
  eventId: string,
  subject: string
) =>
  calendarJson(
    {
      target,
      write: true,
      method: 'PATCH',
      url: eventUrl(target, eventId),
      body: { subject },
      code: 'microsoft_update_event_failed',
      message: 'Microsoft Graph update event failed'
    },
    GraphEvent
  )

export const deleteCalendarEvent = (target: CalendarTarget, eventId: string) =>
  calendarNoContent({
    target,
    write: true,
    method: 'DELETE',
    url: eventUrl(target, eventId),
    code: 'microsoft_delete_event_failed',
    message: 'Microsoft Graph delete event failed'
  })

export const cancelCalendarEvent = (target: CalendarTarget, eventId: string, comment: string) =>
  calendarNoContent({
    target,
    write: true,
    method: 'POST',
    url: `${eventUrl(target, eventId)}/cancel`,
    body: { comment },
    code: 'microsoft_cancel_event_failed',
    message: 'Microsoft Graph cancel event failed'
  })

/**
 * An instant as whole milliseconds since the epoch plus the remaining 100-nanosecond ticks
 * (0-9999), so Graph's 7-digit fractional seconds compare exactly.
 */
export type Instant = { readonly millis: number; readonly subMillisTicks: number }

/** Graph `dateTime` with exactly seven fractional digits and no offset. */
export const graphSevenDigitDateTimePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}$/

const localDateTimePattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,7}))?$/

/** ISO-8601 instant in UTC (`Z`) with at most millisecond precision, as hosts supply seeds. */
export const isoUtcInstantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/

const fromLocalUtc = (dateTime: string): Instant | undefined => {
  const match = localDateTimePattern.exec(dateTime)

  if (match === null) return undefined

  const [, year, month, day, hour, minute, second, fraction = ''] = match
  const digits = fraction.padEnd(7, '0')

  const wholeMillis = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second)
  )

  return Number.isFinite(wholeMillis)
    ? {
        millis: wholeMillis + Number(digits.slice(0, 3)),
        subMillisTicks: Number(digits.slice(3))
      }
    : undefined
}

/**
 * The instant a Graph `dateTimeTimeZone` names, when it is expressed in UTC (the cases ask for
 * `Prefer: outlook.timezone="UTC"`). Any other time zone name, or an unreadable date-time, yields
 * `undefined`: the helpers never guess a zone.
 */
export const graphInstant = (value: GraphDateTimeTimeZone | undefined): Instant | undefined =>
  value !== undefined && value.timeZone.toUpperCase() === 'UTC'
    ? fromLocalUtc(value.dateTime)
    : undefined

/** The instant an ISO-8601 UTC string (`...Z`) names. */
export const isoInstant = (value: string): Instant | undefined =>
  isoUtcInstantPattern.test(value) ? fromLocalUtc(value.slice(0, -1)) : undefined

export const sameInstant = (left: Instant | undefined, right: Instant | undefined): boolean =>
  left !== undefined &&
  right !== undefined &&
  left.millis === right.millis &&
  left.subMillisTicks === right.subMillisTicks

/** `left` strictly before `right`. */
export const isBefore = (left: Instant, right: Instant): boolean =>
  left.millis < right.millis ||
  (left.millis === right.millis && left.subMillisTicks < right.subMillisTicks)

export const isNonEmptyString = (value: unknown): value is string =>
  Predicate.isString(value) && value.trim().length > 0
