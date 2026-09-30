import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * Attachment listing without `contentId`, then the inline file attachment with its `contentId`.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:microsoft --live --owner-approved --account <label> --record` stages a replacement in a
 * gitignored directory; see the script header for the manual scrub-and-promote step.
 */
export const microsoftOutlookAttachmentContentIdFixture: WireFixture = {
  id: 'microsoft.outlook.attachment-content-id.synthetic',
  caseId: 'microsoft.outlook.attachment-content-id',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://graph.microsoft.com/v1.0',
  note: 'Attachment listing without contentId (base properties only), then retrieval of the inline file attachment with its contentId. Synthetic placeholder shaped like the Microsoft Graph wire; not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'GET',
        url: 'https://graph.microsoft.com/v1.0/users/ada%40example.test/messages/AAMkAGI2-synthetic-message-0001%3D/attachments?$select=id,name,contentType,size,isInline,lastModifiedDateTime',
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
        body: '{"@odata.context":"https://graph.microsoft.com/v1.0/$metadata#users(\'ada%40example.test\')/messages(\'AAMkAGI2-synthetic-message-0001%3D\')/attachments(id,name,contentType,size,isInline,lastModifiedDateTime)","value":[{"@odata.type":"#microsoft.graph.fileAttachment","@odata.mediaContentType":"image/png","id":"AAMkAGI2-synthetic-attachment-0001=","name":"image001.png","contentType":"image/png","size":1024,"isInline":true,"lastModifiedDateTime":"2026-09-22T08:15:00Z"},{"@odata.type":"#microsoft.graph.fileAttachment","@odata.mediaContentType":"application/pdf","id":"AAMkAGI2-synthetic-attachment-0002=","name":"synthetic-report.pdf","contentType":"application/pdf","size":2048,"isInline":false,"lastModifiedDateTime":"2026-09-22T08:15:00Z"}]}'
      }
    },
    {
      request: {
        method: 'GET',
        url: 'https://graph.microsoft.com/v1.0/users/ada%40example.test/messages/AAMkAGI2-synthetic-message-0001%3D/attachments/AAMkAGI2-synthetic-attachment-0001%3D',
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
        body: '{"@odata.context":"https://graph.microsoft.com/v1.0/$metadata#users(\'ada%40example.test\')/messages(\'AAMkAGI2-synthetic-message-0001%3D\')/attachments/$entity","@odata.type":"#microsoft.graph.fileAttachment","@odata.mediaContentType":"image/png","id":"AAMkAGI2-synthetic-attachment-0001=","lastModifiedDateTime":"2026-09-22T08:15:00Z","name":"image001.png","contentType":"image/png","size":1024,"isInline":true,"contentId":"image001.png@01DD2E00.00000000","contentLocation":null,"contentBytes":"iVBORw0KGgo="}'
      }
    }
  ]
}
