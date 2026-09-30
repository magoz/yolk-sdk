import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * Event create (201 with an id), GET, PATCH, DELETE (204), and a final GET (404) with that id.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:microsoft --live --owner-approved --account <label> --record` stages a replacement in a
 * gitignored directory; see the script header for the manual scrub-and-promote step.
 */
export const microsoftCalendarCreateEventFixture: WireFixture = {
  id: 'microsoft.calendar.create-returns-event-id.synthetic',
  caseId: 'microsoft.calendar.create-returns-event-id',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://graph.microsoft.com/v1.0',
  note: 'Create a case-owned event, then GET, PATCH, and DELETE it by the returned id, and a final GET answering 404. Synthetic placeholder shaped like the Microsoft Graph wire; not recorded from a live service.',
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
          subject: 'yolk-conformance event: safe to delete',
          body: {
            contentType: 'text',
            content: 'Synthetic conformance event; safe to delete.'
          },
          start: {
            dateTime: '2026-01-05T09:00:00',
            timeZone: 'UTC'
          },
          end: {
            dateTime: '2026-01-05T09:30:00',
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
        body: '{"@odata.context":"https://graph.microsoft.com/v1.0/$metadata#users(\'ada%40example.test\')/calendars(\'AAMkAGI2-synthetic-calendar-0001%3D\')/events/$entity","@odata.etag":"W/\\"DwAAABYAAAAsynthetic0101\\"","id":"AAMkAGI2-synthetic-event-0101=","subject":"yolk-conformance event: safe to delete","start":{"dateTime":"2026-01-05T09:00:00.0000000","timeZone":"UTC"},"end":{"dateTime":"2026-01-05T09:30:00.0000000","timeZone":"UTC"},"isCancelled":false}'
      }
    },
    {
      request: {
        method: 'GET',
        url: 'https://graph.microsoft.com/v1.0/users/ada%40example.test/events/AAMkAGI2-synthetic-event-0101%3D?$select=id,subject,start,end,isCancelled',
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
        body: '{"@odata.context":"https://graph.microsoft.com/v1.0/$metadata#users(\'ada%40example.test\')/events(id,subject,start,end,isCancelled)/$entity","@odata.etag":"W/\\"DwAAABYAAAAsynthetic0101\\"","id":"AAMkAGI2-synthetic-event-0101=","subject":"yolk-conformance event: safe to delete","start":{"dateTime":"2026-01-05T09:00:00.0000000","timeZone":"UTC"},"end":{"dateTime":"2026-01-05T09:30:00.0000000","timeZone":"UTC"},"isCancelled":false}'
      }
    },
    {
      request: {
        method: 'PATCH',
        url: 'https://graph.microsoft.com/v1.0/users/ada%40example.test/events/AAMkAGI2-synthetic-event-0101%3D',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          prefer: 'outlook.timezone="UTC"'
        },
        body: {
          subject: 'yolk-conformance event (updated): safe to delete'
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type':
            'application/json; odata.metadata=minimal; odata.streaming=true; IEEE754Compatible=false; charset=utf-8'
        },
        body: '{"@odata.context":"https://graph.microsoft.com/v1.0/$metadata#users(\'ada%40example.test\')/events/$entity","@odata.etag":"W/\\"DwAAABYAAAAsynthetic0102\\"","id":"AAMkAGI2-synthetic-event-0101=","subject":"yolk-conformance event (updated): safe to delete","start":{"dateTime":"2026-01-05T09:00:00.0000000","timeZone":"UTC"},"end":{"dateTime":"2026-01-05T09:30:00.0000000","timeZone":"UTC"},"isCancelled":false}'
      }
    },
    {
      request: {
        method: 'DELETE',
        url: 'https://graph.microsoft.com/v1.0/users/ada%40example.test/events/AAMkAGI2-synthetic-event-0101%3D',
        headers: {
          accept: 'application/json',
          prefer: 'outlook.timezone="UTC"'
        }
      },
      response: {
        status: 204,
        headers: {},
        body: ''
      }
    },
    {
      request: {
        method: 'GET',
        url: 'https://graph.microsoft.com/v1.0/users/ada%40example.test/events/AAMkAGI2-synthetic-event-0101%3D?$select=id,subject,start,end,isCancelled',
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
        body: '{"error":{"code":"ErrorItemNotFound","message":"The specified object was not found in the store.","innerError":{"date":"2026-09-29T10:00:01","request-id":"00000000-0000-4000-8000-000000000001","client-request-id":"00000000-0000-4000-8000-000000000001"}}}'
      }
    }
  ]
}
