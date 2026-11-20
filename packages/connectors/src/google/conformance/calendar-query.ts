import type { WireFixture } from '@yolk-sdk/conformance/fixture'
import { calendarListUrl, calendarSyntheticPage } from './synthetic.ts'

/**
 * The free-text event query the read-only leftover lookup sends (`q=yolk-conformance`,
 * `maxResults=250`) on the practice calendar, whose events never mention the query: an empty page
 * without `nextPageToken`.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it. The shape
 * follows the Calendar API reference for `events.list`, fetched 2026-11-20 (`q` free-text search
 * terms matched in the summary, description, location, attendee and organizer names and
 * addresses, and working-location labels; cancelled events left out unless `showDeleted`; an
 * `Events` page with `kind` `calendar#events`, `summary`, `timeZone`, `accessRole`, `items`, and
 * `nextPageToken` while more remain;
 * https://developers.google.com/workspace/calendar/api/v3/reference/events/list), with the page
 * shape of the range fixture, which omits the documented `etag`, `updated`, `defaultReminders`,
 * and `nextSyncToken`. The reference does not say how the terms are tokenized. `pnpm conformance:google --live --owner-approved --account <label>
 * --record` stages a replacement in a gitignored directory; see the script header for the manual
 * scrub-and-promote step.
 */
export const calendarQueryFixture: WireFixture = {
  id: 'google.calendar.free-text-query.synthetic',
  caseId: 'google.calendar.free-text-query',
  evidence: 'unverified',
  recordedAt: '2026-11-20',
  account: 'synthetic',
  endpoint: 'https://www.googleapis.com/calendar/v3',
  note: 'The leftover event query (q=yolk-conformance, maxResults=250) on the practice calendar, none of whose events mentions the query: an empty page without nextPageToken. Synthetic placeholder shaped from the Calendar API reference (fetched 2026-11-20; events.list q: free-text terms over summary, description, location, attendees, and organizer; showDeleted false leaves cancelled events out: https://developers.google.com/workspace/calendar/api/v3/reference/events/list) and the page shape of the range fixture, which omits the documented etag, updated, defaultReminders, and nextSyncToken. Not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'GET',
        url: calendarListUrl({ q: 'yolk-conformance', maxResults: 250 })
      },
      response: calendarSyntheticPage([])
    }
  ]
}
