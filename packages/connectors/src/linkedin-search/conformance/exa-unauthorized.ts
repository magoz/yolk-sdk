import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * `linkedin_search.search` with a synthetic API key Exa does not know: one POST /search answered
 * with HTTP 401 (the case checks only the 4xx status; the authorization header is never
 * recorded).
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:linkedin-search --live --owner-approved --account <label> --record` stages a
 * recording in a gitignored directory; promoting it replaces each 2xx body wholesale with a
 * minimal synthetic body (see the script header).
 */
export const linkedInSearchExaUnauthorizedFixture: WireFixture = {
  id: 'linkedin-search.errors.exa-unauthorized.synthetic',
  caseId: 'linkedin-search.errors.exa-unauthorized',
  evidence: 'unverified',
  recordedAt: '2026-10-01',
  account: 'synthetic',
  endpoint: 'https://api.exa.ai',
  note: 'An Exa search with an unknown API key, answered with a 4xx status. Synthetic placeholder shaped like the Exa error wire; not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'POST',
        url: 'https://api.exa.ai/search',
        headers: { 'content-type': 'application/json' },
        body: {
          query: 'yolk-conformance unauthorized probe',
          category: 'people',
          numResults: 10,
          type: 'auto',
          contents: { text: true }
        }
      },
      response: {
        status: 401,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: 'synthetic-request-0003', error: 'Invalid API key' })
      }
    }
  ]
}
