import type { WireFixture } from '@yolk-sdk/conformance/fixture'

const match = (index: number) => ({
  match_type: { '.tag': 'filename' },
  metadata: {
    '.tag': 'metadata',
    metadata: {
      '.tag': 'file',
      name: `yolk-search-probe-${index}.txt`,
      path_lower: `/conformance/search/yolk-search-probe-${index}.txt`,
      path_display: `/Conformance/Search/yolk-search-probe-${index}.txt`,
      id: `id:SyntheticSearchFile000${index}`,
      client_modified: '2026-09-20T12:00:00Z',
      server_modified: '2026-09-20T12:00:00Z',
      rev: `a1b2c3d4e5f6002${index}`,
      size: 16,
      is_downloadable: true,
      content_hash: `000000000000000000000000000000000000000000000000000000000000002${index}`
    }
  }
})

/**
 * A `max_results: 1` search with `has_more` and a cursor, then the `search/continue_v2` page.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:dropbox --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const dropboxSearchContinueFixture: WireFixture = {
  id: 'dropbox.files.search-continue.synthetic',
  caseId: 'dropbox.files.search-continue',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://api.dropboxapi.com/2',
  note: 'Two search pages for the seeded query (two matching files, max_results 1). Synthetic placeholder shaped like the Dropbox wire; not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'POST',
        url: 'https://api.dropboxapi.com/2/files/search_v2',
        headers: { 'content-type': 'application/json' },
        body: { query: 'yolk-search-probe', options: { max_results: 1, filename_only: true } }
      },
      response: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          matches: [match(1)],
          has_more: true,
          cursor: 'AAHsyntheticSearchCursor0001'
        })
      }
    },
    {
      request: {
        method: 'POST',
        url: 'https://api.dropboxapi.com/2/files/search/continue_v2',
        headers: { 'content-type': 'application/json' },
        body: { cursor: 'AAHsyntheticSearchCursor0001' }
      },
      response: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ matches: [match(2)], has_more: false })
      }
    }
  ]
}
