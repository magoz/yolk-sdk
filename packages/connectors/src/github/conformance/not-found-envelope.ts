import type { WireFixture } from '@yolk-sdk/conformance/fixture'
import {
  githubErrorBody,
  githubJson,
  githubRequestHeaders,
  githubSyntheticRepoApi
} from './synthetic.ts'

/**
 * `github.get_issue` of an issue number the practice repository has not reached: HTTP 404 with
 * GitHub's JSON error body.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:github --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const githubNotFoundEnvelopeFixture: WireFixture = {
  id: 'github.errors.not-found-envelope.synthetic',
  caseId: 'github.errors.not-found-envelope',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://api.github.com',
  note: 'An issue lookup for a number the repository has not reached, answered 404 with the JSON error body. Synthetic placeholder shaped like the GitHub REST API; not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'GET',
        url: `${githubSyntheticRepoApi}/issues/99999999`,
        headers: githubRequestHeaders
      },
      response: githubJson(
        404,
        githubErrorBody('Not Found', 'https://docs.github.com/rest/issues/issues#get-an-issue', 404)
      )
    }
  ]
}
