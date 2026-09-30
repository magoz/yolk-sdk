import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * Draft create, move to Deleted Items keeping the immutable id, mark read by the original id, then the permanent-delete batch.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:microsoft --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const microsoftOutlookImmutableIdFixture: WireFixture = {
  id: 'microsoft.outlook.immutable-id-survives-move.synthetic',
  caseId: 'microsoft.outlook.immutable-id-survives-move',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://graph.microsoft.com/v1.0',
  note: 'A case-owned draft created with the immutable-id preference, moved to Deleted Items (same id, new parentFolderId), marked read by its original id, then permanently deleted through a JSON batch. Synthetic placeholder shaped like the Microsoft Graph wire; not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'POST',
        url: 'https://graph.microsoft.com/v1.0/users/ada%40example.test/messages',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          prefer: 'IdType="ImmutableId"'
        },
        body: {
          subject: 'yolk-conformance draft: safe to delete',
          body: {
            contentType: 'Text',
            content: 'Synthetic conformance draft; never sent.'
          },
          toRecipients: [],
          from: {
            emailAddress: {
              address: 'ada@example.test'
            }
          }
        }
      },
      response: {
        status: 201,
        headers: {
          'content-type':
            'application/json; odata.metadata=minimal; odata.streaming=true; IEEE754Compatible=false; charset=utf-8'
        },
        body: '{"@odata.context":"https://graph.microsoft.com/v1.0/$metadata#users(\'ada%40example.test\')/messages/$entity","@odata.etag":"W/\\"CQAAABYAAAAsynthetic0201\\"","id":"AAkALgAAAAAAHYQDEapmEc2byACqAC-EWg0A-synthetic-immutable-0001=","createdDateTime":"2026-09-29T10:00:00Z","lastModifiedDateTime":"2026-09-29T10:00:00Z","changeKey":"CQAAABYAAAAsynthetic0201","categories":[],"receivedDateTime":"2026-09-29T10:00:00Z","sentDateTime":"2026-09-29T10:00:00Z","hasAttachments":false,"internetMessageId":"<synthetic-draft@example.test>","subject":"yolk-conformance draft: safe to delete","bodyPreview":"Synthetic conformance draft; never sent.","importance":"normal","parentFolderId":"AAMkAGI2-synthetic-drafts-folder=","conversationId":"AAQkAGI2-synthetic-conversation-0201=","isDeliveryReceiptRequested":false,"isReadReceiptRequested":false,"isRead":true,"isDraft":true,"webLink":"https://outlook.office365.com/owa/?ItemID=AAkALgAAAAAAHYQDEapmEc2byACqAC-EWg0A-synthetic-immutable-0001%3D&exvsurl=1&viewmodel=ReadMessageItem","body":{"contentType":"text","content":"Synthetic conformance draft; never sent."},"sender":{"emailAddress":{"name":"Ada Example","address":"ada@example.test"}},"from":{"emailAddress":{"name":"Ada Example","address":"ada@example.test"}},"toRecipients":[],"ccRecipients":[],"bccRecipients":[],"replyTo":[],"flag":{"flagStatus":"notFlagged"}}'
      }
    },
    {
      request: {
        method: 'POST',
        url: 'https://graph.microsoft.com/v1.0/users/ada%40example.test/messages/AAkALgAAAAAAHYQDEapmEc2byACqAC-EWg0A-synthetic-immutable-0001%3D/move',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          prefer: 'IdType="ImmutableId"'
        },
        body: {
          destinationId: 'deleteditems'
        }
      },
      response: {
        status: 201,
        headers: {
          'content-type':
            'application/json; odata.metadata=minimal; odata.streaming=true; IEEE754Compatible=false; charset=utf-8'
        },
        body: '{"@odata.context":"https://graph.microsoft.com/v1.0/$metadata#users(\'ada%40example.test\')/messages/$entity","@odata.etag":"W/\\"CQAAABYAAAAsynthetic0202\\"","id":"AAkALgAAAAAAHYQDEapmEc2byACqAC-EWg0A-synthetic-immutable-0001=","createdDateTime":"2026-09-29T10:00:00Z","lastModifiedDateTime":"2026-09-29T10:00:00Z","changeKey":"CQAAABYAAAAsynthetic0202","categories":[],"receivedDateTime":"2026-09-29T10:00:00Z","sentDateTime":"2026-09-29T10:00:00Z","hasAttachments":false,"internetMessageId":"<synthetic-draft@example.test>","subject":"yolk-conformance draft: safe to delete","bodyPreview":"Synthetic conformance draft; never sent.","importance":"normal","parentFolderId":"AAMkAGI2-synthetic-deleteditems-folder=","conversationId":"AAQkAGI2-synthetic-conversation-0201=","isDeliveryReceiptRequested":false,"isReadReceiptRequested":false,"isRead":true,"isDraft":true,"webLink":"https://outlook.office365.com/owa/?ItemID=AAkALgAAAAAAHYQDEapmEc2byACqAC-EWg0A-synthetic-immutable-0001%3D&exvsurl=1&viewmodel=ReadMessageItem","body":{"contentType":"text","content":"Synthetic conformance draft; never sent."},"sender":{"emailAddress":{"name":"Ada Example","address":"ada@example.test"}},"from":{"emailAddress":{"name":"Ada Example","address":"ada@example.test"}},"toRecipients":[],"ccRecipients":[],"bccRecipients":[],"replyTo":[],"flag":{"flagStatus":"notFlagged"}}'
      }
    },
    {
      request: {
        method: 'PATCH',
        url: 'https://graph.microsoft.com/v1.0/users/ada%40example.test/messages/AAkALgAAAAAAHYQDEapmEc2byACqAC-EWg0A-synthetic-immutable-0001%3D',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          prefer: 'IdType="ImmutableId"'
        },
        body: {
          isRead: true
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type':
            'application/json; odata.metadata=minimal; odata.streaming=true; IEEE754Compatible=false; charset=utf-8'
        },
        body: '{"@odata.context":"https://graph.microsoft.com/v1.0/$metadata#users(\'ada%40example.test\')/messages/$entity","@odata.etag":"W/\\"CQAAABYAAAAsynthetic0203\\"","id":"AAkALgAAAAAAHYQDEapmEc2byACqAC-EWg0A-synthetic-immutable-0001=","createdDateTime":"2026-09-29T10:00:00Z","lastModifiedDateTime":"2026-09-29T10:00:00Z","changeKey":"CQAAABYAAAAsynthetic0203","categories":[],"receivedDateTime":"2026-09-29T10:00:00Z","sentDateTime":"2026-09-29T10:00:00Z","hasAttachments":false,"internetMessageId":"<synthetic-draft@example.test>","subject":"yolk-conformance draft: safe to delete","bodyPreview":"Synthetic conformance draft; never sent.","importance":"normal","parentFolderId":"AAMkAGI2-synthetic-deleteditems-folder=","conversationId":"AAQkAGI2-synthetic-conversation-0201=","isDeliveryReceiptRequested":false,"isReadReceiptRequested":false,"isRead":true,"isDraft":true,"webLink":"https://outlook.office365.com/owa/?ItemID=AAkALgAAAAAAHYQDEapmEc2byACqAC-EWg0A-synthetic-immutable-0001%3D&exvsurl=1&viewmodel=ReadMessageItem","body":{"contentType":"text","content":"Synthetic conformance draft; never sent."},"sender":{"emailAddress":{"name":"Ada Example","address":"ada@example.test"}},"from":{"emailAddress":{"name":"Ada Example","address":"ada@example.test"}},"toRecipients":[],"ccRecipients":[],"bccRecipients":[],"replyTo":[],"flag":{"flagStatus":"notFlagged"}}'
      }
    },
    {
      request: {
        method: 'POST',
        url: 'https://graph.microsoft.com/v1.0/$batch',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json'
        },
        body: {
          requests: [
            {
              id: 'req-1',
              method: 'POST',
              url: '/users/ada%40example.test/messages/AAkALgAAAAAAHYQDEapmEc2byACqAC-EWg0A-synthetic-immutable-0001%3D/permanentDelete',
              headers: {
                Prefer: 'IdType="ImmutableId"'
              }
            }
          ]
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type':
            'application/json; odata.metadata=minimal; odata.streaming=true; IEEE754Compatible=false; charset=utf-8'
        },
        body: '{"responses":[{"id":"req-1","status":204,"headers":{}}]}'
      }
    }
  ]
}
