/**
 * The Microsoft Teams and SharePoint site conformance fixtures, copied as data (internal; never
 * imported from `@yolk-sdk/connectors`): the eight synthetic `WireFixture`s of the
 * `microsoft.sharepoint.*` and `microsoft.teams.*` cases in
 * `@yolk-sdk/connectors/microsoft/conformance`, in `microsoftConformanceFixtures` order. Their
 * shapes come from the Microsoft Graph v1.0 docs examples (each note names its pages); none is
 * recorded from a live service. `test/microsoft-teams-sharepoint.test.ts` fails when this copy
 * drifts from the source and replays every exchange against the emulator byte for byte. No fixture
 * records `authorization`.
 *
 * @experimental
 */
import type * as Schema from 'effect/Schema'

/** One recorded exchange (the `WireExchange` fields these fixtures use, as data). */
export type MicrosoftRecordedExchange = {
  readonly request: {
    readonly method: string
    readonly url: string
    readonly headers: Readonly<Record<string, string>>
    readonly body?: Schema.Json
  }
  readonly response: {
    readonly status: number
    readonly headers: Readonly<Record<string, string>>
    readonly body: string
  }
}

/** A copied fixture (the `WireFixture` fields, as data). */
export type MicrosoftRecordedFixture = {
  readonly id: string
  readonly caseId: string
  readonly evidence: 'unverified'
  readonly recordedAt: string
  readonly account: string
  readonly endpoint: string
  readonly note: string
  readonly exchanges: ReadonlyArray<MicrosoftRecordedExchange>
}

/** Every Teams and SharePoint site fixture, in `microsoftConformanceFixtures` order. */
export const microsoftTeamsSitesFixtures: ReadonlyArray<MicrosoftRecordedFixture> = [
  {
    id: 'microsoft.sharepoint.search-finds-site.synthetic',
    caseId: 'microsoft.sharepoint.search-finds-site',
    evidence: 'unverified',
    recordedAt: '2026-11-20',
    account: 'synthetic',
    endpoint: 'https://graph.microsoft.com/v1.0',
    note: 'Site search for the seeded keyword: the seeded team site and one more site, each with a {hostname},{site-collection-id},{web-id} id. Shape from the Microsoft Graph v1.0 docs (Search for sites, https://learn.microsoft.com/graph/api/site-search). Synthetic placeholder shaped like the Microsoft Graph wire; not recorded from a live service.',
    exchanges: [
      {
        request: {
          method: 'GET',
          url: 'https://graph.microsoft.com/v1.0/sites?search=synthetic',
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
          body: '{"@odata.context":"https://graph.microsoft.com/v1.0/$metadata#sites","value":[{"createdDateTime":"2026-08-03T09:00:00Z","description":"Synthetic practice team site","id":"synthetic.sharepoint.com,11111111-1111-4111-8111-111111111111,22222222-2222-4222-8222-222222222222","lastModifiedDateTime":"2026-09-28T16:45:00Z","name":"synthetic-team","webUrl":"https://synthetic.sharepoint.com/sites/synthetic-team","displayName":"Synthetic Team"},{"createdDateTime":"2026-08-04T09:00:00Z","description":null,"id":"synthetic.sharepoint.com,11111111-1111-4111-8111-111111111111,33333333-3333-4333-8333-333333333333","lastModifiedDateTime":"2026-09-01T08:00:00Z","name":"synthetic-archive","webUrl":"https://synthetic.sharepoint.com/sites/synthetic-archive","displayName":"Synthetic Archive"}]}'
        }
      }
    ]
  },
  {
    id: 'microsoft.sharepoint.site-drives-libraries.synthetic',
    caseId: 'microsoft.sharepoint.site-drives-libraries',
    evidence: 'unverified',
    recordedAt: '2026-11-20',
    account: 'synthetic',
    endpoint: 'https://graph.microsoft.com/v1.0',
    note: 'Document libraries of the seeded site (one without a description, sent as null), requested by its site id with the commas literal. Shape from the Microsoft Graph v1.0 docs (List drives, https://learn.microsoft.com/graph/api/drive-list). Synthetic placeholder shaped like the Microsoft Graph wire; not recorded from a live service.',
    exchanges: [
      {
        request: {
          method: 'GET',
          url: 'https://graph.microsoft.com/v1.0/sites/synthetic.sharepoint.com,11111111-1111-4111-8111-111111111111,22222222-2222-4222-8222-222222222222/drives?%24select=id%2Cname%2Cdescription%2CdriveType%2CwebUrl%2CcreatedDateTime%2ClastModifiedDateTime',
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
          body: '{"@odata.context":"https://graph.microsoft.com/v1.0/$metadata#drives(id,name,description,driveType,webUrl,createdDateTime,lastModifiedDateTime)","value":[{"id":"b!synthetic-library-0001","name":"Documents","description":null,"driveType":"documentLibrary","webUrl":"https://synthetic.sharepoint.com/sites/synthetic-team/Shared%20Documents","createdDateTime":"2026-08-03T09:00:00Z","lastModifiedDateTime":"2026-09-28T16:45:00Z"},{"id":"b!synthetic-library-0002","name":"Synthetic Records","description":"Synthetic records library","driveType":"documentLibrary","webUrl":"https://synthetic.sharepoint.com/sites/synthetic-team/Synthetic%20Records","createdDateTime":"2026-08-05T09:00:00Z","lastModifiedDateTime":"2026-09-20T12:00:00Z"}]}'
        }
      }
    ]
  },
  {
    id: 'microsoft.teams.chats-list-members.synthetic',
    caseId: 'microsoft.teams.chats-list-members',
    evidence: 'unverified',
    recordedAt: '2026-11-20',
    account: 'synthetic',
    endpoint: 'https://graph.microsoft.com/v1.0',
    note: "One page of the signed-in user's chats with $expand=members (a group chat and a one-on-one chat), then the first listed chat by id with its members. Shapes from the Microsoft Graph v1.0 docs (List chats, https://learn.microsoft.com/graph/api/chat-list; Get chat, https://learn.microsoft.com/graph/api/chat-get). Synthetic placeholder shaped like the Microsoft Graph wire; not recorded from a live service.",
    exchanges: [
      {
        request: {
          method: 'GET',
          url: 'https://graph.microsoft.com/v1.0/me/chats?%24expand=members&%24top=10',
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
          body: '{"@odata.context":"https://graph.microsoft.com/v1.0/$metadata#chats(members())","@odata.count":2,"value":[{"id":"19:synthetic-chat-0001@thread.v2","topic":"Synthetic project chat","createdDateTime":"2026-09-01T08:00:00Z","lastUpdatedDateTime":"2026-09-28T09:30:00Z","chatType":"group","webUrl":"https://teams.microsoft.com/l/chat/19%3Asynthetic-chat-0001@thread.v2/0?tenantId=00000000-0000-4000-8000-00000000c0de","tenantId":"00000000-0000-4000-8000-00000000c0de","onlineMeetingInfo":null,"viewpoint":{"isHidden":false,"lastMessageReadDateTime":"2026-09-28T09:30:00Z"},"isHiddenForAllMembers":false,"members":[{"@odata.type":"#microsoft.graph.aadUserConversationMember","id":"c3ludGhldGljLW1lbWJlci0wMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMGFkYTE=","roles":["owner"],"displayName":"Ada Example","visibleHistoryStartDateTime":"0001-01-01T00:00:00Z","userId":"00000000-0000-4000-8000-00000000ada1","email":"ada@example.test","tenantId":"00000000-0000-4000-8000-00000000c0de"},{"@odata.type":"#microsoft.graph.aadUserConversationMember","id":"c3ludGhldGljLW1lbWJlci0wMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDk3YWM=","roles":["owner"],"displayName":"Grace Example","visibleHistoryStartDateTime":"0001-01-01T00:00:00Z","userId":"00000000-0000-4000-8000-0000000097ac","email":"grace@example.test","tenantId":"00000000-0000-4000-8000-00000000c0de"}]},{"id":"19:00000000-0000-4000-8000-00000000ada1_00000000-0000-4000-8000-0000000097ac@unq.gbl.spaces","topic":null,"createdDateTime":"2026-09-02T08:00:00Z","lastUpdatedDateTime":"2026-09-27T15:00:00Z","chatType":"oneOnOne","webUrl":"https://teams.microsoft.com/l/chat/19%3A00000000-0000-4000-8000-00000000ada1_00000000-0000-4000-8000-0000000097ac@unq.gbl.spaces/0?tenantId=00000000-0000-4000-8000-00000000c0de","tenantId":"00000000-0000-4000-8000-00000000c0de","onlineMeetingInfo":null,"viewpoint":{"isHidden":false,"lastMessageReadDateTime":"2026-09-27T15:00:00Z"},"isHiddenForAllMembers":false,"members":[{"@odata.type":"#microsoft.graph.aadUserConversationMember","id":"c3ludGhldGljLW1lbWJlci0wMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMGFkYTE=","roles":["owner"],"displayName":"Ada Example","visibleHistoryStartDateTime":"0001-01-01T00:00:00Z","userId":"00000000-0000-4000-8000-00000000ada1","email":"ada@example.test","tenantId":"00000000-0000-4000-8000-00000000c0de"},{"@odata.type":"#microsoft.graph.aadUserConversationMember","id":"c3ludGhldGljLW1lbWJlci0wMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDk3YWM=","roles":["owner"],"displayName":"Grace Example","visibleHistoryStartDateTime":"0001-01-01T00:00:00Z","userId":"00000000-0000-4000-8000-0000000097ac","email":"grace@example.test","tenantId":"00000000-0000-4000-8000-00000000c0de"}]}]}'
        }
      },
      {
        request: {
          method: 'GET',
          url: 'https://graph.microsoft.com/v1.0/chats/19%3Asynthetic-chat-0001%40thread.v2?%24expand=members',
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
          body: '{"@odata.context":"https://graph.microsoft.com/v1.0/$metadata#chats(members())/$entity","id":"19:synthetic-chat-0001@thread.v2","topic":"Synthetic project chat","createdDateTime":"2026-09-01T08:00:00Z","lastUpdatedDateTime":"2026-09-28T09:30:00Z","chatType":"group","webUrl":"https://teams.microsoft.com/l/chat/19%3Asynthetic-chat-0001@thread.v2/0?tenantId=00000000-0000-4000-8000-00000000c0de","tenantId":"00000000-0000-4000-8000-00000000c0de","onlineMeetingInfo":null,"viewpoint":{"isHidden":false,"lastMessageReadDateTime":"2026-09-28T09:30:00Z"},"isHiddenForAllMembers":false,"members":[{"@odata.type":"#microsoft.graph.aadUserConversationMember","id":"c3ludGhldGljLW1lbWJlci0wMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMGFkYTE=","roles":["owner"],"displayName":"Ada Example","visibleHistoryStartDateTime":"0001-01-01T00:00:00Z","userId":"00000000-0000-4000-8000-00000000ada1","email":"ada@example.test","tenantId":"00000000-0000-4000-8000-00000000c0de"},{"@odata.type":"#microsoft.graph.aadUserConversationMember","id":"c3ludGhldGljLW1lbWJlci0wMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDk3YWM=","roles":["owner"],"displayName":"Grace Example","visibleHistoryStartDateTime":"0001-01-01T00:00:00Z","userId":"00000000-0000-4000-8000-0000000097ac","email":"grace@example.test","tenantId":"00000000-0000-4000-8000-00000000c0de"}]}'
        }
      }
    ]
  },
  {
    id: 'microsoft.teams.chat-messages-paging.synthetic',
    caseId: 'microsoft.teams.chat-messages-paging',
    evidence: 'unverified',
    recordedAt: '2026-11-20',
    account: 'synthetic',
    endpoint: 'https://graph.microsoft.com/v1.0',
    note: 'Two pages of the seeded chat (three messages, page size 2): the first with an @odata.nextLink that names the chat id unencoded (as the Graph docs example does), the second reached by following it; then the first listed message by id. Shapes from the Microsoft Graph v1.0 docs (List messages in a chat, https://learn.microsoft.com/graph/api/chat-list-messages; Get chatMessage, https://learn.microsoft.com/graph/api/chatmessage-get). Synthetic placeholder shaped like the Microsoft Graph wire; not recorded from a live service.',
    exchanges: [
      {
        request: {
          method: 'GET',
          url: 'https://graph.microsoft.com/v1.0/chats/19%3Asynthetic-chat-0001%40thread.v2/messages?%24top=2&%24orderby=lastModifiedDateTime+desc',
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
          body: '{"@odata.context":"https://graph.microsoft.com/v1.0/$metadata#chats(\'19%3Asynthetic-chat-0001%40thread.v2\')/messages","@odata.count":2,"@odata.nextLink":"https://graph.microsoft.com/v1.0/chats/19:synthetic-chat-0001@thread.v2/messages?$top=2&$skiptoken=c3ludGhldGljLXNraXB0b2tlbi0wMDAx","value":[{"id":"1789900000003","replyToId":null,"etag":"1789900000003","messageType":"message","createdDateTime":"2026-09-28T09:00:00.003Z","lastModifiedDateTime":"2026-09-28T09:00:00.003Z","lastEditedDateTime":null,"deletedDateTime":null,"subject":null,"summary":null,"chatId":"19:synthetic-chat-0001@thread.v2","importance":"normal","locale":"en-us","webUrl":null,"policyViolation":null,"eventDetail":null,"from":{"application":null,"device":null,"user":{"@odata.type":"#microsoft.graph.teamworkUserIdentity","id":"00000000-0000-4000-8000-00000000ada1","displayName":"Ada Example","userIdentityType":"aadUser","tenantId":"00000000-0000-4000-8000-00000000c0de"}},"body":{"contentType":"html","content":"<p>Synthetic update 3</p>"},"channelIdentity":null,"attachments":[],"mentions":[],"reactions":[],"messageHistory":[]},{"id":"1789900000002","replyToId":null,"etag":"1789900000002","messageType":"message","createdDateTime":"2026-09-28T08:00:00.002Z","lastModifiedDateTime":"2026-09-28T08:00:00.002Z","lastEditedDateTime":null,"deletedDateTime":null,"subject":null,"summary":null,"chatId":"19:synthetic-chat-0001@thread.v2","importance":"normal","locale":"en-us","webUrl":null,"policyViolation":null,"eventDetail":null,"from":{"application":null,"device":null,"user":{"@odata.type":"#microsoft.graph.teamworkUserIdentity","id":"00000000-0000-4000-8000-0000000097ac","displayName":"Grace Example","userIdentityType":"aadUser","tenantId":"00000000-0000-4000-8000-00000000c0de"}},"body":{"contentType":"html","content":"<p>Synthetic update 2</p>"},"channelIdentity":null,"attachments":[],"mentions":[],"reactions":[],"messageHistory":[]}]}'
        }
      },
      {
        request: {
          method: 'GET',
          url: 'https://graph.microsoft.com/v1.0/chats/19:synthetic-chat-0001@thread.v2/messages?$top=2&$skiptoken=c3ludGhldGljLXNraXB0b2tlbi0wMDAx',
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
          body: '{"@odata.context":"https://graph.microsoft.com/v1.0/$metadata#chats(\'19%3Asynthetic-chat-0001%40thread.v2\')/messages","@odata.count":1,"value":[{"id":"1789900000001","replyToId":null,"etag":"1789900000001","messageType":"message","createdDateTime":"2026-09-28T07:00:00.001Z","lastModifiedDateTime":"2026-09-28T07:00:00.001Z","lastEditedDateTime":null,"deletedDateTime":null,"subject":null,"summary":null,"chatId":"19:synthetic-chat-0001@thread.v2","importance":"normal","locale":"en-us","webUrl":null,"policyViolation":null,"eventDetail":null,"from":{"application":null,"device":null,"user":{"@odata.type":"#microsoft.graph.teamworkUserIdentity","id":"00000000-0000-4000-8000-00000000ada1","displayName":"Ada Example","userIdentityType":"aadUser","tenantId":"00000000-0000-4000-8000-00000000c0de"}},"body":{"contentType":"html","content":"<p>Synthetic update 1</p>"},"channelIdentity":null,"attachments":[],"mentions":[],"reactions":[],"messageHistory":[]}]}'
        }
      },
      {
        request: {
          method: 'GET',
          url: 'https://graph.microsoft.com/v1.0/chats/19%3Asynthetic-chat-0001%40thread.v2/messages/1789900000003',
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
          body: '{"@odata.context":"https://graph.microsoft.com/v1.0/$metadata#chats(\'19%3Asynthetic-chat-0001%40thread.v2\')/messages/$entity","id":"1789900000003","replyToId":null,"etag":"1789900000003","messageType":"message","createdDateTime":"2026-09-28T09:00:00.003Z","lastModifiedDateTime":"2026-09-28T09:00:00.003Z","lastEditedDateTime":null,"deletedDateTime":null,"subject":null,"summary":null,"chatId":"19:synthetic-chat-0001@thread.v2","importance":"normal","locale":"en-us","webUrl":null,"policyViolation":null,"eventDetail":null,"from":{"application":null,"device":null,"user":{"@odata.type":"#microsoft.graph.teamworkUserIdentity","id":"00000000-0000-4000-8000-00000000ada1","displayName":"Ada Example","userIdentityType":"aadUser","tenantId":"00000000-0000-4000-8000-00000000c0de"}},"body":{"contentType":"html","content":"<p>Synthetic update 3</p>"},"channelIdentity":null,"attachments":[],"mentions":[],"reactions":[],"messageHistory":[]}'
        }
      }
    ]
  },
  {
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
  },
  {
    id: 'microsoft.teams.channel-message-replies.synthetic',
    caseId: 'microsoft.teams.channel-message-replies',
    evidence: 'unverified',
    recordedAt: '2026-11-20',
    account: 'synthetic',
    endpoint: 'https://graph.microsoft.com/v1.0',
    note: "The seeded channel's top-level posts (no replyToId), the seeded post by id, and its two replies (replyToId naming the post). Shapes from the Microsoft Graph v1.0 docs (List channel messages, https://learn.microsoft.com/graph/api/channel-list-messages; Get chatMessage, https://learn.microsoft.com/graph/api/chatmessage-get; List replies, https://learn.microsoft.com/graph/api/chatmessage-list-replies). Synthetic placeholder shaped like the Microsoft Graph wire; not recorded from a live service.",
    exchanges: [
      {
        request: {
          method: 'GET',
          url: 'https://graph.microsoft.com/v1.0/teams/00000000-0000-4000-8000-000000007ea1/channels/19%3Asynthetic-channel-0001%40thread.tacv2/messages?%24top=50',
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
          body: '{"@odata.context":"https://graph.microsoft.com/v1.0/$metadata#teams(\'00000000-0000-4000-8000-000000007ea1\')/channels(\'19%3Asynthetic-channel-0001%40thread.tacv2\')/messages","@odata.count":2,"value":[{"id":"1789900000102","replyToId":null,"etag":"1789900000102","messageType":"message","createdDateTime":"2026-09-22T09:00:00.102Z","lastModifiedDateTime":"2026-09-22T09:00:00.102Z","lastEditedDateTime":null,"deletedDateTime":null,"subject":"Synthetic question","summary":null,"chatId":null,"importance":"normal","locale":"en-us","webUrl":"https://teams.microsoft.com/l/message/19%3Asynthetic-channel-0001%40thread.tacv2/1789900000102?groupId=00000000-0000-4000-8000-000000007ea1&tenantId=00000000-0000-4000-8000-00000000c0de&createdTime=1789900000102&parentMessageId=1789900000102","policyViolation":null,"eventDetail":null,"from":{"application":null,"device":null,"user":{"@odata.type":"#microsoft.graph.teamworkUserIdentity","id":"00000000-0000-4000-8000-0000000097ac","displayName":"Grace Example","userIdentityType":"aadUser","tenantId":"00000000-0000-4000-8000-00000000c0de"}},"body":{"contentType":"html","content":"<p>Synthetic post 02</p>"},"channelIdentity":{"teamId":"00000000-0000-4000-8000-000000007ea1","channelId":"19:synthetic-channel-0001@thread.tacv2"},"attachments":[],"mentions":[],"reactions":[],"messageHistory":[]},{"id":"1789900000101","replyToId":null,"etag":"1789900000101","messageType":"message","createdDateTime":"2026-09-21T08:00:00.101Z","lastModifiedDateTime":"2026-09-21T08:00:00.101Z","lastEditedDateTime":null,"deletedDateTime":null,"subject":"Synthetic weekly update","summary":null,"chatId":null,"importance":"normal","locale":"en-us","webUrl":"https://teams.microsoft.com/l/message/19%3Asynthetic-channel-0001%40thread.tacv2/1789900000101?groupId=00000000-0000-4000-8000-000000007ea1&tenantId=00000000-0000-4000-8000-00000000c0de&createdTime=1789900000101&parentMessageId=1789900000101","policyViolation":null,"eventDetail":null,"from":{"application":null,"device":null,"user":{"@odata.type":"#microsoft.graph.teamworkUserIdentity","id":"00000000-0000-4000-8000-00000000ada1","displayName":"Ada Example","userIdentityType":"aadUser","tenantId":"00000000-0000-4000-8000-00000000c0de"}},"body":{"contentType":"html","content":"<p>Synthetic post 01</p>"},"channelIdentity":{"teamId":"00000000-0000-4000-8000-000000007ea1","channelId":"19:synthetic-channel-0001@thread.tacv2"},"attachments":[],"mentions":[],"reactions":[],"messageHistory":[]}]}'
        }
      },
      {
        request: {
          method: 'GET',
          url: 'https://graph.microsoft.com/v1.0/teams/00000000-0000-4000-8000-000000007ea1/channels/19%3Asynthetic-channel-0001%40thread.tacv2/messages/1789900000101',
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
          body: '{"@odata.context":"https://graph.microsoft.com/v1.0/$metadata#teams(\'00000000-0000-4000-8000-000000007ea1\')/channels(\'19%3Asynthetic-channel-0001%40thread.tacv2\')/messages/$entity","id":"1789900000101","replyToId":null,"etag":"1789900000101","messageType":"message","createdDateTime":"2026-09-21T08:00:00.101Z","lastModifiedDateTime":"2026-09-21T08:00:00.101Z","lastEditedDateTime":null,"deletedDateTime":null,"subject":"Synthetic weekly update","summary":null,"chatId":null,"importance":"normal","locale":"en-us","webUrl":"https://teams.microsoft.com/l/message/19%3Asynthetic-channel-0001%40thread.tacv2/1789900000101?groupId=00000000-0000-4000-8000-000000007ea1&tenantId=00000000-0000-4000-8000-00000000c0de&createdTime=1789900000101&parentMessageId=1789900000101","policyViolation":null,"eventDetail":null,"from":{"application":null,"device":null,"user":{"@odata.type":"#microsoft.graph.teamworkUserIdentity","id":"00000000-0000-4000-8000-00000000ada1","displayName":"Ada Example","userIdentityType":"aadUser","tenantId":"00000000-0000-4000-8000-00000000c0de"}},"body":{"contentType":"html","content":"<p>Synthetic post 01</p>"},"channelIdentity":{"teamId":"00000000-0000-4000-8000-000000007ea1","channelId":"19:synthetic-channel-0001@thread.tacv2"},"attachments":[],"mentions":[],"reactions":[],"messageHistory":[]}'
        }
      },
      {
        request: {
          method: 'GET',
          url: 'https://graph.microsoft.com/v1.0/teams/00000000-0000-4000-8000-000000007ea1/channels/19%3Asynthetic-channel-0001%40thread.tacv2/messages/1789900000101/replies?%24top=50',
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
          body: '{"@odata.context":"https://graph.microsoft.com/v1.0/$metadata#teams(\'00000000-0000-4000-8000-000000007ea1\')/channels(\'19%3Asynthetic-channel-0001%40thread.tacv2\')/messages(\'1789900000101\')/replies","@odata.count":2,"value":[{"id":"1789900000112","replyToId":"1789900000101","etag":"1789900000112","messageType":"message","createdDateTime":"2026-09-21T09:30:00.112Z","lastModifiedDateTime":"2026-09-21T09:30:00.112Z","lastEditedDateTime":null,"deletedDateTime":null,"subject":null,"summary":null,"chatId":null,"importance":"normal","locale":"en-us","webUrl":"https://teams.microsoft.com/l/message/19%3Asynthetic-channel-0001%40thread.tacv2/1789900000112?groupId=00000000-0000-4000-8000-000000007ea1&tenantId=00000000-0000-4000-8000-00000000c0de&createdTime=1789900000112&parentMessageId=1789900000101","policyViolation":null,"eventDetail":null,"from":{"application":null,"device":null,"user":{"@odata.type":"#microsoft.graph.teamworkUserIdentity","id":"00000000-0000-4000-8000-00000000ada1","displayName":"Ada Example","userIdentityType":"aadUser","tenantId":"00000000-0000-4000-8000-00000000c0de"}},"body":{"contentType":"html","content":"<p>Synthetic reply 12</p>"},"channelIdentity":{"teamId":"00000000-0000-4000-8000-000000007ea1","channelId":"19:synthetic-channel-0001@thread.tacv2"},"attachments":[],"mentions":[],"reactions":[],"messageHistory":[]},{"id":"1789900000111","replyToId":"1789900000101","etag":"1789900000111","messageType":"message","createdDateTime":"2026-09-21T08:30:00.111Z","lastModifiedDateTime":"2026-09-21T08:30:00.111Z","lastEditedDateTime":null,"deletedDateTime":null,"subject":null,"summary":null,"chatId":null,"importance":"normal","locale":"en-us","webUrl":"https://teams.microsoft.com/l/message/19%3Asynthetic-channel-0001%40thread.tacv2/1789900000111?groupId=00000000-0000-4000-8000-000000007ea1&tenantId=00000000-0000-4000-8000-00000000c0de&createdTime=1789900000111&parentMessageId=1789900000101","policyViolation":null,"eventDetail":null,"from":{"application":null,"device":null,"user":{"@odata.type":"#microsoft.graph.teamworkUserIdentity","id":"00000000-0000-4000-8000-0000000097ac","displayName":"Grace Example","userIdentityType":"aadUser","tenantId":"00000000-0000-4000-8000-00000000c0de"}},"body":{"contentType":"html","content":"<p>Synthetic reply 11</p>"},"channelIdentity":{"teamId":"00000000-0000-4000-8000-000000007ea1","channelId":"19:synthetic-channel-0001@thread.tacv2"},"attachments":[],"mentions":[],"reactions":[],"messageHistory":[]}]}'
        }
      }
    ]
  },
  {
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
  },
  {
    id: 'microsoft.teams.send-chat-message.synthetic',
    caseId: 'microsoft.teams.send-chat-message',
    evidence: 'unverified',
    recordedAt: '2026-11-20',
    account: 'synthetic',
    endpoint: 'https://graph.microsoft.com/v1.0',
    note: 'A plain-text message naming the run id posted to the seeded send chat (a dedicated practice chat) as escaped HTML (markup and & escaped, the line break a <br>), answered 201 with the created message, then read back by the returned id. Shapes from the Microsoft Graph v1.0 docs (Send chatMessage in a chat, https://learn.microsoft.com/graph/api/chatmessage-post; Get chatMessage, https://learn.microsoft.com/graph/api/chatmessage-get). Synthetic placeholder shaped like the Microsoft Graph wire; not recorded from a live service.',
    exchanges: [
      {
        request: {
          method: 'POST',
          url: 'https://graph.microsoft.com/v1.0/chats/19%3Asynthetic-send-chat-0001%40thread.v2/messages',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json'
          },
          body: {
            body: {
              contentType: 'html',
              content:
                'yolk-conformance run-synthetic: &lt;b&gt;not bold&lt;/b&gt; &amp; safe to ignore<br>second line'
            }
          }
        },
        response: {
          status: 201,
          headers: {
            'content-type':
              'application/json; odata.metadata=minimal; odata.streaming=true; IEEE754Compatible=false; charset=utf-8'
          },
          body: '{"@odata.context":"https://graph.microsoft.com/v1.0/$metadata#chats(\'19%3Asynthetic-send-chat-0001%40thread.v2\')/messages/$entity","id":"1790000000101","replyToId":null,"etag":"1790000000101","messageType":"message","createdDateTime":"2026-09-29T10:00:00.101Z","lastModifiedDateTime":"2026-09-29T10:00:00.101Z","lastEditedDateTime":null,"deletedDateTime":null,"subject":null,"summary":null,"chatId":"19:synthetic-send-chat-0001@thread.v2","importance":"normal","locale":"en-us","webUrl":null,"policyViolation":null,"eventDetail":null,"from":{"application":null,"device":null,"user":{"@odata.type":"#microsoft.graph.teamworkUserIdentity","id":"00000000-0000-4000-8000-00000000ada1","displayName":"Ada Example","userIdentityType":"aadUser","tenantId":"00000000-0000-4000-8000-00000000c0de"}},"body":{"contentType":"html","content":"yolk-conformance run-synthetic: &lt;b&gt;not bold&lt;/b&gt; &amp; safe to ignore<br>second line"},"channelIdentity":null,"attachments":[],"mentions":[],"reactions":[],"messageHistory":[]}'
        }
      },
      {
        request: {
          method: 'GET',
          url: 'https://graph.microsoft.com/v1.0/chats/19%3Asynthetic-send-chat-0001%40thread.v2/messages/1790000000101',
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
          body: '{"@odata.context":"https://graph.microsoft.com/v1.0/$metadata#chats(\'19%3Asynthetic-send-chat-0001%40thread.v2\')/messages/$entity","id":"1790000000101","replyToId":null,"etag":"1790000000101","messageType":"message","createdDateTime":"2026-09-29T10:00:00.101Z","lastModifiedDateTime":"2026-09-29T10:00:00.101Z","lastEditedDateTime":null,"deletedDateTime":null,"subject":null,"summary":null,"chatId":"19:synthetic-send-chat-0001@thread.v2","importance":"normal","locale":"en-us","webUrl":null,"policyViolation":null,"eventDetail":null,"from":{"application":null,"device":null,"user":{"@odata.type":"#microsoft.graph.teamworkUserIdentity","id":"00000000-0000-4000-8000-00000000ada1","displayName":"Ada Example","userIdentityType":"aadUser","tenantId":"00000000-0000-4000-8000-00000000c0de"}},"body":{"contentType":"html","content":"yolk-conformance run-synthetic: &lt;b&gt;not bold&lt;/b&gt; &amp; safe to ignore<br>second line"},"channelIdentity":null,"attachments":[],"mentions":[],"reactions":[],"messageHistory":[]}'
        }
      }
    ]
  }
]
