import type { WireFixture } from '@yolk-sdk/conformance/fixture'
import {
  gmailConformancePracticeMime,
  gmailSyntheticApi,
  googleJson,
  googleSyntheticPracticeAddress
} from './synthetic.ts'

const sentId = '18f00000000000e1'

const subject = 'yolk-conformance run-synthetic send: synthetic conformance message, safe to delete'

/**
 * The multipart boundary of the recorded upload. The connector draws a fresh random boundary per
 * send, and replay matches by method and URL only, so any boundary replays.
 */
export const gmailSendSyntheticBoundary = 'yolk_gmail_send_00000000000000000000000000000000'

/** The `multipart/related` upload body the connector sends for 7-bit MIME. */
const uploadBody = (mime: string) =>
  [
    `--${gmailSendSyntheticBoundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    '{}',
    `--${gmailSendSyntheticBoundary}`,
    'Content-Type: message/rfc822',
    '',
    mime,
    `--${gmailSendSyntheticBoundary}--`
  ].join('\r\n')

/**
 * `gmail.send_message` of a 7-bit message to the synthetic practice address (one multipart
 * upload), then `gmail.get_message` of the answered id with `format=metadata`.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:google --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const gmailSendPracticeFixture: WireFixture = {
  id: 'google.gmail.send-practice-address.synthetic',
  caseId: 'google.gmail.send-practice-address',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://gmail.googleapis.com',
  note: 'Send one 7-bit message whose only recipient is the practice address through the multipart upload, then read the answered id back with its To and Subject headers. Synthetic placeholder shaped like the Gmail API; not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'POST',
        url: 'https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=multipart',
        headers: {
          'content-type': `multipart/related; boundary=${gmailSendSyntheticBoundary}`
        },
        body: uploadBody(gmailConformancePracticeMime(googleSyntheticPracticeAddress, subject))
      },
      response: googleJson(200, { id: sentId, threadId: sentId, labelIds: ['SENT'] })
    },
    {
      request: { method: 'GET', url: `${gmailSyntheticApi}/messages/${sentId}?format=metadata` },
      response: googleJson(200, {
        id: sentId,
        threadId: sentId,
        labelIds: ['SENT', 'INBOX', 'UNREAD'],
        snippet: 'Synthetic conformance message sent to the seeded practice address only.',
        sizeEstimate: 640,
        historyId: '900030',
        internalDate: '1790000000000',
        payload: {
          partId: '',
          mimeType: 'text/plain',
          filename: '',
          headers: [
            { name: 'MIME-Version', value: '1.0' },
            { name: 'Date', value: 'Wed, 30 Sep 2026 12:00:00 +0000' },
            { name: 'Message-ID', value: '<synthetic-send-0001@example.test>' },
            { name: 'Subject', value: subject },
            { name: 'From', value: googleSyntheticPracticeAddress },
            { name: 'To', value: googleSyntheticPracticeAddress },
            { name: 'Content-Type', value: 'text/plain; charset=us-ascii' }
          ],
          body: { size: 88 }
        }
      })
    }
  ]
}
