import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * `linkedin_search.profile` for the seeded profile URL: one GET /profile answered with a minimal
 * synthetic profile object (the case reads only that it is a non-empty object). The person and
 * company are synthetic.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:linkedin-search --live --owner-approved --account <label> --record` stages a
 * recording in a gitignored directory; promoting it replaces each 2xx body wholesale with a
 * minimal synthetic body (see the script header).
 */
export const linkedInSearchProfileFixture: WireFixture = {
  id: 'linkedin-search.profile.get-profile.synthetic',
  caseId: 'linkedin-search.profile.get-profile',
  evidence: 'unverified',
  recordedAt: '2026-10-01',
  account: 'synthetic',
  endpoint: 'https://enrichlayer.com/api/v2',
  note: 'An Enrich Layer profile lookup for the seeded profile URL, answered with a synthetic profile. Synthetic placeholder shaped like the Enrich Layer profile wire; not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'GET',
        url: 'https://enrichlayer.com/api/v2/profile?linkedin_profile_url=https%3A%2F%2Flinkedin.example.com%2Fin%2Fsynthetic-person-01'
      },
      response: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          public_identifier: 'synthetic-person-01',
          full_name: 'Synthetic Person 01',
          headline: 'Conformance Engineer at Example Synthetic Co'
        })
      }
    }
  ]
}
