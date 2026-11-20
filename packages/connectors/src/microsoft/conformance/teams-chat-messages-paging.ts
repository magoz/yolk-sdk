import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * A two-message first page of the seeded chat with `@odata.nextLink`, the page the link returns, and the first message by id.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:microsoft --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const microsoftTeamsChatMessagesPagingFixture: WireFixture = {
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
}
