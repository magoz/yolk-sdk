import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { defineAction } from '../action.ts'
import { ConnectorError } from '../error.ts'
import { decodeJsonResponse } from '../http.ts'
import { ActionResult } from '../result.ts'
import type { ConnectorIntegration } from '../integration.ts'
import {
  GithubIssue,
  GithubIssueNumber,
  GithubWireIssue,
  githubApiBaseUrl,
  githubFailure,
  githubHasNextPage,
  githubListBodyMaxChars,
  githubPaginationFields,
  githubPaginationQuery,
  githubRepoRequest,
  githubRequest,
  githubHasScopeQualifier,
  isGithubSuccess,
  normalizeGithubIssue,
  resolveGithubContext,
  truncateGithubText
} from './shared.ts'
import type { GithubRequestContext } from './shared.ts'

const GithubNonEmptyString = Schema.Trimmed.pipe(Schema.check(Schema.isNonEmpty()))

const hasNoScopeQualifier = (value: string): value is string => !githubHasScopeQualifier(value)

const GithubIssueSearchQuery = GithubNonEmptyString.pipe(
  Schema.refine(hasNoScopeQualifier, {
    message:
      'Search query must not include repo:, org:, user:, or owner: qualifiers; search is scoped to the configured repository'
  })
)

const GithubLabelList = Schema.Array(GithubNonEmptyString).pipe(Schema.check(Schema.isMinLength(1)))

const GithubAssigneeList = Schema.Array(GithubNonEmptyString).pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(10))
)

const failUpdateValidation = (integration: ConnectorIntegration, message: string) =>
  Effect.fail(
    new ConnectorError({
      cause: 'validation_failed',
      message,
      connectorId: integration.connectorId,
      actionId: 'github.update_issue'
    })
  )

// ---------------------------------------------------------------------------
// search_issues
// ---------------------------------------------------------------------------

export const GithubSearchIssuesInput = Schema.Struct({
  query: GithubIssueSearchQuery,
  sort: Schema.optional(Schema.Literals(['created', 'updated', 'comments'])),
  order: Schema.optional(Schema.Literals(['asc', 'desc'])),
  ...githubPaginationFields
})

export type GithubSearchIssuesInput = typeof GithubSearchIssuesInput.Type

export const GithubSearchIssuesOutput = Schema.Struct({
  totalCount: Schema.Number,
  incompleteResults: Schema.Boolean,
  items: Schema.Array(GithubIssue),
  hasNextPage: Schema.Boolean
})

export type GithubSearchIssuesOutput = typeof GithubSearchIssuesOutput.Type

const GithubSearchWireIssue = Schema.Struct({
  ...GithubWireIssue.fields,
  repository_url: Schema.optional(Schema.String)
})

const GithubSearchIssuesWire = Schema.Struct({
  total_count: Schema.Number,
  incomplete_results: Schema.Boolean,
  items: Schema.Array(GithubSearchWireIssue)
})

export const githubSearchIssuesAction = defineAction({
  id: 'github.search_issues',
  description:
    'Search issues and pull requests in the configured repository. Repo scoping is automatic; the query must not contain repo:, org:, user:, or owner: qualifiers.',
  access: 'read',
  inputSchema: GithubSearchIssuesInput,
  outputSchema: GithubSearchIssuesOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const context = yield* resolveGithubContext(integration)

      const response = yield* githubRequest(context.token, {
        method: 'GET',
        path: '/search/issues',
        query: {
          q: `repo:${context.owner}/${context.repo} ${input.query}`,
          sort: input.sort,
          order: input.order,
          ...githubPaginationQuery(input)
        }
      })

      if (!isGithubSuccess(response.status)) {
        return yield* githubFailure(response, { operation: 'search issues' })
      }

      const wire = yield* decodeJsonResponse(GithubSearchIssuesWire, response)

      const expectedRepositoryUrl =
        `${githubApiBaseUrl}/repos/${context.owner}/${context.repo}`.toLowerCase()

      const items = wire.items.flatMap(item => {
        if (item.repository_url?.toLowerCase() !== expectedRepositoryUrl) return []

        return [normalizeGithubIssue(item, githubListBodyMaxChars)]
      })

      return ActionResult.success({
        totalCount: wire.total_count,
        incompleteResults: wire.incomplete_results,
        items,
        hasNextPage: githubHasNextPage(response.headers)
      })
    })
})

// ---------------------------------------------------------------------------
// list_issues
// ---------------------------------------------------------------------------

export const GithubListIssuesInput = Schema.Struct({
  state: Schema.optional(Schema.Literals(['open', 'closed', 'all'])),
  labels: Schema.optional(GithubLabelList),
  assignee: Schema.optional(GithubNonEmptyString),
  type: Schema.optional(GithubNonEmptyString),
  since: Schema.optional(GithubNonEmptyString),
  sort: Schema.optional(Schema.Literals(['created', 'updated', 'comments'])),
  direction: Schema.optional(Schema.Literals(['asc', 'desc'])),
  ...githubPaginationFields
})

export type GithubListIssuesInput = typeof GithubListIssuesInput.Type

export const GithubListIssuesOutput = Schema.Struct({
  issues: Schema.Array(GithubIssue),
  hasNextPage: Schema.Boolean
})

export type GithubListIssuesOutput = typeof GithubListIssuesOutput.Type

export const githubListIssuesAction = defineAction({
  id: 'github.list_issues',
  description: 'List issues and pull requests in the configured repository.',
  access: 'read',
  inputSchema: GithubListIssuesInput,
  outputSchema: GithubListIssuesOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const context = yield* resolveGithubContext(integration)

      const response = yield* githubRepoRequest(context, {
        method: 'GET',
        path: '/issues',
        query: {
          ...githubPaginationQuery(input),
          state: input.state,
          labels: input.labels === undefined ? undefined : input.labels.join(','),
          assignee: input.assignee,
          type: input.type,
          since: input.since,
          sort: input.sort,
          direction: input.direction
        }
      })

      if (!isGithubSuccess(response.status)) {
        return yield* githubFailure(response, { operation: 'list issues' })
      }

      const wire = yield* decodeJsonResponse(Schema.Array(GithubWireIssue), response)

      const issues = wire.map(item => normalizeGithubIssue(item, githubListBodyMaxChars))

      return ActionResult.success({
        issues,
        hasNextPage: githubHasNextPage(response.headers)
      })
    })
})

// ---------------------------------------------------------------------------
// get_issue
// ---------------------------------------------------------------------------

export const GithubGetIssueInput = Schema.Struct({
  issueNumber: GithubIssueNumber
})

export type GithubGetIssueInput = typeof GithubGetIssueInput.Type

export const githubGetIssueAction = defineAction({
  id: 'github.get_issue',
  description: 'Get a single issue or pull request by number.',
  access: 'read',
  inputSchema: GithubGetIssueInput,
  outputSchema: GithubIssue,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const context = yield* resolveGithubContext(integration)

      const response = yield* githubRepoRequest(context, {
        method: 'GET',
        path: `/issues/${encodeURIComponent(input.issueNumber)}`
      })

      if (!isGithubSuccess(response.status)) {
        return yield* githubFailure(response, { operation: 'get issue' })
      }

      const wire = yield* decodeJsonResponse(GithubWireIssue, response)

      return ActionResult.success(normalizeGithubIssue(wire))
    })
})

// ---------------------------------------------------------------------------
// create_issue
// ---------------------------------------------------------------------------

export const GithubCreateIssueInput = Schema.Struct({
  title: GithubNonEmptyString,
  body: Schema.optional(Schema.String),
  labels: Schema.optional(GithubLabelList),
  assignees: Schema.optional(GithubAssigneeList),
  milestone: Schema.optional(GithubIssueNumber),
  type: Schema.optional(GithubNonEmptyString)
})

export type GithubCreateIssueInput = typeof GithubCreateIssueInput.Type

export const githubCreateIssueAction = defineAction({
  id: 'github.create_issue',
  description: 'Create an issue in the configured repository.',
  access: 'write',
  inputSchema: GithubCreateIssueInput,
  outputSchema: GithubIssue,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const context = yield* resolveGithubContext(integration)

      const response = yield* githubRepoRequest(context, {
        method: 'POST',
        path: '/issues',
        body: {
          title: input.title,
          body: input.body,
          labels: input.labels,
          assignees: input.assignees,
          milestone: input.milestone,
          type: input.type
        }
      })

      if (!isGithubSuccess(response.status)) {
        return yield* githubFailure(response, { operation: 'create issue' })
      }

      const wire = yield* decodeJsonResponse(GithubWireIssue, response)

      return ActionResult.success(normalizeGithubIssue(wire))
    })
})

// ---------------------------------------------------------------------------
// update_issue
// ---------------------------------------------------------------------------

export const GithubUpdateIssueInput = Schema.Struct({
  issueNumber: GithubIssueNumber,
  title: Schema.optional(GithubNonEmptyString),
  body: Schema.optional(Schema.String),
  state: Schema.optional(Schema.Literals(['open', 'closed'])),
  stateReason: Schema.optional(
    Schema.Literals(['completed', 'not_planned', 'duplicate', 'reopened'])
  ),
  milestone: Schema.optional(GithubIssueNumber),
  clearMilestone: Schema.optional(Schema.Boolean),
  type: Schema.optional(GithubNonEmptyString),
  clearType: Schema.optional(Schema.Boolean)
})

export type GithubUpdateIssueInput = typeof GithubUpdateIssueInput.Type

export const githubUpdateIssueAction = defineAction({
  id: 'github.update_issue',
  description: 'Update an issue by number. At least one change is required.',
  access: 'write',
  inputSchema: GithubUpdateIssueInput,
  outputSchema: GithubIssue,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const hasChange =
        input.title !== undefined ||
        input.body !== undefined ||
        input.state !== undefined ||
        input.stateReason !== undefined ||
        input.milestone !== undefined ||
        input.clearMilestone === true ||
        input.type !== undefined ||
        input.clearType === true

      if (!hasChange) {
        return yield* failUpdateValidation(
          integration,
          'Update issue requires at least one change: title, body, state, stateReason, milestone, clearMilestone, type, or clearType'
        )
      }

      if (input.milestone !== undefined && input.clearMilestone === true) {
        return yield* failUpdateValidation(
          integration,
          'Update issue rejects milestone together with clearMilestone'
        )
      }

      if (input.type !== undefined && input.clearType === true) {
        return yield* failUpdateValidation(
          integration,
          'Update issue rejects type together with clearType'
        )
      }

      if (input.stateReason === 'reopened' && input.state !== 'open') {
        return yield* failUpdateValidation(
          integration,
          "Update issue state reason 'reopened' requires state 'open'"
        )
      }

      if (
        (input.stateReason === 'completed' ||
          input.stateReason === 'not_planned' ||
          input.stateReason === 'duplicate') &&
        input.state !== 'closed'
      ) {
        return yield* failUpdateValidation(
          integration,
          `Update issue state reason '${input.stateReason}' requires state 'closed'`
        )
      }

      const context = yield* resolveGithubContext(integration)

      const response = yield* githubRepoRequest(context, {
        method: 'PATCH',
        path: `/issues/${encodeURIComponent(input.issueNumber)}`,
        body: {
          title: input.title,
          body: input.body,
          state: input.state,
          state_reason: input.stateReason,
          milestone: input.clearMilestone === true ? null : input.milestone,
          type: input.clearType === true ? null : input.type
        }
      })

      if (!isGithubSuccess(response.status)) {
        return yield* githubFailure(response, { operation: 'update issue' })
      }

      const wire = yield* decodeJsonResponse(GithubWireIssue, response)

      return ActionResult.success(normalizeGithubIssue(wire))
    })
})

// ---------------------------------------------------------------------------
// lock_issue / unlock_issue
// ---------------------------------------------------------------------------

export const GithubLockIssueInput = Schema.Struct({
  issueNumber: GithubIssueNumber,
  lockReason: Schema.optional(Schema.Literals(['off-topic', 'too heated', 'resolved', 'spam']))
})

export type GithubLockIssueInput = typeof GithubLockIssueInput.Type

export const GithubLockIssueOutput = Schema.Struct({
  issueNumber: GithubIssueNumber,
  locked: Schema.Boolean
})

export type GithubLockIssueOutput = typeof GithubLockIssueOutput.Type

export const githubLockIssueAction = defineAction({
  id: 'github.lock_issue',
  description: 'Lock an issue conversation, optionally with a lock reason.',
  access: 'write',
  inputSchema: GithubLockIssueInput,
  outputSchema: GithubLockIssueOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const context = yield* resolveGithubContext(integration)

      const response = yield* githubRepoRequest(context, {
        method: 'PUT',
        path: `/issues/${encodeURIComponent(input.issueNumber)}/lock`,
        body: input.lockReason === undefined ? undefined : { lock_reason: input.lockReason }
      })

      if (!isGithubSuccess(response.status)) {
        return yield* githubFailure(response, { operation: 'lock issue' })
      }

      return ActionResult.success({ issueNumber: input.issueNumber, locked: true })
    })
})

export const GithubUnlockIssueInput = Schema.Struct({
  issueNumber: GithubIssueNumber
})

export type GithubUnlockIssueInput = typeof GithubUnlockIssueInput.Type

export const GithubUnlockIssueOutput = Schema.Struct({
  issueNumber: GithubIssueNumber,
  locked: Schema.Boolean
})

export type GithubUnlockIssueOutput = typeof GithubUnlockIssueOutput.Type

export const githubUnlockIssueAction = defineAction({
  id: 'github.unlock_issue',
  description: 'Unlock an issue conversation.',
  access: 'write',
  inputSchema: GithubUnlockIssueInput,
  outputSchema: GithubUnlockIssueOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const context = yield* resolveGithubContext(integration)

      const response = yield* githubRepoRequest(context, {
        method: 'DELETE',
        path: `/issues/${encodeURIComponent(input.issueNumber)}/lock`
      })

      if (!isGithubSuccess(response.status)) {
        return yield* githubFailure(response, { operation: 'unlock issue' })
      }

      return ActionResult.success({ issueNumber: input.issueNumber, locked: false })
    })
})

// ---------------------------------------------------------------------------
// add_assignees / remove_assignees
// ---------------------------------------------------------------------------

export const GithubAddAssigneesInput = Schema.Struct({
  issueNumber: GithubIssueNumber,
  assignees: GithubAssigneeList
})

export type GithubAddAssigneesInput = typeof GithubAddAssigneesInput.Type

export const githubAddAssigneesAction = defineAction({
  id: 'github.add_assignees',
  description: 'Add assignees to an issue.',
  access: 'write',
  inputSchema: GithubAddAssigneesInput,
  outputSchema: GithubIssue,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const context = yield* resolveGithubContext(integration)

      const response = yield* githubRepoRequest(context, {
        method: 'POST',
        path: `/issues/${encodeURIComponent(input.issueNumber)}/assignees`,
        body: { assignees: input.assignees }
      })

      if (!isGithubSuccess(response.status)) {
        return yield* githubFailure(response, { operation: 'add assignees' })
      }

      const wire = yield* decodeJsonResponse(GithubWireIssue, response)

      return ActionResult.success(normalizeGithubIssue(wire))
    })
})

export const GithubRemoveAssigneesInput = Schema.Struct({
  issueNumber: GithubIssueNumber,
  assignees: GithubAssigneeList
})

export type GithubRemoveAssigneesInput = typeof GithubRemoveAssigneesInput.Type

export const githubRemoveAssigneesAction = defineAction({
  id: 'github.remove_assignees',
  description: 'Remove assignees from an issue.',
  access: 'write',
  inputSchema: GithubRemoveAssigneesInput,
  outputSchema: GithubIssue,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const context = yield* resolveGithubContext(integration)

      const response = yield* githubRepoRequest(context, {
        method: 'DELETE',
        path: `/issues/${encodeURIComponent(input.issueNumber)}/assignees`,
        body: { assignees: input.assignees }
      })

      if (!isGithubSuccess(response.status)) {
        return yield* githubFailure(response, { operation: 'remove assignees' })
      }

      const wire = yield* decodeJsonResponse(GithubWireIssue, response)

      return ActionResult.success(normalizeGithubIssue(wire))
    })
})

// ---------------------------------------------------------------------------
// list_assignees
// ---------------------------------------------------------------------------

export const GithubListAssigneesInput = Schema.Struct({
  ...githubPaginationFields
})

export type GithubListAssigneesInput = typeof GithubListAssigneesInput.Type

export const GithubAssignee = Schema.Struct({
  login: Schema.String,
  type: Schema.NullOr(Schema.String)
})

export type GithubAssignee = typeof GithubAssignee.Type

export const GithubListAssigneesOutput = Schema.Struct({
  assignees: Schema.Array(GithubAssignee),
  hasNextPage: Schema.Boolean
})

export type GithubListAssigneesOutput = typeof GithubListAssigneesOutput.Type

const GithubAssigneeWire = Schema.Struct({
  login: Schema.String,
  type: Schema.optional(Schema.NullOr(Schema.String))
})

export const githubListAssigneesAction = defineAction({
  id: 'github.list_assignees',
  description: 'List users assignable to issues in the configured repository.',
  access: 'read',
  inputSchema: GithubListAssigneesInput,
  outputSchema: GithubListAssigneesOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const context = yield* resolveGithubContext(integration)

      const response = yield* githubRepoRequest(context, {
        method: 'GET',
        path: '/assignees',
        query: githubPaginationQuery(input)
      })

      if (!isGithubSuccess(response.status)) {
        return yield* githubFailure(response, { operation: 'list assignees' })
      }

      const wire = yield* decodeJsonResponse(Schema.Array(GithubAssigneeWire), response)

      const assignees = wire.map(user => ({ login: user.login, type: user.type ?? null }))

      return ActionResult.success({
        assignees,
        hasNextPage: githubHasNextPage(response.headers)
      })
    })
})

// ---------------------------------------------------------------------------
// list_issue_timeline
// ---------------------------------------------------------------------------

export const GithubListIssueTimelineInput = Schema.Struct({
  issueNumber: GithubIssueNumber,
  ...githubPaginationFields
})

export type GithubListIssueTimelineInput = typeof GithubListIssueTimelineInput.Type

export const GithubTimelineSource = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  isPullRequest: Schema.Boolean,
  state: Schema.String,
  url: Schema.String,
  repository: Schema.String
})

export type GithubTimelineSource = typeof GithubTimelineSource.Type

export const GithubTimelineEvent = Schema.Struct({
  event: Schema.String,
  actor: Schema.NullOr(Schema.String),
  createdAt: Schema.NullOr(Schema.String),
  label: Schema.optional(Schema.String),
  assignee: Schema.optional(Schema.String),
  commitId: Schema.optional(Schema.String),
  stateReason: Schema.optional(Schema.String),
  renamedFrom: Schema.optional(Schema.String),
  renamedTo: Schema.optional(Schema.String),
  milestone: Schema.optional(Schema.String),
  reviewState: Schema.optional(Schema.String),
  body: Schema.optional(Schema.NullOr(Schema.String)),
  bodyTruncated: Schema.optional(Schema.Boolean),
  source: Schema.optional(GithubTimelineSource),
  sha: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String)
})

export type GithubTimelineEvent = typeof GithubTimelineEvent.Type

export const GithubListIssueTimelineOutput = Schema.Struct({
  events: Schema.Array(GithubTimelineEvent),
  hasNextPage: Schema.Boolean
})

export type GithubListIssueTimelineOutput = typeof GithubListIssueTimelineOutput.Type

const GithubTimelineWireUser = Schema.Struct({
  login: Schema.optional(Schema.String)
})

const GithubTimelineWireLabel = Schema.Struct({
  name: Schema.optional(Schema.NullOr(Schema.String))
})

const GithubTimelineWireMilestone = Schema.Struct({
  title: Schema.optional(Schema.String)
})

const GithubTimelineWireRename = Schema.Struct({
  from: Schema.optional(Schema.NullOr(Schema.String)),
  to: Schema.optional(Schema.NullOr(Schema.String))
})

const GithubTimelineWireCommitPerson = Schema.Struct({
  name: Schema.optional(Schema.NullOr(Schema.String)),
  email: Schema.optional(Schema.NullOr(Schema.String)),
  date: Schema.optional(Schema.NullOr(Schema.String))
})

const GithubTimelineWireSourceIssue = Schema.Struct({
  number: Schema.optional(Schema.Number),
  title: Schema.optional(Schema.String),
  state: Schema.optional(Schema.String),
  html_url: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  repository_url: Schema.optional(Schema.String),
  pull_request: Schema.optional(Schema.NullOr(Schema.Struct({})))
})

const GithubTimelineWireSource = Schema.Struct({
  issue: Schema.optional(Schema.NullOr(GithubTimelineWireSourceIssue))
})

const GithubTimelineWireEvent = Schema.Struct({
  event: Schema.optional(Schema.String),
  actor: Schema.optional(Schema.NullOr(GithubTimelineWireUser)),
  user: Schema.optional(Schema.NullOr(GithubTimelineWireUser)),
  created_at: Schema.optional(Schema.NullOr(Schema.String)),
  submitted_at: Schema.optional(Schema.NullOr(Schema.String)),
  commit_id: Schema.optional(Schema.NullOr(Schema.String)),
  sha: Schema.optional(Schema.NullOr(Schema.String)),
  message: Schema.optional(Schema.NullOr(Schema.String)),
  body: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
  state_reason: Schema.optional(Schema.NullOr(Schema.String)),
  lock_reason: Schema.optional(Schema.NullOr(Schema.String)),
  label: Schema.optional(Schema.NullOr(GithubTimelineWireLabel)),
  assignee: Schema.optional(Schema.NullOr(GithubTimelineWireUser)),
  milestone: Schema.optional(Schema.NullOr(GithubTimelineWireMilestone)),
  rename: Schema.optional(Schema.NullOr(GithubTimelineWireRename)),
  author: Schema.optional(Schema.NullOr(GithubTimelineWireCommitPerson)),
  committer: Schema.optional(Schema.NullOr(GithubTimelineWireCommitPerson)),
  source: Schema.optional(Schema.NullOr(GithubTimelineWireSource))
})

type GithubTimelineWireEvent = typeof GithubTimelineWireEvent.Type

const repositoryFullName = (repositoryUrl: string | undefined, context: GithubRequestContext) => {
  const prefix = `${githubApiBaseUrl}/repos/`

  if (repositoryUrl === undefined || !repositoryUrl.startsWith(prefix)) {
    return `${context.owner}/${context.repo}`
  }

  const fullName = repositoryUrl.slice(prefix.length)

  return fullName === '' ? `${context.owner}/${context.repo}` : fullName
}

const normalizeTimelineEvent = (
  wire: GithubTimelineWireEvent,
  context: GithubRequestContext
): GithubTimelineEvent => {
  const event = wire.event ?? 'unknown'

  const actor = wire.actor?.login ?? wire.user?.login ?? null

  const createdAt =
    wire.created_at ?? wire.submitted_at ?? wire.author?.date ?? wire.committer?.date ?? null

  let normalized: GithubTimelineEvent = { event, actor, createdAt }

  const commitId = wire.commit_id ?? undefined

  if (commitId !== undefined) {
    normalized = { ...normalized, commitId }
  }

  const stateReason = wire.state_reason ?? wire.lock_reason ?? undefined

  if (stateReason !== undefined) {
    normalized = { ...normalized, stateReason }
  }

  const label = wire.label?.name ?? undefined

  if (label !== undefined) {
    normalized = { ...normalized, label }
  }

  const assignee = wire.assignee?.login ?? undefined

  if (assignee !== undefined) {
    normalized = { ...normalized, assignee }
  }

  const milestone = wire.milestone?.title ?? undefined

  if (milestone !== undefined) {
    normalized = { ...normalized, milestone }
  }

  const renamedFrom = wire.rename?.from ?? undefined

  if (renamedFrom !== undefined) {
    normalized = { ...normalized, renamedFrom }
  }

  const renamedTo = wire.rename?.to ?? undefined

  if (renamedTo !== undefined) {
    normalized = { ...normalized, renamedTo }
  }

  if (event === 'reviewed') {
    const reviewState = wire.state ?? undefined

    if (reviewState !== undefined) {
      normalized = { ...normalized, reviewState }
    }
  }

  if (event === 'commented' || event === 'reviewed') {
    if (wire.body === undefined || wire.body === null) {
      normalized = { ...normalized, body: null, bodyTruncated: false }
    } else {
      const truncated = truncateGithubText(wire.body, githubListBodyMaxChars)

      normalized = { ...normalized, body: truncated.text, bodyTruncated: truncated.truncated }
    }
  }

  if (event === 'committed') {
    const sha = wire.sha ?? undefined

    if (sha !== undefined) {
      normalized = { ...normalized, sha }
    }

    const message = wire.message ?? undefined

    if (message !== undefined) {
      normalized = { ...normalized, message }
    }
  }

  const sourceIssue = wire.source?.issue

  if (event === 'cross-referenced' && sourceIssue?.number !== undefined) {
    normalized = {
      ...normalized,
      source: {
        number: sourceIssue.number,
        title: sourceIssue.title ?? '',
        isPullRequest: sourceIssue.pull_request !== undefined && sourceIssue.pull_request !== null,
        state: sourceIssue.state ?? '',
        url: sourceIssue.html_url ?? sourceIssue.url ?? '',
        repository: repositoryFullName(sourceIssue.repository_url, context)
      }
    }
  }

  return normalized
}

export const githubListIssueTimelineAction = defineAction({
  id: 'github.list_issue_timeline',
  description:
    'List timeline events for an issue, including cross-referenced pull requests and review activity.',
  access: 'read',
  inputSchema: GithubListIssueTimelineInput,
  outputSchema: GithubListIssueTimelineOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const context = yield* resolveGithubContext(integration)

      const response = yield* githubRepoRequest(context, {
        method: 'GET',
        path: `/issues/${encodeURIComponent(input.issueNumber)}/timeline`,
        query: githubPaginationQuery(input)
      })

      if (!isGithubSuccess(response.status)) {
        return yield* githubFailure(response, { operation: 'list issue timeline' })
      }

      const wire = yield* decodeJsonResponse(Schema.Array(GithubTimelineWireEvent), response)

      const events = wire.map(item => normalizeTimelineEvent(item, context))

      return ActionResult.success({
        events,
        hasNextPage: githubHasNextPage(response.headers)
      })
    })
})

export const githubIssueActions = [
  githubSearchIssuesAction,
  githubListIssuesAction,
  githubGetIssueAction,
  githubCreateIssueAction,
  githubUpdateIssueAction,
  githubLockIssueAction,
  githubUnlockIssueAction,
  githubAddAssigneesAction,
  githubRemoveAssigneesAction,
  githubListAssigneesAction,
  githubListIssueTimelineAction
]
