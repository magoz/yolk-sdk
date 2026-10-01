import type { WireFixture } from '@yolk-sdk/conformance/fixture'
import { gmailSyntheticApi, gmailSyntheticMinimalMessage, googleJson } from './synthetic.ts'

const workMessageId = '18f00000000000b1'

const read = { method: 'GET', url: `${gmailSyntheticApi}/messages/${workMessageId}?format=minimal` }

const before = ['INBOX', 'IMPORTANT']

const trashed = [...before, 'TRASH']

const answer = (labelIds: ReadonlyArray<string>) =>
  googleJson(200, { id: workMessageId, threadId: workMessageId, labelIds: [...labelIds] })

/**
 * The seeded work message read, trashed (TRASH added), read in Trash, untrashed, and read back
 * with exactly its earlier labels.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:google --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const gmailTrashUntrashFixture: WireFixture = {
  id: 'google.gmail.trash-untrash.synthetic',
  caseId: 'google.gmail.trash-untrash',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://gmail.googleapis.com',
  note: 'Read the work message labels, trash it, read it with TRASH, untrash it, and read its earlier labels back. Synthetic placeholder shaped like the Gmail API; not recorded from a live service.',
  exchanges: [
    {
      request: read,
      response: googleJson(200, gmailSyntheticMinimalMessage(workMessageId, before))
    },
    {
      request: { method: 'POST', url: `${gmailSyntheticApi}/messages/${workMessageId}/trash` },
      response: answer(trashed)
    },
    {
      request: read,
      response: googleJson(200, gmailSyntheticMinimalMessage(workMessageId, trashed))
    },
    {
      request: { method: 'POST', url: `${gmailSyntheticApi}/messages/${workMessageId}/untrash` },
      response: answer(before)
    },
    {
      request: read,
      response: googleJson(200, gmailSyntheticMinimalMessage(workMessageId, before))
    }
  ]
}
