import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * The seeded meeting found by its join link, then its transcripts by meeting id.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:microsoft --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const microsoftTeamsMeetingTranscriptsFixture: WireFixture = {
  id: 'microsoft.teams.meeting-transcripts.synthetic',
  caseId: 'microsoft.teams.meeting-transcripts',
  evidence: 'unverified',
  recordedAt: '2026-11-20',
  account: 'synthetic',
  endpoint: 'https://graph.microsoft.com/v1.0',
  note: "The signed-in user's online meeting found by the seeded join link ($filter on JoinWebUrl), then the transcripts of that meeting by its id. Shapes from the Microsoft Graph v1.0 docs (Get onlineMeeting, https://learn.microsoft.com/graph/api/onlinemeeting-get; List transcripts, https://learn.microsoft.com/graph/api/onlinemeeting-list-transcripts). Synthetic placeholder shaped like the Microsoft Graph wire; not recorded from a live service.",
  exchanges: [
    {
      request: {
        method: 'GET',
        url: 'https://graph.microsoft.com/v1.0/me/onlineMeetings?%24filter=JoinWebUrl+eq+%27https%3A%2F%2Fteams.microsoft.com%2Fl%2Fmeetup-join%2F19%253ameeting_c3ludGhldGljLW1lZXRpbmctMDAwMQ%2540thread.v2%2F0%3Fcontext%3D%257b%2522Tid%2522%253a%252200000000-0000-4000-8000-00000000c0de%2522%252c%2522Oid%2522%253a%252200000000-0000-4000-8000-00000000ada1%2522%257d%27',
        headers: {
          accept: 'application/json'
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type':
            'application/json; odata.metadata=minimal; odata.streaming=true; IEEE754Compatible=false; charset=utf-8'
        },
        body: '{"@odata.context":"https://graph.microsoft.com/v1.0/$metadata#users(\'00000000-0000-4000-8000-00000000ada1\')/onlineMeetings","value":[{"id":"MSpzeW50aGV0aWMtbWVldGluZy0wMDAx","creationDateTime":"2026-09-20T08:00:00.0000000Z","startDateTime":"2026-09-23T12:00:00Z","endDateTime":"2026-09-23T13:00:00Z","joinUrl":"https://teams.microsoft.com/l/meetup-join/19%3ameeting_c3ludGhldGljLW1lZXRpbmctMDAwMQ%40thread.v2/0?context=%7b%22Tid%22%3a%2200000000-0000-4000-8000-00000000c0de%22%2c%22Oid%22%3a%2200000000-0000-4000-8000-00000000ada1%22%7d","joinWebUrl":"https://teams.microsoft.com/l/meetup-join/19%3ameeting_c3ludGhldGljLW1lZXRpbmctMDAwMQ%40thread.v2/0?context=%7b%22Tid%22%3a%2200000000-0000-4000-8000-00000000c0de%22%2c%22Oid%22%3a%2200000000-0000-4000-8000-00000000ada1%22%7d","meetingCode":null,"subject":"Synthetic planning session","isBroadcast":false,"autoAdmittedUsers":"everyoneInCompany","outerMeetingAutoAdmittedUsers":null,"isEntryExitAnnounced":true,"allowedPresenters":"everyone","allowMeetingChat":"enabled","allowTeamworkReactions":true,"allowAttendeeToEnableMic":true,"allowAttendeeToEnableCamera":true,"recordAutomatically":false,"videoTeleconferenceId":null,"externalId":null,"broadcastSettings":null,"audioConferencing":null,"meetingInfo":null,"participants":{"organizer":{"upn":"ada@example.test","role":"presenter","identity":{"application":null,"device":null,"user":{"id":"00000000-0000-4000-8000-00000000ada1","displayName":null,"tenantId":"00000000-0000-4000-8000-00000000c0de","identityProvider":"AAD"}}},"attendees":[{"upn":"grace@example.test","role":"attendee","identity":{"application":null,"device":null,"user":{"id":"00000000-0000-4000-8000-0000000097ac","displayName":null,"tenantId":"00000000-0000-4000-8000-00000000c0de","identityProvider":"AAD"}}}],"producers":[],"contributors":[]},"lobbyBypassSettings":{"scope":"organization","isDialInBypassEnabled":false},"joinMeetingIdSettings":null,"chatInfo":{"threadId":"19:meeting_c3ludGhldGljLW1lZXRpbmctMDAwMQ@thread.v2","messageId":"0","replyChainMessageId":null}}]}'
      }
    },
    {
      request: {
        method: 'GET',
        url: 'https://graph.microsoft.com/v1.0/me/onlineMeetings/MSpzeW50aGV0aWMtbWVldGluZy0wMDAx/transcripts',
        headers: {
          accept: 'application/json'
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type':
            'application/json; odata.metadata=minimal; odata.streaming=true; IEEE754Compatible=false; charset=utf-8'
        },
        body: '{"@odata.context":"https://graph.microsoft.com/v1.0/$metadata#users(\'00000000-0000-4000-8000-00000000ada1\')/onlineMeetings(\'MSpzeW50aGV0aWMtbWVldGluZy0wMDAx\')/transcripts","value":[{"id":"MSMjMCMjc3ludGhldGljLXRyYW5zY3JpcHQtMDAwMQ","meetingId":"MSpzeW50aGV0aWMtbWVldGluZy0wMDAx","callId":"synthetic-call-0001","contentCorrelationId":"synthetic-correlation-0001","transcriptContentUrl":"https://graph.microsoft.com/v1.0/users/00000000-0000-4000-8000-00000000ada1/onlineMeetings/MSpzeW50aGV0aWMtbWVldGluZy0wMDAx/transcripts/MSMjMCMjc3ludGhldGljLXRyYW5zY3JpcHQtMDAwMQ/content","createdDateTime":"2026-09-23T12:05:00.0000000Z","endDateTime":"2026-09-23T12:55:00.0000000Z","meetingOrganizer":{"application":null,"device":null,"user":{"id":"00000000-0000-4000-8000-00000000ada1","displayName":null,"userIdentityType":"aadUser","tenantId":"00000000-0000-4000-8000-00000000c0de"}}}]}'
      }
    }
  ]
}
