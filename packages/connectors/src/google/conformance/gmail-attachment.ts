import type { WireFixture } from '@yolk-sdk/conformance/fixture'
import { base64UrlOfText, gmailSyntheticApi, googleJson } from './synthetic.ts'

const messageId = '18f00000000000a1'

const attachmentId = 'ANGjdJ_synthetic_attachment_0001'

const text = 'Synthetic practice message with an attachment.'

/**
 * `gmail.list_attachments` of the seeded attachment message (a text part and a six-byte binary
 * attachment stored apart), then `gmail.get_attachment` of it: base64url `data` using `-` and `_`.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:google --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const gmailAttachmentFixture: WireFixture = {
  id: 'google.gmail.attachment-base64url.synthetic',
  caseId: 'google.gmail.attachment-base64url',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://gmail.googleapis.com',
  note: 'List the attachments of the seeded message (format=full), then fetch the one with an attachmentId; its base64url data decodes to exactly size bytes. Synthetic placeholder shaped like the Gmail API; not recorded from a live service.',
  exchanges: [
    {
      request: { method: 'GET', url: `${gmailSyntheticApi}/messages/${messageId}?format=full` },
      response: googleJson(200, {
        id: messageId,
        threadId: messageId,
        labelIds: ['INBOX'],
        snippet: text,
        sizeEstimate: 4096,
        historyId: '900010',
        internalDate: '1790000000000',
        payload: {
          partId: '',
          mimeType: 'multipart/mixed',
          filename: '',
          headers: [
            { name: 'From', value: 'practice@example.test' },
            { name: 'Subject', value: 'Synthetic practice attachment' },
            { name: 'Content-Type', value: 'multipart/mixed; boundary="synthetic"' }
          ],
          body: { size: 0 },
          parts: [
            {
              partId: '0',
              mimeType: 'text/plain',
              filename: '',
              headers: [{ name: 'Content-Type', value: 'text/plain; charset="UTF-8"' }],
              body: { size: text.length, data: base64UrlOfText(text) }
            },
            {
              partId: '1',
              mimeType: 'application/octet-stream',
              filename: 'synthetic.bin',
              headers: [
                { name: 'Content-Type', value: 'application/octet-stream; name="synthetic.bin"' },
                { name: 'Content-Disposition', value: 'attachment; filename="synthetic.bin"' },
                { name: 'Content-Transfer-Encoding', value: 'base64' }
              ],
              body: { attachmentId, size: 6 }
            }
          ]
        }
      })
    },
    {
      request: {
        method: 'GET',
        url: `${gmailSyntheticApi}/messages/${messageId}/attachments/${attachmentId}`
      },
      // The bytes fb ff bf 3e 3f fe: standard base64 "+/+/Pj/+", base64url "-_-_Pj_-".
      response: googleJson(200, { size: 6, data: '-_-_Pj_-' })
    }
  ]
}
