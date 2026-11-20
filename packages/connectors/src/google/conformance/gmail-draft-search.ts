import type { WireFixture } from '@yolk-sdk/conformance/fixture'
import { gmailSyntheticApi, googleJson } from './synthetic.ts'

/**
 * The draft search the read-only leftover lookup sends (`q=subject:yolk-conformance`,
 * `maxResults=100`) on an account without conformance drafts: no `drafts` member, an estimate of 0.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it. The shape
 * follows the Gmail API reference for `users.drafts.list`, fetched 2026-11-20 (`q` takes the Gmail
 * search box syntax, `maxResults` defaults to 100 and is at most 500; the answer is
 * `{ drafts: [Draft], nextPageToken, resultSizeEstimate }`, each draft's message holding only `id`
 * and `threadId`;
 * https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.drafts/list). Not in
 * the reference: that a search matching nothing omits `drafts` (the JSON mapping drops an empty
 * list; the case accepts `drafts` absent or empty).
 * `pnpm conformance:google --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const gmailDraftSearchFixture: WireFixture = {
  id: 'google.gmail.draft-search.synthetic',
  caseId: 'google.gmail.draft-search',
  evidence: 'unverified',
  recordedAt: '2026-11-20',
  account: 'synthetic',
  endpoint: 'https://gmail.googleapis.com',
  note: 'The leftover draft search (q=subject:yolk-conformance, maxResults=100) on an account without conformance drafts: no drafts member, resultSizeEstimate 0. Synthetic placeholder shaped from the Gmail API reference (fetched 2026-11-20; users.drafts.list: { drafts, nextPageToken, resultSizeEstimate }, q in the Gmail search box syntax: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.drafts/list). Not in the reference: that an empty search omits drafts (the case accepts it absent or empty). Not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'GET',
        url: `${gmailSyntheticApi}/drafts?${new URLSearchParams({ q: 'subject:yolk-conformance', maxResults: '100' }).toString()}`
      },
      response: googleJson(200, { resultSizeEstimate: 0 })
    }
  ]
}
