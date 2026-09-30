import type { WireFixture } from '@yolk-sdk/conformance/fixture'
import {
  githubJson,
  githubJsonRequestHeaders,
  githubRequestHeaders,
  githubSyntheticIssue,
  githubSyntheticRepoApi
} from './synthetic.ts'

const title =
  'yolk-conformance run-synthetic lifecycle: synthetic conformance issue, safe to ignore'

const renamed =
  'yolk-conformance run-synthetic lifecycle renamed: synthetic conformance issue, safe to ignore'

const body =
  'Synthetic conformance issue. GitHub issues cannot be deleted through the REST API, so it stays closed.'

const issueUrl = `${githubSyntheticRepoApi}/issues/42`

const open = (issueTitle: string) =>
  githubSyntheticIssue({ number: 42, title: issueTitle, state: 'open', body })

const closed = githubSyntheticIssue({
  number: 42,
  title: renamed,
  state: 'closed',
  stateReason: 'completed',
  body,
  closedAt: '2026-09-30T12:00:10Z',
  updatedAt: '2026-09-30T12:00:10Z'
})

/**
 * A run-scoped issue created, read, renamed, closed as completed, and read back closed. The closed
 * issue stays in the repository (GitHub issues cannot be deleted through the REST API).
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:github --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const githubIssueLifecycleFixture: WireFixture = {
  id: 'github.issues.lifecycle-close.synthetic',
  caseId: 'github.issues.lifecycle-close',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://api.github.com',
  note: 'Create a run-scoped issue, read it, rename it, close it as completed, and read it back closed. Synthetic placeholder shaped like the GitHub REST API; not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'POST',
        url: `${githubSyntheticRepoApi}/issues`,
        headers: githubJsonRequestHeaders,
        body: { title, body }
      },
      response: githubJson(201, open(title))
    },
    {
      request: { method: 'GET', url: issueUrl, headers: githubRequestHeaders },
      response: githubJson(200, open(title))
    },
    {
      request: {
        method: 'PATCH',
        url: issueUrl,
        headers: githubJsonRequestHeaders,
        body: { title: renamed }
      },
      response: githubJson(200, open(renamed))
    },
    {
      request: {
        method: 'PATCH',
        url: issueUrl,
        headers: githubJsonRequestHeaders,
        body: { state: 'closed', state_reason: 'completed' }
      },
      response: githubJson(200, closed)
    },
    {
      request: { method: 'GET', url: issueUrl, headers: githubRequestHeaders },
      response: githubJson(200, closed)
    }
  ]
}
