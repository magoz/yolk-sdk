import type { WireFixture } from '@yolk-sdk/conformance/fixture'
import { gmailSyntheticApi, googleJson } from './synthetic.ts'

const listUrl = (resource: 'messages' | 'threads', maxResults: number, pageToken?: string) =>
  `${gmailSyntheticApi}/${resource}?labelIds=Label_9001&maxResults=${maxResults}${pageToken === undefined ? '' : `&pageToken=${pageToken}`}`

const messageRef = (suffix: string) => ({
  id: `18f00000000000c${suffix}`,
  threadId: `18f00000000000c${suffix}`
})

const threadRef = (suffix: string) => ({
  id: `18f00000000000c${suffix}`,
  snippet: `Synthetic paging message ${suffix}.`,
  historyId: `90010${suffix}`
})

/**
 * The seeded paging label's threads (five, one message each) listed on one page
 * (`maxResults=100`), the label's messages listed on one page for their thread ids, then
 * `gmail.list_threads` pages of two chained through `nextPageToken`.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:google --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const gmailListThreadsPagingFixture: WireFixture = {
  id: 'google.gmail.list-threads-page-token.synthetic',
  caseId: 'google.gmail.list-threads-page-token',
  evidence: 'unverified',
  recordedAt: '2026-10-04',
  account: 'synthetic',
  endpoint: 'https://gmail.googleapis.com',
  note: "List the paging label's threads on one page, its messages on one page, then the threads two at a time, feeding nextPageToken back as pageToken until a page has none. Synthetic placeholder shaped like the Gmail API; not recorded from a live service.",
  exchanges: [
    {
      request: { method: 'GET', url: listUrl('threads', 100) },
      response: googleJson(200, {
        threads: [threadRef('1'), threadRef('2'), threadRef('3'), threadRef('4'), threadRef('5')],
        resultSizeEstimate: 5
      })
    },
    {
      request: { method: 'GET', url: listUrl('messages', 100) },
      response: googleJson(200, {
        messages: [
          messageRef('1'),
          messageRef('2'),
          messageRef('3'),
          messageRef('4'),
          messageRef('5')
        ],
        resultSizeEstimate: 5
      })
    },
    {
      request: { method: 'GET', url: listUrl('threads', 2) },
      response: googleJson(200, {
        threads: [threadRef('1'), threadRef('2')],
        nextPageToken: 'synthetic-gmail-threads-page-2',
        resultSizeEstimate: 5
      })
    },
    {
      request: { method: 'GET', url: listUrl('threads', 2, 'synthetic-gmail-threads-page-2') },
      response: googleJson(200, {
        threads: [threadRef('3'), threadRef('4')],
        nextPageToken: 'synthetic-gmail-threads-page-3',
        resultSizeEstimate: 5
      })
    },
    {
      request: { method: 'GET', url: listUrl('threads', 2, 'synthetic-gmail-threads-page-3') },
      response: googleJson(200, { threads: [threadRef('5')], resultSizeEstimate: 5 })
    }
  ]
}
