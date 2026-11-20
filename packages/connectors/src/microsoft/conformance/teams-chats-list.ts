import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * A page of the signed-in user's chats with their members, then the first chat by id.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:microsoft --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const microsoftTeamsChatsListMembersFixture: WireFixture = {
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
}
