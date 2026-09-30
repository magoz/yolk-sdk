import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * One calendar view page over the seeded range: two events with seven-digit fractional UTC times.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:microsoft --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const microsoftCalendarListRangeFixture: WireFixture = {
  id: 'microsoft.calendar.list-range-returns-events.synthetic',
  caseId: 'microsoft.calendar.list-range-returns-events',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://graph.microsoft.com/v1.0',
  note: 'Calendar view over the seeded range (2026-09-21 to 2026-09-28, UTC) of a calendar with two events. Synthetic placeholder shaped like the Microsoft Graph wire; not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'GET',
        url: 'https://graph.microsoft.com/v1.0/users/ada%40example.test/calendars/AAMkAGI2-synthetic-calendar-0001%3D/calendarView?startDateTime=2026-09-21T00:00:00Z&endDateTime=2026-09-28T00:00:00Z&$select=id,subject,start,end,isCancelled&$top=50',
        headers: {
          accept: 'application/json',
          prefer: 'outlook.timezone="UTC"'
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type':
            'application/json; odata.metadata=minimal; odata.streaming=true; IEEE754Compatible=false; charset=utf-8',
          'preference-applied': 'outlook.timezone="UTC"'
        },
        body: '{"@odata.context":"https://graph.microsoft.com/v1.0/$metadata#users(\'ada%40example.test\')/calendars(\'AAMkAGI2-synthetic-calendar-0001%3D\')/calendarView(id,subject,start,end,isCancelled)","value":[{"@odata.etag":"W/\\"DwAAABYAAAAsynthetic0001\\"","id":"AAMkAGI2-synthetic-event-0001=","subject":"Synthetic planning session","start":{"dateTime":"2026-09-23T12:00:00.0000000","timeZone":"UTC"},"end":{"dateTime":"2026-09-23T13:00:00.0000000","timeZone":"UTC"},"isCancelled":false},{"@odata.etag":"W/\\"DwAAABYAAAAsynthetic0002\\"","id":"AAMkAGI2-synthetic-event-0002=","subject":"Synthetic review","start":{"dateTime":"2026-09-24T08:30:00.0000000","timeZone":"UTC"},"end":{"dateTime":"2026-09-24T09:00:00.0000000","timeZone":"UTC"},"isCancelled":false}]}'
      }
    }
  ]
}
