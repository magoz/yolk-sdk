import type { WireFixture } from '@yolk-sdk/conformance/fixture'
import {
  calendarConformanceEventEnd,
  calendarConformanceEventStart,
  calendarSyntheticEvent,
  calendarSyntheticEvents,
  googleJson,
  googleJsonRequestHeaders,
  googleNoContent
} from './synthetic.ts'

const eventId = 'syntheticconformance0001'

const summary = 'yolk-conformance run-synthetic event: synthetic conformance event, safe to delete'

const renamed =
  'yolk-conformance run-synthetic event renamed: synthetic conformance event, safe to delete'

const eventUrl = `${calendarSyntheticEvents}/${eventId}`

const boundaries = {
  start: { dateTime: calendarConformanceEventStart, timeZone: 'UTC' },
  end: { dateTime: calendarConformanceEventEnd, timeZone: 'UTC' }
}

const created = calendarSyntheticEvent({
  id: eventId,
  summary,
  description: 'Synthetic conformance event without attendees.',
  ...boundaries
})

const updated = calendarSyntheticEvent({
  id: eventId,
  summary: renamed,
  description: 'Synthetic conformance event, renamed.',
  updated: '2026-09-30T12:00:03.000Z',
  ...boundaries
})

/**
 * A run-scoped event without attendees created in the seeded calendar, read, renamed by PATCH,
 * read again, deleted by id (204), and read back cancelled.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:google --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const calendarEventLifecycleFixture: WireFixture = {
  id: 'google.calendar.event-lifecycle.synthetic',
  caseId: 'google.calendar.event-lifecycle',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://www.googleapis.com/calendar/v3',
  note: 'Create an event without attendees, read it, rename it by PATCH, read it, delete it (204), and read it back cancelled. Synthetic placeholder shaped like the Calendar API; not recorded from a live service.',
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
      response: googleJson(200, created)
    },
    { request: { method: 'GET', url: eventUrl }, response: googleJson(200, created) },
    {
      request: {
        method: 'PATCH',
        url: eventUrl,
        headers: googleJsonRequestHeaders,
        body: { summary: renamed, description: 'Synthetic conformance event, renamed.' }
      },
      response: googleJson(200, updated)
    },
    { request: { method: 'GET', url: eventUrl }, response: googleJson(200, updated) },
    { request: { method: 'DELETE', url: eventUrl }, response: googleNoContent },
    {
      request: { method: 'GET', url: eventUrl },
      response: googleJson(
        200,
        calendarSyntheticEvent({
          id: eventId,
          summary: renamed,
          description: 'Synthetic conformance event, renamed.',
          status: 'cancelled',
          updated: '2026-09-30T12:00:05.000Z',
          ...boundaries
        })
      )
    }
  ]
}
