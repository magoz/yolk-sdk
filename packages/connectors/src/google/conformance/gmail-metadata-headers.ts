import type { WireFixture } from '@yolk-sdk/conformance/fixture'
import { gmailSyntheticApi, googleJson } from './synthetic.ts'

const messageId = '18f00000000000a1'

const headers = {
  from: { name: 'From', value: 'practice@example.test' },
  subject: { name: 'Subject', value: 'Synthetic practice attachment' },
  contentType: { name: 'Content-Type', value: 'multipart/mixed; boundary="synthetic"' }
}

/** The seeded attachment message as `format=metadata` answers it, with `payloadHeaders`. */
const metadataMessage = (payloadHeaders: ReadonlyArray<{ name: string; value: string }>) => ({
  id: messageId,
  threadId: messageId,
  labelIds: ['INBOX'],
  snippet: 'Synthetic practice message with an attachment.',
  sizeEstimate: 4096,
  historyId: '900010',
  internalDate: '1790000000000',
  payload: {
    partId: '',
    mimeType: 'multipart/mixed',
    filename: '',
    headers: [...payloadHeaders],
    body: { size: 0 }
  }
})

const selection = 'metadataHeaders=Subject&metadataHeaders=From'

/**
 * The seeded attachment message read with `format=metadata` (every header), then with the
 * `Subject` and `From` selection (repeated `metadataHeaders` parameters), then its thread with the
 * same selection: the selected reads keep only `From` and `Subject`, in the recorded order.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:google --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const gmailMetadataHeadersFixture: WireFixture = {
  id: 'google.gmail.metadata-headers.synthetic',
  caseId: 'google.gmail.metadata-headers',
  evidence: 'unverified',
  recordedAt: '2026-10-04',
  account: 'synthetic',
  endpoint: 'https://gmail.googleapis.com',
  note: 'Read the seeded attachment message with format=metadata, again selecting Subject and From through repeated metadataHeaders parameters, then read its thread with the same selection. Synthetic placeholder shaped like the Gmail API; not recorded from a live service.',
  exchanges: [
    {
      request: { method: 'GET', url: `${gmailSyntheticApi}/messages/${messageId}?format=metadata` },
      response: googleJson(
        200,
        metadataMessage([headers.from, headers.subject, headers.contentType])
      )
    },
    {
      request: {
        method: 'GET',
        url: `${gmailSyntheticApi}/messages/${messageId}?format=metadata&${selection}`
      },
      response: googleJson(200, metadataMessage([headers.from, headers.subject]))
    },
    {
      request: {
        method: 'GET',
        url: `${gmailSyntheticApi}/threads/${messageId}?format=metadata&${selection}`
      },
      response: googleJson(200, {
        id: messageId,
        historyId: '900010',
        messages: [metadataMessage([headers.from, headers.subject])]
      })
    }
  ]
}
