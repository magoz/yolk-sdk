import type { WireFixture } from '@yolk-sdk/conformance/fixture'
import {
  githubJson,
  githubRequestHeaders,
  githubSyntheticIssue,
  githubSyntheticLabel,
  githubSyntheticUrl
} from './synthetic.ts'

const repoPath = '/repos/yolk-synthetic/conformance-practice'

/** The seeded work issue, open, with the `bug` label (as the label fixture reads it). */
const workIssue = githubSyntheticIssue({
  number: 1,
  title: 'Synthetic work issue for conformance runs',
  state: 'open',
  labels: [githubSyntheticLabel(700000001, 'bug', 'd73a4a')],
  body: 'Synthetic work issue: conformance cases add and remove a label and a comment here.'
})

/**
 * The open-issue listing and the work issue's comment listing, as the read-only leftover lookup
 * sends them (`per_page=100`, `page=1`): the seeded work issue is the repository's only open issue
 * (the issues the repository reached before it are closed), it holds no comments, and both
 * listings fit one page, so neither carries a `Link` header.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it. The shapes
 * follow the GitHub REST reference, fetched 2026-11-20: "List repository issues" (an array of issue
 * objects with `comments` and `state_reason`, pull requests included and marked by `pull_request`,
 * `state` defaulting to `open`, `per_page` at most 100;
 * https://docs.github.com/rest/issues/issues#list-repository-issues), "List issue comments" (an
 * array of comment objects; https://docs.github.com/rest/issues/comments#list-issue-comments), and
 * "Using pagination in the REST API" (the `link` header and its `rel="next"`;
 * https://docs.github.com/rest/using-the-rest-api/using-pagination-in-the-rest-api), with the
 * issue shape of the other GitHub fixtures, a subset of the documented issue fields (no
 * `events_url`, `labels_url`, `closed_by`, ...). `pnpm conformance:github --live --owner-approved --account <label>
 * --record` stages a replacement in a gitignored directory; see the script header for the manual
 * scrub-and-promote step.
 */
export const githubOpenIssuesFixture: WireFixture = {
  id: 'github.issues.open-listing.synthetic',
  caseId: 'github.issues.open-listing',
  evidence: 'unverified',
  recordedAt: '2026-11-20',
  account: 'synthetic',
  endpoint: 'https://api.github.com',
  note: 'The open-issue listing (state=open, per_page=100, page=1) answering the seeded work issue only, then its comment listing (per_page=100, page=1) answering no comment; neither carries a Link header. Synthetic placeholder shaped from the GitHub REST reference (fetched 2026-11-20; List repository issues: https://docs.github.com/rest/issues/issues#list-repository-issues; List issue comments: https://docs.github.com/rest/issues/comments#list-issue-comments; the link header: https://docs.github.com/rest/using-the-rest-api/using-pagination-in-the-rest-api) and the issue shape of the other GitHub fixtures, a subset of the documented issue fields. Not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'GET',
        url: githubSyntheticUrl(`${repoPath}/issues`, {
          per_page: '100',
          page: '1',
          state: 'open'
        }),
        headers: githubRequestHeaders
      },
      response: githubJson(200, [workIssue])
    },
    {
      request: {
        method: 'GET',
        url: githubSyntheticUrl(`${repoPath}/issues/1/comments`, { per_page: '100', page: '1' }),
        headers: githubRequestHeaders
      },
      response: githubJson(200, [])
    }
  ]
}
