/**
 * Todoist emulator state: the typed entities, the seed input, the default seed, and the profiles
 * (internal; re-exported by `src/todoist.ts`).
 *
 * Entity shapes and the default entities are copied as data from the synthetic Todoist
 * conformance fixtures (the same user, project, task, and label ids as
 * `todoistConformanceFixtureSeeds`), never imported from SDK code. Where no fixture records a
 * value, the default is synthesized and says so: the work and paging projects themselves (the
 * fixtures name only their ids) are the fixture project shape with synthetic names and
 * `parent_id: null`.
 *
 * @experimental
 */
import { Result } from 'effect'
import * as Schema from 'effect/Schema'

/** A task due as the fixtures answer it. */
export const TodoistEmulatorDue = Schema.Struct({
  date: Schema.String,
  timezone: Schema.NullOr(Schema.String),
  string: Schema.String,
  lang: Schema.String,
  is_recurring: Schema.Boolean
})

export type TodoistEmulatorDue = typeof TodoistEmulatorDue.Type

/** A stored project, in the fixtures' API v1 wire shape. Deleted projects are removed. */
export const TodoistEmulatorProject = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  parent_id: Schema.NullOr(Schema.String),
  child_order: Schema.Int,
  color: Schema.String,
  description: Schema.String,
  is_archived: Schema.Boolean,
  is_deleted: Schema.Boolean,
  is_favorite: Schema.Boolean,
  is_frozen: Schema.Boolean,
  is_shared: Schema.Boolean,
  is_collapsed: Schema.Boolean,
  can_assign_tasks: Schema.Boolean,
  inbox_project: Schema.Boolean,
  view_style: Schema.String,
  default_order: Schema.Int,
  created_at: Schema.String,
  updated_at: Schema.String
})

export type TodoistEmulatorProject = typeof TodoistEmulatorProject.Type

/** A stored task, in the fixtures' API v1 wire shape. */
export const TodoistEmulatorTask = Schema.Struct({
  id: Schema.String,
  user_id: Schema.String,
  project_id: Schema.String,
  section_id: Schema.Null,
  parent_id: Schema.Null,
  added_by_uid: Schema.String,
  assigned_by_uid: Schema.Null,
  responsible_uid: Schema.Null,
  /** Label NAMES, as the fixtures answer them. */
  labels: Schema.Array(Schema.String),
  deadline: Schema.Null,
  duration: Schema.Null,
  /** `true` once closed: a closed task is no longer active. */
  checked: Schema.Boolean,
  is_deleted: Schema.Boolean,
  added_at: Schema.String,
  completed_at: Schema.NullOr(Schema.String),
  updated_at: Schema.String,
  due: Schema.NullOr(TodoistEmulatorDue),
  priority: Schema.Int,
  child_order: Schema.Int,
  content: Schema.String,
  description: Schema.String,
  note_count: Schema.Int,
  day_order: Schema.Int,
  is_collapsed: Schema.Boolean
})

export type TodoistEmulatorTask = typeof TodoistEmulatorTask.Type

/** A personal label, in the fixtures' wire shape. */
export const TodoistEmulatorLabel = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  color: Schema.String,
  order: Schema.Int,
  is_favorite: Schema.Boolean
})

export type TodoistEmulatorLabel = typeof TodoistEmulatorLabel.Type

const Counter = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

const Counters = Schema.Struct({
  /** Next number in created project ids (`6XEmuProject0001`). */
  nextProjectNumber: Counter,
  /** Next number in created task ids (`6XEmuTask0000001`). */
  nextTaskNumber: Counter,
  /** Next `error_extra.event_id` number of a 404 answer. */
  nextEventNumber: Counter
})

/** The whole emulator state (JSON-compatible; what `snapshot()` returns). */
export const TodoistEmulatorStateSchema = Schema.Struct({
  userId: Schema.String,
  projects: Schema.Array(TodoistEmulatorProject),
  tasks: Schema.Array(TodoistEmulatorTask),
  labels: Schema.Array(TodoistEmulatorLabel),
  counters: Counters
})

/**
 * The emulator state. The container is mutable (route handlers replace whole entity lists);
 * every entity is replaced, never edited in place.
 */
export type TodoistEmulatorState = {
  userId: string
  projects: ReadonlyArray<TodoistEmulatorProject>
  tasks: ReadonlyArray<TodoistEmulatorTask>
  labels: ReadonlyArray<TodoistEmulatorLabel>
  counters: typeof Counters.Type
}

/** A seeded project: `id` and `name` are required; the rest default to the fixture values. */
export const TodoistEmulatorProjectSeed = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  parent_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  child_order: Schema.optionalKey(Schema.Int),
  created_at: Schema.optionalKey(Schema.String),
  updated_at: Schema.optionalKey(Schema.String)
})

export type TodoistEmulatorProjectSeed = typeof TodoistEmulatorProjectSeed.Type

/** A seeded active task: `id`, `project_id`, and `content` are required. */
export const TodoistEmulatorTaskSeed = Schema.Struct({
  id: Schema.String,
  project_id: Schema.String,
  content: Schema.String,
  labels: Schema.optionalKey(Schema.Array(Schema.String)),
  child_order: Schema.optionalKey(Schema.Int),
  added_at: Schema.optionalKey(Schema.String),
  updated_at: Schema.optionalKey(Schema.String),
  due: Schema.optionalKey(Schema.NullOr(TodoistEmulatorDue))
})

export type TodoistEmulatorTaskSeed = typeof TodoistEmulatorTaskSeed.Type

/** Account-variance profiles for the default seed. */
export const TodoistEmulatorProfile = Schema.Literals(['default', 'empty'])

export type TodoistEmulatorProfile = typeof TodoistEmulatorProfile.Type

/**
 * A typed seed. Start from `profile` (default `'default'`, the fixture entities; `'empty'` keeps
 * only the work project); every other key, when given, replaces that part of the profile.
 */
export const TodoistEmulatorSeed = Schema.Struct({
  profile: Schema.optionalKey(TodoistEmulatorProfile),
  userId: Schema.optionalKey(Schema.String),
  projects: Schema.optionalKey(Schema.Array(TodoistEmulatorProjectSeed)),
  tasks: Schema.optionalKey(Schema.Array(TodoistEmulatorTaskSeed)),
  labels: Schema.optionalKey(Schema.Array(TodoistEmulatorLabel))
})

export type TodoistEmulatorSeed = typeof TodoistEmulatorSeed.Type

const strict = { onExcessProperty: 'error' } as const

const decodeSeedInput = Schema.decodeUnknownResult(TodoistEmulatorSeed, strict)

const decodeStateInput = Schema.decodeUnknownResult(TodoistEmulatorStateSchema, strict)

const issueMessage = (issue: Schema.SchemaError['issue']): string =>
  new Schema.SchemaError(issue).message

/** Ids are opaque strings in the characters the conformance seeds accept. */
export const todoistIdPattern = /^[A-Za-z0-9_-]{1,64}$/

/** Prefix of every id the emulator mints; seeds may not use it, so ids never collide. */
export const todoistReservedIdPrefix = '6XEmu'

/** Prefix of project ids the emulator mints (`6XEmuProject0001`). */
export const todoistMintedProjectPrefix = `${todoistReservedIdPrefix}Project`

/** Prefix of task ids the emulator mints (`6XEmuTask0000001`). */
export const todoistMintedTaskPrefix = `${todoistReservedIdPrefix}Task`

/** True for an id minted with `prefix`, that is, created through the recorded create flow. */
export const isTodoistMintedId = (id: string, prefix: string): boolean => id.startsWith(prefix)

// Default entities, copied from the fixtures.

const userId = '10000001'

const workProjectId = '6XSyntheticWork0'

/**
 * The paging project the paging fixture lists with `limit=2` (the only seeded project whose task
 * listing a fixture records).
 */
export const todoistPagingProjectId = '6XSyntheticPage0'

const pagingProjectId = todoistPagingProjectId

/** Fixture timestamp of the seeded tasks (`tasks-paging.ts`, `task-labels.ts`). */
const seededAt = '2026-09-20T10:00:00.000000Z'

const defaultProjects: ReadonlyArray<TodoistEmulatorProjectSeed> = [
  // Synthesized: the fixtures name only the ids of these two projects.
  { id: workProjectId, name: 'Synthetic work project', child_order: 1 },
  { id: pagingProjectId, name: 'Synthetic paging project', child_order: 2 }
]

const pagingTask = (id: string, content: string, order: number): TodoistEmulatorTaskSeed => ({
  id,
  project_id: pagingProjectId,
  content,
  child_order: order
})

const defaultTasks: ReadonlyArray<TodoistEmulatorTaskSeed> = [
  pagingTask('6XSynPagingTask1', 'Synthetic paging task one', 1),
  pagingTask('6XSynPagingTask2', 'Synthetic paging task two', 2),
  pagingTask('6XSynPagingTask3', 'Synthetic paging task three', 3),
  {
    id: '6XSyntheticLabel',
    project_id: workProjectId,
    content: 'Synthetic labeled task',
    labels: ['synthetic-errand', 'synthetic-waiting'],
    child_order: 1
  }
]

const label = (id: string, name: string, order: number): TodoistEmulatorLabel => ({
  id,
  name,
  color: 'charcoal',
  order,
  is_favorite: false
})

const defaultLabels: ReadonlyArray<TodoistEmulatorLabel> = [
  label('2100000001', 'synthetic-errand', 1),
  label('2100000002', 'synthetic-waiting', 2),
  label('2100000003', 'synthetic-someday', 3)
]

type ProfileEntities = {
  readonly userId: string
  readonly projects: ReadonlyArray<TodoistEmulatorProjectSeed>
  readonly tasks: ReadonlyArray<TodoistEmulatorTaskSeed>
  readonly labels: ReadonlyArray<TodoistEmulatorLabel>
}

const profileEntities = (profile: TodoistEmulatorProfile): ProfileEntities => {
  switch (profile) {
    case 'default':
      return { userId, projects: defaultProjects, tasks: defaultTasks, labels: defaultLabels }
    case 'empty':
      return { userId, projects: defaultProjects.slice(0, 1), tasks: [], labels: [] }
  }
}

/** A project in wire key order (the fixtures' order and default values). */
export const makeTodoistProject = (fields: {
  readonly id: string
  readonly name: string
  readonly parentId: string | null
  readonly childOrder: number
  readonly createdAt: string
  readonly updatedAt: string
}): TodoistEmulatorProject => ({
  id: fields.id,
  name: fields.name,
  parent_id: fields.parentId,
  child_order: fields.childOrder,
  color: 'charcoal',
  description: '',
  is_archived: false,
  is_deleted: false,
  is_favorite: false,
  is_frozen: false,
  is_shared: false,
  is_collapsed: false,
  can_assign_tasks: false,
  inbox_project: false,
  view_style: 'list',
  default_order: 0,
  created_at: fields.createdAt,
  updated_at: fields.updatedAt
})

/** An active task in wire key order (the fixtures' order and default values). */
export const makeTodoistTask = (fields: {
  readonly id: string
  readonly userId: string
  readonly projectId: string
  readonly content: string
  readonly labels: ReadonlyArray<string>
  readonly addedAt: string
  readonly updatedAt: string
  readonly due: TodoistEmulatorDue | null
  readonly childOrder: number
}): TodoistEmulatorTask => ({
  id: fields.id,
  user_id: fields.userId,
  project_id: fields.projectId,
  section_id: null,
  parent_id: null,
  added_by_uid: fields.userId,
  assigned_by_uid: null,
  responsible_uid: null,
  labels: fields.labels,
  deadline: null,
  duration: null,
  checked: false,
  is_deleted: false,
  added_at: fields.addedAt,
  completed_at: null,
  updated_at: fields.updatedAt,
  due: fields.due,
  priority: 1,
  child_order: fields.childOrder,
  content: fields.content,
  description: '',
  note_count: 0,
  day_order: -1,
  is_collapsed: false
})

const duplicate = (values: ReadonlyArray<string>): string | undefined =>
  values.find((value, index) => values.indexOf(value) !== index)

/** Integrity problems a decoded seed can still have (ids, duplicates, dangling references). */
const seedProblem = (entities: ProfileEntities): string | undefined => {
  const projectIds = entities.projects.map(project => project.id)
  const taskIds = entities.tasks.map(task => task.id)
  const labelIds = entities.labels.map(item => item.id)

  const invalid = [...projectIds, ...taskIds, ...labelIds].find(id => !todoistIdPattern.test(id))

  if (invalid !== undefined) return `id ${JSON.stringify(invalid)} is not 1-64 of [A-Za-z0-9_-]`

  // Minted ids come from counters that start at 1: a seeded id in their namespace could collide.
  const reserved = [...projectIds, ...taskIds, ...labelIds].find(id =>
    id.startsWith(todoistReservedIdPrefix)
  )

  if (reserved !== undefined) {
    return (
      `id ${reserved} uses the prefix ${todoistReservedIdPrefix}, ` +
      'reserved for ids the emulator mints'
    )
  }

  const duplicates: ReadonlyArray<readonly [string, string | undefined]> = [
    ['project id', duplicate(projectIds)],
    ['task id', duplicate(taskIds)],
    ['label id', duplicate(labelIds)],
    ['label name', duplicate(entities.labels.map(item => item.name))]
  ]

  for (const [name, value] of duplicates) {
    if (value !== undefined) return `duplicate ${name} ${value}`
  }

  const orphan = entities.projects.find(
    project =>
      project.parent_id !== undefined &&
      project.parent_id !== null &&
      !projectIds.includes(project.parent_id)
  )

  if (orphan !== undefined) {
    return `project ${orphan.id} references a missing parent project`
  }

  const task = entities.tasks.find(candidate => !projectIds.includes(candidate.project_id))

  if (task !== undefined) return `task ${task.id} references missing project ${task.project_id}`

  const names = entities.labels.map(item => item.name)

  const unlabeled = entities.tasks.find(candidate =>
    (candidate.labels ?? []).some(name => !names.includes(name))
  )

  return unlabeled === undefined
    ? undefined
    : `task ${unlabeled.id} carries a label that is not a seeded personal label`
}

const stateFromSeed = (seed: TodoistEmulatorSeed): TodoistEmulatorState | string => {
  const profile = profileEntities(seed.profile ?? 'default')

  const entities: ProfileEntities = {
    userId: seed.userId ?? profile.userId,
    projects: seed.projects ?? profile.projects,
    tasks: seed.tasks ?? profile.tasks,
    labels: seed.labels ?? profile.labels
  }

  const problem = seedProblem(entities)

  if (problem !== undefined) return problem

  return {
    userId: entities.userId,
    projects: entities.projects.map((project, index) =>
      makeTodoistProject({
        id: project.id,
        name: project.name,
        parentId: project.parent_id ?? null,
        childOrder: project.child_order ?? index + 1,
        createdAt: project.created_at ?? seededAt,
        updatedAt: project.updated_at ?? project.created_at ?? seededAt
      })
    ),
    tasks: entities.tasks.map((task, index) =>
      makeTodoistTask({
        id: task.id,
        userId: entities.userId,
        projectId: task.project_id,
        content: task.content,
        labels: task.labels ?? [],
        addedAt: task.added_at ?? seededAt,
        updatedAt: task.updated_at ?? task.added_at ?? seededAt,
        due: task.due ?? null,
        childOrder: task.child_order ?? index + 1
      })
    ),
    labels: entities.labels,
    counters: { nextProjectNumber: 1, nextTaskNumber: 1, nextEventNumber: 1 }
  }
}

/** Decode and build a seed; a string is the reason it is invalid. */
export const buildTodoistSeedState = (input: unknown): TodoistEmulatorState | string => {
  const decoded = decodeSeedInput(input)

  return Result.isFailure(decoded)
    ? issueMessage(decoded.failure.issue)
    : stateFromSeed(decoded.success)
}

/** Decode a full state (a restored snapshot); a string is the reason it is invalid. */
export const decodeTodoistState = (input: unknown): TodoistEmulatorState | string => {
  const decoded = decodeStateInput(input)

  return Result.isFailure(decoded) ? issueMessage(decoded.failure.issue) : { ...decoded.success }
}
