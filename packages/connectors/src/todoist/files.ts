import { Chunk, Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { defineAction } from '../action.ts'
import { ConnectorBinaryHttpClient } from '../binary-http.ts'
import { ConnectorError } from '../error.ts'
import { ConnectorFileTransferError } from '../file-transfer.ts'
import type { ConnectorFileTransferBudget } from '../file-transfer.ts'
import { ConnectorHttpClient, ConnectorHttpRequest, decodeJsonResponse } from '../http.ts'
import type { ConnectorIntegration } from '../integration.ts'
import { ActionResult } from '../result.ts'
import {
  OpaqueId,
  SafeText,
  checkResponse,
  credentialFailure,
  decodeInput,
  decodeMetadata,
  failTransfer,
  fileBytes,
  isBytes,
  readBytes,
  safeHttpsUrl,
  safeToken,
  singleHeader,
  validateTransfer
} from '../transfer-internal.ts'
import { resolveTodoistToken, todoistApiBaseUrl } from './shared.ts'

const Attachment = Schema.Struct({
  file_url: SafeText,
  file_name: Schema.optional(SafeText),
  file_type: Schema.optional(SafeText)
})

const Comment = Schema.Struct({
  id: OpaqueId,
  content: Schema.String,
  task_id: Schema.optional(Schema.NullOr(OpaqueId)),
  project_id: Schema.optional(Schema.NullOr(OpaqueId)),
  file_attachment: Schema.optional(Schema.NullOr(Attachment))
})

export class TodoistCommentMetadata extends Schema.Class<TodoistCommentMetadata>(
  'TodoistCommentMetadata'
)({
  id: OpaqueId,
  content: Schema.String,
  taskId: Schema.optional(Schema.NullOr(OpaqueId)),
  projectId: Schema.optional(Schema.NullOr(OpaqueId)),
  hasAttachment: Schema.Boolean,
  filename: Schema.optional(SafeText),
  contentType: Schema.optional(SafeText)
}) {}

export class TodoistListCommentsInput extends Schema.Class<TodoistListCommentsInput>(
  'TodoistListCommentsInput'
)({
  taskId: Schema.optional(OpaqueId),
  projectId: Schema.optional(OpaqueId),
  cursor: Schema.optional(SafeText),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 })))
}) {}

export class TodoistListCommentsOutput extends Schema.Class<TodoistListCommentsOutput>(
  'TodoistListCommentsOutput'
)({ comments: Schema.Chunk(TodoistCommentMetadata), nextCursor: Schema.NullOr(Schema.String) }) {}

const List = Schema.Struct({
  results: Schema.Array(Comment),
  next_cursor: Schema.NullOr(Schema.String)
})

export const todoistListCommentsAction = defineAction({
  id: 'todoist.list_comments',
  access: 'read',
  description:
    'List one page of task or project comments and attachment metadata (never signed file URLs). Select exactly one taskId or projectId.',
  inputSchema: TodoistListCommentsInput,
  outputSchema: TodoistListCommentsOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      if ((input.taskId === undefined) === (input.projectId === undefined))
        return yield* Effect.fail(
          new ConnectorError({
            cause: 'validation_failed',
            message: 'Select exactly one taskId or projectId',
            connectorId: integration.connectorId
          })
        )
      const token = yield* resolveTodoistToken(integration)
      const query = new URLSearchParams()

      if (input.taskId !== undefined) query.set('task_id', input.taskId)

      if (input.projectId !== undefined) query.set('project_id', input.projectId)

      if (input.cursor !== undefined) query.set('cursor', input.cursor)

      if (input.limit !== undefined) query.set('limit', String(input.limit))
      const http = yield* ConnectorHttpClient

      const r = yield* http.request(
        ConnectorHttpRequest.make({
          method: 'GET',
          url: `${todoistApiBaseUrl}/comments?${query}`,
          headers: { authorization: `Bearer ${token}` }
        })
      )

      if (r.status !== 200)
        return ActionResult.failure({
          code: 'todoist_request_failed',
          message: 'Could not retrieve comments',
          status: r.status
        })
      const data = yield* decodeJsonResponse(List, r)

      return ActionResult.success(
        TodoistListCommentsOutput.make({
          comments: Chunk.fromIterable(
            data.results.map(c =>
              TodoistCommentMetadata.make({
                id: c.id,
                content: c.content,
                taskId: c.task_id,
                projectId: c.project_id,
                hasAttachment: c.file_attachment != null,
                filename: c.file_attachment?.file_name,
                contentType: c.file_attachment?.file_type
              })
            )
          ),
          nextCursor: data.next_cursor
        })
      )
    })
})

const cdnHosts = new Set(['todoist.b-cdn.net', 'd1ysz50cxb9zwl.cloudfront.net'])

/** Lookup by owning comment ID. files.todoist.com is authenticated; known CDN origins are not. */
export const downloadTodoistAttachment = (
  integration: ConnectorIntegration,
  input: { readonly commentId: string },
  budget: ConnectorFileTransferBudget
) =>
  Effect.gen(function* () {
    const limits = yield* validateTransfer(integration, 'todoist', budget)
    const target = yield* decodeInput(Schema.Struct({ commentId: OpaqueId }), input)

    const token = yield* resolveTodoistToken(integration).pipe(
      Effect.mapError(credentialFailure),
      Effect.flatMap(safeToken)
    )

    const r = yield* readBytes(
      `${todoistApiBaseUrl}/comments/${encodeURIComponent(target.commentId)}`,
      { authorization: `Bearer ${token}` },
      limits,
      true
    )

    const comment = yield* decodeMetadata(Comment, r.bytes)

    if (comment.id !== target.commentId) return yield* failTransfer('invalid_metadata')

    if (comment.file_attachment == null) return yield* failTransfer('not_downloadable')
    let url = yield* safeHttpsUrl(comment.file_attachment.file_url)

    if (url.hostname !== 'files.todoist.com' && !cdnHosts.has(url.hostname))
      return yield* failTransfer('network_policy_rejected')
    const http = yield* ConnectorBinaryHttpClient

    for (let hop = 0; hop <= 5; hop++) {
      const headers: Record<string, string> =
        hop === 0 && url.hostname === 'files.todoist.com'
          ? { authorization: `Bearer ${token}` }
          : {}

      const response = yield* http
        .request({
          method: 'GET',
          url: url.href,
          headers,
          maxBytes: limits.maxBytes,
          maxErrorBodyBytes: limits.maxErrorBodyBytes,
          redirect: 'manual',
          credentials: 'omit'
        })
        .pipe(Effect.mapError(e => new ConnectorFileTransferError({ code: e.code })))

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (!isBytes(response.bytes) || response.bytes.byteLength > limits.maxErrorBodyBytes)
          return yield* failTransfer('response_too_large')
        const location = singleHeader(response.headers, 'location')

        if (location === undefined || hop === 5) return yield* failTransfer('unexpected_redirect')
        url = yield* safeHttpsUrl(location)

        // Never reauthenticate after a redirect, including same-origin redirects.
        if (url.hostname !== 'files.todoist.com' && !cdnHosts.has(url.hostname))
          return yield* failTransfer('network_policy_rejected')
        continue
      }

      yield* checkResponse(response, limits.maxBytes, limits.maxErrorBodyBytes)

      return {
        ...fileBytes(response.bytes),
        source: {
          commentId: comment.id,
          filename: comment.file_attachment.file_name,
          contentType: comment.file_attachment.file_type
        }
      }
    }

    return yield* failTransfer('unexpected_redirect')
  })
