import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * A plain-text message posted to the seeded chat (escaped HTML, `<br>` line break), then read back by the returned id.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:microsoft --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const microsoftTeamsSendChatMessageFixture: WireFixture = {
  id: 'microsoft.teams.send-chat-message.synthetic',
  caseId: 'microsoft.teams.send-chat-message',
  evidence: 'unverified',
  recordedAt: '2026-11-20',
  account: 'synthetic',
  endpoint: 'https://graph.microsoft.com/v1.0',
  note: 'A plain-text message naming the run id posted to the seeded chat as escaped HTML (markup and & escaped, the line break a <br>), answered 201 with the created message, then read back by the returned id. Shapes from the Microsoft Graph v1.0 docs (Send chatMessage in a chat, https://learn.microsoft.com/graph/api/chatmessage-post; Get chatMessage, https://learn.microsoft.com/graph/api/chatmessage-get). Synthetic placeholder shaped like the Microsoft Graph wire; not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'POST',
        url: 'https://graph.microsoft.com/v1.0/chats/19%3Asynthetic-chat-0001%40thread.v2/messages',
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
        body: '{"@odata.context":"https://graph.microsoft.com/v1.0/$metadata#chats(\'19%3Asynthetic-chat-0001%40thread.v2\')/messages/$entity","id":"1790000000101","replyToId":null,"etag":"1790000000101","messageType":"message","createdDateTime":"2026-09-29T10:00:00.101Z","lastModifiedDateTime":"2026-09-29T10:00:00.101Z","lastEditedDateTime":null,"deletedDateTime":null,"subject":null,"summary":null,"chatId":"19:synthetic-chat-0001@thread.v2","importance":"normal","locale":"en-us","webUrl":null,"policyViolation":null,"eventDetail":null,"from":{"application":null,"device":null,"user":{"@odata.type":"#microsoft.graph.teamworkUserIdentity","id":"00000000-0000-4000-8000-00000000ada1","displayName":"Ada Example","userIdentityType":"aadUser","tenantId":"00000000-0000-4000-8000-00000000c0de"}},"body":{"contentType":"html","content":"yolk-conformance run-synthetic: &lt;b&gt;not bold&lt;/b&gt; &amp; safe to ignore<br>second line"},"channelIdentity":null,"attachments":[],"mentions":[],"reactions":[],"messageHistory":[]}'
      }
    },
    {
      request: {
        method: 'GET',
        url: 'https://graph.microsoft.com/v1.0/chats/19%3Asynthetic-chat-0001%40thread.v2/messages/1790000000101',
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
        body: '{"@odata.context":"https://graph.microsoft.com/v1.0/$metadata#chats(\'19%3Asynthetic-chat-0001%40thread.v2\')/messages/$entity","id":"1790000000101","replyToId":null,"etag":"1790000000101","messageType":"message","createdDateTime":"2026-09-29T10:00:00.101Z","lastModifiedDateTime":"2026-09-29T10:00:00.101Z","lastEditedDateTime":null,"deletedDateTime":null,"subject":null,"summary":null,"chatId":"19:synthetic-chat-0001@thread.v2","importance":"normal","locale":"en-us","webUrl":null,"policyViolation":null,"eventDetail":null,"from":{"application":null,"device":null,"user":{"@odata.type":"#microsoft.graph.teamworkUserIdentity","id":"00000000-0000-4000-8000-00000000ada1","displayName":"Ada Example","userIdentityType":"aadUser","tenantId":"00000000-0000-4000-8000-00000000c0de"}},"body":{"contentType":"html","content":"yolk-conformance run-synthetic: &lt;b&gt;not bold&lt;/b&gt; &amp; safe to ignore<br>second line"},"channelIdentity":null,"attachments":[],"mentions":[],"reactions":[],"messageHistory":[]}'
      }
    }
  ]
}
