/**
 * Todoist emulator API: the route table (evidence, query allowlist, handler), route matching, and
 * the registration of the stateful handlers on the `@emulators/core` app (internal; re-exported
 * by `src/todoist.ts`).
 *
 * Only the routes the seven Todoist conformance cases (and their cleanup) need are emulated, with
 * wire shapes copied from the synthetic fixtures; everything else answers the wrapper's ledgered
 * 400 not-emulated. Each route lists the cases whose claims it follows. The project listing that
 * the read-only leftover lookup (`findTodoistConformanceLeftovers`) sends has no fixture, so it is
 * not emulated: the lookup fails, and runners print their lookup-failed WARN.
 *
 * @experimental
 */
import type { Hono } from '@emulators/core'
import { Predicate } from 'effect'
import type * as Schema from 'effect/Schema'
import { handlerFailedResponse } from '../emulator-http.ts'
import type { EmulatorRouteEvidence } from '../route-evidence.ts'
import {
  commit,
  coreResponse,
  isRefusal,
  notEmulatedCoreResponse,
  parseJsonText,
  refuse,
  type CoreOutcome,
  type CoreRefusal
} from '../stateful-fixture.ts'
import {
  isTodoistMintedId,
  makeTodoistProject,
  makeTodoistTask,
  todoistIdPattern,
  todoistMintedProjectPrefix,
  todoistMintedTaskPrefix,
  todoistPagingProjectId,
  type TodoistEmulatorDue,
  type TodoistEmulatorProject,
  type TodoistEmulatorState,
  type TodoistEmulatorTask
} from './state.ts'

/** API v1 prefix of every Todoist route. */
export const todoistEmulatorBasePath = '/api/v1'

/** Drill knobs (tests only): each makes the emulator disagree with one conformance claim. */
export type TodoistEmulatorDrills = {
  /** `true`: a task-listing cursor leads back to the first page (tasks repeat across pages). */
  readonly cursorRestarts?: boolean
  /** `true`: 404 bodies omit the `error` message. */
  readonly notFoundWithoutError?: boolean
  /** `true`: tasks answer their labels as label ids instead of names. */
  readonly taskLabelsAsIds?: boolean
  /** `true`: task listings include closed tasks. */
  readonly listIncludesClosed?: boolean
  /** `true`: `due_date` / `due_datetime` are accepted but not applied (`due` stays `null`). */
  readonly ignoreDue?: boolean
  /** `true`: a project create answers `parent_id: null` (the project still has its parent). */
  readonly createOmitsParent?: boolean
  /** `true`: deleting a project keeps its tasks. */
  readonly deleteKeepsTasks?: boolean
}

/** Where a task-listing cursor leads (runtime data, like the ledger; not in the state). */
export type TodoistCursor = {
  readonly id: string
  readonly projectId: string
  readonly limit: string
  readonly offset: number
}

export type TodoistApiEnv = {
  /** Clock in epoch milliseconds (timestamps of created and closed items). */
  readonly now: () => number
  readonly drills: Required<TodoistEmulatorDrills>
  /** Task-listing cursors by id (runtime-only; cleared by reset and seed). */
  readonly cursors: Map<string, TodoistCursor>
  readonly cursorCounter: { next: number }
}

type RouteRequest = {
  /** Path parameters (Todoist ids, matched raw). */
  readonly params: Readonly<Record<string, string>>
  readonly query: URLSearchParams
  /** Parsed JSON body; `undefined` when absent. */
  readonly body: Schema.Json | undefined
  /** The request carried a non-empty body. */
  readonly hasBody: boolean
  readonly contentType: string | null
}

/**
 * A route handler: it validates the request and the state without writing (a refusal), then
 * returns a commit whose `run` performs every write (see `CoreOutcome`).
 */
type RouteHandler = (
  state: TodoistEmulatorState,
  request: RouteRequest,
  env: TodoistApiEnv
) => CoreOutcome

type TodoistApiRoute = EmulatorRouteEvidence & {
  /** Query parameters the route emulates; any other (or a repeated) key is not emulated. */
  readonly queryKeys: ReadonlyArray<string>
  readonly handler: RouteHandler
}

const pagingCase = 'todoist.tasks.list-cursor-paging'

const notFoundCase = 'todoist.errors.not-found-envelope'

const labelsCase = 'todoist.labels.task-labels-are-names'

const lifecycleCase = 'todoist.tasks.lifecycle-close'

const dueCase = 'todoist.tasks.due-dates'

const parentCase = 'todoist.projects.parent-id'

const deleteCase = 'todoist.projects.delete-then-not-found'

/** Every write case creates, reads, and deletes its own project. */
const projectCases = [lifecycleCase, dueCase, parentCase, deleteCase]

/** The task listing page size the fixtures send (the only one emulated), and the largest
 * unlimited listing they record. */
const taskLimit = 2

/** The `limit` the label listing fixture sends (the largest one emulated). */
const maxListLimit = 200

/** The only due values the due-dates fixture records, with the due objects it answers. */
const recordedDueDate = '2030-01-15'

const recordedDueDatetime = '2030-01-15T12:00:00Z'

const dueOfDate: TodoistEmulatorDue = {
  date: recordedDueDate,
  timezone: null,
  string: 'Jan 15 2030',
  lang: 'en',
  is_recurring: false
}

const dueOfDatetime: TodoistEmulatorDue = {
  date: recordedDueDatetime,
  timezone: 'UTC',
  string: 'Jan 15 2030 12:00',
  lang: 'en',
  is_recurring: false
}

/**
 * Case project names: `yolk-conformance-<runId>-<suffix>` with a conformance run id (`run-` then
 * lower-case letters, digits, and inner hyphens, at most 40 characters) and a recorded suffix.
 */
const caseProjectNamePattern =
  /^yolk-conformance-(run-[a-z0-9]+(?:-[a-z0-9]+)*)-(lifecycle|due|parent|delete)$/

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })

const noContent = (): Response => new Response(null, { status: 204 })

const padded = (value: number, width: number): string => String(value).padStart(width, '0')

/** An API v1 timestamp (`2026-09-30T12:00:00.000000Z`) from the clock; throws on a bad clock. */
const timestamp = (env: TodoistApiEnv): string => {
  const value = env.now()

  if (!Number.isFinite(value)) throw new Error('the emulator clock is not a finite instant')

  return `${new Date(value).toISOString().slice(0, 23)}000Z`
}

/** The 404 error body of the fixtures, with the next synthetic `event_id`. */
const notFound = (state: TodoistEmulatorState, env: TodoistApiEnv, error: string): Response => {
  const number = state.counters.nextEventNumber

  state.counters = { ...state.counters, nextEventNumber: number + 1 }

  const rest = {
    error_code: 478,
    error_extra: { event_id: padded(number, 32) },
    error_tag: 'NOT_FOUND',
    http_code: 404
  }

  return json(404, env.drills.notFoundWithoutError ? rest : { error, ...rest })
}

const projectWire = (project: TodoistEmulatorProject) =>
  makeTodoistProject({
    id: project.id,
    name: project.name,
    parentId: project.parent_id,
    childOrder: project.child_order,
    createdAt: project.created_at,
    updatedAt: project.updated_at
  })

const taskWire = (state: TodoistEmulatorState, env: TodoistApiEnv, task: TodoistEmulatorTask) => ({
  id: task.id,
  user_id: task.user_id,
  project_id: task.project_id,
  section_id: task.section_id,
  parent_id: task.parent_id,
  added_by_uid: task.added_by_uid,
  assigned_by_uid: task.assigned_by_uid,
  responsible_uid: task.responsible_uid,
  labels: env.drills.taskLabelsAsIds
    ? task.labels.map(name => state.labels.find(item => item.name === name)?.id ?? name)
    : task.labels,
  deadline: task.deadline,
  duration: task.duration,
  checked: task.checked,
  is_deleted: task.is_deleted,
  added_at: task.added_at,
  completed_at: task.completed_at,
  updated_at: task.updated_at,
  due: task.due,
  priority: task.priority,
  child_order: task.child_order,
  content: task.content,
  description: task.description,
  note_count: task.note_count,
  day_order: task.day_order,
  is_collapsed: task.is_collapsed
})

const isJsonObject = (value: Schema.Json | undefined): value is Schema.JsonObject =>
  value !== undefined && value !== null && Predicate.isObject(value) && !Array.isArray(value)

const mediaType = (contentType: string | null): string | undefined =>
  contentType?.split(';', 1)[0]?.trim().toLowerCase()

/**
 * A write body: `application/json`, a JSON object with only `allowed` keys and every `required`
 * key, or a refusal.
 */
const bodyObject = (
  request: RouteRequest,
  allowed: ReadonlyArray<string>,
  required: ReadonlyArray<string>
): Schema.JsonObject | CoreRefusal => {
  if (mediaType(request.contentType) !== 'application/json') {
    return refuse('write bodies other than application/json are not emulated')
  }

  if (!isJsonObject(request.body)) {
    return refuse('a request body that is not a JSON object is not emulated')
  }

  const keys = Object.keys(request.body)
  const unknown = keys.find(key => !allowed.includes(key))

  if (unknown !== undefined) {
    return refuse(`the body field ${unknown} is not emulated on this route`)
  }

  const missing = required.find(key => !keys.includes(key))

  return missing === undefined
    ? request.body
    : refuse(`requests without the body field ${missing} are not emulated on this route`)
}

const noBody = (request: RouteRequest): CoreRefusal | undefined =>
  request.hasBody ? refuse('a request body is not emulated on this route') : undefined

/** A positive integer query value: `undefined` when absent, a refusal when not in `allowed`. */
const limitOf = (
  request: RouteRequest,
  allowed: (value: number) => boolean,
  what: string
): number | undefined | CoreRefusal => {
  const raw = request.query.get('limit')

  if (raw === null) return undefined

  const value = Number(raw)

  return /^[1-9][0-9]{0,3}$/.test(raw) && allowed(value)
    ? value
    : refuse(`limit must be ${what} (as the fixtures send it)`)
}

/** A task created through the recorded create flow (never a seeded one), still active. */
const createdActiveTask = (state: TodoistEmulatorState, id: string) =>
  isTodoistMintedId(id, todoistMintedTaskPrefix)
    ? state.tasks.find(task => task.id === id && !task.checked)
    : undefined

/** A case project created through the recorded create flow (never a seeded one). */
const createdProject = (state: TodoistEmulatorState, id: string) =>
  isTodoistMintedId(id, todoistMintedProjectPrefix)
    ? state.projects.find(project => project.id === id)
    : undefined

const byOrder = (left: TodoistEmulatorTask, right: TodoistEmulatorTask): number =>
  left.child_order - right.child_order || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)

// Handlers: validate (refuse) first, then `commit` the writes.

const listTasks: RouteHandler = (state, request, env) => {
  const projectId = request.query.get('project_id')

  if (projectId === null) return refuse('task listings without project_id are not emulated')

  if (!state.projects.some(project => project.id === projectId)) {
    return refuse('a task listing of an unknown project is not emulated')
  }

  const limit = limitOf(request, value => value === taskLimit, String(taskLimit))

  if (isRefusal(limit)) return limit

  // The fixtures record two listings only: the paging project with `limit=2`, and a case project
  // created here without `limit`.
  const recorded =
    limit === undefined
      ? createdProject(state, projectId) !== undefined
      : projectId === todoistPagingProjectId

  if (!recorded) {
    return refuse(
      'task listings other than the paging project with limit=2 or a case project created here ' +
        'without limit are not emulated'
    )
  }

  const tasks = state.tasks
    .filter(
      task => task.project_id === projectId && (env.drills.listIncludesClosed || !task.checked)
    )
    .sort(byOrder)

  const rawCursor = request.query.get('cursor')
  const cursor = rawCursor === null ? undefined : env.cursors.get(rawCursor)

  // Cursors are valid only as issued by this emulator since its last reset or seed.
  if (rawCursor !== null && cursor === undefined) {
    return refuse('a cursor this emulator did not issue is not emulated')
  }

  if (
    cursor !== undefined &&
    (cursor.projectId !== projectId || cursor.limit !== request.query.get('limit'))
  ) {
    return refuse('a cursor sent with another project_id or limit is not emulated')
  }

  // A case project holds at most one task, so its unlimited listing is always one page.
  if (limit === undefined) {
    return commit(() =>
      json(200, { results: tasks.map(task => taskWire(state, env, task)), next_cursor: null })
    )
  }

  const offset = cursor === undefined || env.drills.cursorRestarts ? 0 : cursor.offset
  const end = offset + limit

  return commit(() => {
    let next: string | null = null

    if (end < tasks.length) {
      next = `SyntheticTaskCursor${padded(env.cursorCounter.next++, 4)}`
      env.cursors.set(next, { id: next, projectId, limit: String(limit), offset: end })
    }

    return json(200, {
      results: tasks.slice(offset, end).map(task => taskWire(state, env, task)),
      next_cursor: next
    })
  })
}

const getTask: RouteHandler = (state, request, env) => {
  const id = request.params.taskId ?? ''
  const task = state.tasks.find(candidate => candidate.id === id)

  if (task === undefined) return commit(() => notFound(state, env, 'Task not found'))

  return task.checked
    ? refuse('reading a closed task is not emulated')
    : commit(() => json(200, taskWire(state, env, task)))
}

const createTask: RouteHandler = (state, request, env) => {
  const body = bodyObject(request, ['content', 'project_id', 'due_date'], ['content', 'project_id'])

  if (isRefusal(body)) return body

  const { content, project_id: projectId, due_date: dueDate } = body

  if (!Predicate.isString(content) || content === '') {
    return refuse('content must be a non-empty string')
  }

  if (!Predicate.isString(projectId) || createdProject(state, projectId) === undefined) {
    return refuse('a task outside a case project created here is not emulated')
  }

  // The fixtures record one task per case project (`child_order: 1`).
  if (state.tasks.some(item => item.project_id === projectId)) {
    return refuse('a second task in one case project is not emulated')
  }

  if (dueDate !== undefined && dueDate !== recordedDueDate) {
    return refuse(`due_date other than ${recordedDueDate} (the recorded value) is not emulated`)
  }

  return commit(() => {
    const now = timestamp(env)
    const number = state.counters.nextTaskNumber

    const task = makeTodoistTask({
      id: `${todoistMintedTaskPrefix}${padded(number, 7)}`,
      userId: state.userId,
      projectId,
      content,
      labels: [],
      addedAt: now,
      updatedAt: now,
      due: dueDate === undefined || env.drills.ignoreDue ? null : dueOfDate,
      childOrder: 1
    })

    state.counters = { ...state.counters, nextTaskNumber: number + 1 }
    state.tasks = [...state.tasks, task]

    return json(200, taskWire(state, env, task))
  })
}

const updateTask: RouteHandler = (state, request, env) => {
  const task = createdActiveTask(state, request.params.taskId ?? '')

  if (task === undefined) {
    return refuse('updating a seeded, unknown, or closed task is not emulated')
  }

  const body = bodyObject(request, ['content', 'due_datetime'], [])

  if (isRefusal(body)) return body

  const { content, due_datetime: dueDatetime } = body

  if (content === undefined && dueDatetime === undefined) {
    return refuse('an update without content or due_datetime is not emulated')
  }

  if (content !== undefined && (!Predicate.isString(content) || content === '')) {
    return refuse('content must be a non-empty string')
  }

  if (dueDatetime !== undefined && dueDatetime !== recordedDueDatetime) {
    return refuse(
      `due_datetime other than ${recordedDueDatetime} (the recorded value) is not emulated`
    )
  }

  // The fixtures answer an update with the task's unchanged `updated_at`.
  const updated: TodoistEmulatorTask = {
    ...task,
    content: Predicate.isString(content) ? content : task.content,
    due: dueDatetime === undefined || env.drills.ignoreDue ? task.due : dueOfDatetime
  }

  return commit(() => {
    state.tasks = state.tasks.map(item => (item.id === task.id ? updated : item))

    return json(200, taskWire(state, env, updated))
  })
}

const closeTask: RouteHandler = (state, request, env) => {
  const refused = noBody(request)

  if (refused !== undefined) return refused

  const task = createdActiveTask(state, request.params.taskId ?? '')

  if (task === undefined) {
    return refuse('closing a seeded, unknown, or closed task is not emulated')
  }

  return commit(() => {
    const closed: TodoistEmulatorTask = { ...task, checked: true, completed_at: timestamp(env) }

    state.tasks = state.tasks.map(item => (item.id === task.id ? closed : item))

    return noContent()
  })
}

/** The label listing, one page (its fixture never pages): `limit` required; every label in it. */
const listLabels: RouteHandler = (state, request) => {
  const limit = limitOf(request, value => value <= maxListLimit, `from 1 to ${maxListLimit}`)

  if (isRefusal(limit)) return limit

  if (limit === undefined) return refuse('label listings without limit are not emulated')

  return state.labels.length > limit
    ? refuse(`more labels than limit (${limit}): paging labels is not emulated`)
    : commit(() => json(200, { results: state.labels, next_cursor: null }))
}

const createProject: RouteHandler = (state, request, env) => {
  const body = bodyObject(request, ['name', 'parent_id'], ['name', 'parent_id'])

  if (isRefusal(body)) return body

  const { name, parent_id: parentId } = body
  const runId = Predicate.isString(name) ? caseProjectNamePattern.exec(name)?.[1] : undefined

  if (!Predicate.isString(name) || runId === undefined || runId.length > 40) {
    return refuse(
      'project names other than yolk-conformance-<runId>-<lifecycle|due|parent|delete> ' +
        'are not emulated'
    )
  }

  // The fixtures create case projects under the seeded work project, never under a case project.
  if (
    !Predicate.isString(parentId) ||
    isTodoistMintedId(parentId, todoistMintedProjectPrefix) ||
    !state.projects.some(item => item.id === parentId)
  ) {
    return refuse('a project under anything but an existing seeded project is not emulated')
  }

  // The fixtures record a first sub-project (`child_order: 1`) only.
  if (state.projects.some(item => item.parent_id === parentId)) {
    return refuse('a second sub-project under one parent is not emulated')
  }

  return commit(() => {
    const now = timestamp(env)
    const number = state.counters.nextProjectNumber

    const project = makeTodoistProject({
      id: `${todoistMintedProjectPrefix}${padded(number, 4)}`,
      name,
      parentId,
      childOrder: 1,
      createdAt: now,
      updatedAt: now
    })

    state.counters = { ...state.counters, nextProjectNumber: number + 1 }
    state.projects = [...state.projects, project]

    return json(
      200,
      env.drills.createOmitsParent
        ? { ...projectWire(project), parent_id: null }
        : projectWire(project)
    )
  })
}

const getProject: RouteHandler = (state, request, env) => {
  const id = request.params.projectId ?? ''

  if (!state.projects.some(item => item.id === id)) {
    return commit(() => notFound(state, env, 'Project not found'))
  }

  // Only projects created here answer: no fixture records a seeded project's object.
  const project = createdProject(state, id)

  return project === undefined
    ? refuse('reading a seeded project is not emulated (no fixture records its answer)')
    : commit(() => json(200, projectWire(project)))
}

const deleteProject: RouteHandler = (state, request, env) => {
  const refused = noBody(request)

  if (refused !== undefined) return refused

  const project = createdProject(state, request.params.projectId ?? '')

  // A created project never has sub-projects: projects are created under seeded parents only.
  if (project === undefined) {
    return refuse('deleting a seeded or unknown project is not emulated')
  }

  return commit(() => {
    state.projects = state.projects.filter(item => item.id !== project.id)

    if (!env.drills.deleteKeepsTasks) {
      state.tasks = state.tasks.filter(task => task.project_id !== project.id)
    }

    return noContent()
  })
}

const route = (
  method: string,
  path: string,
  write: boolean,
  caseIds: ReadonlyArray<string>,
  handler: RouteHandler,
  queryKeys: ReadonlyArray<string> = []
): TodoistApiRoute => ({
  method,
  path: `${todoistEmulatorBasePath}${path}`,
  kind: 'connector',
  write,
  caseIds,
  evidence: 'unverified',
  queryKeys,
  handler
})

/** The route table: evidence plus handler. `todoistEmulatorRoutes` is its evidence part. */
export const todoistApiRoutes: ReadonlyArray<TodoistApiRoute> = [
  route('GET', '/tasks', false, [pagingCase, lifecycleCase], listTasks, [
    'project_id',
    'cursor',
    'limit'
  ]),
  route('POST', '/tasks', true, [lifecycleCase, dueCase, deleteCase], createTask),
  route(
    'GET',
    '/tasks/{taskId}',
    false,
    [notFoundCase, labelsCase, lifecycleCase, deleteCase],
    getTask
  ),
  route('POST', '/tasks/{taskId}', true, [lifecycleCase, dueCase], updateTask),
  route('POST', '/tasks/{taskId}/close', true, [lifecycleCase], closeTask),
  route('GET', '/labels', false, [labelsCase], listLabels, ['limit']),
  route('POST', '/projects', true, projectCases, createProject),
  route('GET', '/projects/{projectId}', false, projectCases, getProject),
  route('DELETE', '/projects/{projectId}', true, projectCases, deleteProject)
]

const compiledRoutes = todoistApiRoutes.map(candidate => ({
  route: candidate,
  pattern: new RegExp(`^${candidate.path.replace(/\{[A-Za-z]+\}/g, '([^/]+)')}$`),
  names: [...candidate.path.matchAll(/\{([A-Za-z]+)\}/g)].map(match => match[1] ?? '')
}))

export type TodoistMatchedRoute = {
  readonly route: TodoistApiRoute
  /** Path parameters (Todoist ids, matched raw: never percent-encoded). */
  readonly params: Readonly<Record<string, string>>
}

/**
 * Path words of other Todoist endpoints (`/tasks/filter`, `/tasks/completed`, `/projects/archived`,
 * ...): never an id, so those endpoints stay unknown routes instead of reading as a missing item.
 */
const reservedSegments: ReadonlySet<string> = new Set([
  'filter',
  'completed',
  'quick',
  'archived',
  'search'
])

/**
 * The route answering `method` + raw `path` with its id parameters, or `undefined` (no route, a
 * reserved endpoint word, or a raw segment that is not a Todoist id: percent-encoding is never
 * recognised).
 */
export const matchTodoistRoute = (
  method: string,
  path: string
): TodoistMatchedRoute | undefined => {
  for (const candidate of compiledRoutes) {
    if (candidate.route.method !== method.toUpperCase()) continue

    const match = candidate.pattern.exec(path)

    if (match === null) continue

    const params: Record<string, string> = {}

    for (const [index, name] of candidate.names.entries()) {
      // The raw segment itself must be a Todoist id: a percent-encoded id is not recognised.
      const value = match[index + 1] ?? ''

      if (!todoistIdPattern.test(value) || reservedSegments.has(value)) {
        return undefined
      }

      params[name] = value
    }

    return { route: candidate.route, params }
  }

  return undefined
}

/**
 * Why the query is not emulated on `route` (a key it does not emulate, or a repeated key), or
 * `undefined`.
 */
export const todoistQueryProblem = (
  route: TodoistApiRoute,
  query: URLSearchParams
): string | undefined => {
  const keys = [...query.keys()]
  const unknown = keys.find(key => !route.queryKeys.includes(key))

  if (unknown !== undefined) return `the query parameter ${unknown} is not emulated on this route`

  const repeated = keys.find((key, index) => keys.indexOf(key) !== index)

  return repeated === undefined
    ? undefined
    : `the repeated query parameter ${repeated} is not emulated`
}

const handle = async (
  raw: Request,
  state: TodoistEmulatorState,
  env: TodoistApiEnv
): Promise<Response> => {
  const url = new URL(raw.url)
  const matched = matchTodoistRoute(raw.method, url.pathname)

  if (matched === undefined) return notEmulatedCoreResponse('no emulated Todoist route')

  const text = await raw.text()
  const body = text === '' ? undefined : parseJsonText(text)

  const outcome = matched.route.handler(
    state,
    {
      params: matched.params,
      query: url.searchParams,
      body,
      hasBody: text !== '',
      contentType: raw.headers.get('content-type')
    },
    env
  )

  return coreResponse(outcome, raw)
}

/** `{Name}` path templates become `:Name` core route parameters. */
const corePath = (template: string): string => template.replace(/\{([A-Za-z]+)\}/g, ':$1')

/**
 * Register every route of the table on the core app, over the generation's state. Each handler
 * re-matches the raw request path against the same table the wrapper ledgers and runs the
 * handler. A handler that throws answers `handlerFailedResponse()`,
 * which the wrapper turns into its 500 with `responseError` in the ledger.
 */
export const registerTodoistApi = (
  app: Hono,
  state: TodoistEmulatorState,
  env: TodoistApiEnv
): void => {
  for (const apiRoute of todoistApiRoutes) {
    app.on(apiRoute.method, corePath(apiRoute.path), async context => {
      try {
        return await handle(context.req.raw, state, env)
      } catch {
        return handlerFailedResponse()
      }
    })
  }
}
