import type { WireFixture } from '@yolk-sdk/conformance/fixture'
import {
  githubErrorBody,
  githubJson,
  githubJsonRequestHeaders,
  githubNoContent,
  githubRequestHeaders,
  githubSyntheticComment,
  githubSyntheticRepoApi,
  githubSyntheticUrl
} from './synthetic.ts'

const body = 'yolk-conformance run-synthetic comment: synthetic conformance comment, safe to delete'

const createdAt = '2026-09-30T12:00:05Z'

const comment = githubSyntheticComment({ id: 9000000001, issueNumber: 1, body, createdAt })

const since = {
  request: {
    method: 'GET',
    url: githubSyntheticUrl('/repos/yolk-synthetic/conformance-practice/issues/1/comments', {
      per_page: '100',
      since: createdAt
    }),
    headers: githubRequestHeaders
  }
}

const deleteRequest = {
  method: 'DELETE',
  url: `${githubSyntheticRepoApi}/issues/comments/9000000001`,
  headers: githubRequestHeaders
}

/**
 * A run-scoped comment created on the seeded work issue, listed since its `created_at`, deleted by
 * id, no longer listed, then deleted again (not found).
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:github --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const githubCommentLifecycleFixture: WireFixture = {
  id: 'github.comments.create-delete.synthetic',
  caseId: 'github.comments.create-delete',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://api.github.com',
  note: 'Create a run-scoped comment on the work issue, list it since its created_at, delete it by id, list again (gone), and delete it again (404). Synthetic placeholder shaped like the GitHub REST API; not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'POST',
        url: `${githubSyntheticRepoApi}/issues/1/comments`,
        headers: githubJsonRequestHeaders,
        body: { body }
      },
      response: githubJson(201, comment)
    },
    { ...since, response: githubJson(200, [comment]) },
    { request: deleteRequest, response: githubNoContent },
    { ...since, response: githubJson(200, []) },
    {
      request: deleteRequest,
      response: githubJson(
        404,
        githubErrorBody(
          'Not Found',
          'https://docs.github.com/rest/issues/comments#delete-an-issue-comment',
          404
        )
      )
    }
  ]
}
