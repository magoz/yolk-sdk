import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * `linkedin_search.profile` for the seeded absent profile URL (a made-up slug): one GET /profile
 * answered with HTTP 404 (the case checks only the 4xx status).
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:linkedin-search --live --owner-approved --account <label> --record` stages a
 * recording in a gitignored directory; promoting it replaces each 2xx body wholesale with a
 * minimal synthetic body (see the script header).
 */
export const linkedInSearchProfileNotFoundFixture: WireFixture = {
  id: 'linkedin-search.errors.profile-not-found.synthetic',
  caseId: 'linkedin-search.errors.profile-not-found',
  evidence: 'unverified',
  recordedAt: '2026-10-01',
  account: 'synthetic',
  endpoint: 'https://enrichlayer.com/api/v2',
  note: 'An Enrich Layer profile lookup for a profile URL that names no profile, answered with a 4xx status. Synthetic placeholder shaped like the Enrich Layer error wire; not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'GET',
        url: 'https://enrichlayer.com/api/v2/profile?linkedin_profile_url=https%3A%2F%2Flinkedin.example.com%2Fin%2Fsynthetic-absent-person-00'
      },
      response: {
        status: 404,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code: 404,
          description: 'Person profile does not exist',
          name: 'Not Found'
        })
      }
    }
  ]
}
