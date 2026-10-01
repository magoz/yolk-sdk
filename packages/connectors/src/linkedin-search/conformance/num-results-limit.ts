import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * The control and the limited search: `linkedin_search.search` for the seeded query with
 * `numResults: 3`, answered with three synthetic people results, then with `numResults: 2`,
 * answered with two. Both are POST /search, keeping only the result fields the connector decodes.
 * Every person, company, and profile URL is synthetic (`linkedin.example.com`).
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:linkedin-search --live --owner-approved --account <label> --record` stages a
 * recording in a gitignored directory; promoting it replaces each 2xx body wholesale with a
 * minimal synthetic body (see the script header).
 */
export const linkedInSearchNumResultsLimitFixture: WireFixture = {
  id: 'linkedin-search.search.num-results-limit.synthetic',
  caseId: 'linkedin-search.search.num-results-limit',
  evidence: 'unverified',
  recordedAt: '2026-10-01',
  account: 'synthetic',
  endpoint: 'https://api.exa.ai',
  note: 'An Exa people search for the seeded query with numResults 3 (three synthetic results), then with numResults 2 (two). Synthetic placeholder shaped like the Exa search wire; not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'POST',
        url: 'https://api.exa.ai/search',
        headers: { 'content-type': 'application/json' },
        body: {
          query: 'synthetic conformance engineer',
          category: 'people',
          numResults: 3,
          type: 'auto',
          contents: { text: true }
        }
      },
      response: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          results: [
            {
              title: 'Synthetic Person 01 | Conformance Engineer at Example Synthetic Co',
              url: 'https://linkedin.example.com/in/synthetic-person-01',
              author: 'Synthetic Person 01',
              text: 'Synthetic Person 01. Conformance Engineer at Example Synthetic Co. Synthetic profile text, not a real person.'
            },
            {
              title: 'Synthetic Person 02 | Test Engineer at Example Synthetic Co',
              url: 'https://linkedin.example.com/in/synthetic-person-02',
              author: 'Synthetic Person 02',
              publishedDate: '2026-01-15T00:00:00.000Z',
              text: 'Synthetic Person 02. Test Engineer at Example Synthetic Co. Synthetic profile text, not a real person.'
            },
            {
              title: 'Synthetic Person 03 | Conformance Lead at Example Synthetic Labs',
              url: 'https://linkedin.example.com/in/synthetic-person-03'
            }
          ]
        })
      }
    },
    {
      request: {
        method: 'POST',
        url: 'https://api.exa.ai/search',
        headers: { 'content-type': 'application/json' },
        body: {
          query: 'synthetic conformance engineer',
          category: 'people',
          numResults: 2,
          type: 'auto',
          contents: { text: true }
        }
      },
      response: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          results: [
            {
              title: 'Synthetic Person 01 | Conformance Engineer at Example Synthetic Co',
              url: 'https://linkedin.example.com/in/synthetic-person-01',
              author: 'Synthetic Person 01',
              text: 'Synthetic Person 01. Conformance Engineer at Example Synthetic Co. Synthetic profile text, not a real person.'
            },
            {
              title: 'Synthetic Person 02 | Test Engineer at Example Synthetic Co',
              url: 'https://linkedin.example.com/in/synthetic-person-02',
              author: 'Synthetic Person 02',
              text: 'Synthetic Person 02. Test Engineer at Example Synthetic Co. Synthetic profile text, not a real person.'
            }
          ]
        })
      }
    }
  ]
}
