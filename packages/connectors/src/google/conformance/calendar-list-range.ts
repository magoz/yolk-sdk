import type * as Schema from 'effect/Schema'
import type { WireFixture } from '@yolk-sdk/conformance/fixture'
import { calendarListUrl, calendarSyntheticEvent, googleJson } from './synthetic.ts'

const range = {
  timeMin: '2026-09-01T00:00:00Z',
  timeMax: '2026-09-08T00:00:00Z',
  singleEvents: true,
  orderBy: 'startTime'
} as const

const timed = (id: string, summary: string, start: string, end: string) =>
  calendarSyntheticEvent({
    id,
    summary,
    start: { dateTime: start, timeZone: 'UTC' },
    end: { dateTime: end, timeZone: 'UTC' }
  })

const events = [
  timed(
    'syntheticrange0001',
    'Synthetic overnight',
    '2026-08-31T23:30:00Z',
    '2026-09-01T00:30:00Z'
  ),
  timed('syntheticrange0002', 'Synthetic standup', '2026-09-02T09:00:00Z', '2026-09-02T09:15:00Z'),
  timed('syntheticrange0003', 'Synthetic review', '2026-09-03T14:00:00Z', '2026-09-03T15:00:00Z'),
  calendarSyntheticEvent({
    id: 'syntheticrange0004',
    summary: 'Synthetic all-day',
    start: { date: '2026-09-05' },
    end: { date: '2026-09-06' }
  }),
  timed('syntheticrange0005', 'Synthetic late', '2026-09-07T23:00:00Z', '2026-09-08T01:00:00Z')
]

type SyntheticEventsPage = {
  readonly kind: string
  readonly summary: string
  readonly timeZone: string
  readonly accessRole: string
  readonly items: Array<Schema.Json>
  nextPageToken?: string
}

const page = (items: ReadonlyArray<Schema.Json>, nextPageToken?: string) => {
  const body: SyntheticEventsPage = {
    kind: 'calendar#events',
    summary: 'Synthetic practice calendar',
    timeZone: 'UTC',
    accessRole: 'owner',
    items: [...items]
  }

  if (nextPageToken !== undefined) {
    body.nextPageToken = nextPageToken
  }

  return googleJson(200, body)
}

/**
 * The seeded range listed on one page (`maxResults=250`), then in pages of two chained through
 * `nextPageToken`: the same five events (one all-day, two crossing the range edges).
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:google --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const calendarListRangeFixture: WireFixture = {
  id: 'google.calendar.list-range-paging.synthetic',
  caseId: 'google.calendar.list-range-paging',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://www.googleapis.com/calendar/v3',
  note: 'List the seeded range on one page, then two events at a time, feeding nextPageToken back as pageToken. Synthetic placeholder shaped like the Calendar API; not recorded from a live service.',
  exchanges: [
    {
      request: { method: 'GET', url: calendarListUrl({ ...range, maxResults: 250 }) },
      response: page(events)
    },
    {
      request: { method: 'GET', url: calendarListUrl({ ...range, maxResults: 2 }) },
      response: page(events.slice(0, 2), 'synthetic-calendar-page-2')
    },
    {
      request: {
        method: 'GET',
        url: calendarListUrl({ ...range, maxResults: 2, pageToken: 'synthetic-calendar-page-2' })
      },
      response: page(events.slice(2, 4), 'synthetic-calendar-page-3')
    },
    {
      request: {
        method: 'GET',
        url: calendarListUrl({ ...range, maxResults: 2, pageToken: 'synthetic-calendar-page-3' })
      },
      response: page(events.slice(4))
    }
  ]
}
