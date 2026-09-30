import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * `notion.get_page` of a well-formed id that addresses no page (HTTP 404 `object_not_found`) and
 * of a malformed id (HTTP 400 `validation_error`).
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:notion --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const notionErrorEnvelopeFixture: WireFixture = {
  id: 'notion.errors.error-envelope.synthetic',
  caseId: 'notion.errors.error-envelope',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://api.notion.com/v1',
  note: 'A missing page and a malformed page id, both answered with the Notion error envelope. Synthetic placeholder shaped like the Notion wire; not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'GET',
        url: 'https://api.notion.com/v1/pages/ffffffff-ffff-4fff-bfff-ffffffffffff',
        headers: { 'notion-version': '2025-09-03' }
      },
      response: {
        status: 404,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          object: 'error',
          status: 404,
          code: 'object_not_found',
          message:
            'Could not find page with ID: ffffffff-ffff-4fff-bfff-ffffffffffff. Make sure the relevant pages and databases are shared with your integration.',
          request_id: '00000000-0000-4000-8000-0000000000e3'
        })
      }
    },
    {
      request: {
        method: 'GET',
        url: 'https://api.notion.com/v1/pages/not-a-notion-id',
        headers: { 'notion-version': '2025-09-03' }
      },
      response: {
        status: 400,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          object: 'error',
          status: 400,
          code: 'validation_error',
          message:
            'path failed validation: path.page_id should be a valid uuid, instead was `"not-a-notion-id"`.',
          request_id: '00000000-0000-4000-8000-0000000000e4'
        })
      }
    }
  ]
}
