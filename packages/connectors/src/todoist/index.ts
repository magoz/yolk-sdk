import { Effect, Result } from 'effect'
import * as Schema from 'effect/Schema'
import { defineAction } from '../action.ts'
import { defineConnector } from '../connector.ts'
import { CredentialSlot, resolveCredential } from '../credential.ts'
import { ConnectorError } from '../error.ts'
import { ConnectorHttpClient, ConnectorHttpRequest, decodeJsonResponse } from '../http.ts'
import { ActionResult, ProviderFailure } from '../result.ts'
import type { ConnectorIntegration } from '../integration.ts'

export const todoistConnectorId = 'todoist'
export const todoistApiTokenSlotId = 'todoist.api_token'
export const todoistApiBaseUrl = 'https://api.todoist.com/api/v1'

export const TodoistApiTokenSlot = CredentialSlot.make({
  id: todoistApiTokenSlotId,
  kind: 'api_key'
})

const JsonObject = Schema.Record(Schema.String, Schema.Unknown)
const isJsonObject = Schema.is(JsonObject)

export const todoistAuthorizationHeaders = (token: string) => ({
  authorization: `Bearer ${token}`
})

const isSuccessStatus = (status: number) => status >= 200 && status < 300

const decodeJsonObject = (body: string) =>
  Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(body).pipe(
    Effect.result,
    Effect.map(result => {
      if (Result.isFailure(result) || !isJsonObject(result.success)) return undefined
      return result.success
    })
  )

const jsonMessageField = (body: string, keys: ReadonlyArray<string>) =>
  decodeJsonObject(body).pipe(
    Effect.map(parsed => {
      if (parsed === undefined) return undefined
      for (const key of keys) {
        const value = parsed[key]
        if (typeof value === 'string' && value.trim() !== '') return value
      }
      return undefined
    })
  )

const providerMessage = (fallback: string, body: string) =>
  jsonMessageField(body, ['error', 'message', 'error_description', 'error_tag']).pipe(
    Effect.map(detail => (detail === undefined ? fallback : `${fallback}: ${detail}`))
  )

const providerCode = (fallback: string, status: number) => {
  switch (status) {
    case 401:
    case 403:
      return 'todoist_unauthorized'
    case 404:
      return 'todoist_not_found'
    case 429:
      return 'todoist_rate_limited'
    default:
      return fallback
  }
}

const todoistProviderFailure = (input: {
  readonly code: string
  readonly message: string
  readonly status: number
  readonly body: string
}) =>
  providerMessage(input.message, input.body).pipe(
    Effect.map(message =>
      ActionResult.failure(
        new ProviderFailure({
          code: providerCode(input.code, input.status),
          message,
          status: input.status,
          underlying: input.body
        })
      )
    )
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
  project_id: Schema.optional(Schema.String),
  sectionId: Schema.optional(Schema.NullOr(Schema.String)),
  section_id: Schema.optional(Schema.NullOr(Schema.String)),
  parentId: Schema.optional(Schema.NullOr(Schema.String)),
  parent_id: Schema.optional(Schema.NullOr(Schema.String)),
  labels: Schema.optional(Schema.Array(Schema.String)),
  priority: Schema.optional(Schema.Number),
  due: Schema.optional(Schema.Unknown),
  url: Schema.optional(Schema.String)
}) {}

export class TodoistListTasksInput extends Schema.Class<TodoistListTasksInput>(
  'TodoistListTasksInput'
)({
  projectId: Schema.optional(Schema.String),
  project_id: Schema.optional(Schema.String),
  sectionId: Schema.optional(Schema.String),
  section_id: Schema.optional(Schema.String),
  parentId: Schema.optional(Schema.String),
  parent_id: Schema.optional(Schema.String),
  label: Schema.optional(Schema.String),
  ids: Schema.optional(Schema.String),
  filter: Schema.optional(Schema.String),
  filterLang: Schema.optional(Schema.String),
  filter_lang: Schema.optional(Schema.String),
  cursor: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Number)
}) {}

export class TodoistListTasksOutput extends Schema.Class<TodoistListTasksOutput>(
  'TodoistListTasksOutput'
)({
  tasks: Schema.Array(TodoistTask),
  nextCursor: Schema.NullOr(Schema.String)
}) {}

const TodoistListTasksApiOutput = Schema.Struct({
  results: Schema.Array(TodoistTask),
  next_cursor: Schema.NullOr(Schema.String)
})

export class TodoistCreateTaskInput extends Schema.Class<TodoistCreateTaskInput>(
  'TodoistCreateTaskInput'
)({
  content: Schema.String,
  description: Schema.optional(Schema.String),
  projectId: Schema.optional(Schema.String),
  project_id: Schema.optional(Schema.String),
  sectionId: Schema.optional(Schema.String),
  section_id: Schema.optional(Schema.String),
  parentId: Schema.optional(Schema.String),
  parent_id: Schema.optional(Schema.String),
  labels: Schema.optional(Schema.Array(Schema.String)),
  priority: Schema.optional(Schema.Number),
  dueString: Schema.optional(Schema.String),
  due_string: Schema.optional(Schema.String),
  dueDate: Schema.optional(Schema.String),
  due_date: Schema.optional(Schema.String),
  dueDatetime: Schema.optional(Schema.String),
  due_datetime: Schema.optional(Schema.String),
  dueLang: Schema.optional(Schema.String),
  due_lang: Schema.optional(Schema.String),
  assigneeId: Schema.optional(Schema.String),
  assignee_id: Schema.optional(Schema.String),
  duration: Schema.optional(Schema.Number),
  durationUnit: Schema.optional(Schema.String),
  duration_unit: Schema.optional(Schema.String),
  deadlineDate: Schema.optional(Schema.String),
  deadline_date: Schema.optional(Schema.String)
}) {}

export class TodoistCloseTaskInput extends Schema.Class<TodoistCloseTaskInput>(
  'TodoistCloseTaskInput'
)({
  id: Schema.optional(Schema.String),
  taskId: Schema.optional(Schema.String),
  task_id: Schema.optional(Schema.String)
}) {}

export class TodoistCloseTaskOutput extends Schema.Class<TodoistCloseTaskOutput>(
  'TodoistCloseTaskOutput'
)({
  id: Schema.String,
  closed: Schema.Boolean
}) {}

export class TodoistPaginationInput extends Schema.Class<TodoistPaginationInput>(
  'TodoistPaginationInput'
)({
  cursor: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Number)
}) {}

export class TodoistProject extends Schema.Class<TodoistProject>('TodoistProject')({
  id: Schema.String,
  name: Schema.String,
  commentCount: Schema.optional(Schema.Number),
  comment_count: Schema.optional(Schema.Number),
  order: Schema.optional(Schema.Number),
  child_order: Schema.optional(Schema.Number),
  color: Schema.optional(Schema.String),
  isShared: Schema.optional(Schema.Boolean),
  is_shared: Schema.optional(Schema.Boolean),
  isFavorite: Schema.optional(Schema.Boolean),
  is_favorite: Schema.optional(Schema.Boolean),
  parent_id: Schema.optional(Schema.NullOr(Schema.String)),
  url: Schema.optional(Schema.String)
}) {}

export class TodoistLabel extends Schema.Class<TodoistLabel>('TodoistLabel')({
  id: Schema.String,
  name: Schema.String,
  color: Schema.optional(Schema.String),
  order: Schema.optional(Schema.Number),
  isFavorite: Schema.optional(Schema.Boolean),
  is_favorite: Schema.optional(Schema.Boolean)
}) {}

export class TodoistListProjectsOutput extends Schema.Class<TodoistListProjectsOutput>(
  'TodoistListProjectsOutput'
)({
  projects: Schema.Array(TodoistProject),
  nextCursor: Schema.NullOr(Schema.String)
}) {}

const TodoistListProjectsApiOutput = Schema.Struct({
  results: Schema.Array(TodoistProject),
  next_cursor: Schema.NullOr(Schema.String)
})

export class TodoistListLabelsOutput extends Schema.Class<TodoistListLabelsOutput>(
  'TodoistListLabelsOutput'
)({
  labels: Schema.Array(TodoistLabel),
  nextCursor: Schema.NullOr(Schema.String)
}) {}

const TodoistListLabelsApiOutput = Schema.Struct({
  results: Schema.Array(TodoistLabel),
  next_cursor: Schema.NullOr(Schema.String)
})

export class TodoistProjectIdInput extends Schema.Class<TodoistProjectIdInput>(
  'TodoistProjectIdInput'
)({
  projectId: Schema.optional(Schema.String),
  project_id: Schema.optional(Schema.String)
}) {}

export class TodoistTaskIdInput extends Schema.Class<TodoistTaskIdInput>('TodoistTaskIdInput')({
  taskId: Schema.optional(Schema.String),
  task_id: Schema.optional(Schema.String)
}) {}

export class TodoistCreateProjectInput extends Schema.Class<TodoistCreateProjectInput>(
  'TodoistCreateProjectInput'
)({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  parentId: Schema.optional(Schema.String),
  parent_id: Schema.optional(Schema.String),
  color: Schema.optional(Schema.String),
  isFavorite: Schema.optional(Schema.Boolean),
  is_favorite: Schema.optional(Schema.Boolean),
  viewStyle: Schema.optional(Schema.String),
  view_style: Schema.optional(Schema.String)
}) {}

export class TodoistUpdateProjectInput extends Schema.Class<TodoistUpdateProjectInput>(
  'TodoistUpdateProjectInput'
)({
  projectId: Schema.optional(Schema.String),
  project_id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  color: Schema.optional(Schema.String),
  isFavorite: Schema.optional(Schema.Boolean),
  is_favorite: Schema.optional(Schema.Boolean),
  viewStyle: Schema.optional(Schema.String),
  view_style: Schema.optional(Schema.String)
}) {}

export class TodoistUpdateTaskInput extends Schema.Class<TodoistUpdateTaskInput>(
  'TodoistUpdateTaskInput'
)({
  taskId: Schema.optional(Schema.String),
  task_id: Schema.optional(Schema.String),
  content: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  labels: Schema.optional(Schema.Array(Schema.String)),
  priority: Schema.optional(Schema.Number),
  dueString: Schema.optional(Schema.String),
  due_string: Schema.optional(Schema.String),
  dueDate: Schema.optional(Schema.String),
  due_date: Schema.optional(Schema.String),
  dueDatetime: Schema.optional(Schema.String),
  due_datetime: Schema.optional(Schema.String),
  dueLang: Schema.optional(Schema.String),
  due_lang: Schema.optional(Schema.String),
  assigneeId: Schema.optional(Schema.String),
  assignee_id: Schema.optional(Schema.String),
  duration: Schema.optional(Schema.Number),
  durationUnit: Schema.optional(Schema.String),
  duration_unit: Schema.optional(Schema.String),
  deadlineDate: Schema.optional(Schema.String),
  deadline_date: Schema.optional(Schema.String)
}) {}

const appendSearchParam = (params: URLSearchParams, key: string, value: string | undefined) => {
  if (value !== undefined && value.trim() !== '') {
    params.set(key, value)
  }
}

const appendNumberSearchParam = (params: URLSearchParams, key: string, value: number | undefined) => {
  if (value !== undefined) {
    params.set(key, String(value))
  }
}

const todoistProjectId = (input: TodoistProjectIdInput | TodoistUpdateProjectInput) =>
  input.project_id ?? input.projectId

const todoistTaskId = (input: TodoistTaskIdInput | TodoistUpdateTaskInput) =>
  input.task_id ?? input.taskId

const todoistCloseTaskId = (input: TodoistCloseTaskInput) =>
  input.task_id ?? input.taskId ?? input.id

const requireTodoistProjectId = (
  input: TodoistProjectIdInput | TodoistUpdateProjectInput,
  actionId: string
) =>
  Effect.gen(function* () {
    const projectId = todoistProjectId(input)
    if (projectId !== undefined) return projectId

    return yield* Effect.fail(
      new ConnectorError({
        cause: 'validation_failed',
        message: 'Todoist action requires projectId or project_id',
        connectorId: todoistConnectorId,
        actionId
      })
    )
  })

const requireTodoistTaskId = (input: TodoistTaskIdInput | TodoistUpdateTaskInput, actionId: string) =>
  Effect.gen(function* () {
    const taskId = todoistTaskId(input)
    if (taskId !== undefined) return taskId

    return yield* Effect.fail(
      new ConnectorError({
        cause: 'validation_failed',
        message: 'Todoist action requires taskId or task_id',
        connectorId: todoistConnectorId,
        actionId
      })
    )
  })

const requireTodoistCloseTaskId = (input: TodoistCloseTaskInput) =>
  Effect.gen(function* () {
    const taskId = todoistCloseTaskId(input)
    if (taskId !== undefined) return taskId

    return yield* Effect.fail(
      new ConnectorError({
        cause: 'validation_failed',
        message: 'Todoist close task requires id, taskId, or task_id',
        connectorId: todoistConnectorId,
        actionId: 'todoist.close_task'
      })
    )
  })

const todoistRequest = (input: {
  readonly token: string
  readonly method: 'GET' | 'POST' | 'DELETE'
  readonly path: string
  readonly body?: unknown
}) => {
  const headers =
    input.body === undefined
      ? todoistAuthorizationHeaders(input.token)
      : { ...todoistAuthorizationHeaders(input.token), 'content-type': 'application/json' }

  return ConnectorHttpRequest.make({
    method: input.method,
    url: `${todoistApiBaseUrl}${input.path}`,
    headers,
    body: input.body === undefined ? undefined : JSON.stringify(input.body)
  })
}

const todoistJsonAction = <A>(input: {
  readonly integration: ConnectorIntegration
  readonly request: (token: string) => ConnectorHttpRequest
  readonly outputSchema: Schema.Schema<A> & { readonly DecodingServices: never }
  readonly errorCode: string
  readonly errorMessage: string
}) =>
  Effect.gen(function* () {
    const token = yield* resolveTodoistToken(input.integration)
    const http = yield* ConnectorHttpClient
    const response = yield* http.request(input.request(token))

    if (!isSuccessStatus(response.status)) {
      return yield* todoistProviderFailure({
        code: input.errorCode,
        message: input.errorMessage,
        status: response.status,
        body: response.body
      })
    }

    const output = yield* decodeJsonResponse(input.outputSchema, response)
    return ActionResult.success(output)
  })

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
      const path = input.filter === undefined ? '/tasks' : '/tasks/filter'
      if (input.filter === undefined) {
        appendSearchParam(params, 'project_id', input.project_id ?? input.projectId)
        appendSearchParam(params, 'section_id', input.section_id ?? input.sectionId)
        appendSearchParam(params, 'parent_id', input.parent_id ?? input.parentId)
        appendSearchParam(params, 'label', input.label)
        appendSearchParam(params, 'ids', input.ids)
      } else {
        appendSearchParam(params, 'query', input.filter)
        appendSearchParam(params, 'lang', input.filter_lang ?? input.filterLang)
      }
      appendSearchParam(params, 'cursor', input.cursor)
      appendNumberSearchParam(params, 'limit', input.limit)
      const query = params.toString()
      const response = yield* http.request(
        ConnectorHttpRequest.make({
          method: 'GET',
          url: `${todoistApiBaseUrl}${path}${query === '' ? '' : `?${query}`}`,
          headers: todoistAuthorizationHeaders(token)
        })
      )

      if (!isSuccessStatus(response.status)) {
        return yield* todoistProviderFailure({
          code: 'todoist_list_tasks_failed',
          message: 'Todoist list tasks failed',
          status: response.status,
          body: response.body
        })
      }

      const output = yield* decodeJsonResponse(TodoistListTasksApiOutput, response)
      return ActionResult.success(
        TodoistListTasksOutput.make({
          tasks: output.results,
          nextCursor: output.next_cursor
        })
      )
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
            project_id: input.project_id ?? input.projectId,
            section_id: input.section_id ?? input.sectionId,
            parent_id: input.parent_id ?? input.parentId,
            labels: input.labels,
            priority: input.priority,
            due_string: input.due_string ?? input.dueString,
            due_date: input.due_date ?? input.dueDate,
            due_datetime: input.due_datetime ?? input.dueDatetime,
            due_lang: input.due_lang ?? input.dueLang,
            assignee_id: input.assignee_id ?? input.assigneeId,
            duration: input.duration,
            duration_unit: input.duration_unit ?? input.durationUnit,
            deadline_date: input.deadline_date ?? input.deadlineDate
          })
        })
      )

      if (!isSuccessStatus(response.status)) {
        return yield* todoistProviderFailure({
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
      const taskId = yield* requireTodoistCloseTaskId(input)
      const token = yield* resolveTodoistToken(integration)
      const http = yield* ConnectorHttpClient
      const response = yield* http.request(
        ConnectorHttpRequest.make({
          method: 'POST',
          url: `${todoistApiBaseUrl}/tasks/${encodeURIComponent(taskId)}/close`,
          headers: todoistAuthorizationHeaders(token)
        })
      )

      if (!isSuccessStatus(response.status)) {
        return yield* todoistProviderFailure({
          code: 'todoist_close_task_failed',
          message: 'Todoist close task failed',
          status: response.status,
          body: response.body
        })
      }

      return ActionResult.success(
        TodoistCloseTaskOutput.make({ id: taskId, closed: true })
      )
    })
})

export const todoistListProjectsAction = defineAction({
  id: 'todoist.list_projects',
  description: 'List Todoist projects.',
  inputSchema: TodoistPaginationInput,
  outputSchema: TodoistListProjectsOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const result = yield* todoistJsonAction({
        integration,
        request: token => {
          const params = new URLSearchParams()
          appendSearchParam(params, 'cursor', input.cursor)
          appendNumberSearchParam(params, 'limit', input.limit)
          const query = params.toString()
          return todoistRequest({
            token,
            method: 'GET',
            path: `/projects${query === '' ? '' : `?${query}`}`
          })
        },
        outputSchema: TodoistListProjectsApiOutput,
        errorCode: 'todoist_list_projects_failed',
        errorMessage: 'Todoist list projects failed'
      })
      if (result._tag === 'Failure') return result
      return ActionResult.success(
        TodoistListProjectsOutput.make({
          projects: result.value.results,
          nextCursor: result.value.next_cursor
        })
      )
    })
})

export const todoistCreateProjectAction = defineAction({
  id: 'todoist.create_project',
  description: 'Create a Todoist project.',
  inputSchema: TodoistCreateProjectInput,
  outputSchema: TodoistProject,
  execute: ({ integration, input }) =>
    todoistJsonAction({
      integration,
      request: token =>
        todoistRequest({
          token,
          method: 'POST',
          path: '/projects',
          body: {
            name: input.name,
            description: input.description,
            parent_id: input.parent_id ?? input.parentId,
            color: input.color,
            is_favorite: input.is_favorite ?? input.isFavorite,
            view_style: input.view_style ?? input.viewStyle
          }
        }),
      outputSchema: TodoistProject,
      errorCode: 'todoist_create_project_failed',
      errorMessage: 'Todoist create project failed'
    })
})

export const todoistGetProjectAction = defineAction({
  id: 'todoist.get_project',
  description: 'Get a Todoist project.',
  inputSchema: TodoistProjectIdInput,
  outputSchema: TodoistProject,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const projectId = yield* requireTodoistProjectId(input, 'todoist.get_project')
      return yield* todoistJsonAction({
        integration,
        request: token =>
          todoistRequest({
            token,
            method: 'GET',
            path: `/projects/${encodeURIComponent(projectId)}`
          }),
        outputSchema: TodoistProject,
        errorCode: 'todoist_get_project_failed',
        errorMessage: 'Todoist get project failed'
      })
    })
})

export const todoistUpdateProjectAction = defineAction({
  id: 'todoist.update_project',
  description: 'Update a Todoist project.',
  inputSchema: TodoistUpdateProjectInput,
  outputSchema: TodoistProject,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const projectId = yield* requireTodoistProjectId(input, 'todoist.update_project')
      return yield* todoistJsonAction({
        integration,
        request: token =>
          todoistRequest({
            token,
            method: 'POST',
            path: `/projects/${encodeURIComponent(projectId)}`,
            body: {
              name: input.name,
              description: input.description,
              color: input.color,
              is_favorite: input.is_favorite ?? input.isFavorite,
              view_style: input.view_style ?? input.viewStyle
            }
          }),
        outputSchema: TodoistProject,
        errorCode: 'todoist_update_project_failed',
        errorMessage: 'Todoist update project failed'
      })
    })
})

export const todoistDeleteProjectAction = defineAction({
  id: 'todoist.delete_project',
  description: 'Delete a Todoist project.',
  inputSchema: TodoistProjectIdInput,
  outputSchema: Schema.Struct({ deleted: Schema.Boolean, projectId: Schema.String }),
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const projectId = yield* requireTodoistProjectId(input, 'todoist.delete_project')
      const token = yield* resolveTodoistToken(integration)
      const http = yield* ConnectorHttpClient
      const response = yield* http.request(
        todoistRequest({
          token,
          method: 'DELETE',
          path: `/projects/${encodeURIComponent(projectId)}`
        })
      )

      if (!isSuccessStatus(response.status)) {
        return yield* todoistProviderFailure({
          code: 'todoist_delete_project_failed',
          message: 'Todoist delete project failed',
          status: response.status,
          body: response.body
        })
      }

      return ActionResult.success({ deleted: true, projectId })
    })
})

export const todoistGetTaskAction = defineAction({
  id: 'todoist.get_task',
  description: 'Get a Todoist task.',
  inputSchema: TodoistTaskIdInput,
  outputSchema: TodoistTask,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const taskId = yield* requireTodoistTaskId(input, 'todoist.get_task')
      return yield* todoistJsonAction({
        integration,
        request: token =>
          todoistRequest({
            token,
            method: 'GET',
            path: `/tasks/${encodeURIComponent(taskId)}`
          }),
        outputSchema: TodoistTask,
        errorCode: 'todoist_get_task_failed',
        errorMessage: 'Todoist get task failed'
      })
    })
})

export const todoistUpdateTaskAction = defineAction({
  id: 'todoist.update_task',
  description: 'Update a Todoist task.',
  inputSchema: TodoistUpdateTaskInput,
  outputSchema: TodoistTask,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const taskId = yield* requireTodoistTaskId(input, 'todoist.update_task')
      return yield* todoistJsonAction({
        integration,
        request: token =>
          todoistRequest({
            token,
            method: 'POST',
            path: `/tasks/${encodeURIComponent(taskId)}`,
            body: {
              content: input.content,
              description: input.description,
              labels: input.labels,
              priority: input.priority,
              due_string: input.due_string ?? input.dueString,
              due_date: input.due_date ?? input.dueDate,
              due_datetime: input.due_datetime ?? input.dueDatetime,
              due_lang: input.due_lang ?? input.dueLang,
              assignee_id: input.assignee_id ?? input.assigneeId,
              duration: input.duration,
              duration_unit: input.duration_unit ?? input.durationUnit,
              deadline_date: input.deadline_date ?? input.deadlineDate
            }
          }),
        outputSchema: TodoistTask,
        errorCode: 'todoist_update_task_failed',
        errorMessage: 'Todoist update task failed'
      })
    })
})

export const todoistDeleteTaskAction = defineAction({
  id: 'todoist.delete_task',
  description: 'Delete a Todoist task.',
  inputSchema: TodoistTaskIdInput,
  outputSchema: Schema.Struct({ deleted: Schema.Boolean, taskId: Schema.String }),
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const taskId = yield* requireTodoistTaskId(input, 'todoist.delete_task')
      const token = yield* resolveTodoistToken(integration)
      const http = yield* ConnectorHttpClient
      const response = yield* http.request(
        todoistRequest({
          token,
          method: 'DELETE',
          path: `/tasks/${encodeURIComponent(taskId)}`
        })
      )

      if (!isSuccessStatus(response.status)) {
        return yield* todoistProviderFailure({
          code: 'todoist_delete_task_failed',
          message: 'Todoist delete task failed',
          status: response.status,
          body: response.body
        })
      }

      return ActionResult.success({ deleted: true, taskId })
    })
})

export const todoistListLabelsAction = defineAction({
  id: 'todoist.list_labels',
  description: 'List Todoist labels.',
  inputSchema: TodoistPaginationInput,
  outputSchema: TodoistListLabelsOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const result = yield* todoistJsonAction({
        integration,
        request: token => {
          const params = new URLSearchParams()
          appendSearchParam(params, 'cursor', input.cursor)
          appendNumberSearchParam(params, 'limit', input.limit)
          const query = params.toString()
          return todoistRequest({
            token,
            method: 'GET',
            path: `/labels${query === '' ? '' : `?${query}`}`
          })
        },
        outputSchema: TodoistListLabelsApiOutput,
        errorCode: 'todoist_list_labels_failed',
        errorMessage: 'Todoist list labels failed'
      })
      if (result._tag === 'Failure') return result
      return ActionResult.success(
        TodoistListLabelsOutput.make({
          labels: result.value.results,
          nextCursor: result.value.next_cursor
        })
      )
    })
})

export const todoistActions = [
  todoistListProjectsAction,
  todoistCreateProjectAction,
  todoistGetProjectAction,
  todoistUpdateProjectAction,
  todoistDeleteProjectAction,
  todoistListTasksAction,
  todoistCreateTaskAction,
  todoistGetTaskAction,
  todoistUpdateTaskAction,
  todoistCloseTaskAction,
  todoistDeleteTaskAction,
  todoistListLabelsAction
]

export const TodoistConnector = defineConnector({
  id: todoistConnectorId,
  description: 'Todoist task connector actions.',
  actions: todoistActions
})
