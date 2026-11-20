import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * The seeded channel's top-level posts, the seeded post by id, and its replies.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:microsoft --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const microsoftTeamsChannelMessageRepliesFixture: WireFixture = {
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
}
