import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * Event create, cancel (202, empty body), GET after cancel (404), and DELETE after cancel (404).
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:microsoft --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const microsoftCalendarCancelFixture: WireFixture = {
  id: 'microsoft.calendar.cancel-semantics.synthetic',
  caseId: 'microsoft.calendar.cancel-semantics',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://graph.microsoft.com/v1.0',
  note: 'Create a case-owned, attendee-free event, cancel it (202), then GET (404) and DELETE (404). Synthetic placeholder shaped like the Microsoft Graph wire; not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'POST',
        url: 'https://graph.microsoft.com/v1.0/users/ada%40example.test/calendars/AAMkAGI2-synthetic-calendar-0001%3D/events',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          prefer: 'outlook.timezone="UTC"'
        },
        body: {
          subject: 'yolk-conformance cancel probe: safe to delete',
          body: {
            contentType: 'text',
            content: 'Synthetic conformance event; cancelled by the case.'
          },
          start: {
            dateTime: '2026-01-05T10:00:00',
            timeZone: 'UTC'
          },
          end: {
            dateTime: '2026-01-05T10:30:00',
            timeZone: 'UTC'
          },
          isReminderOn: false,
          showAs: 'free'
        }
      },
      response: {
        status: 201,
        headers: {
          'content-type':
            'application/json; odata.metadata=minimal; odata.streaming=true; IEEE754Compatible=false; charset=utf-8'
        },
        body: '{"@odata.context":"https://graph.microsoft.com/v1.0/$metadata#users(\'ada%40example.test\')/calendars(\'AAMkAGI2-synthetic-calendar-0001%3D\')/events/$entity","@odata.etag":"W/\\"DwAAABYAAAAsynthetic0103\\"","id":"AAMkAGI2-synthetic-event-0102=","subject":"yolk-conformance cancel probe: safe to delete","start":{"dateTime":"2026-01-05T10:00:00.0000000","timeZone":"UTC"},"end":{"dateTime":"2026-01-05T10:30:00.0000000","timeZone":"UTC"},"isCancelled":false}'
      }
    },
    {
      request: {
        method: 'POST',
        url: 'https://graph.microsoft.com/v1.0/users/ada%40example.test/events/AAMkAGI2-synthetic-event-0102%3D/cancel',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          prefer: 'outlook.timezone="UTC"'
        },
        body: {
          comment: 'Synthetic conformance cancellation.'
        }
      },
      response: {
        status: 202,
        headers: {},
        body: ''
      }
    },
    {
      request: {
        method: 'GET',
        url: 'https://graph.microsoft.com/v1.0/users/ada%40example.test/events/AAMkAGI2-synthetic-event-0102%3D?$select=id,subject,start,end,isCancelled',
        headers: {
          accept: 'application/json',
          prefer: 'outlook.timezone="UTC"'
        }
      },
      response: {
        status: 404,
        headers: {
          'content-type':
            'application/json; odata.metadata=minimal; odata.streaming=true; IEEE754Compatible=false; charset=utf-8'
        },
        body: '{"error":{"code":"ErrorItemNotFound","message":"The specified object was not found in the store.","innerError":{"date":"2026-09-29T10:00:02","request-id":"00000000-0000-4000-8000-000000000002","client-request-id":"00000000-0000-4000-8000-000000000002"}}}'
      }
    },
    {
      request: {
        method: 'DELETE',
        url: 'https://graph.microsoft.com/v1.0/users/ada%40example.test/events/AAMkAGI2-synthetic-event-0102%3D',
        headers: {
          accept: 'application/json',
          prefer: 'outlook.timezone="UTC"'
        }
      },
      response: {
        status: 404,
        headers: {
          'content-type':
            'application/json; odata.metadata=minimal; odata.streaming=true; IEEE754Compatible=false; charset=utf-8'
        },
        body: '{"error":{"code":"ErrorItemNotFound","message":"The specified object was not found in the store.","innerError":{"date":"2026-09-29T10:00:03","request-id":"00000000-0000-4000-8000-000000000003","client-request-id":"00000000-0000-4000-8000-000000000003"}}}'
      }
    }
  ]
}
