import type { WireFixture } from '@yolk-sdk/conformance/fixture'
import {
  calendarConformanceEventEnd,
  calendarConformanceEventStart,
  calendarSyntheticEvent,
  calendarSyntheticEvents,
  googleErrorBody,
  googleJson,
  googleJsonRequestHeaders,
  googleNoContent
} from './synthetic.ts'

const eventId = 'syntheticconformance0002'

const summary =
  'yolk-conformance run-synthetic deleted event: synthetic conformance event, safe to delete'

const eventUrl = `${calendarSyntheticEvents}/${eventId}`

const boundaries = {
  start: { dateTime: calendarConformanceEventStart, timeZone: 'UTC' },
  end: { dateTime: calendarConformanceEventEnd, timeZone: 'UTC' }
}

/**
 * A run-scoped event without attendees created, deleted by id (204), read back cancelled, and
 * deleted again (410 Gone).
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:google --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const calendarDeletedGoneFixture: WireFixture = {
  id: 'google.calendar.deleted-event-gone.synthetic',
  caseId: 'google.calendar.deleted-event-gone',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://www.googleapis.com/calendar/v3',
  note: 'Create an event without attendees, delete it (204), read it back cancelled, and delete it again (410). Synthetic placeholder shaped like the Calendar API; not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'POST',
        url: calendarSyntheticEvents,
        headers: googleJsonRequestHeaders,
        body: {
          summary,
          description: 'Synthetic conformance event without attendees.',
          ...boundaries
        }
      },
      response: googleJson(
        200,
        calendarSyntheticEvent({
          id: eventId,
          summary,
          description: 'Synthetic conformance event without attendees.',
          ...boundaries
        })
      )
    },
    { request: { method: 'DELETE', url: eventUrl }, response: googleNoContent },
    {
      request: { method: 'GET', url: eventUrl },
      response: googleJson(
        200,
        calendarSyntheticEvent({
          id: eventId,
          summary,
          description: 'Synthetic conformance event without attendees.',
          status: 'cancelled',
          updated: '2026-09-30T12:00:05.000Z',
          ...boundaries
        })
      )
    },
    {
      request: { method: 'DELETE', url: eventUrl },
      response: googleJson(
        410,
        googleErrorBody(410, 'Resource has been deleted', 'deleted', 'GONE')
      )
    }
  ]
}
