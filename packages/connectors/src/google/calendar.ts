import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { defineAction } from '../action.ts'
import { ConnectorHttpClient, ConnectorHttpRequest, decodeJsonResponse } from '../http.ts'
import { ActionResult } from '../result.ts'
import { googleAuthorizationHeaders } from './oauth.ts'
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
  end: Schema.optional(GoogleCalendarEventDateTime)
}) {}

export class GoogleCalendarListEventsInput extends Schema.Class<GoogleCalendarListEventsInput>(
  'GoogleCalendarListEventsInput'
)({
  calendarId: Schema.optional(Schema.String),
  timeMin: Schema.optional(Schema.String),
  timeMax: Schema.optional(Schema.String),
  query: Schema.optional(Schema.String),
  maxResults: Schema.optional(Schema.Number)
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
  end: GoogleCalendarEventDateTime
}) {}

const calendarIdOrPrimary = (calendarId: string | undefined) => calendarId ?? 'primary'

export const googleCalendarListEventsAction = defineAction({
  id: 'calendar.list_events',
  description: 'List Google Calendar events for the integration account.',
  inputSchema: GoogleCalendarListEventsInput,
  outputSchema: GoogleCalendarListEventsOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const token = yield* resolveGoogleAccessToken(integration)
      const http = yield* ConnectorHttpClient
      const params = new URLSearchParams()
      appendSearchParam(params, 'timeMin', input.timeMin)
      appendSearchParam(params, 'timeMax', input.timeMax)
      appendSearchParam(params, 'q', input.query)
      appendNumberSearchParam(params, 'maxResults', input.maxResults)
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
        return providerFailureFromResponse({
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
      const token = yield* resolveGoogleAccessToken(integration)
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
            end: input.end
          })
        })
      )

      if (!isSuccessStatus(response.status)) {
        return providerFailureFromResponse({
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

export const googleCalendarActions = [googleCalendarListEventsAction, googleCalendarCreateEventAction]
