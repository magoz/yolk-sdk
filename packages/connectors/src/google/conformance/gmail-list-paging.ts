import type { WireFixture } from '@yolk-sdk/conformance/fixture'
import { gmailSyntheticApi, googleJson } from './synthetic.ts'

const listUrl = (maxResults: number, pageToken?: string) =>
  `${gmailSyntheticApi}/messages?labelIds=Label_9001&maxResults=${maxResults}${pageToken === undefined ? '' : `&pageToken=${pageToken}`}`

const ref = (suffix: string) => ({
  id: `18f00000000000c${suffix}`,
  threadId: `18f00000000000c${suffix}`
})

/**
 * The seeded paging label (five messages) listed on one page (`maxResults=100`), then in
 * `gmail.list` pages of two chained through `nextPageToken`.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:google --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const gmailListPagingFixture: WireFixture = {
  id: 'google.gmail.list-page-token.synthetic',
  caseId: 'google.gmail.list-page-token',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://gmail.googleapis.com',
  note: 'List the paging label on one page, then two messages at a time, feeding nextPageToken back as pageToken until a page has none. Synthetic placeholder shaped like the Gmail API; not recorded from a live service.',
  exchanges: [
    {
      request: { method: 'GET', url: listUrl(100) },
      response: googleJson(200, {
        messages: [ref('1'), ref('2'), ref('3'), ref('4'), ref('5')],
        resultSizeEstimate: 5
      })
    },
    {
      request: { method: 'GET', url: listUrl(2) },
      response: googleJson(200, {
        messages: [ref('1'), ref('2')],
        nextPageToken: 'synthetic-gmail-page-2',
        resultSizeEstimate: 5
      })
    },
    {
      request: { method: 'GET', url: listUrl(2, 'synthetic-gmail-page-2') },
      response: googleJson(200, {
        messages: [ref('3'), ref('4')],
        nextPageToken: 'synthetic-gmail-page-3',
        resultSizeEstimate: 5
      })
    },
    {
      request: { method: 'GET', url: listUrl(2, 'synthetic-gmail-page-3') },
      response: googleJson(200, { messages: [ref('5')], resultSizeEstimate: 5 })
    }
  ]
}
