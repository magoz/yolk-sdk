import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * A `limit: 2` listing of the seeded paging folder with `has_more` and a cursor, then the
 * `list_folder/continue` page that ends the listing.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:dropbox --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const dropboxListFolderPagingFixture: WireFixture = {
  id: 'dropbox.files.list-folder-cursor-paging.synthetic',
  caseId: 'dropbox.files.list-folder-cursor-paging',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://api.dropboxapi.com/2',
  note: 'Two pages of the seeded paging folder (three entries, limit 2): the first with has_more and a cursor, the second reached through list_folder/continue. Synthetic placeholder shaped like the Dropbox wire; not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'POST',
        url: 'https://api.dropboxapi.com/2/files/list_folder',
        headers: { 'content-type': 'application/json' },
        body: { path: '/Conformance/Paging', limit: 2 }
      },
      response: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          entries: [
            {
              '.tag': 'file',
              name: 'paging-one.txt',
              path_lower: '/conformance/paging/paging-one.txt',
              path_display: '/Conformance/Paging/paging-one.txt',
              id: 'id:SyntheticPagingFile0001',
              client_modified: '2026-09-20T10:00:00Z',
              server_modified: '2026-09-20T10:00:00Z',
              rev: 'a1b2c3d4e5f60001',
              size: 12,
              is_downloadable: true,
              content_hash: '0000000000000000000000000000000000000000000000000000000000000001'
            },
            {
              '.tag': 'folder',
              name: 'paging-two',
              path_lower: '/conformance/paging/paging-two',
              path_display: '/Conformance/Paging/paging-two',
              id: 'id:SyntheticPagingFolder0002'
            }
          ],
          cursor: 'AAHsyntheticListCursor0001',
          has_more: true
        })
      }
    },
    {
      request: {
        method: 'POST',
        url: 'https://api.dropboxapi.com/2/files/list_folder/continue',
        headers: { 'content-type': 'application/json' },
        body: { cursor: 'AAHsyntheticListCursor0001' }
      },
      response: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          entries: [
            {
              '.tag': 'file',
              name: 'paging-three.txt',
              path_lower: '/conformance/paging/paging-three.txt',
              path_display: '/Conformance/Paging/paging-three.txt',
              id: 'id:SyntheticPagingFile0003',
              client_modified: '2026-09-20T10:05:00Z',
              server_modified: '2026-09-20T10:05:00Z',
              rev: 'a1b2c3d4e5f60003',
              size: 14,
              is_downloadable: true,
              content_hash: '0000000000000000000000000000000000000000000000000000000000000003'
            }
          ],
          cursor: 'AAHsyntheticListCursor0002',
          has_more: false
        })
      }
    }
  ]
}
