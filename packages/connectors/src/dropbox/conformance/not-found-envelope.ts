import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * `get_metadata` of an absent child of the seeded work folder: HTTP 409 with a `path/not_found`
 * error envelope.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:dropbox --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const dropboxNotFoundEnvelopeFixture: WireFixture = {
  id: 'dropbox.errors.not-found-409-envelope.synthetic',
  caseId: 'dropbox.errors.not-found-409-envelope',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://api.dropboxapi.com/2',
  note: 'A missing path answered with HTTP 409 and the path/not_found route error. Synthetic placeholder shaped like the Dropbox wire; not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'POST',
        url: 'https://api.dropboxapi.com/2/files/get_metadata',
        headers: { 'content-type': 'application/json' },
        body: { path: '/Conformance/Work/yolk-conformance-absent' }
      },
      response: {
        status: 409,
        headers: { 'content-type': 'application/json' },
        body: '{"error_summary": "path/not_found/.", "error": {".tag": "path", "path": {".tag": "not_found"}}}'
      }
    }
  ]
}
