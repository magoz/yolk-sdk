import { Effect, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import { defineAction } from '../action.ts'
import { ConnectorError } from '../error.ts'
import { decodeJsonResponse } from '../http.ts'
import { ActionResult } from '../result.ts'
import type { ConnectorIntegration } from '../integration.ts'
import type { GithubRequestContext } from './shared.ts'
import {
  GithubIssueNumber,
  GithubWireUser,
  githubBodyMaxChars,
  githubFailure,
  githubHasNextPage,
  githubLabelNames,
  githubListBodyMaxChars,
  githubLogin,
  githubPaginationFields,
  githubPaginationQuery,
  githubPatchMaxChars,
  githubRepoRequest,
  isGithubSuccess,
  resolveGithubContext,
  truncateGithubText
} from './shared.ts'

/** Per-comment body cap for PR review comments (list cap is too small, full cap too large). */
export const githubPullRequestCommentMaxChars = 4_000

const NonEmptyString = Schema.String.pipe(Schema.check(Schema.isNonEmpty()))

const GithubCommentId = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1)))

const GithubCommitSha = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[0-9a-f]{40}([0-9a-f]{24})?$/))
)

// ---------------------------------------------------------------------------
// Wire + normalized pull request shapes
// ---------------------------------------------------------------------------

const GithubWirePullRequestLabel = Schema.Union([
  Schema.String,
  Schema.Struct({ name: Schema.optional(Schema.NullOr(Schema.String)) })
])

const GithubWirePullRequestTeam = Schema.Struct({
  slug: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String)
})

const GithubWirePullRequestRef = Schema.Struct({
  ref: Schema.optional(Schema.String),
  sha: Schema.optional(Schema.String),
  repo: Schema.optional(
    Schema.NullOr(Schema.Struct({ full_name: Schema.optional(Schema.NullOr(Schema.String)) }))
  )
})

export const GithubWirePullRequest = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  state: Schema.String,
  draft: Schema.optional(Schema.Boolean),
  body: Schema.optional(Schema.NullOr(Schema.String)),
  user: Schema.optional(Schema.NullOr(GithubWireUser)),
  head: Schema.optional(GithubWirePullRequestRef),
  base: Schema.optional(GithubWirePullRequestRef),
  labels: Schema.optional(Schema.Array(GithubWirePullRequestLabel)),
  assignees: Schema.optional(Schema.NullOr(Schema.Array(GithubWireUser))),
  requested_reviewers: Schema.optional(Schema.Array(GithubWireUser)),
  requested_teams: Schema.optional(Schema.Array(GithubWirePullRequestTeam)),
  html_url: Schema.String,
  created_at: Schema.String,
  updated_at: Schema.String,
  closed_at: Schema.optional(Schema.NullOr(Schema.String)),
  merged_at: Schema.optional(Schema.NullOr(Schema.String)),
  merged: Schema.optional(Schema.Boolean),
  mergeable: Schema.optional(Schema.NullOr(Schema.Boolean)),
  mergeable_state: Schema.optional(Schema.NullOr(Schema.String)),
  merged_by: Schema.optional(Schema.NullOr(GithubWireUser)),
  commits: Schema.optional(Schema.NullOr(Schema.Number)),
  additions: Schema.optional(Schema.NullOr(Schema.Number)),
  deletions: Schema.optional(Schema.NullOr(Schema.Number)),
  changed_files: Schema.optional(Schema.NullOr(Schema.Number))
})

export type GithubWirePullRequest = typeof GithubWirePullRequest.Type

const githubPullRequestSummaryFields = {
  number: Schema.Number,
  title: Schema.String,
  state: Schema.String,
  draft: Schema.Boolean,
  author: Schema.NullOr(Schema.String),
  headRef: Schema.String,
  headSha: Schema.String,
  baseRef: Schema.String,
  labels: Schema.Array(Schema.String),
  assignees: Schema.Array(Schema.String),
  requestedReviewers: Schema.Array(Schema.String),
  url: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  closedAt: Schema.NullOr(Schema.String),
  mergedAt: Schema.NullOr(Schema.String)
}

export const GithubPullRequestSummary = Schema.Struct(githubPullRequestSummaryFields)

export type GithubPullRequestSummary = typeof GithubPullRequestSummary.Type

export const GithubPullRequest = Schema.Struct({
  ...githubPullRequestSummaryFields,
  body: Schema.NullOr(Schema.String),
  bodyTruncated: Schema.Boolean,
  merged: Schema.Boolean,
  mergeable: Schema.NullOr(Schema.Boolean),
  mergeableState: Schema.NullOr(Schema.String),
  mergedBy: Schema.NullOr(Schema.String),
  headRepository: Schema.NullOr(Schema.String),
  commits: Schema.NullOr(Schema.Number),
  additions: Schema.NullOr(Schema.Number),
  deletions: Schema.NullOr(Schema.Number),
  changedFiles: Schema.NullOr(Schema.Number)
})

export type GithubPullRequest = typeof GithubPullRequest.Type

const pullRequestRequestedReviewers = (wire: GithubWirePullRequest) => {
  const users = (wire.requested_reviewers ?? []).map(user => user.login)

  const teams = (wire.requested_teams ?? []).flatMap(team => {
    if (Predicate.isString(team.slug) && team.slug !== '') return [team.slug]

    if (Predicate.isString(team.name) && team.name !== '') return [team.name]

    return []
  })

  return [...users, ...teams]
}

export const normalizeGithubPullRequestSummary = (
  wire: GithubWirePullRequest
): GithubPullRequestSummary => ({
  number: wire.number,
  title: wire.title,
  state: wire.state,
  draft: wire.draft ?? false,
  author: githubLogin(wire.user),
  headRef: wire.head?.ref ?? '',
  headSha: wire.head?.sha ?? '',
  baseRef: wire.base?.ref ?? '',
  labels: githubLabelNames(wire.labels),
  assignees: (wire.assignees ?? []).map(user => user.login),
  requestedReviewers: pullRequestRequestedReviewers(wire),
  url: wire.html_url,
  createdAt: wire.created_at,
  updatedAt: wire.updated_at,
  closedAt: wire.closed_at ?? null,
  mergedAt: wire.merged_at ?? null
})

export const normalizeGithubPullRequest = (
  wire: GithubWirePullRequest,
  bodyMaxChars: number = githubBodyMaxChars
): GithubPullRequest => {
  const body =
    wire.body === undefined || wire.body === null
      ? { text: null, truncated: false }
      : truncateGithubText(wire.body, bodyMaxChars)

  return {
    ...normalizeGithubPullRequestSummary(wire),
    body: body.text,
    bodyTruncated: body.truncated,
    merged: wire.merged ?? false,
    mergeable: wire.mergeable ?? null,
    mergeableState: wire.mergeable_state ?? null,
    mergedBy: githubLogin(wire.merged_by),
    headRepository: wire.head?.repo?.full_name ?? null,
    commits: wire.commits ?? null,
    additions: wire.additions ?? null,
    deletions: wire.deletions ?? null,
    changedFiles: wire.changed_files ?? null
  }
}

const validationFailure = (integration: ConnectorIntegration, actionId: string, message: string) =>
  Effect.fail(
    new ConnectorError({
      cause: 'validation_failed',
      message,
      connectorId: integration.connectorId,
      actionId
    })
  )

// ---------------------------------------------------------------------------
// list_pull_requests
// ---------------------------------------------------------------------------

export const GithubListPullRequestsInput = Schema.Struct({
  ...githubPaginationFields,
  state: Schema.optional(Schema.Literals(['open', 'closed', 'all'])),
  base: Schema.optional(NonEmptyString),
  head: Schema.optional(NonEmptyString),
  sort: Schema.optional(Schema.Literals(['created', 'updated', 'popularity', 'long-running'])),
  direction: Schema.optional(Schema.Literals(['asc', 'desc']))
})

export const GithubListPullRequestsOutput = Schema.Struct({
  pullRequests: Schema.Array(GithubPullRequestSummary),
  hasNextPage: Schema.Boolean
})

export const githubListPullRequestsAction = defineAction({
  id: 'github.list_pull_requests',
  description: 'List pull requests in the configured repository.',
  access: 'read',
  inputSchema: GithubListPullRequestsInput,
  outputSchema: GithubListPullRequestsOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const context = yield* resolveGithubContext(integration)

      const head =
        input.head === undefined || input.head.includes(':')
          ? input.head
          : `${context.owner}:${input.head}`

      const response = yield* githubRepoRequest(context, {
        method: 'GET',
        path: '/pulls',
        query: {
          ...githubPaginationQuery(input),
          state: input.state,
          base: input.base,
          head,
          sort: input.sort,
          direction: input.direction
        }
      })

      if (!isGithubSuccess(response.status)) {
        return yield* githubFailure(response, { operation: 'list pull requests' })
      }

      const pullRequests = yield* decodeJsonResponse(Schema.Array(GithubWirePullRequest), response)

      return ActionResult.success({
        pullRequests: pullRequests.map(normalizeGithubPullRequestSummary),
        hasNextPage: githubHasNextPage(response.headers)
      })
    })
})

// ---------------------------------------------------------------------------
// get_pull_request
// ---------------------------------------------------------------------------

export const GithubGetPullRequestInput = Schema.Struct({
  pullNumber: GithubIssueNumber
})

export const githubGetPullRequestAction = defineAction({
  id: 'github.get_pull_request',
  description: 'Get a single pull request by number.',
  access: 'read',
  inputSchema: GithubGetPullRequestInput,
  outputSchema: GithubPullRequest,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const context = yield* resolveGithubContext(integration)

      const response = yield* githubRepoRequest(context, {
        method: 'GET',
        path: `/pulls/${encodeURIComponent(input.pullNumber)}`
      })

      if (!isGithubSuccess(response.status)) {
        return yield* githubFailure(response, { operation: 'get pull request' })
      }

      const pullRequest = yield* decodeJsonResponse(GithubWirePullRequest, response)

      return ActionResult.success(normalizeGithubPullRequest(pullRequest))
    })
})

// ---------------------------------------------------------------------------
// list_pull_request_files
// ---------------------------------------------------------------------------

const GithubWirePullRequestFile = Schema.Struct({
  filename: Schema.String,
  previous_filename: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.String,
  additions: Schema.Number,
  deletions: Schema.Number,
  changes: Schema.Number,
  patch: Schema.optional(Schema.NullOr(Schema.String))
})

export const GithubPullRequestFile = Schema.Struct({
  filename: Schema.String,
  previousFilename: Schema.NullOr(Schema.String),
  status: Schema.String,
  additions: Schema.Number,
  deletions: Schema.Number,
  changes: Schema.Number,
  patch: Schema.NullOr(Schema.String),
  patchTruncated: Schema.Boolean
})

export const GithubListPullRequestFilesInput = Schema.Struct({
  ...githubPaginationFields,
  pullNumber: GithubIssueNumber
})

export const GithubListPullRequestFilesOutput = Schema.Struct({
  files: Schema.Array(GithubPullRequestFile),
  hasNextPage: Schema.Boolean
})

export const githubListPullRequestFilesAction = defineAction({
  id: 'github.list_pull_request_files',
  description: 'List the files changed by a pull request, including patches.',
  access: 'read',
  inputSchema: GithubListPullRequestFilesInput,
  outputSchema: GithubListPullRequestFilesOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const context = yield* resolveGithubContext(integration)

      const response = yield* githubRepoRequest(context, {
        method: 'GET',
        path: `/pulls/${encodeURIComponent(input.pullNumber)}/files`,
        query: githubPaginationQuery(input)
      })

      if (!isGithubSuccess(response.status)) {
        return yield* githubFailure(response, { operation: 'list pull request files' })
      }

      const files = yield* decodeJsonResponse(Schema.Array(GithubWirePullRequestFile), response)

      return ActionResult.success({
        files: files.map(file => {
          const patch =
            file.patch === undefined || file.patch === null
              ? { text: null, truncated: false }
              : truncateGithubText(file.patch, githubPatchMaxChars)

          return {
            filename: file.filename,
            previousFilename: file.previous_filename ?? null,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            changes: file.changes,
            patch: patch.text,
            patchTruncated: patch.truncated
          }
        }),
        hasNextPage: githubHasNextPage(response.headers)
      })
    })
})

// ---------------------------------------------------------------------------
// list_pull_request_commits
// ---------------------------------------------------------------------------

const GithubWirePullRequestCommit = Schema.Struct({
  sha: Schema.String,
  commit: Schema.Struct({
    message: Schema.String,
    author: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          name: Schema.optional(Schema.NullOr(Schema.String)),
          date: Schema.optional(Schema.NullOr(Schema.String))
        })
      )
    )
  }),
  author: Schema.optional(Schema.NullOr(GithubWireUser))
})

export const GithubPullRequestCommit = Schema.Struct({
  sha: Schema.String,
  message: Schema.String,
  messageTruncated: Schema.Boolean,
  author: Schema.NullOr(Schema.String),
  authorName: Schema.NullOr(Schema.String),
  date: Schema.NullOr(Schema.String)
})

export const GithubListPullRequestCommitsInput = Schema.Struct({
  ...githubPaginationFields,
  pullNumber: GithubIssueNumber
})

export const GithubListPullRequestCommitsOutput = Schema.Struct({
  commits: Schema.Array(GithubPullRequestCommit),
  hasNextPage: Schema.Boolean
})

export const githubListPullRequestCommitsAction = defineAction({
  id: 'github.list_pull_request_commits',
  description: 'List the commits in a pull request.',
  access: 'read',
  inputSchema: GithubListPullRequestCommitsInput,
  outputSchema: GithubListPullRequestCommitsOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const context = yield* resolveGithubContext(integration)

      const response = yield* githubRepoRequest(context, {
        method: 'GET',
        path: `/pulls/${encodeURIComponent(input.pullNumber)}/commits`,
        query: githubPaginationQuery(input)
      })

      if (!isGithubSuccess(response.status)) {
        return yield* githubFailure(response, { operation: 'list pull request commits' })
      }

      const commits = yield* decodeJsonResponse(Schema.Array(GithubWirePullRequestCommit), response)

      return ActionResult.success({
        commits: commits.map(commit => {
          const message = truncateGithubText(commit.commit.message, githubListBodyMaxChars)

          return {
            sha: commit.sha,
            message: message.text,
            messageTruncated: message.truncated,
            author: githubLogin(commit.author),
            authorName: commit.commit.author?.name ?? null,
            date: commit.commit.author?.date ?? null
          }
        }),
        hasNextPage: githubHasNextPage(response.headers)
      })
    })
})

// ---------------------------------------------------------------------------
// get_pull_request_checks
// ---------------------------------------------------------------------------

const GithubWireCheckRun = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  status: Schema.String,
  conclusion: Schema.optional(Schema.NullOr(Schema.String)),
  html_url: Schema.optional(Schema.NullOr(Schema.String)),
  details_url: Schema.optional(Schema.NullOr(Schema.String)),
  started_at: Schema.optional(Schema.NullOr(Schema.String)),
  completed_at: Schema.optional(Schema.NullOr(Schema.String)),
  app: Schema.optional(
    Schema.NullOr(Schema.Struct({ slug: Schema.optional(Schema.NullOr(Schema.String)) }))
  )
})

const GithubWireCheckRuns = Schema.Struct({
  total_count: Schema.Number,
  check_runs: Schema.Array(GithubWireCheckRun)
})

const GithubWireCombinedStatus = Schema.Struct({
  state: Schema.String,
  total_count: Schema.optional(Schema.Number),
  statuses: Schema.Array(
    Schema.Struct({
      context: Schema.String,
      state: Schema.String,
      description: Schema.optional(Schema.NullOr(Schema.String)),
      target_url: Schema.optional(Schema.NullOr(Schema.String))
    })
  )
})

export const GithubCheckRun = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  status: Schema.String,
  conclusion: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
  app: Schema.NullOr(Schema.String),
  startedAt: Schema.NullOr(Schema.String),
  completedAt: Schema.NullOr(Schema.String)
})

export const GithubCombinedStatus = Schema.Struct({
  state: Schema.String,
  total: Schema.Number,
  statuses: Schema.Array(
    Schema.Struct({
      context: Schema.String,
      state: Schema.String,
      description: Schema.NullOr(Schema.String),
      url: Schema.NullOr(Schema.String)
    })
  )
})

export const GithubGetPullRequestChecksInput = Schema.Struct({
  ...githubPaginationFields,
  pullNumber: GithubIssueNumber
})

export const GithubGetPullRequestChecksOutput = Schema.Struct({
  headSha: Schema.String,
  checkRuns: Schema.Array(GithubCheckRun),
  checkRunsTotal: Schema.Number,
  checkRunsHasNextPage: Schema.Boolean,
  combinedStatus: GithubCombinedStatus,
  combinedStatusHasNextPage: Schema.Boolean
})

export const githubGetPullRequestChecksAction = defineAction({
  id: 'github.get_pull_request_checks',
  description: 'Get the check runs and combined commit status for a pull request head commit.',
  access: 'read',
  inputSchema: GithubGetPullRequestChecksInput,
  outputSchema: GithubGetPullRequestChecksOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const context = yield* resolveGithubContext(integration)

      const pullResponse = yield* githubRepoRequest(context, {
        method: 'GET',
        path: `/pulls/${encodeURIComponent(input.pullNumber)}`
      })

      if (!isGithubSuccess(pullResponse.status)) {
        return yield* githubFailure(pullResponse, { operation: 'get pull request' })
      }

      const pullRequest = yield* decodeJsonResponse(GithubWirePullRequest, pullResponse)
      const headSha = pullRequest.head?.sha

      if (headSha === undefined || headSha === '') {
        return yield* validationFailure(
          integration,
          'github.get_pull_request_checks',
          'Pull request has no head commit sha'
        )
      }

      const checkRunsResponse = yield* githubRepoRequest(context, {
        method: 'GET',
        path: `/commits/${encodeURIComponent(headSha)}/check-runs`,
        query: githubPaginationQuery(input)
      })

      if (!isGithubSuccess(checkRunsResponse.status)) {
        return yield* githubFailure(checkRunsResponse, {
          operation: 'list pull request check runs'
        })
      }

      const checkRuns = yield* decodeJsonResponse(GithubWireCheckRuns, checkRunsResponse)

      const statusResponse = yield* githubRepoRequest(context, {
        method: 'GET',
        path: `/commits/${encodeURIComponent(headSha)}/status`,
        query: githubPaginationQuery(input)
      })

      if (!isGithubSuccess(statusResponse.status)) {
        return yield* githubFailure(statusResponse, {
          operation: 'get pull request commit status'
        })
      }

      const combined = yield* decodeJsonResponse(GithubWireCombinedStatus, statusResponse)

      return ActionResult.success({
        headSha,
        checkRuns: checkRuns.check_runs.map(run => ({
          id: run.id,
          name: run.name,
          status: run.status,
          conclusion: run.conclusion ?? null,
          url: run.html_url ?? run.details_url ?? null,
          app: run.app?.slug ?? null,
          startedAt: run.started_at ?? null,
          completedAt: run.completed_at ?? null
        })),
        checkRunsTotal: checkRuns.total_count,
        checkRunsHasNextPage: githubHasNextPage(checkRunsResponse.headers),
        combinedStatus: {
          state: combined.state,
          total: combined.total_count ?? combined.statuses.length,
          statuses: combined.statuses.map(status => ({
            context: status.context,
            state: status.state,
            description: status.description ?? null,
            url: status.target_url ?? null
          }))
        },
        combinedStatusHasNextPage: githubHasNextPage(statusResponse.headers)
      })
    })
})

// ---------------------------------------------------------------------------
// list_pull_request_reviews
// ---------------------------------------------------------------------------

const GithubWirePullRequestReview = Schema.Struct({
  id: Schema.Number,
  user: Schema.optional(Schema.NullOr(GithubWireUser)),
  state: Schema.String,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  commit_id: Schema.optional(Schema.NullOr(Schema.String)),
  submitted_at: Schema.optional(Schema.NullOr(Schema.String)),
  html_url: Schema.String
})

export const GithubPullRequestReview = Schema.Struct({
  id: Schema.Number,
  author: Schema.NullOr(Schema.String),
  state: Schema.String,
  body: Schema.NullOr(Schema.String),
  bodyTruncated: Schema.Boolean,
  commitId: Schema.NullOr(Schema.String),
  submittedAt: Schema.NullOr(Schema.String),
  url: Schema.String
})

export const GithubListPullRequestReviewsInput = Schema.Struct({
  ...githubPaginationFields,
  pullNumber: GithubIssueNumber
})

export const GithubListPullRequestReviewsOutput = Schema.Struct({
  reviews: Schema.Array(GithubPullRequestReview),
  hasNextPage: Schema.Boolean
})

export const githubListPullRequestReviewsAction = defineAction({
  id: 'github.list_pull_request_reviews',
  description: 'List the reviews on a pull request.',
  access: 'read',
  inputSchema: GithubListPullRequestReviewsInput,
  outputSchema: GithubListPullRequestReviewsOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const context = yield* resolveGithubContext(integration)

      const response = yield* githubRepoRequest(context, {
        method: 'GET',
        path: `/pulls/${encodeURIComponent(input.pullNumber)}/reviews`,
        query: githubPaginationQuery(input)
      })

      if (!isGithubSuccess(response.status)) {
        return yield* githubFailure(response, { operation: 'list pull request reviews' })
      }

      const reviews = yield* decodeJsonResponse(Schema.Array(GithubWirePullRequestReview), response)

      return ActionResult.success({
        reviews: reviews.map(review => {
          const body =
            review.body === undefined || review.body === null
              ? { text: null, truncated: false }
              : truncateGithubText(review.body, githubListBodyMaxChars)

          return {
            id: review.id,
            author: githubLogin(review.user),
            state: review.state,
            body: body.text,
            bodyTruncated: body.truncated,
            commitId: review.commit_id ?? null,
            submittedAt: review.submitted_at ?? null,
            url: review.html_url
          }
        }),
        hasNextPage: githubHasNextPage(response.headers)
      })
    })
})

// ---------------------------------------------------------------------------
// list_pull_request_review_comments
// ---------------------------------------------------------------------------

const GithubWirePullRequestReviewComment = Schema.Struct({
  id: Schema.Number,
  user: Schema.optional(Schema.NullOr(GithubWireUser)),
  body: Schema.String,
  path: Schema.String,
  line: Schema.optional(Schema.NullOr(Schema.Number)),
  start_line: Schema.optional(Schema.NullOr(Schema.Number)),
  side: Schema.optional(Schema.NullOr(Schema.String)),
  in_reply_to_id: Schema.optional(Schema.NullOr(Schema.Number)),
  commit_id: Schema.String,
  html_url: Schema.String,
  created_at: Schema.String,
  updated_at: Schema.String
})

export type GithubWirePullRequestReviewComment = typeof GithubWirePullRequestReviewComment.Type

export const GithubPullRequestReviewComment = Schema.Struct({
  id: Schema.Number,
  author: Schema.NullOr(Schema.String),
  body: Schema.String,
  bodyTruncated: Schema.Boolean,
  path: Schema.String,
  line: Schema.NullOr(Schema.Number),
  startLine: Schema.NullOr(Schema.Number),
  side: Schema.NullOr(Schema.String),
  inReplyToId: Schema.NullOr(Schema.Number),
  commitId: Schema.String,
  url: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String
})

export type GithubPullRequestReviewComment = typeof GithubPullRequestReviewComment.Type

export const normalizeGithubPullRequestReviewComment = (
  comment: GithubWirePullRequestReviewComment
): GithubPullRequestReviewComment => {
  const body = truncateGithubText(comment.body, githubPullRequestCommentMaxChars)

  return {
    id: comment.id,
    author: githubLogin(comment.user),
    body: body.text,
    bodyTruncated: body.truncated,
    path: comment.path,
    line: comment.line ?? null,
    startLine: comment.start_line ?? null,
    side: comment.side ?? null,
    inReplyToId: comment.in_reply_to_id ?? null,
    commitId: comment.commit_id,
    url: comment.html_url,
    createdAt: comment.created_at,
    updatedAt: comment.updated_at
  }
}

export const GithubListPullRequestReviewCommentsInput = Schema.Struct({
  ...githubPaginationFields,
  pullNumber: GithubIssueNumber
})

export const GithubListPullRequestReviewCommentsOutput = Schema.Struct({
  comments: Schema.Array(GithubPullRequestReviewComment),
  hasNextPage: Schema.Boolean
})

export const githubListPullRequestReviewCommentsAction = defineAction({
  id: 'github.list_pull_request_review_comments',
  description: 'List the inline review comments on a pull request.',
  access: 'read',
  inputSchema: GithubListPullRequestReviewCommentsInput,
  outputSchema: GithubListPullRequestReviewCommentsOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const context = yield* resolveGithubContext(integration)

      const response = yield* githubRepoRequest(context, {
        method: 'GET',
        path: `/pulls/${encodeURIComponent(input.pullNumber)}/comments`,
        query: githubPaginationQuery(input)
      })

      if (!isGithubSuccess(response.status)) {
        return yield* githubFailure(response, { operation: 'list pull request review comments' })
      }

      const comments = yield* decodeJsonResponse(
        Schema.Array(GithubWirePullRequestReviewComment),
        response
      )

      return ActionResult.success({
        comments: comments.map(normalizeGithubPullRequestReviewComment),
        hasNextPage: githubHasNextPage(response.headers)
      })
    })
})

// ---------------------------------------------------------------------------
// create_pull_request
// ---------------------------------------------------------------------------

export const GithubCreatePullRequestInput = Schema.Struct({
  title: NonEmptyString,
  head: NonEmptyString,
  base: NonEmptyString,
  body: Schema.optional(Schema.String),
  draft: Schema.optional(Schema.Boolean),
  maintainerCanModify: Schema.optional(Schema.Boolean)
})

export const githubCreatePullRequestAction = defineAction({
  id: 'github.create_pull_request',
  description: 'Create a pull request from an existing head branch into a base branch.',
  access: 'write',
  inputSchema: GithubCreatePullRequestInput,
  outputSchema: GithubPullRequest,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const context = yield* resolveGithubContext(integration)

      const response = yield* githubRepoRequest(context, {
        method: 'POST',
        path: '/pulls',
        body: {
          title: input.title,
          head: input.head,
          base: input.base,
          body: input.body,
          draft: input.draft,
          maintainer_can_modify: input.maintainerCanModify
        }
      })

      if (!isGithubSuccess(response.status)) {
        return yield* githubFailure(response, { operation: 'create pull request' })
      }

      const pullRequest = yield* decodeJsonResponse(GithubWirePullRequest, response)

      return ActionResult.success(normalizeGithubPullRequest(pullRequest))
    })
})

// ---------------------------------------------------------------------------
// update_pull_request
// ---------------------------------------------------------------------------

export const GithubUpdatePullRequestInput = Schema.Struct({
  pullNumber: GithubIssueNumber,
  title: Schema.optional(NonEmptyString),
  body: Schema.optional(Schema.String),
  base: Schema.optional(NonEmptyString),
  state: Schema.optional(Schema.Literals(['open', 'closed'])),
  maintainerCanModify: Schema.optional(Schema.Boolean)
})

export const githubUpdatePullRequestAction = defineAction({
  id: 'github.update_pull_request',
  description: 'Update a pull request title, body, base branch, state, or maintainer access.',
  access: 'write',
  inputSchema: GithubUpdatePullRequestInput,
  outputSchema: GithubPullRequest,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      if (
        input.title === undefined &&
        input.body === undefined &&
        input.base === undefined &&
        input.state === undefined &&
        input.maintainerCanModify === undefined
      ) {
        return yield* validationFailure(
          integration,
          'github.update_pull_request',
          'Update pull request requires at least one change'
        )
      }

      const context = yield* resolveGithubContext(integration)

      const response = yield* githubRepoRequest(context, {
        method: 'PATCH',
        path: `/pulls/${encodeURIComponent(input.pullNumber)}`,
        body: {
          title: input.title,
          body: input.body,
          base: input.base,
          state: input.state,
          maintainer_can_modify: input.maintainerCanModify
        }
      })

      if (!isGithubSuccess(response.status)) {
        return yield* githubFailure(response, { operation: 'update pull request' })
      }

      const pullRequest = yield* decodeJsonResponse(GithubWirePullRequest, response)

      return ActionResult.success(normalizeGithubPullRequest(pullRequest))
    })
})

// ---------------------------------------------------------------------------
// request_reviewers
// ---------------------------------------------------------------------------

const GithubReviewerLogin = NonEmptyString

export const GithubRequestReviewersInput = Schema.Struct({
  pullNumber: GithubIssueNumber,
  reviewers: Schema.optional(
    Schema.Array(GithubReviewerLogin).pipe(Schema.check(Schema.isMinLength(1)))
  ),
  teamReviewers: Schema.optional(
    Schema.Array(GithubReviewerLogin).pipe(Schema.check(Schema.isMinLength(1)))
  )
})

export const githubRequestReviewersAction = defineAction({
  id: 'github.request_reviewers',
  description: 'Request reviewers and team reviewers for a pull request.',
  access: 'write',
  inputSchema: GithubRequestReviewersInput,
  outputSchema: GithubPullRequest,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const reviewers = input.reviewers ?? []
      const teamReviewers = input.teamReviewers ?? []

      if (reviewers.length === 0 && teamReviewers.length === 0) {
        return yield* validationFailure(
          integration,
          'github.request_reviewers',
          'Request reviewers requires at least one reviewer or team reviewer'
        )
      }

      const context = yield* resolveGithubContext(integration)

      const response = yield* githubRepoRequest(context, {
        method: 'POST',
        path: `/pulls/${encodeURIComponent(input.pullNumber)}/requested_reviewers`,
        body: {
          reviewers: input.reviewers,
          team_reviewers: input.teamReviewers
        }
      })

      if (!isGithubSuccess(response.status)) {
        return yield* githubFailure(response, { operation: 'request pull request reviewers' })
      }

      const pullRequest = yield* decodeJsonResponse(GithubWirePullRequest, response)

      return ActionResult.success(normalizeGithubPullRequest(pullRequest))
    })
})

// ---------------------------------------------------------------------------
// create_pull_request_review
// ---------------------------------------------------------------------------

const GithubPullRequestReviewCommentDraft = Schema.Struct({
  path: NonEmptyString,
  body: NonEmptyString,
  line: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1))),
  side: Schema.optional(Schema.Literals(['LEFT', 'RIGHT'])),
  startLine: Schema.optional(Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1)))),
  startSide: Schema.optional(Schema.Literals(['LEFT', 'RIGHT']))
})

export const GithubCreatePullRequestReviewInput = Schema.Struct({
  pullNumber: GithubIssueNumber,
  event: Schema.Literals(['COMMENT', 'APPROVE', 'REQUEST_CHANGES']),
  body: Schema.optional(Schema.String),
  commitId: Schema.optional(NonEmptyString),
  comments: Schema.optional(Schema.Array(GithubPullRequestReviewCommentDraft))
})

export const GithubPullRequestReviewResult = Schema.Struct({
  id: Schema.Number,
  state: Schema.String,
  author: Schema.NullOr(Schema.String),
  body: Schema.NullOr(Schema.String),
  bodyTruncated: Schema.Boolean,
  commitId: Schema.NullOr(Schema.String),
  submittedAt: Schema.NullOr(Schema.String),
  url: Schema.String
})

export const githubCreatePullRequestReviewAction = defineAction({
  id: 'github.create_pull_request_review',
  description: 'Submit a pull request review with an optional body and inline comments.',
  access: 'write',
  inputSchema: GithubCreatePullRequestReviewInput,
  outputSchema: GithubPullRequestReviewResult,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      if (
        (input.event === 'COMMENT' || input.event === 'REQUEST_CHANGES') &&
        (input.body === undefined || input.body.trim() === '')
      ) {
        return yield* validationFailure(
          integration,
          'github.create_pull_request_review',
          `Create pull request review requires a body for event ${input.event}`
        )
      }

      const context = yield* resolveGithubContext(integration)

      const response = yield* githubRepoRequest(context, {
        method: 'POST',
        path: `/pulls/${encodeURIComponent(input.pullNumber)}/reviews`,
        body: {
          event: input.event,
          body: input.body,
          commit_id: input.commitId,
          comments: input.comments?.map(comment => ({
            path: comment.path,
            body: comment.body,
            line: comment.line,
            side: comment.side,
            start_line: comment.startLine,
            start_side: comment.startSide
          }))
        }
      })

      if (!isGithubSuccess(response.status)) {
        return yield* githubFailure(response, { operation: 'create pull request review' })
      }

      const review = yield* decodeJsonResponse(GithubWirePullRequestReview, response)

      const body =
        review.body === undefined || review.body === null
          ? { text: null, truncated: false }
          : truncateGithubText(review.body, githubBodyMaxChars)

      return ActionResult.success({
        id: review.id,
        state: review.state,
        author: githubLogin(review.user),
        body: body.text,
        bodyTruncated: body.truncated,
        commitId: review.commit_id ?? null,
        submittedAt: review.submitted_at ?? null,
        url: review.html_url
      })
    })
})

// ---------------------------------------------------------------------------
// create_pull_request_review_comment
// ---------------------------------------------------------------------------

export const GithubCreatePullRequestReviewCommentInput = Schema.Struct({
  pullNumber: GithubIssueNumber,
  body: NonEmptyString,
  inReplyTo: Schema.optional(GithubCommentId),
  path: Schema.optional(NonEmptyString),
  line: Schema.optional(Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1)))),
  side: Schema.optional(Schema.Literals(['LEFT', 'RIGHT'])),
  startLine: Schema.optional(Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1)))),
  startSide: Schema.optional(Schema.Literals(['LEFT', 'RIGHT'])),
  commitId: Schema.optional(NonEmptyString)
})

const postInlineReviewComment = (
  context: GithubRequestContext,
  input: typeof GithubCreatePullRequestReviewCommentInput.Type,
  position: { readonly path: string; readonly line: number },
  commitId: string
) =>
  Effect.gen(function* () {
    const response = yield* githubRepoRequest(context, {
      method: 'POST',
      path: `/pulls/${encodeURIComponent(input.pullNumber)}/comments`,
      body: {
        body: input.body,
        commit_id: commitId,
        path: position.path,
        line: position.line,
        side: input.side,
        start_line: input.startLine,
        start_side: input.startSide
      }
    })

    if (!isGithubSuccess(response.status)) {
      return yield* githubFailure(response, { operation: 'create pull request review comment' })
    }

    const comment = yield* decodeJsonResponse(GithubWirePullRequestReviewComment, response)

    return ActionResult.success(normalizeGithubPullRequestReviewComment(comment))
  })

export const githubCreatePullRequestReviewCommentAction = defineAction({
  id: 'github.create_pull_request_review_comment',
  description:
    'Create an inline pull request review comment, or reply to one with inReplyTo. ' +
    'Inline comments need path and line; commitId defaults to the pull request head sha.',
  access: 'write',
  inputSchema: GithubCreatePullRequestReviewCommentInput,
  outputSchema: GithubPullRequestReviewComment,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      if (input.inReplyTo !== undefined) {
        if (
          input.path !== undefined ||
          input.line !== undefined ||
          input.side !== undefined ||
          input.startLine !== undefined ||
          input.startSide !== undefined ||
          input.commitId !== undefined
        ) {
          return yield* validationFailure(
            integration,
            'github.create_pull_request_review_comment',
            'Reply comments take only inReplyTo and body, not inline position fields'
          )
        }

        const context = yield* resolveGithubContext(integration)

        const response = yield* githubRepoRequest(context, {
          method: 'POST',
          path: `/pulls/${encodeURIComponent(input.pullNumber)}/comments/${encodeURIComponent(input.inReplyTo)}/replies`,
          body: { body: input.body }
        })

        if (!isGithubSuccess(response.status)) {
          return yield* githubFailure(response, {
            operation: 'reply to pull request review comment'
          })
        }

        const comment = yield* decodeJsonResponse(GithubWirePullRequestReviewComment, response)

        return ActionResult.success(normalizeGithubPullRequestReviewComment(comment))
      }

      if (input.path === undefined || input.line === undefined) {
        return yield* validationFailure(
          integration,
          'github.create_pull_request_review_comment',
          'Inline review comments require path and line, or inReplyTo for a reply'
        )
      }

      const context = yield* resolveGithubContext(integration)

      const position = { path: input.path, line: input.line }

      if (input.commitId !== undefined) {
        return yield* postInlineReviewComment(context, input, position, input.commitId)
      }

      // Default to the head sha; a failed lookup returns its own failure and never POSTs.
      const pullResponse = yield* githubRepoRequest(context, {
        method: 'GET',
        path: `/pulls/${encodeURIComponent(input.pullNumber)}`
      })

      if (!isGithubSuccess(pullResponse.status)) {
        return yield* githubFailure(pullResponse, { operation: 'get pull request' })
      }

      const pullRequest = yield* decodeJsonResponse(GithubWirePullRequest, pullResponse)

      const headSha = pullRequest.head?.sha

      if (headSha === undefined || headSha === '') {
        return yield* validationFailure(
          integration,
          'github.create_pull_request_review_comment',
          'Pull request has no head commit sha'
        )
      }

      return yield* postInlineReviewComment(context, input, position, headSha)
    })
})

// ---------------------------------------------------------------------------
// merge_pull_request
// ---------------------------------------------------------------------------

export const GithubMergePullRequestInput = Schema.Struct({
  pullNumber: GithubIssueNumber,
  expectedHeadSha: GithubCommitSha,
  method: Schema.Literals(['merge', 'squash', 'rebase']),
  commitTitle: Schema.optional(Schema.String),
  commitMessage: Schema.optional(Schema.String)
})

const GithubWireMergeResult = Schema.Struct({
  sha: Schema.String,
  merged: Schema.Boolean,
  message: Schema.String
})

export const GithubMergePullRequestOutput = Schema.Struct({
  merged: Schema.Boolean,
  sha: Schema.String,
  message: Schema.String
})

export const githubMergePullRequestAction = defineAction({
  id: 'github.merge_pull_request',
  description: 'Merge a pull request after verifying the head sha matches expectedHeadSha.',
  access: 'destructive',
  inputSchema: GithubMergePullRequestInput,
  outputSchema: GithubMergePullRequestOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const context = yield* resolveGithubContext(integration)

      const response = yield* githubRepoRequest(context, {
        method: 'PUT',
        path: `/pulls/${encodeURIComponent(input.pullNumber)}/merge`,
        body: {
          sha: input.expectedHeadSha,
          merge_method: input.method,
          commit_title: input.commitTitle,
          commit_message: input.commitMessage
        }
      })

      if (!isGithubSuccess(response.status)) {
        return yield* githubFailure(response, {
          operation: 'merge pull request',
          codes: { 405: 'github_not_mergeable' }
        })
      }

      const result = yield* decodeJsonResponse(GithubWireMergeResult, response)

      return ActionResult.success({
        merged: result.merged,
        sha: result.sha,
        message: result.message
      })
    })
})

export const githubPullRequestActions = [
  githubListPullRequestsAction,
  githubGetPullRequestAction,
  githubListPullRequestFilesAction,
  githubListPullRequestCommitsAction,
  githubGetPullRequestChecksAction,
  githubListPullRequestReviewsAction,
  githubListPullRequestReviewCommentsAction,
  githubCreatePullRequestAction,
  githubUpdatePullRequestAction,
  githubRequestReviewersAction,
  githubCreatePullRequestReviewAction,
  githubCreatePullRequestReviewCommentAction,
  githubMergePullRequestAction
]
