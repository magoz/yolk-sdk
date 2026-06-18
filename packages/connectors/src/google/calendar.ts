import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { defineAction } from '../action.ts'
import { ConnectorHttpClient, ConnectorHttpRequest, decodeJsonResponse } from '../http.ts'
import { ActionResult } from '../result.ts'
import {
  GoogleCalendarEventsOAuthCredentialSlot,
  GoogleCalendarReadonlyOAuthCredentialSlot,
  googleAuthorizationHeaders
} from './oauth.ts'
import {
  appendNumberSearchParam,
  appendSearchParam,
  isSuccessStatus,
  providerFailureFromResponse,
  resolveGoogleAccessToken
} from './shared.ts'

export const googleCalendarApiBaseUrl = 'https://www.googleapis.com/calendar/v3'

export class GoogleCalendarEventDateTime extends Schema.Class<GoogleCalendarEventDateTime>(
  'GoogleCalendarEventDateTime'
)({
  date: Schema.optional(Schema.String),
  dateTime: Schema.optional(Schema.String),
  timeZone: Schema.optional(Schema.String)
}) {}

export class GoogleCalendarEvent extends Schema.Class<GoogleCalendarEvent>('GoogleCalendarEvent')({
  id: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  htmlLink: Schema.optional(Schema.String),
  summary: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  location: Schema.optional(Schema.String),
  start: Schema.optional(GoogleCalendarEventDateTime),
  end: Schema.optional(GoogleCalendarEventDateTime),
  attendees: Schema.optional(Schema.Array(Schema.Struct({ email: Schema.String }))),
  organizer: Schema.optional(Schema.Unknown)
}) {}

export class GoogleCalendarRef extends Schema.Class<GoogleCalendarRef>('GoogleCalendarRef')({
  id: Schema.String,
  summary: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  timeZone: Schema.optional(Schema.String),
  accessRole: Schema.optional(Schema.String),
  primary: Schema.optional(Schema.Boolean)
}) {}

export class GoogleCalendarListCalendarsInput extends Schema.Class<GoogleCalendarListCalendarsInput>(
  'GoogleCalendarListCalendarsInput'
)({
  maxResults: Schema.optional(Schema.Number),
  pageToken: Schema.optional(Schema.String)
}) {}

export class GoogleCalendarListCalendarsOutput extends Schema.Class<GoogleCalendarListCalendarsOutput>(
  'GoogleCalendarListCalendarsOutput'
)({
  items: Schema.optional(Schema.Array(GoogleCalendarRef)),
  nextPageToken: Schema.optional(Schema.String)
}) {}

export class GoogleCalendarListEventsInput extends Schema.Class<GoogleCalendarListEventsInput>(
  'GoogleCalendarListEventsInput'
)({
  calendarId: Schema.optional(Schema.String),
  timeMin: Schema.optional(Schema.String),
  timeMax: Schema.optional(Schema.String),
  query: Schema.optional(Schema.String),
  maxResults: Schema.optional(Schema.Number),
  pageToken: Schema.optional(Schema.String),
  singleEvents: Schema.optional(Schema.Boolean),
  orderBy: Schema.optional(Schema.Literals(['startTime', 'updated']))
}) {}

export class GoogleCalendarListEventsOutput extends Schema.Class<GoogleCalendarListEventsOutput>(
  'GoogleCalendarListEventsOutput'
)({
  items: Schema.optional(Schema.Array(GoogleCalendarEvent)),
  nextPageToken: Schema.optional(Schema.String)
}) {}

export class GoogleCalendarCreateEventInput extends Schema.Class<GoogleCalendarCreateEventInput>(
  'GoogleCalendarCreateEventInput'
)({
  calendarId: Schema.optional(Schema.String),
  summary: Schema.String,
  description: Schema.optional(Schema.String),
  location: Schema.optional(Schema.String),
  start: GoogleCalendarEventDateTime,
  end: GoogleCalendarEventDateTime,
  attendees: Schema.optional(Schema.Array(Schema.Struct({ email: Schema.String })))
}) {}

export class GoogleCalendarEventIdInput extends Schema.Class<GoogleCalendarEventIdInput>(
  'GoogleCalendarEventIdInput'
)({
  calendarId: Schema.optional(Schema.String),
  eventId: Schema.String
}) {}

export class GoogleCalendarUpdateEventInput extends Schema.Class<GoogleCalendarUpdateEventInput>(
  'GoogleCalendarUpdateEventInput'
)({
  calendarId: Schema.optional(Schema.String),
  eventId: Schema.String,
  summary: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  location: Schema.optional(Schema.String),
  start: Schema.optional(GoogleCalendarEventDateTime),
  end: Schema.optional(GoogleCalendarEventDateTime),
  attendees: Schema.optional(Schema.Array(Schema.Struct({ email: Schema.String })))
}) {}

const calendarIdOrPrimary = (calendarId: string | undefined) => calendarId ?? 'primary'

const calendarRequest = (input: {
  readonly token: string
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  readonly path: string
  readonly body?: unknown
}) => {
  const headers =
    input.body === undefined
      ? googleAuthorizationHeaders(input.token)
      : { ...googleAuthorizationHeaders(input.token), 'content-type': 'application/json' }

  return ConnectorHttpRequest.make({
    method: input.method,
    url: `${googleCalendarApiBaseUrl}${input.path}`,
    headers,
    body: input.body === undefined ? undefined : JSON.stringify(input.body)
  })
}

export const googleCalendarListEventsAction = defineAction({
  id: 'calendar.list_events',
  description: 'List Google Calendar events for the integration account.',
  inputSchema: GoogleCalendarListEventsInput,
  outputSchema: GoogleCalendarListEventsOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const token = yield* resolveGoogleAccessToken(
        integration,
        GoogleCalendarReadonlyOAuthCredentialSlot
      )
      const http = yield* ConnectorHttpClient
      const params = new URLSearchParams()
      appendSearchParam(params, 'timeMin', input.timeMin)
      appendSearchParam(params, 'timeMax', input.timeMax)
      appendSearchParam(params, 'q', input.query)
      appendNumberSearchParam(params, 'maxResults', input.maxResults)
      appendSearchParam(params, 'pageToken', input.pageToken)
      appendSearchParam(
        params,
        'singleEvents',
        input.singleEvents === undefined ? undefined : String(input.singleEvents)
      )
      appendSearchParam(params, 'orderBy', input.orderBy)
      const query = params.toString()
      const url = `${googleCalendarApiBaseUrl}/calendars/${encodeURIComponent(calendarIdOrPrimary(input.calendarId))}/events${query === '' ? '' : `?${query}`}`
      const response = yield* http.request(
        ConnectorHttpRequest.make({
          method: 'GET',
          url,
          headers: googleAuthorizationHeaders(token)
        })
      )

      if (!isSuccessStatus(response.status)) {
        return yield* providerFailureFromResponse({
          code: 'calendar_list_events_failed',
          message: 'Google Calendar list events failed',
          status: response.status,
          body: response.body
        })
      }

      const output = yield* decodeJsonResponse(GoogleCalendarListEventsOutput, response)
      return ActionResult.success(output)
    })
})

export const googleCalendarCreateEventAction = defineAction({
  id: 'calendar.create_event',
  description: 'Create a Google Calendar event for the integration account.',
  inputSchema: GoogleCalendarCreateEventInput,
  outputSchema: GoogleCalendarEvent,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const token = yield* resolveGoogleAccessToken(
        integration,
        GoogleCalendarEventsOAuthCredentialSlot
      )
      const http = yield* ConnectorHttpClient
      const response = yield* http.request(
        ConnectorHttpRequest.make({
          method: 'POST',
          url: `${googleCalendarApiBaseUrl}/calendars/${encodeURIComponent(calendarIdOrPrimary(input.calendarId))}/events`,
          headers: {
            ...googleAuthorizationHeaders(token),
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            summary: input.summary,
            description: input.description,
            location: input.location,
            start: input.start,
            end: input.end,
            attendees: input.attendees
          })
        })
      )

      if (!isSuccessStatus(response.status)) {
        return yield* providerFailureFromResponse({
          code: 'calendar_create_event_failed',
          message: 'Google Calendar create event failed',
          status: response.status,
          body: response.body
        })
      }

      const output = yield* decodeJsonResponse(GoogleCalendarEvent, response)
      return ActionResult.success(output)
    })
})

export const googleCalendarListCalendarsAction = defineAction({
  id: 'calendar.list_calendars',
  description: 'List Google calendars for the integration account.',
  inputSchema: GoogleCalendarListCalendarsInput,
  outputSchema: GoogleCalendarListCalendarsOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const token = yield* resolveGoogleAccessToken(
        integration,
        GoogleCalendarReadonlyOAuthCredentialSlot
      )
      const http = yield* ConnectorHttpClient
      const params = new URLSearchParams()
      appendNumberSearchParam(params, 'maxResults', input.maxResults)
      appendSearchParam(params, 'pageToken', input.pageToken)
      const query = params.toString()
      const response = yield* http.request(
        calendarRequest({
          token,
          method: 'GET',
          path: `/users/me/calendarList${query === '' ? '' : `?${query}`}`
        })
      )

      if (!isSuccessStatus(response.status)) {
        return yield* providerFailureFromResponse({
          code: 'calendar_list_calendars_failed',
          message: 'Google Calendar list calendars failed',
          status: response.status,
          body: response.body
        })
      }

      const output = yield* decodeJsonResponse(GoogleCalendarListCalendarsOutput, response)
      return ActionResult.success(output)
    })
})

export const googleCalendarGetEventAction = defineAction({
  id: 'calendar.get_event',
  description: 'Get a Google Calendar event by id.',
  inputSchema: GoogleCalendarEventIdInput,
  outputSchema: GoogleCalendarEvent,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const token = yield* resolveGoogleAccessToken(
        integration,
        GoogleCalendarReadonlyOAuthCredentialSlot
      )
      const http = yield* ConnectorHttpClient
      const response = yield* http.request(
        calendarRequest({
          token,
          method: 'GET',
          path: `/calendars/${encodeURIComponent(calendarIdOrPrimary(input.calendarId))}/events/${encodeURIComponent(input.eventId)}`
        })
      )

      if (!isSuccessStatus(response.status)) {
        return yield* providerFailureFromResponse({
          code: 'calendar_get_event_failed',
          message: 'Google Calendar get event failed',
          status: response.status,
          body: response.body
        })
      }

      const output = yield* decodeJsonResponse(GoogleCalendarEvent, response)
      return ActionResult.success(output)
    })
})

export const googleCalendarUpdateEventAction = defineAction({
  id: 'calendar.update_event',
  description: 'Update a Google Calendar event.',
  inputSchema: GoogleCalendarUpdateEventInput,
  outputSchema: GoogleCalendarEvent,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const token = yield* resolveGoogleAccessToken(
        integration,
        GoogleCalendarEventsOAuthCredentialSlot
      )
      const http = yield* ConnectorHttpClient
      const response = yield* http.request(
        calendarRequest({
          token,
          method: 'PATCH',
          path: `/calendars/${encodeURIComponent(calendarIdOrPrimary(input.calendarId))}/events/${encodeURIComponent(input.eventId)}`,
          body: {
            summary: input.summary,
            description: input.description,
            location: input.location,
            start: input.start,
            end: input.end,
            attendees: input.attendees
          }
        })
      )

      if (!isSuccessStatus(response.status)) {
        return yield* providerFailureFromResponse({
          code: 'calendar_update_event_failed',
          message: 'Google Calendar update event failed',
          status: response.status,
          body: response.body
        })
      }

      const output = yield* decodeJsonResponse(GoogleCalendarEvent, response)
      return ActionResult.success(output)
    })
})

export const googleCalendarDeleteEventAction = defineAction({
  id: 'calendar.delete_event',
  description: 'Delete a Google Calendar event.',
  inputSchema: GoogleCalendarEventIdInput,
  outputSchema: Schema.Struct({ deleted: Schema.Boolean, eventId: Schema.String }),
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const token = yield* resolveGoogleAccessToken(
        integration,
        GoogleCalendarEventsOAuthCredentialSlot
      )
      const http = yield* ConnectorHttpClient
      const response = yield* http.request(
        calendarRequest({
          token,
          method: 'DELETE',
          path: `/calendars/${encodeURIComponent(calendarIdOrPrimary(input.calendarId))}/events/${encodeURIComponent(input.eventId)}`
        })
      )

      if (!isSuccessStatus(response.status)) {
        return yield* providerFailureFromResponse({
          code: 'calendar_delete_event_failed',
          message: 'Google Calendar delete event failed',
          status: response.status,
          body: response.body
        })
      }

      return ActionResult.success({ deleted: true, eventId: input.eventId })
    })
})

export const googleCalendarListAccountsAction = defineAction({
  id: 'calendar.list_accounts',
  description: 'List the configured Google Calendar account.',
  inputSchema: Schema.Struct({}),
  outputSchema: Schema.Unknown,
  execute: ({ integration }) =>
    Effect.succeed(
      ActionResult.success({
        accounts: [{ id: integration.id, connectorId: integration.connectorId }]
      })
    )
})

export const googleCalendarActions = [
  googleCalendarListCalendarsAction,
  googleCalendarListEventsAction,
  googleCalendarGetEventAction,
  googleCalendarCreateEventAction,
  googleCalendarUpdateEventAction,
  googleCalendarDeleteEventAction,
  googleCalendarListAccountsAction
]
