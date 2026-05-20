import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { defineAction } from '../action.ts'
import { defineConnector } from '../connector.ts'
import { CredentialSlot, resolveCredential } from '../credential.ts'
import { ConnectorHttpClient, ConnectorHttpRequest, decodeJsonResponse } from '../http.ts'
import { ActionResult, ProviderFailure } from '../result.ts'
import type { ConnectorIntegration } from '../integration.ts'

export const todoistConnectorId = 'todoist'
export const todoistApiTokenSlotId = 'todoist.api_token'
export const todoistApiBaseUrl = 'https://api.todoist.com/rest/v2'

export const TodoistApiTokenSlot = CredentialSlot.make({
  id: todoistApiTokenSlotId,
  kind: 'api_key'
})

export const todoistAuthorizationHeaders = (token: string) => ({
  authorization: `Bearer ${token}`
})

const isSuccessStatus = (status: number) => status >= 200 && status < 300

const todoistProviderFailure = (input: {
  readonly code: string
  readonly message: string
  readonly status: number
  readonly body: string
}) =>
  ActionResult.failure(
    new ProviderFailure({
      code: input.code,
      message: input.message,
      status: input.status,
      underlying: input.body
    })
  )

const resolveTodoistToken = (integration: ConnectorIntegration) =>
  Effect.gen(function* () {
    const credential = yield* resolveCredential(integration, TodoistApiTokenSlot)

    switch (credential._tag) {
      case 'ApiKeyCredential':
        return credential.key
      case 'BearerTokenCredential':
        return credential.token
      case 'OAuthCredential':
        return credential.accessToken
    }
  })

export class TodoistTask extends Schema.Class<TodoistTask>('TodoistTask')({
  id: Schema.String,
  content: Schema.String,
  description: Schema.optional(Schema.String),
  projectId: Schema.optional(Schema.String),
  sectionId: Schema.optional(Schema.String),
  parentId: Schema.optional(Schema.String),
  labels: Schema.optional(Schema.Array(Schema.String)),
  priority: Schema.optional(Schema.Number),
  due: Schema.optional(Schema.Unknown),
  url: Schema.optional(Schema.String)
}) {}

export class TodoistListTasksInput extends Schema.Class<TodoistListTasksInput>('TodoistListTasksInput')({
  projectId: Schema.optional(Schema.String),
  sectionId: Schema.optional(Schema.String),
  parentId: Schema.optional(Schema.String),
  label: Schema.optional(Schema.String),
  filter: Schema.optional(Schema.String)
}) {}

export class TodoistListTasksOutput extends Schema.Class<TodoistListTasksOutput>('TodoistListTasksOutput')({
  tasks: Schema.Array(TodoistTask)
}) {}

export class TodoistCreateTaskInput extends Schema.Class<TodoistCreateTaskInput>('TodoistCreateTaskInput')({
  content: Schema.String,
  description: Schema.optional(Schema.String),
  projectId: Schema.optional(Schema.String),
  sectionId: Schema.optional(Schema.String),
  parentId: Schema.optional(Schema.String),
  labels: Schema.optional(Schema.Array(Schema.String)),
  priority: Schema.optional(Schema.Number),
  dueString: Schema.optional(Schema.String),
  dueDate: Schema.optional(Schema.String),
  dueDatetime: Schema.optional(Schema.String)
}) {}

export class TodoistCloseTaskInput extends Schema.Class<TodoistCloseTaskInput>('TodoistCloseTaskInput')({
  id: Schema.String
}) {}

export class TodoistCloseTaskOutput extends Schema.Class<TodoistCloseTaskOutput>('TodoistCloseTaskOutput')({
  id: Schema.String,
  closed: Schema.Boolean
}) {}

const appendSearchParam = (params: URLSearchParams, key: string, value: string | undefined) => {
  if (value !== undefined && value.trim() !== '') {
    params.set(key, value)
  }
}

export const todoistListTasksAction = defineAction({
  id: 'todoist.list_tasks',
  description: 'List Todoist active tasks.',
  inputSchema: TodoistListTasksInput,
  outputSchema: TodoistListTasksOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const token = yield* resolveTodoistToken(integration)
      const http = yield* ConnectorHttpClient
      const params = new URLSearchParams()
      appendSearchParam(params, 'project_id', input.projectId)
      appendSearchParam(params, 'section_id', input.sectionId)
      appendSearchParam(params, 'parent_id', input.parentId)
      appendSearchParam(params, 'label', input.label)
      appendSearchParam(params, 'filter', input.filter)
      const query = params.toString()
      const response = yield* http.request(
        ConnectorHttpRequest.make({
          method: 'GET',
          url: `${todoistApiBaseUrl}/tasks${query === '' ? '' : `?${query}`}`,
          headers: todoistAuthorizationHeaders(token)
        })
      )

      if (!isSuccessStatus(response.status)) {
        return todoistProviderFailure({
          code: 'todoist_list_tasks_failed',
          message: 'Todoist list tasks failed',
          status: response.status,
          body: response.body
        })
      }

      const tasks = yield* decodeJsonResponse(Schema.Array(TodoistTask), response)
      return ActionResult.success(TodoistListTasksOutput.make({ tasks }))
    })
})

export const todoistCreateTaskAction = defineAction({
  id: 'todoist.create_task',
  description: 'Create a Todoist task.',
  inputSchema: TodoistCreateTaskInput,
  outputSchema: TodoistTask,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const token = yield* resolveTodoistToken(integration)
      const http = yield* ConnectorHttpClient
      const response = yield* http.request(
        ConnectorHttpRequest.make({
          method: 'POST',
          url: `${todoistApiBaseUrl}/tasks`,
          headers: {
            ...todoistAuthorizationHeaders(token),
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            content: input.content,
            description: input.description,
            project_id: input.projectId,
            section_id: input.sectionId,
            parent_id: input.parentId,
            labels: input.labels,
            priority: input.priority,
            due_string: input.dueString,
            due_date: input.dueDate,
            due_datetime: input.dueDatetime
          })
        })
      )

      if (!isSuccessStatus(response.status)) {
        return todoistProviderFailure({
          code: 'todoist_create_task_failed',
          message: 'Todoist create task failed',
          status: response.status,
          body: response.body
        })
      }

      const output = yield* decodeJsonResponse(TodoistTask, response)
      return ActionResult.success(output)
    })
})

export const todoistCloseTaskAction = defineAction({
  id: 'todoist.close_task',
  description: 'Close a Todoist task.',
  inputSchema: TodoistCloseTaskInput,
  outputSchema: TodoistCloseTaskOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const token = yield* resolveTodoistToken(integration)
      const http = yield* ConnectorHttpClient
      const response = yield* http.request(
        ConnectorHttpRequest.make({
          method: 'POST',
          url: `${todoistApiBaseUrl}/tasks/${encodeURIComponent(input.id)}/close`,
          headers: todoistAuthorizationHeaders(token)
        })
      )

      if (!isSuccessStatus(response.status)) {
        return todoistProviderFailure({
          code: 'todoist_close_task_failed',
          message: 'Todoist close task failed',
          status: response.status,
          body: response.body
        })
      }

      return ActionResult.success(TodoistCloseTaskOutput.make({ id: input.id, closed: true }))
    })
})

export const todoistActions = [todoistListTasksAction, todoistCreateTaskAction, todoistCloseTaskAction]

export const TodoistConnector = defineConnector({
  id: todoistConnectorId,
  description: 'Todoist task connector actions.',
  actions: todoistActions
})
