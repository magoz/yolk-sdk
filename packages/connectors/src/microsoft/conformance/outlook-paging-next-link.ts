import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * A two-message first page with `@odata.nextLink`, then the page the link returns.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:microsoft --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const microsoftOutlookPagingNextLinkFixture: WireFixture = {
  id: 'microsoft.outlook.paging-next-link.synthetic',
  caseId: 'microsoft.outlook.paging-next-link',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://graph.microsoft.com/v1.0',
  note: 'Two pages of the seeded mail folder (three messages, page size 2): the first with @odata.nextLink, the second reached by following it unchanged. Synthetic placeholder shaped like the Microsoft Graph wire; not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'GET',
        url: 'https://graph.microsoft.com/v1.0/users/ada%40example.test/mailFolders/AAMkAGI2-synthetic-folder-0001%3D/messages?$select=id,subject,bodyPreview,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,hasAttachments,isRead,flag,isDraft,importance,conversationId,internetMessageId,webLink&$top=2',
        headers: {
          accept: 'application/json',
          prefer: 'IdType="ImmutableId"'
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type':
            'application/json; odata.metadata=minimal; odata.streaming=true; IEEE754Compatible=false; charset=utf-8'
        },
        body: '{"@odata.context":"https://graph.microsoft.com/v1.0/$metadata#users(\'ada%40example.test\')/mailFolders(\'AAMkAGI2-synthetic-folder-0001%3D\')/messages(id,subject,bodyPreview,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,hasAttachments,isRead,flag,isDraft,importance,conversationId,internetMessageId,webLink)","value":[{"@odata.etag":"W/\\"CQAAABYAAAAsynthetic0101\\"","id":"AAMkAGI2-synthetic-message-0101=","subject":"Synthetic update 1","bodyPreview":"Synthetic message body.","from":{"emailAddress":{"name":"Grace Example","address":"grace@example.test"}},"toRecipients":[{"emailAddress":{"name":"Ada Example","address":"ada@example.test"}}],"ccRecipients":[],"receivedDateTime":"2026-09-22T09:00:00Z","sentDateTime":"2026-09-22T09:00:00Z","hasAttachments":false,"isRead":true,"flag":{"flagStatus":"notFlagged"},"isDraft":false,"importance":"normal","conversationId":"AAQkAGI2-synthetic-conversation-0101=","internetMessageId":"<synthetic-0101@example.test>","webLink":"https://outlook.office365.com/owa/?ItemID=AAMkAGI2-synthetic-message-0101%3D&exvsurl=1&viewmodel=ReadMessageItem"},{"@odata.etag":"W/\\"CQAAABYAAAAsynthetic0102\\"","id":"AAMkAGI2-synthetic-message-0102=","subject":"Synthetic update 2","bodyPreview":"Synthetic message body.","from":{"emailAddress":{"name":"Grace Example","address":"grace@example.test"}},"toRecipients":[{"emailAddress":{"name":"Ada Example","address":"ada@example.test"}}],"ccRecipients":[],"receivedDateTime":"2026-09-22T08:00:00Z","sentDateTime":"2026-09-22T08:00:00Z","hasAttachments":false,"isRead":true,"flag":{"flagStatus":"notFlagged"},"isDraft":false,"importance":"normal","conversationId":"AAQkAGI2-synthetic-conversation-0102=","internetMessageId":"<synthetic-0102@example.test>","webLink":"https://outlook.office365.com/owa/?ItemID=AAMkAGI2-synthetic-message-0102%3D&exvsurl=1&viewmodel=ReadMessageItem"}],"@odata.nextLink":"https://graph.microsoft.com/v1.0/users/ada%40example.test/mailFolders/AAMkAGI2-synthetic-folder-0001%3D/messages?%24select=id%2Csubject%2CbodyPreview%2Cfrom%2CtoRecipients%2CccRecipients%2CreceivedDateTime%2CsentDateTime%2ChasAttachments%2CisRead%2Cflag%2CisDraft%2Cimportance%2CconversationId%2CinternetMessageId%2CwebLink&%24top=2&%24skip=2"}'
      }
    },
    {
      request: {
        method: 'GET',
        url: 'https://graph.microsoft.com/v1.0/users/ada%40example.test/mailFolders/AAMkAGI2-synthetic-folder-0001%3D/messages?%24select=id%2Csubject%2CbodyPreview%2Cfrom%2CtoRecipients%2CccRecipients%2CreceivedDateTime%2CsentDateTime%2ChasAttachments%2CisRead%2Cflag%2CisDraft%2Cimportance%2CconversationId%2CinternetMessageId%2CwebLink&%24top=2&%24skip=2',
        headers: {
          accept: 'application/json',
          prefer: 'IdType="ImmutableId"'
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type':
            'application/json; odata.metadata=minimal; odata.streaming=true; IEEE754Compatible=false; charset=utf-8'
        },
        body: '{"@odata.context":"https://graph.microsoft.com/v1.0/$metadata#users(\'ada%40example.test\')/mailFolders(\'AAMkAGI2-synthetic-folder-0001%3D\')/messages(id,subject,bodyPreview,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,hasAttachments,isRead,flag,isDraft,importance,conversationId,internetMessageId,webLink)","value":[{"@odata.etag":"W/\\"CQAAABYAAAAsynthetic0103\\"","id":"AAMkAGI2-synthetic-message-0103=","subject":"Synthetic update 3","bodyPreview":"Synthetic message body.","from":{"emailAddress":{"name":"Grace Example","address":"grace@example.test"}},"toRecipients":[{"emailAddress":{"name":"Ada Example","address":"ada@example.test"}}],"ccRecipients":[],"receivedDateTime":"2026-09-22T07:00:00Z","sentDateTime":"2026-09-22T07:00:00Z","hasAttachments":false,"isRead":true,"flag":{"flagStatus":"notFlagged"},"isDraft":false,"importance":"normal","conversationId":"AAQkAGI2-synthetic-conversation-0103=","internetMessageId":"<synthetic-0103@example.test>","webLink":"https://outlook.office365.com/owa/?ItemID=AAMkAGI2-synthetic-message-0103%3D&exvsurl=1&viewmodel=ReadMessageItem"}]}'
      }
    }
  ]
}
