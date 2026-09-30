import type { WireFixture } from '@yolk-sdk/conformance/fixture'
import {
  githubConformanceLongSearchQuery,
  githubJson,
  githubRequestHeaders,
  githubSyntheticUrl
} from './synthetic.ts'

/**
 * `github.search_issues` with a query longer than 256 characters: HTTP 422 with GitHub's
 * validation body (`message` and an `errors` array).
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:github --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const githubValidationEnvelopeFixture: WireFixture = {
  id: 'github.errors.validation-envelope.synthetic',
  caseId: 'github.errors.validation-envelope',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://api.github.com',
  note: 'An issue search longer than 256 characters, refused with 422 and a validation errors array. Synthetic placeholder shaped like the GitHub REST API; not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'GET',
        url: githubSyntheticUrl('/search/issues', {
          q: `repo:yolk-synthetic/conformance-practice ${githubConformanceLongSearchQuery}`
        }),
        headers: githubRequestHeaders
      },
      response: githubJson(422, {
        message: 'Validation Failed',
        errors: [
          {
            message: 'The search is longer than 256 characters.',
            resource: 'Search',
            field: 'q',
            code: 'invalid'
          }
        ],
        documentation_url: 'https://docs.github.com/v3/search/',
        status: '422'
      })
    }
  ]
}
