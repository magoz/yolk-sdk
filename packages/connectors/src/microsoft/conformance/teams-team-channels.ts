import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * The joined teams, the seeded team by id, its channels, and the seeded channel by id.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:microsoft --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const microsoftTeamsTeamChannelsFixture: WireFixture = {
  id: 'microsoft.teams.team-channels.synthetic',
  caseId: 'microsoft.teams.team-channels',
  evidence: 'unverified',
  recordedAt: '2026-11-20',
  account: 'synthetic',
  endpoint: 'https://graph.microsoft.com/v1.0',
  note: "The signed-in user's joined teams (the seeded team), the seeded team by id, its channels (General and the seeded channel), and the seeded channel by id, each with the connector's $select. Shapes from the Microsoft Graph v1.0 docs (List joinedTeams, https://learn.microsoft.com/graph/api/user-list-joinedteams; Get team, https://learn.microsoft.com/graph/api/team-get; List channels, https://learn.microsoft.com/graph/api/channel-list; Get channel, https://learn.microsoft.com/graph/api/channel-get). Synthetic placeholder shaped like the Microsoft Graph wire; not recorded from a live service.",
  exchanges: [
    {
      request: {
        method: 'GET',
        url: 'https://graph.microsoft.com/v1.0/me/joinedTeams',
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
        body: '{"@odata.context":"https://graph.microsoft.com/v1.0/$metadata#teams","@odata.count":1,"value":[{"id":"00000000-0000-4000-8000-000000007ea1","createdDateTime":null,"displayName":"Synthetic Team","description":"Synthetic practice team","internalId":null,"classification":null,"specialization":null,"visibility":null,"webUrl":null,"isArchived":false,"tenantId":"00000000-0000-4000-8000-00000000c0de","isMembershipLimitedToOwners":null,"memberSettings":null,"guestSettings":null,"messagingSettings":null,"funSettings":null,"discoverySettings":null,"summary":null}]}'
      }
    },
    {
      request: {
        method: 'GET',
        url: 'https://graph.microsoft.com/v1.0/teams/00000000-0000-4000-8000-000000007ea1?%24select=id%2CdisplayName%2Cdescription%2CisArchived%2CwebUrl',
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
        body: '{"@odata.context":"https://graph.microsoft.com/v1.0/$metadata#teams(id,displayName,description,isArchived,webUrl)/$entity","id":"00000000-0000-4000-8000-000000007ea1","displayName":"Synthetic Team","description":"Synthetic practice team","isArchived":false,"webUrl":"https://teams.microsoft.com/l/team/19%3Asynthetic-general-0001%40thread.tacv2/conversations?groupId=00000000-0000-4000-8000-000000007ea1&tenantId=00000000-0000-4000-8000-00000000c0de"}'
      }
    },
    {
      request: {
        method: 'GET',
        url: 'https://graph.microsoft.com/v1.0/teams/00000000-0000-4000-8000-000000007ea1/channels?%24select=id%2CdisplayName%2Cdescription%2CmembershipType%2CcreatedDateTime%2CwebUrl',
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
        body: '{"@odata.context":"https://graph.microsoft.com/v1.0/$metadata#teams(\'00000000-0000-4000-8000-000000007ea1\')/channels(id,displayName,description,membershipType,createdDateTime,webUrl)","@odata.count":2,"value":[{"id":"19:synthetic-general-0001@thread.tacv2","createdDateTime":"2026-08-03T09:00:00Z","displayName":"General","description":"Synthetic practice team","webUrl":"https://teams.microsoft.com/l/channel/19%3Asynthetic-general-0001%40thread.tacv2/General?groupId=00000000-0000-4000-8000-000000007ea1&tenantId=00000000-0000-4000-8000-00000000c0de","membershipType":"standard"},{"id":"19:synthetic-channel-0001@thread.tacv2","createdDateTime":"2026-08-04T09:00:00Z","displayName":"Synthetic Updates","description":"Synthetic channel for weekly updates","webUrl":"https://teams.microsoft.com/l/channel/19%3Asynthetic-channel-0001%40thread.tacv2/Synthetic%20Updates?groupId=00000000-0000-4000-8000-000000007ea1&tenantId=00000000-0000-4000-8000-00000000c0de","membershipType":"standard"}]}'
      }
    },
    {
      request: {
        method: 'GET',
        url: 'https://graph.microsoft.com/v1.0/teams/00000000-0000-4000-8000-000000007ea1/channels/19%3Asynthetic-channel-0001%40thread.tacv2?%24select=id%2CdisplayName%2Cdescription%2CmembershipType%2CcreatedDateTime%2CwebUrl',
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
        body: '{"@odata.context":"https://graph.microsoft.com/v1.0/$metadata#teams(\'00000000-0000-4000-8000-000000007ea1\')/channels(id,displayName,description,membershipType,createdDateTime,webUrl)/$entity","id":"19:synthetic-channel-0001@thread.tacv2","createdDateTime":"2026-08-04T09:00:00Z","displayName":"Synthetic Updates","description":"Synthetic channel for weekly updates","webUrl":"https://teams.microsoft.com/l/channel/19%3Asynthetic-channel-0001%40thread.tacv2/Synthetic%20Updates?groupId=00000000-0000-4000-8000-000000007ea1&tenantId=00000000-0000-4000-8000-00000000c0de","membershipType":"standard"}'
      }
    }
  ]
}
