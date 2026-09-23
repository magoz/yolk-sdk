import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { defineAction } from '../action.ts'
import { ConnectorError } from '../error.ts'
import { decodeJsonResponse } from '../http.ts'
import { ActionResult } from '../result.ts'
import type { ConnectorIntegration } from '../integration.ts'
import {
  GithubIssueNumber,
  GithubWireUser,
  githubBodyMaxChars,
  githubFailure,
  githubHasNextPage,
  githubLogin,
  githubPaginationFields,
  githubPaginationQuery,
  githubRepoRequest,
  isGithubSuccess,
  resolveGithubContext,
  truncateGithubText
} from './shared.ts'

/** Per-comment body cap: list cap is too small, the full cap too large for 100 items. */
export const githubCommentBodyMaxChars = 4_000

const GithubNonEmptyString = Schema.String.pipe(Schema.check(Schema.isMinLength(1)))

const GithubCommentId = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1)))

const GithubWireComment = Schema.Struct({
  id: Schema.Number,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  user: Schema.optional(Schema.NullOr(GithubWireUser)),
  html_url: Schema.String,
  created_at: Schema.String,
  updated_at: Schema.String
})

export const GithubComment = Schema.Struct({
  id: Schema.Number,
  author: Schema.NullOr(Schema.String),
  body: Schema.String,
  bodyTruncated: Schema.Boolean,
  url: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String
})

export type GithubComment = typeof GithubComment.Type

const normalizeGithubComment = (
  comment: typeof GithubWireComment.Type,
  maxChars: number
): GithubComment => {
  const cut = truncateGithubText(comment.body ?? '', maxChars)

  return {
    id: comment.id,
    author: githubLogin(comment.user),
    body: cut.text,
    bodyTruncated: cut.truncated,
    url: comment.html_url,
    createdAt: comment.created_at,
    updatedAt: comment.updated_at
  }
}

export const GithubListIssueCommentsInput = Schema.Struct({
  issueNumber: GithubIssueNumber,
  since: Schema.optional(Schema.String.pipe(Schema.check(Schema.isMinLength(1)))),
  ...githubPaginationFields
})

export const GithubListIssueCommentsOutput = Schema.Struct({
  comments: Schema.Array(GithubComment),
  hasNextPage: Schema.Boolean
})

export const githubListIssueCommentsAction = defineAction({
  id: 'github.list_issue_comments',
  description: 'List comments on a GitHub issue (also works for pull request conversation).',
  access: 'read',
  inputSchema: GithubListIssueCommentsInput,
  outputSchema: GithubListIssueCommentsOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const context = yield* resolveGithubContext(integration)

      const response = yield* githubRepoRequest(context, {
        method: 'GET',
        path: `/issues/${encodeURIComponent(String(input.issueNumber))}/comments`,
        query: { ...githubPaginationQuery(input), since: input.since }
      })

      if (!isGithubSuccess(response.status)) {
        return yield* githubFailure(response, { operation: 'list issue comments' })
      }

      const wire = yield* decodeJsonResponse(Schema.Array(GithubWireComment), response)

      return ActionResult.success({
        comments: wire.map(comment => normalizeGithubComment(comment, githubCommentBodyMaxChars)),
        hasNextPage: githubHasNextPage(response.headers)
      })
    })
})

export const GithubCreateIssueCommentInput = Schema.Struct({
  issueNumber: GithubIssueNumber,
  body: GithubNonEmptyString
})

export const githubCreateIssueCommentAction = defineAction({
  id: 'github.create_issue_comment',
  description: 'Create a comment on a GitHub issue.',
  access: 'write',
  inputSchema: GithubCreateIssueCommentInput,
  outputSchema: GithubComment,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const context = yield* resolveGithubContext(integration)

      const response = yield* githubRepoRequest(context, {
        method: 'POST',
        path: `/issues/${encodeURIComponent(String(input.issueNumber))}/comments`,
        body: { body: input.body }
      })

      if (!isGithubSuccess(response.status)) {
        return yield* githubFailure(response, { operation: 'create issue comment' })
      }

      const wire = yield* decodeJsonResponse(GithubWireComment, response)

      return ActionResult.success(normalizeGithubComment(wire, githubBodyMaxChars))
    })
})

export const GithubUpdateIssueCommentInput = Schema.Struct({
  commentId: GithubCommentId,
  body: GithubNonEmptyString
})

export const githubUpdateIssueCommentAction = defineAction({
  id: 'github.update_issue_comment',
  description: 'Update a GitHub issue comment.',
  access: 'write',
  inputSchema: GithubUpdateIssueCommentInput,
  outputSchema: GithubComment,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const context = yield* resolveGithubContext(integration)

      const response = yield* githubRepoRequest(context, {
        method: 'PATCH',
        path: `/issues/comments/${encodeURIComponent(String(input.commentId))}`,
        body: { body: input.body }
      })

      if (!isGithubSuccess(response.status)) {
        return yield* githubFailure(response, { operation: 'update issue comment' })
      }

      const wire = yield* decodeJsonResponse(GithubWireComment, response)

      return ActionResult.success(normalizeGithubComment(wire, githubBodyMaxChars))
    })
})

export const GithubDeleteIssueCommentInput = Schema.Struct({
  commentId: GithubCommentId
})

export const GithubDeleteIssueCommentOutput = Schema.Struct({
  commentId: Schema.Number,
  deleted: Schema.Boolean
})

export const githubDeleteIssueCommentAction = defineAction({
  id: 'github.delete_issue_comment',
  description: 'Delete a GitHub issue comment.',
  access: 'destructive',
  inputSchema: GithubDeleteIssueCommentInput,
  outputSchema: GithubDeleteIssueCommentOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const context = yield* resolveGithubContext(integration)

      const response = yield* githubRepoRequest(context, {
        method: 'DELETE',
        path: `/issues/comments/${encodeURIComponent(String(input.commentId))}`
      })

      if (!isGithubSuccess(response.status)) {
        return yield* githubFailure(response, { operation: 'delete issue comment' })
      }

      return ActionResult.success({ commentId: input.commentId, deleted: true })
    })
})

export const GithubListLabelsInput = Schema.Struct({
  ...githubPaginationFields
})

const GithubWireLabel = Schema.Struct({
  name: Schema.String,
  color: Schema.String,
  description: Schema.optional(Schema.NullOr(Schema.String))
})

export const GithubLabel = Schema.Struct({
  name: Schema.String,
  color: Schema.String,
  description: Schema.NullOr(Schema.String)
})

export type GithubLabel = typeof GithubLabel.Type

export const GithubListLabelsOutput = Schema.Struct({
  labels: Schema.Array(GithubLabel),
  hasNextPage: Schema.Boolean
})

export const githubListLabelsAction = defineAction({
  id: 'github.list_labels',
  description: 'List labels of the configured GitHub repository.',
  access: 'read',
  inputSchema: GithubListLabelsInput,
  outputSchema: GithubListLabelsOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const context = yield* resolveGithubContext(integration)

      const response = yield* githubRepoRequest(context, {
        method: 'GET',
        path: '/labels',
        query: githubPaginationQuery(input)
      })

      if (!isGithubSuccess(response.status)) {
        return yield* githubFailure(response, { operation: 'list labels' })
      }

      const wire = yield* decodeJsonResponse(Schema.Array(GithubWireLabel), response)

      return ActionResult.success({
        labels: wire.map(label => ({
          name: label.name,
          color: label.color,
          description: label.description ?? null
        })),
        hasNextPage: githubHasNextPage(response.headers)
      })
    })
})

const GithubLabelNames = Schema.Array(GithubNonEmptyString).pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(100))
)

const GithubWireLabelName = Schema.Struct({
  name: Schema.String
})

export const GithubAddLabelsInput = Schema.Struct({
  issueNumber: GithubIssueNumber,
  labels: GithubLabelNames
})

export const GithubIssueLabelsOutput = Schema.Struct({
  issueNumber: Schema.Number,
  labels: Schema.Array(Schema.String)
})

export const githubAddLabelsAction = defineAction({
  id: 'github.add_labels',
  description: 'Add labels to a GitHub issue.',
  access: 'write',
  inputSchema: GithubAddLabelsInput,
  outputSchema: GithubIssueLabelsOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const context = yield* resolveGithubContext(integration)

      const response = yield* githubRepoRequest(context, {
        method: 'POST',
        path: `/issues/${encodeURIComponent(String(input.issueNumber))}/labels`,
        body: { labels: input.labels }
      })

      if (!isGithubSuccess(response.status)) {
        return yield* githubFailure(response, { operation: 'add labels' })
      }

      const wire = yield* decodeJsonResponse(Schema.Array(GithubWireLabelName), response)

      return ActionResult.success({
        issueNumber: input.issueNumber,
        labels: wire.map(label => label.name)
      })
    })
})

export const GithubRemoveLabelInput = Schema.Struct({
  issueNumber: GithubIssueNumber,
  label: GithubNonEmptyString
})

export const githubRemoveLabelAction = defineAction({
  id: 'github.remove_label',
  description: 'Remove a label from a GitHub issue.',
  access: 'write',
  inputSchema: GithubRemoveLabelInput,
  outputSchema: GithubIssueLabelsOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const context = yield* resolveGithubContext(integration)

      const response = yield* githubRepoRequest(context, {
        method: 'DELETE',
        path: `/issues/${encodeURIComponent(String(input.issueNumber))}/labels/${encodeURIComponent(input.label)}`
      })

      if (!isGithubSuccess(response.status)) {
        return yield* githubFailure(response, { operation: 'remove label' })
      }

      const wire = yield* decodeJsonResponse(Schema.Array(GithubWireLabelName), response)

      return ActionResult.success({
        issueNumber: input.issueNumber,
        labels: wire.map(label => label.name)
      })
    })
})

export const GithubListMilestonesInput = Schema.Struct({
  state: Schema.optional(Schema.Literals(['open', 'closed', 'all'])),
  sort: Schema.optional(Schema.Literals(['due_on', 'completeness'])),
  direction: Schema.optional(Schema.Literals(['asc', 'desc'])),
  ...githubPaginationFields
})

const GithubWireMilestone = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  state: Schema.String,
  description: Schema.optional(Schema.NullOr(Schema.String)),
  due_on: Schema.optional(Schema.NullOr(Schema.String)),
  open_issues: Schema.Number,
  closed_issues: Schema.Number,
  html_url: Schema.String
})

export const GithubMilestone = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  state: Schema.String,
  description: Schema.NullOr(Schema.String),
  dueOn: Schema.NullOr(Schema.String),
  openIssues: Schema.Number,
  closedIssues: Schema.Number,
  url: Schema.String
})

export type GithubMilestone = typeof GithubMilestone.Type

export const GithubListMilestonesOutput = Schema.Struct({
  milestones: Schema.Array(GithubMilestone),
  hasNextPage: Schema.Boolean
})

export const githubListMilestonesAction = defineAction({
  id: 'github.list_milestones',
  description: 'List milestones of the configured GitHub repository.',
  access: 'read',
  inputSchema: GithubListMilestonesInput,
  outputSchema: GithubListMilestonesOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const context = yield* resolveGithubContext(integration)

      const response = yield* githubRepoRequest(context, {
        method: 'GET',
        path: '/milestones',
        query: {
          state: input.state,
          sort: input.sort,
          direction: input.direction,
          ...githubPaginationQuery(input)
        }
      })

      if (!isGithubSuccess(response.status)) {
        return yield* githubFailure(response, { operation: 'list milestones' })
      }

      const wire = yield* decodeJsonResponse(Schema.Array(GithubWireMilestone), response)

      return ActionResult.success({
        milestones: wire.map(milestone => ({
          number: milestone.number,
          title: milestone.title,
          state: milestone.state,
          description: milestone.description ?? null,
          dueOn: milestone.due_on ?? null,
          openIssues: milestone.open_issues,
          closedIssues: milestone.closed_issues,
          url: milestone.html_url
        })),
        hasNextPage: githubHasNextPage(response.headers)
      })
    })
})

export const GithubReactionContent = Schema.Literals([
  '+1',
  '-1',
  'laugh',
  'confused',
  'heart',
  'hooray',
  'rocket',
  'eyes'
])

export const GithubCreateReactionInput = Schema.Struct({
  content: GithubReactionContent,
  issueNumber: Schema.optional(GithubIssueNumber),
  commentId: Schema.optional(GithubCommentId)
})

const GithubWireReaction = Schema.Struct({
  id: Schema.Number,
  content: Schema.String,
  user: Schema.optional(Schema.NullOr(GithubWireUser))
})

export const GithubReaction = Schema.Struct({
  id: Schema.Number,
  content: Schema.String,
  author: Schema.NullOr(Schema.String)
})

export type GithubReaction = typeof GithubReaction.Type

const reactionTargetError = (integration: ConnectorIntegration) =>
  new ConnectorError({
    cause: 'validation_failed',
    message: 'Reaction requires exactly one of issueNumber or commentId',
    connectorId: integration.connectorId,
    actionId: 'github.create_reaction'
  })

export const githubCreateReactionAction = defineAction({
  id: 'github.create_reaction',
  description: 'Create a reaction on a GitHub issue or issue comment.',
  access: 'write',
  inputSchema: GithubCreateReactionInput,
  outputSchema: GithubReaction,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      if (input.issueNumber !== undefined && input.commentId !== undefined) {
        return yield* Effect.fail(reactionTargetError(integration))
      }

      const context = yield* resolveGithubContext(integration)

      if (input.commentId !== undefined) {
        const response = yield* githubRepoRequest(context, {
          method: 'POST',
          path: `/issues/comments/${encodeURIComponent(String(input.commentId))}/reactions`,
          body: { content: input.content }
        })

        if (!isGithubSuccess(response.status)) {
          return yield* githubFailure(response, { operation: 'create reaction' })
        }

        const wire = yield* decodeJsonResponse(GithubWireReaction, response)

        return ActionResult.success({
          id: wire.id,
          content: wire.content,
          author: githubLogin(wire.user)
        })
      }

      if (input.issueNumber !== undefined) {
        const response = yield* githubRepoRequest(context, {
          method: 'POST',
          path: `/issues/${encodeURIComponent(String(input.issueNumber))}/reactions`,
          body: { content: input.content }
        })

        if (!isGithubSuccess(response.status)) {
          return yield* githubFailure(response, { operation: 'create reaction' })
        }

        const wire = yield* decodeJsonResponse(GithubWireReaction, response)

        return ActionResult.success({
          id: wire.id,
          content: wire.content,
          author: githubLogin(wire.user)
        })
      }

      return yield* Effect.fail(reactionTargetError(integration))
    })
})

export const githubCommentActions = [
  githubListIssueCommentsAction,
  githubCreateIssueCommentAction,
  githubUpdateIssueCommentAction,
  githubDeleteIssueCommentAction,
  githubListLabelsAction,
  githubAddLabelsAction,
  githubRemoveLabelAction,
  githubListMilestonesAction,
  githubCreateReactionAction
]
