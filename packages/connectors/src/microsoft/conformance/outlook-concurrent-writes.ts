import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * Draft create, two concurrent PATCHes (200, then 409 with a Graph error envelope), then the permanent-delete batch.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:microsoft --live --account <label> --record` stages a replacement in a
 * gitignored directory; see the script header for the manual scrub-and-promote step.
 */
export const microsoftOutlookConcurrentWritesFixture: WireFixture = {
  id: 'microsoft.outlook.concurrent-writes-same-message.synthetic',
  caseId: 'microsoft.outlook.concurrent-writes-same-message',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://graph.microsoft.com/v1.0',
  note: 'A case-owned draft, two concurrent subject PATCHes (the first answered 200, the second 409 ErrorIrresolvableConflict), then the permanent-delete batch. Synthetic placeholder shaped like the Microsoft Graph wire; not recorded from a live service.',
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
        body: '{"@odata.context":"https://graph.microsoft.com/v1.0/$metadata#users(\'ada%40example.test\')/messages/$entity","@odata.etag":"W/\\"CQAAABYAAAAsynthetic0301\\"","id":"AAkALgAAAAAAHYQDEapmEc2byACqAC-EWg0A-synthetic-immutable-0002=","createdDateTime":"2026-09-29T10:00:00Z","lastModifiedDateTime":"2026-09-29T10:00:00Z","changeKey":"CQAAABYAAAAsynthetic0301","categories":[],"receivedDateTime":"2026-09-29T10:00:00Z","sentDateTime":"2026-09-29T10:00:00Z","hasAttachments":false,"internetMessageId":"<synthetic-draft@example.test>","subject":"yolk-conformance draft: safe to delete","bodyPreview":"Synthetic conformance draft; never sent.","importance":"normal","parentFolderId":"AAMkAGI2-synthetic-drafts-folder=","conversationId":"AAQkAGI2-synthetic-conversation-0201=","isDeliveryReceiptRequested":false,"isReadReceiptRequested":false,"isRead":true,"isDraft":true,"webLink":"https://outlook.office365.com/owa/?ItemID=AAkALgAAAAAAHYQDEapmEc2byACqAC-EWg0A-synthetic-immutable-0002%3D&exvsurl=1&viewmodel=ReadMessageItem","body":{"contentType":"text","content":"Synthetic conformance draft; never sent."},"sender":{"emailAddress":{"name":"Ada Example","address":"ada@example.test"}},"from":{"emailAddress":{"name":"Ada Example","address":"ada@example.test"}},"toRecipients":[],"ccRecipients":[],"bccRecipients":[],"replyTo":[],"flag":{"flagStatus":"notFlagged"}}'
      }
    },
    {
      request: {
        method: 'PATCH',
        url: 'https://graph.microsoft.com/v1.0/users/ada%40example.test/messages/AAkALgAAAAAAHYQDEapmEc2byACqAC-EWg0A-synthetic-immutable-0002%3D',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          prefer: 'IdType="ImmutableId"'
        },
        body: {
          subject: 'yolk-conformance concurrent write A'
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type':
            'application/json; odata.metadata=minimal; odata.streaming=true; IEEE754Compatible=false; charset=utf-8'
        },
        body: '{"@odata.context":"https://graph.microsoft.com/v1.0/$metadata#users(\'ada%40example.test\')/messages/$entity","@odata.etag":"W/\\"CQAAABYAAAAsynthetic0302\\"","id":"AAkALgAAAAAAHYQDEapmEc2byACqAC-EWg0A-synthetic-immutable-0002=","createdDateTime":"2026-09-29T10:00:00Z","lastModifiedDateTime":"2026-09-29T10:00:00Z","changeKey":"CQAAABYAAAAsynthetic0302","categories":[],"receivedDateTime":"2026-09-29T10:00:00Z","sentDateTime":"2026-09-29T10:00:00Z","hasAttachments":false,"internetMessageId":"<synthetic-draft@example.test>","subject":"yolk-conformance concurrent write A","bodyPreview":"Synthetic conformance draft; never sent.","importance":"normal","parentFolderId":"AAMkAGI2-synthetic-drafts-folder=","conversationId":"AAQkAGI2-synthetic-conversation-0201=","isDeliveryReceiptRequested":false,"isReadReceiptRequested":false,"isRead":true,"isDraft":true,"webLink":"https://outlook.office365.com/owa/?ItemID=AAkALgAAAAAAHYQDEapmEc2byACqAC-EWg0A-synthetic-immutable-0002%3D&exvsurl=1&viewmodel=ReadMessageItem","body":{"contentType":"text","content":"Synthetic conformance draft; never sent."},"sender":{"emailAddress":{"name":"Ada Example","address":"ada@example.test"}},"from":{"emailAddress":{"name":"Ada Example","address":"ada@example.test"}},"toRecipients":[],"ccRecipients":[],"bccRecipients":[],"replyTo":[],"flag":{"flagStatus":"notFlagged"}}'
      }
    },
    {
      request: {
        method: 'PATCH',
        url: 'https://graph.microsoft.com/v1.0/users/ada%40example.test/messages/AAkALgAAAAAAHYQDEapmEc2byACqAC-EWg0A-synthetic-immutable-0002%3D',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          prefer: 'IdType="ImmutableId"'
        },
        body: {
          subject: 'yolk-conformance concurrent write B'
        }
      },
      response: {
        status: 409,
        headers: {
          'content-type':
            'application/json; odata.metadata=minimal; odata.streaming=true; IEEE754Compatible=false; charset=utf-8'
        },
        body: '{"error":{"code":"ErrorIrresolvableConflict","message":"The send or update operation could not be performed because the change key passed in the request does not match the current change key for the item.","innerError":{"date":"2026-09-29T10:00:04","request-id":"00000000-0000-4000-8000-000000000004","client-request-id":"00000000-0000-4000-8000-000000000004"}}}'
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
              url: '/users/ada%40example.test/messages/AAkALgAAAAAAHYQDEapmEc2byACqAC-EWg0A-synthetic-immutable-0002%3D/permanentDelete',
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
