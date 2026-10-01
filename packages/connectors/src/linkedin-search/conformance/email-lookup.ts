import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * `linkedin_search.email` for the seeded profile URL: one GET /profile/email answered with a
 * synthetic `example.com` address.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:linkedin-search --live --owner-approved --account <label> --record` stages a
 * recording in a gitignored directory; promoting it replaces each 2xx body wholesale with a
 * minimal synthetic body (see the script header).
 */
export const linkedInSearchEmailLookupFixture: WireFixture = {
  id: 'linkedin-search.email.lookup-answer.synthetic',
  caseId: 'linkedin-search.email.lookup-answer',
  evidence: 'unverified',
  recordedAt: '2026-10-01',
  account: 'synthetic',
  endpoint: 'https://enrichlayer.com/api/v2',
  note: 'An Enrich Layer email lookup for the seeded profile URL, answered with a synthetic address. Synthetic placeholder shaped like the Enrich Layer email wire; not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'GET',
        url: 'https://enrichlayer.com/api/v2/profile/email?linkedin_profile_url=https%3A%2F%2Flinkedin.example.com%2Fin%2Fsynthetic-person-01'
      },
      response: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'synthetic-person-01@example.com' })
      }
    }
  ]
}
