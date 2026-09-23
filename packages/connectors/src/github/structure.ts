import { Effect, Predicate } from 'effect'
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
  githubBodyMaxChars,
  githubFailure,
  githubHasNextPage,
  githubListBodyMaxChars,
  githubOrgPath,
  githubPaginationFields,
  githubPaginationQuery,
  githubRepoRequest,
  githubRequest,
  isGithubSuccess,
  normalizeGithubIssue,
  resolveGithubContext
} from './shared.ts'
import type { GithubRequestContext } from './shared.ts'

const GithubIssueIdInput = Schema.Struct({
  issueNumber: GithubIssueNumber,
  ...githubPaginationFields
})

/**
 * Sub-issue and dependency endpoints take the issue numeric database `id`, not its
 * number. Inputs stay scoped to issue numbers; the id is resolved lane-locally.
 */
const resolveGithubIssueId = (
  context: GithubRequestContext,
  issueNumber: number,
  operation: string
) =>
  Effect.gen(function* () {
    const response = yield* githubRepoRequest(context, {
      method: 'GET',
      path: `/issues/${encodeURIComponent(String(issueNumber))}`
    })

    if (!isGithubSuccess(response.status)) {
      return yield* githubFailure(response, { operation })
    }

    const wire = yield* decodeJsonResponse(Schema.Struct({ id: Schema.Number }), response)

    return ActionResult.success(wire.id)
  })

const failureOrId = (resolved: ActionResult<number>): ActionResult<never> | number =>
  Predicate.isTagged(resolved, 'Failure') ? resolved : resolved.value

export const GithubListSubIssuesOutput = Schema.Struct({
  subIssues: Schema.Array(GithubIssue),
  hasNextPage: Schema.Boolean
})

export const githubListSubIssuesAction = defineAction({
  id: 'github.list_sub_issues',
  description: 'List sub-issues of a GitHub issue.',
  access: 'read',
  inputSchema: GithubIssueIdInput,
  outputSchema: GithubListSubIssuesOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const context = yield* resolveGithubContext(integration)

      const response = yield* githubRepoRequest(context, {
        method: 'GET',
        path: `/issues/${encodeURIComponent(String(input.issueNumber))}/sub_issues`,
        query: githubPaginationQuery(input)
      })

      if (!isGithubSuccess(response.status)) {
        return yield* githubFailure(response, { operation: 'list sub issues' })
      }

      const wire = yield* decodeJsonResponse(Schema.Array(GithubWireIssue), response)

      return ActionResult.success({
        subIssues: wire.map(issue => normalizeGithubIssue(issue, githubListBodyMaxChars)),
        hasNextPage: githubHasNextPage(response.headers)
      })
    })
})

export const GithubAddSubIssueInput = Schema.Struct({
  issueNumber: GithubIssueNumber,
  subIssueNumber: GithubIssueNumber,
  replaceParent: Schema.optional(Schema.Boolean)
})

export const GithubSubIssueOutput = Schema.Struct({
  parent: GithubIssue,
  subIssueNumber: GithubIssueNumber
})

const subIssuePairError = (integration: ConnectorIntegration) =>
  new ConnectorError({
    cause: 'validation_failed',
    message: 'Parent and sub issue numbers must differ',
    connectorId: integration.connectorId,
    actionId: 'github.add_sub_issue'
  })

export const githubAddSubIssueAction = defineAction({
  id: 'github.add_sub_issue',
  description: 'Attach an existing issue as a sub-issue of another issue.',
  access: 'write',
  inputSchema: GithubAddSubIssueInput,
  outputSchema: GithubSubIssueOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      if (input.issueNumber === input.subIssueNumber) {
        return yield* Effect.fail(subIssuePairError(integration))
      }

      const context = yield* resolveGithubContext(integration)
      const resolved = yield* resolveGithubIssueId(context, input.subIssueNumber, 'add sub issue')
      const childId = failureOrId(resolved)

      if (!Predicate.isNumber(childId)) {
        return childId
      }

      const response = yield* githubRepoRequest(context, {
        method: 'POST',
        path: `/issues/${encodeURIComponent(String(input.issueNumber))}/sub_issues`,
        body: { sub_issue_id: childId, replace_parent: input.replaceParent }
      })

      if (!isGithubSuccess(response.status)) {
        return yield* githubFailure(response, { operation: 'add sub issue' })
      }

      const wire = yield* decodeJsonResponse(GithubWireIssue, response)

      return ActionResult.success({
        parent: normalizeGithubIssue(wire, githubBodyMaxChars),
        subIssueNumber: input.subIssueNumber
      })
    })
})

export const GithubRemoveSubIssueInput = Schema.Struct({
  issueNumber: GithubIssueNumber,
  subIssueNumber: GithubIssueNumber
})

export const githubRemoveSubIssueAction = defineAction({
  id: 'github.remove_sub_issue',
  description: 'Detach a sub-issue from its parent issue.',
  access: 'write',
  inputSchema: GithubRemoveSubIssueInput,
  outputSchema: GithubSubIssueOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      if (input.issueNumber === input.subIssueNumber) {
        return yield* Effect.fail(
          new ConnectorError({
            cause: 'validation_failed',
            message: 'Parent and sub issue numbers must differ',
            connectorId: integration.connectorId,
            actionId: 'github.remove_sub_issue'
          })
        )
      }

      const context = yield* resolveGithubContext(integration)

      const resolved = yield* resolveGithubIssueId(
        context,
        input.subIssueNumber,
        'remove sub issue'
      )

      const childId = failureOrId(resolved)

      if (!Predicate.isNumber(childId)) {
        return childId
      }

      const response = yield* githubRepoRequest(context, {
        method: 'DELETE',
        path: `/issues/${encodeURIComponent(String(input.issueNumber))}/sub_issue`,
        body: { sub_issue_id: childId }
      })

      if (!isGithubSuccess(response.status)) {
        return yield* githubFailure(response, { operation: 'remove sub issue' })
      }

      const wire = yield* decodeJsonResponse(GithubWireIssue, response)

      return ActionResult.success({
        parent: normalizeGithubIssue(wire, githubBodyMaxChars),
        subIssueNumber: input.subIssueNumber
      })
    })
})

export const GithubListIssueDependenciesOutput = Schema.Struct({
  blockedBy: Schema.Array(GithubIssue),
  blockedByHasNextPage: Schema.Boolean,
  blocking: Schema.Array(GithubIssue),
  blockingHasNextPage: Schema.Boolean
})

export const githubListIssueDependenciesAction = defineAction({
  id: 'github.list_issue_dependencies',
  description: 'List the blocked-by and blocking issue dependencies of a GitHub issue.',
  access: 'read',
  inputSchema: GithubIssueIdInput,
  outputSchema: GithubListIssueDependenciesOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const context = yield* resolveGithubContext(integration)
      const query = githubPaginationQuery(input)

      const blockedByResponse = yield* githubRepoRequest(context, {
        method: 'GET',
        path: `/issues/${encodeURIComponent(String(input.issueNumber))}/dependencies/blocked_by`,
        query
      })

      if (!isGithubSuccess(blockedByResponse.status)) {
        return yield* githubFailure(blockedByResponse, { operation: 'list issue dependencies' })
      }

      const blockingResponse = yield* githubRepoRequest(context, {
        method: 'GET',
        path: `/issues/${encodeURIComponent(String(input.issueNumber))}/dependencies/blocking`,
        query
      })

      if (!isGithubSuccess(blockingResponse.status)) {
        return yield* githubFailure(blockingResponse, { operation: 'list issue dependencies' })
      }

      const blockedBy = yield* decodeJsonResponse(Schema.Array(GithubWireIssue), blockedByResponse)
      const blocking = yield* decodeJsonResponse(Schema.Array(GithubWireIssue), blockingResponse)

      return ActionResult.success({
        blockedBy: blockedBy.map(issue => normalizeGithubIssue(issue, githubListBodyMaxChars)),
        blockedByHasNextPage: githubHasNextPage(blockedByResponse.headers),
        blocking: blocking.map(issue => normalizeGithubIssue(issue, githubListBodyMaxChars)),
        blockingHasNextPage: githubHasNextPage(blockingResponse.headers)
      })
    })
})

export const GithubBlockedByInput = Schema.Struct({
  issueNumber: GithubIssueNumber,
  blockingIssueNumber: GithubIssueNumber
})

export const GithubBlockedByOutput = Schema.Struct({
  issue: GithubIssue,
  blockingIssueNumber: GithubIssueNumber
})

const blockedByPairError = (integration: ConnectorIntegration, actionId: string) =>
  new ConnectorError({
    cause: 'validation_failed',
    message: 'Issue and blocking issue numbers must differ',
    connectorId: integration.connectorId,
    actionId
  })

export const githubAddBlockedByAction = defineAction({
  id: 'github.add_blocked_by',
  description: 'Mark a GitHub issue as blocked by another issue.',
  access: 'write',
  inputSchema: GithubBlockedByInput,
  outputSchema: GithubBlockedByOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      if (input.issueNumber === input.blockingIssueNumber) {
        return yield* Effect.fail(blockedByPairError(integration, 'github.add_blocked_by'))
      }

      const context = yield* resolveGithubContext(integration)

      const resolved = yield* resolveGithubIssueId(
        context,
        input.blockingIssueNumber,
        'add blocked by'
      )

      const blockingId = failureOrId(resolved)

      if (!Predicate.isNumber(blockingId)) {
        return blockingId
      }

      const response = yield* githubRepoRequest(context, {
        method: 'POST',
        path: `/issues/${encodeURIComponent(String(input.issueNumber))}/dependencies/blocked_by`,
        body: { issue_id: blockingId }
      })

      if (!isGithubSuccess(response.status)) {
        return yield* githubFailure(response, { operation: 'add blocked by' })
      }

      const wire = yield* decodeJsonResponse(GithubWireIssue, response)

      return ActionResult.success({
        issue: normalizeGithubIssue(wire, githubBodyMaxChars),
        blockingIssueNumber: input.blockingIssueNumber
      })
    })
})

export const githubRemoveBlockedByAction = defineAction({
  id: 'github.remove_blocked_by',
  description: 'Remove a blocked-by dependency from a GitHub issue.',
  access: 'write',
  inputSchema: GithubBlockedByInput,
  outputSchema: GithubBlockedByOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      if (input.issueNumber === input.blockingIssueNumber) {
        return yield* Effect.fail(blockedByPairError(integration, 'github.remove_blocked_by'))
      }

      const context = yield* resolveGithubContext(integration)

      const resolved = yield* resolveGithubIssueId(
        context,
        input.blockingIssueNumber,
        'remove blocked by'
      )

      const blockingId = failureOrId(resolved)

      if (!Predicate.isNumber(blockingId)) {
        return blockingId
      }

      const response = yield* githubRepoRequest(context, {
        method: 'DELETE',
        path: `/issues/${encodeURIComponent(String(input.issueNumber))}/dependencies/blocked_by/${encodeURIComponent(String(blockingId))}`
      })

      if (!isGithubSuccess(response.status)) {
        return yield* githubFailure(response, { operation: 'remove blocked by' })
      }

      const wire = yield* decodeJsonResponse(GithubWireIssue, response)

      return ActionResult.success({
        issue: normalizeGithubIssue(wire, githubBodyMaxChars),
        blockingIssueNumber: input.blockingIssueNumber
      })
    })
})

const GithubWireIssueType = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  description: Schema.optional(Schema.NullOr(Schema.String)),
  color: Schema.optional(Schema.NullOr(Schema.String)),
  is_enabled: Schema.optional(Schema.NullOr(Schema.Boolean))
})

export const GithubIssueType = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  color: Schema.NullOr(Schema.String),
  isEnabled: Schema.NullOr(Schema.Boolean)
})

export type GithubIssueType = typeof GithubIssueType.Type

export const GithubListIssueTypesInput = Schema.Struct({})

export const GithubListIssueTypesOutput = Schema.Struct({
  issueTypes: Schema.Array(GithubIssueType)
})

export const githubListIssueTypesAction = defineAction({
  id: 'github.list_issue_types',
  description:
    'List issue types of the GitHub organization. Only works when the owner is an organization (user-owned repos return 404).',
  access: 'read',
  inputSchema: GithubListIssueTypesInput,
  outputSchema: GithubListIssueTypesOutput,
  execute: ({ integration }) =>
    Effect.gen(function* () {
      const context = yield* resolveGithubContext(integration)

      const response = yield* githubRequest(context.token, {
        method: 'GET',
        path: `${githubOrgPath(context)}/issue-types`
      })

      if (!isGithubSuccess(response.status)) {
        return yield* githubFailure(response, { operation: 'list issue types' })
      }

      const wire = yield* decodeJsonResponse(Schema.Array(GithubWireIssueType), response)

      return ActionResult.success({
        issueTypes: wire.map(type => ({
          id: type.id,
          name: type.name,
          description: type.description ?? null,
          color: type.color ?? null,
          isEnabled: type.is_enabled ?? null
        }))
      })
    })
})

const GithubWireFieldOption = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  description: Schema.optional(Schema.NullOr(Schema.String)),
  color: Schema.optional(Schema.NullOr(Schema.String))
})

const GithubWireIssueField = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  description: Schema.optional(Schema.NullOr(Schema.String)),
  data_type: Schema.String,
  options: Schema.optional(Schema.NullOr(Schema.Array(GithubWireFieldOption)))
})

export const GithubIssueFieldOption = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  color: Schema.NullOr(Schema.String)
})

export type GithubIssueFieldOption = typeof GithubIssueFieldOption.Type

export const GithubIssueField = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  dataType: Schema.String,
  options: Schema.Array(GithubIssueFieldOption)
})

export type GithubIssueField = typeof GithubIssueField.Type

export const GithubListIssueFieldsInput = Schema.Struct({})

export const GithubListIssueFieldsOutput = Schema.Struct({
  fields: Schema.Array(GithubIssueField)
})

export const githubListIssueFieldsAction = defineAction({
  id: 'github.list_issue_fields',
  description:
    'List custom issue fields of the GitHub organization. Only works when the owner is an organization (user-owned repos return 404).',
  access: 'read',
  inputSchema: GithubListIssueFieldsInput,
  outputSchema: GithubListIssueFieldsOutput,
  execute: ({ integration }) =>
    Effect.gen(function* () {
      const context = yield* resolveGithubContext(integration)

      const response = yield* githubRequest(context.token, {
        method: 'GET',
        path: `${githubOrgPath(context)}/issue-fields`
      })

      if (!isGithubSuccess(response.status)) {
        return yield* githubFailure(response, { operation: 'list issue fields' })
      }

      const wire = yield* decodeJsonResponse(Schema.Array(GithubWireIssueField), response)

      return ActionResult.success({
        fields: wire.map(field => ({
          id: field.id,
          name: field.name,
          description: field.description ?? null,
          dataType: field.data_type,
          options: (field.options ?? []).map(option => ({
            id: option.id,
            name: option.name,
            description: option.description ?? null,
            color: option.color ?? null
          }))
        }))
      })
    })
})

export const GithubIssueFieldValueInput = Schema.Struct({
  fieldId: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1))),
  text: Schema.optional(Schema.String),
  number: Schema.optional(Schema.Number),
  date: Schema.optional(Schema.String),
  option: Schema.optional(Schema.String),
  options: Schema.optional(Schema.Array(Schema.String))
})

export type GithubIssueFieldValueInput = typeof GithubIssueFieldValueInput.Type

export const GithubSetIssueFieldValuesInput = Schema.Struct({
  issueNumber: GithubIssueNumber,
  values: Schema.Array(GithubIssueFieldValueInput).pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(25))
  )
})

const GithubWireFieldSelectOption = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  color: Schema.optional(Schema.NullOr(Schema.String))
})

const GithubWireFieldValue = Schema.Struct({
  issue_field_id: Schema.Number,
  issue_field_name: Schema.optional(Schema.String),
  data_type: Schema.String,
  value: Schema.optional(Schema.NullOr(Schema.Union([Schema.String, Schema.Number]))),
  single_select_option: Schema.optional(Schema.NullOr(GithubWireFieldSelectOption)),
  multi_select_options: Schema.optional(Schema.NullOr(Schema.Array(GithubWireFieldSelectOption)))
})

export const GithubIssueFieldValue = Schema.Struct({
  fieldId: Schema.Number,
  name: Schema.NullOr(Schema.String),
  dataType: Schema.String,
  value: Schema.NullOr(Schema.String),
  number: Schema.NullOr(Schema.Number),
  options: Schema.Array(Schema.String)
})

export type GithubIssueFieldValue = typeof GithubIssueFieldValue.Type

export const GithubSetIssueFieldValuesOutput = Schema.Struct({
  issueNumber: Schema.Number,
  values: Schema.Array(GithubIssueFieldValue)
})

const datePattern = /^\d{4}-\d{2}-\d{2}$/

const fieldValuesError = (integration: ConnectorIntegration, message: string) =>
  new ConnectorError({
    cause: 'validation_failed',
    message,
    connectorId: integration.connectorId,
    actionId: 'github.set_issue_field_values'
  })

const validateFieldValueEntry = (
  integration: ConnectorIntegration,
  entry: GithubIssueFieldValueInput,
  seen: Set<number>
) => {
  if (seen.has(entry.fieldId)) {
    return Effect.fail(
      fieldValuesError(integration, `Duplicate fieldId ${entry.fieldId} in values`)
    )
  }

  seen.add(entry.fieldId)

  let present = 0

  if (entry.text !== undefined) {
    present += 1
  }

  if (entry.number !== undefined) {
    present += 1
  }

  if (entry.date !== undefined) {
    present += 1
  }

  if (entry.option !== undefined) {
    present += 1
  }

  if (entry.options !== undefined) {
    present += 1
  }

  if (present !== 1) {
    return Effect.fail(
      fieldValuesError(
        integration,
        `Field ${entry.fieldId} must have exactly one of text, number, date, option, options`
      )
    )
  }

  if (entry.date !== undefined && !datePattern.test(entry.date)) {
    return Effect.fail(
      fieldValuesError(integration, `Field ${entry.fieldId} date must use YYYY-MM-DD format`)
    )
  }

  return Effect.void
}

const toFieldValueBody = (entry: GithubIssueFieldValueInput) => {
  if (entry.text !== undefined) {
    return { field_id: entry.fieldId, value: entry.text }
  }

  if (entry.number !== undefined) {
    return { field_id: entry.fieldId, value: entry.number }
  }

  if (entry.date !== undefined) {
    return { field_id: entry.fieldId, value: entry.date }
  }

  if (entry.option !== undefined) {
    return { field_id: entry.fieldId, value: entry.option }
  }

  return { field_id: entry.fieldId, value: entry.options }
}

const normalizeFieldValue = (entry: typeof GithubWireFieldValue.Type): GithubIssueFieldValue => {
  const single =
    entry.single_select_option === undefined || entry.single_select_option === null
      ? []
      : [entry.single_select_option.name]

  const multi = (entry.multi_select_options ?? []).map(option => option.name)

  return {
    fieldId: entry.issue_field_id,
    name: entry.issue_field_name ?? null,
    dataType: entry.data_type,
    value: Predicate.isString(entry.value) ? entry.value : null,
    number: Predicate.isNumber(entry.value) ? entry.value : null,
    options: [...single, ...multi]
  }
}

export const githubSetIssueFieldValuesAction = defineAction({
  id: 'github.set_issue_field_values',
  description:
    'Set custom issue field values on a GitHub issue. Values replace per field; omitted fields are left unchanged.',
  access: 'write',
  inputSchema: GithubSetIssueFieldValuesInput,
  outputSchema: GithubSetIssueFieldValuesOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const seen = new Set<number>()

      for (const entry of input.values) {
        yield* validateFieldValueEntry(integration, entry, seen)
      }

      const context = yield* resolveGithubContext(integration)

      const response = yield* githubRepoRequest(context, {
        method: 'POST',
        path: `/issues/${encodeURIComponent(String(input.issueNumber))}/issue-field-values`,
        body: { issue_field_values: input.values.map(toFieldValueBody) }
      })

      if (!isGithubSuccess(response.status)) {
        return yield* githubFailure(response, { operation: 'set issue field values' })
      }

      const wire = yield* decodeJsonResponse(Schema.Array(GithubWireFieldValue), response)

      return ActionResult.success({
        issueNumber: input.issueNumber,
        values: wire.map(normalizeFieldValue)
      })
    })
})

export const githubStructureActions = [
  githubListSubIssuesAction,
  githubAddSubIssueAction,
  githubRemoveSubIssueAction,
  githubListIssueDependenciesAction,
  githubAddBlockedByAction,
  githubRemoveBlockedByAction,
  githubListIssueTypesAction,
  githubListIssueFieldsAction,
  githubSetIssueFieldValuesAction
]
