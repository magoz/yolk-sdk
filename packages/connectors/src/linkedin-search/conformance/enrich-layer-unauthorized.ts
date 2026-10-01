import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * `linkedin_search.profile`, then `linkedin_search.email`, for the seeded profile URL with a
 * synthetic API key Enrich Layer does not know: both answered with HTTP 401 (the case checks only
 * the 4xx statuses; the authorization header is never recorded).
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:linkedin-search --live --owner-approved --account <label> --record` stages a
 * recording in a gitignored directory; promoting it replaces each 2xx body wholesale with a
 * minimal synthetic body (see the script header).
 */
export const linkedInSearchEnrichLayerUnauthorizedFixture: WireFixture = {
  id: 'linkedin-search.errors.enrich-layer-unauthorized.synthetic',
  caseId: 'linkedin-search.errors.enrich-layer-unauthorized',
  evidence: 'unverified',
  recordedAt: '2026-10-01',
  account: 'synthetic',
  endpoint: 'https://enrichlayer.com/api/v2',
  note: 'Enrich Layer profile and email lookups with an unknown API key, both answered with a 4xx status. Synthetic placeholder shaped like the Enrich Layer error wire; not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'GET',
        url: 'https://enrichlayer.com/api/v2/profile?linkedin_profile_url=https%3A%2F%2Flinkedin.example.com%2Fin%2Fsynthetic-person-01'
      },
      response: {
        status: 401,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: 401, description: 'Invalid API Key', name: 'Unauthorized' })
      }
    },
    {
      request: {
        method: 'GET',
        url: 'https://enrichlayer.com/api/v2/profile/email?linkedin_profile_url=https%3A%2F%2Flinkedin.example.com%2Fin%2Fsynthetic-person-01'
      },
      response: {
        status: 401,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: 401, description: 'Invalid API Key', name: 'Unauthorized' })
      }
    }
  ]
}
