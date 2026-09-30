import type { WireFixture } from '@yolk-sdk/conformance/fixture'
import {
  githubErrorBody,
  githubJson,
  githubJsonRequestHeaders,
  githubRequestHeaders,
  githubSyntheticIssue,
  githubSyntheticLabel,
  githubSyntheticRepoApi,
  githubSyntheticUrl
} from './synthetic.ts'

const bug = githubSyntheticLabel(700000001, 'bug', 'd73a4a')

const documentation = githubSyntheticLabel(700000002, 'documentation', '0075ca')

const conformance = githubSyntheticLabel(700000005, 'synthetic-conformance', 'ededed')

const workIssue = (labels: ReadonlyArray<ReturnType<typeof githubSyntheticLabel>>) =>
  githubSyntheticIssue({
    number: 1,
    title: 'Synthetic work issue for conformance runs',
    state: 'open',
    labels,
    body: 'Synthetic work issue: conformance cases add and remove a label and a comment here.'
  })

const getWorkIssue = {
  method: 'GET',
  url: `${githubSyntheticRepoApi}/issues/1`,
  headers: githubRequestHeaders
}

const removeRequest = {
  method: 'DELETE',
  url: `${githubSyntheticRepoApi}/issues/1/labels/synthetic-conformance`,
  headers: githubRequestHeaders
}

/**
 * The seeded label added to the seeded work issue and removed again: the work issue without it,
 * the repository labels (it exists), the add, the issue with it, the remove, the issue without it,
 * then a second remove (not found).
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:github --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const githubIssueLabelsFixture: WireFixture = {
  id: 'github.labels.add-remove.synthetic',
  caseId: 'github.labels.add-remove',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://api.github.com',
  note: 'Check the work issue lacks the seeded label and the label exists, add it, read it back, remove it, read the issue without it, and remove it again (404). Synthetic placeholder shaped like the GitHub REST API; not recorded from a live service.',
  exchanges: [
    { request: getWorkIssue, response: githubJson(200, workIssue([bug])) },
    {
      request: {
        method: 'GET',
        url: githubSyntheticUrl('/repos/yolk-synthetic/conformance-practice/labels', {
          per_page: '100'
        }),
        headers: githubRequestHeaders
      },
      response: githubJson(200, [bug, documentation, conformance])
    },
    {
      request: {
        method: 'POST',
        url: `${githubSyntheticRepoApi}/issues/1/labels`,
        headers: githubJsonRequestHeaders,
        body: { labels: ['synthetic-conformance'] }
      },
      response: githubJson(200, [bug, conformance])
    },
    { request: getWorkIssue, response: githubJson(200, workIssue([bug, conformance])) },
    { request: removeRequest, response: githubJson(200, [bug]) },
    { request: getWorkIssue, response: githubJson(200, workIssue([bug])) },
    {
      request: removeRequest,
      response: githubJson(
        404,
        githubErrorBody(
          'Label does not exist',
          'https://docs.github.com/rest/issues/labels#remove-a-label-from-an-issue',
          404
        )
      )
    }
  ]
}
