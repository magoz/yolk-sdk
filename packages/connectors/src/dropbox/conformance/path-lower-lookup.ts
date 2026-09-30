import type { WireFixture } from '@yolk-sdk/conformance/fixture'

const metadata = (pathDisplay: string) =>
  JSON.stringify({
    '.tag': 'file',
    name: 'Mixed Case Notes.txt',
    path_lower: '/conformance/mixed case notes.txt',
    path_display: pathDisplay,
    id: 'id:SyntheticMixedCaseFile01',
    client_modified: '2026-09-20T11:00:00Z',
    server_modified: '2026-09-20T11:00:00Z',
    rev: 'a1b2c3d4e5f60010',
    size: 20,
    is_downloadable: true,
    content_hash: '0000000000000000000000000000000000000000000000000000000000000010'
  })

/**
 * `get_metadata` of the seeded mixed-case path, then of the same path lower-cased: the same id and
 * `path_lower`, and a `path_display` whose last component keeps its casing.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:dropbox --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const dropboxPathLowerLookupFixture: WireFixture = {
  id: 'dropbox.files.path-lower-lookup.synthetic',
  caseId: 'dropbox.files.path-lower-lookup',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://api.dropboxapi.com/2',
  note: 'The seeded mixed-case file looked up in its display casing and lower-cased. Synthetic placeholder shaped like the Dropbox wire; not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'POST',
        url: 'https://api.dropboxapi.com/2/files/get_metadata',
        headers: { 'content-type': 'application/json' },
        body: { path: '/Conformance/Mixed Case Notes.txt' }
      },
      response: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: metadata('/Conformance/Mixed Case Notes.txt')
      }
    },
    {
      request: {
        method: 'POST',
        url: 'https://api.dropboxapi.com/2/files/get_metadata',
        headers: { 'content-type': 'application/json' },
        body: { path: '/conformance/mixed case notes.txt' }
      },
      response: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: metadata('/conformance/Mixed Case Notes.txt')
      }
    }
  ]
}
