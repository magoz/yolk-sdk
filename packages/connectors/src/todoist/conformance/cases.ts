/**
 * Todoist conformance cases for `@yolk-sdk/conformance/runner`.
 *
 * Each case checks one wire claim the Todoist connector relies on, running the REAL connector
 * actions over the connector ports (`ConnectorHttpClient`, `CredentialResolver`) plus the
 * host-supplied `TodoistConformanceConfig` seed ids. The same cases run on replay fixtures, an
 * emulator, or by hand against a practice Todoist account. None is observed live yet (`observed`
 * absent = unverified); sub-claims no live run has settled are marked "(unverified: ...)" in their
 * `wire`.
 *
 * Write ownership. Every write case works only inside its own case project
 * `yolk-conformance-<runId>-<case>`, created under the `workProjectId` seed: the `runId` seed makes
 * that namespace unique per invocation (fixtures replay with a fixed synthetic run id; the live
 * runner generates a fresh random one each time). The project create, its decoding, and the
 * registration of the created project's id run uninterruptibly together. Then:
 *
 * - A definitive rejection (HTTP 4xx) proves the case created nothing: it fails with
 *   `TodoistConformanceActionFailed` and deletes NOTHING.
 * - An ambiguous outcome (a transport or decoding failure, no status, or HTTP 5xx) may or may not
 *   have created the project, and the case never learned an id to delete: it fails with
 *   `TodoistConformanceActionFailed` (`createOutcome: 'unknown'`) naming the exact project to check
 *   by hand. Todoist project names are not unique, so the case never deletes by name.
 * - A success registers the created project by id. The cleanup deletes it by id (a not-found answer
 *   proves it gone) and verifies that `todoist.get_project` then answers not-found. A create that
 *   answers a project whose name is not the requested run-scoped name is never adopted for
 *   cleanup: the case fails with `TodoistConformanceCleanupRefused` naming it. Tasks the case
 *   creates must answer the case project as their `project_id`, or the case refuses them the same
 *   way; tasks inside the case project go with it when the cleanup deletes the project.
 * - Every later write inside the case project (task create, update, close, project delete) is
 *   masked too, so an aborted request cannot land after the cleanup.
 *
 * A failed cleanup is reported as `TodoistConformanceRestoreFailed` naming the project (never
 * swallowed). Neither the runner nor the bridges set a request timeout, so a hanging request delays
 * an interruption until it answers. `findTodoistConformanceLeftovers` lists (read-only) the
 * `yolk-conformance-run-*` projects earlier runs left behind, for a runner to warn about.
 */
import { Cause, Context, Data, Effect, Exit, Option, Predicate, Ref, Result } from 'effect'
import * as Schema from 'effect/Schema'
import {
  ConformanceMismatch,
  defineConformanceCase,
  expectConformance,
  expectEqual,
  type ConformanceCase
} from '@yolk-sdk/conformance/case'
import { sanitizeConformanceMessage } from '@yolk-sdk/conformance/runner'
import { interruptPending, reportCleanupProblem } from '../../conformance/cleanup-reporter.ts'
import { makeCredentialBinding, type CredentialResolver } from '../../credential.ts'
import type { ConnectorError } from '../../error.ts'
import type { ConnectorHttpClient } from '../../http.ts'
import { makeIntegration } from '../../integration.ts'
import type { ActionResult, ProviderFailure } from '../../result.ts'
import {
  TodoistCloseTaskInput,
  TodoistCreateProjectInput,
  TodoistCreateTaskInput,
  TodoistListTasksInput,
  TodoistPaginationInput,
  TodoistProjectIdInput,
  TodoistTaskIdInput,
  TodoistUpdateTaskInput,
  todoistCloseTaskAction,
  todoistCreateProjectAction,
  todoistCreateTaskAction,
  todoistDeleteProjectAction,
  todoistGetProjectAction,
  todoistGetTaskAction,
  todoistListLabelsAction,
  todoistListProjectsAction,
  todoistListTasksAction,
  todoistUpdateTaskAction,
  type TodoistProject,
  type TodoistTask
} from '../index.ts'
import { todoistApiTokenSlotId, todoistConnectorId } from '../shared.ts'
import { todoistDueDatesFixture } from './due-dates.ts'
import { todoistNotFoundEnvelopeFixture } from './not-found-envelope.ts'
import { todoistProjectDeleteFixture } from './project-delete.ts'
import { todoistProjectParentIdFixture } from './project-parent-id.ts'
import { todoistTaskLabelsFixture } from './task-labels.ts'
import { todoistTaskLifecycleFixture } from './task-lifecycle.ts'
import { todoistTasksPagingFixture } from './tasks-paging.ts'

/** A Todoist id: letters, digits, `_` and `-` (API v1 ids are opaque strings). */
const SeedId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/))

/**
 * A run id: `run-` then lower-case letters, digits, and inner hyphens, at most 40 characters. The
 * `run-` prefix is required so `findTodoistConformanceLeftovers` covers every valid run id.
 */
const RunId = Schema.String.check(
  Schema.isPattern(/^run-[a-z0-9]+(?:-[a-z0-9]+)*$/),
  Schema.isMaxLength(40)
)

/**
 * Host-supplied seed ids in the practice Todoist account. Cases never hard-code account data. A
 * case whose required seed is missing fails with a `precondition:` `ConformanceMismatch` before any
 * request.
 */
export const TodoistConformanceSeeds = Schema.Struct({
  /** A project holding more than two active tasks, for list paging. */
  pagingProjectId: Schema.optionalKey(SeedId),
  /** An active task carrying at least one personal label (not a shared-only label). */
  labeledTaskId: Schema.optionalKey(SeedId),
  /**
   * An existing project the write cases create (and delete) their own `yolk-conformance-*`
   * sub-projects under.
   */
  workProjectId: Schema.optionalKey(SeedId),
  /**
   * Invocation-unique segment of every write case's project name: `run-` then lower-case letters,
   * digits, and inner hyphens (the prefix keeps every run's projects visible to the leftover
   * lookup). Replay uses the fixed synthetic id of the fixtures; the live runner generates a fresh
   * random one per invocation.
   */
  runId: Schema.optionalKey(RunId)
})

export type TodoistConformanceSeeds = typeof TodoistConformanceSeeds.Type

export type TodoistConformanceSeedKey = keyof TodoistConformanceSeeds

/** Host-supplied seed ids for the Todoist conformance cases. */
export class TodoistConformanceConfig extends Context.Service<
  TodoistConformanceConfig,
  TodoistConformanceSeeds
>()('@yolk-sdk/connectors/todoist/conformance/TodoistConformanceConfig') {}

/**
 * Credential reference the cases bind to the `todoist.api_token` slot. A host `CredentialResolver`
 * (for example `staticCredentialResolverLayer` from `@yolk-sdk/connectors/conformance`) resolves
 * it to a Todoist API token.
 */
export const todoistConformanceCredentialRef = 'todoist.conformance'

/** The integration every Todoist conformance case invokes the connector with. */
export const todoistConformanceIntegration = makeIntegration({
  connectorId: todoistConnectorId,
  credentialBindings: [
    makeCredentialBinding({
      slotId: todoistApiTokenSlotId,
      credentialRef: todoistConformanceCredentialRef
    })
  ]
})

/** Synthetic marker every case-created project name and task content starts with. */
export const todoistConformanceMarker = 'yolk-conformance'

/** Name prefix of every run-scoped case project: `yolk-conformance-run-`. */
export const todoistConformanceRunProjectPrefix = `${todoistConformanceMarker}-run-`

/**
 * A connector action failed where the case needed success. `code` and `status` keep the underlying
 * classification (a `ConnectorError` cause such as `transport_failed`, or a provider failure code).
 *
 * `createOutcome: 'unknown'` marks an ambiguous create (a transport or decoding failure, no status,
 * or HTTP 5xx): Todoist may have created the item without the case learning its id, so the message
 * names the exact `target` to check by hand.
 */
export class TodoistConformanceActionFailed extends Data.TaggedError(
  'TodoistConformanceActionFailed'
)<{
  readonly actionId: string
  readonly code: string
  readonly status?: number
  readonly createOutcome?: 'unknown'
  readonly target?: string
}> {
  override get message(): string {
    const status = this.status === undefined ? '' : ` (HTTP ${this.status})`

    const advice =
      this.createOutcome === 'unknown'
        ? `; create outcome unknown: delete ${this.target ?? 'the case project'} by hand if it exists`
        : ''

    return `${this.actionId} failed: ${this.code}${status}${advice}`
  }
}

/**
 * A create answered an item outside the run namespace (a project without the requested run-scoped
 * name, or a task outside the case project). The case never deletes outside its own namespace, so
 * nothing was deleted: check `item` by hand.
 */
export class TodoistConformanceCleanupRefused extends Data.TaggedError(
  'TodoistConformanceCleanupRefused'
)<{
  readonly caseId: string
  readonly item: string
}> {
  override get message(): string {
    return `${this.caseId}: cleanup refused; a create answered ${this.item}, outside the run namespace, so nothing was deleted there; check it by hand.`
  }
}

/** `text` ending in a period (a truncated `...` summary already does). */
const sentence = (text: string): string => (text.endsWith('.') ? text : `${text}.`)

/**
 * Deleting a write case's own project failed. `caseOutcome` says whether the claim itself held
 * before the restore; `claimFailure` is a sanitized summary of why it failed. The project may or
 * may not still exist: check it, and delete it by hand only if it does.
 */
export class TodoistConformanceRestoreFailed extends Data.TaggedError(
  'TodoistConformanceRestoreFailed'
)<{
  readonly caseId: string
  readonly project: string
  readonly reason: string
  readonly caseOutcome: 'claim held' | 'claim failed'
  readonly claimFailure?: string
}> {
  override get message(): string {
    const claim =
      this.caseOutcome === 'claim held'
        ? 'Claim held first.'
        : this.claimFailure === undefined
          ? 'Claim failed first.'
          : `Claim failed first: ${this.claimFailure}`

    // Conformance reports cap failure messages at 300 characters: the advice comes first.
    return `${this.caseId}: restore failed; delete ${this.project} by hand if it still exists. Restore error: ${sentence(this.reason)} ${claim}`
  }
}

export type TodoistConformanceError =
  | ConformanceMismatch
  | ConnectorError
  | TodoistConformanceActionFailed
  | TodoistConformanceCleanupRefused
  | TodoistConformanceRestoreFailed

/** What every Todoist conformance case requires from the host. */
export type TodoistConformanceRequirements =
  | ConnectorHttpClient
  | CredentialResolver
  | TodoistConformanceConfig

export type TodoistConformanceCase = ConformanceCase<
  TodoistConformanceError,
  TodoistConformanceRequirements
>

const integration = todoistConformanceIntegration

const requireSeed = <K extends TodoistConformanceSeedKey>(key: K) =>
  Effect.gen(function* () {
    const seeds = yield* TodoistConformanceConfig
    const value = seeds[key]

    if (value === undefined) {
      return yield* new ConformanceMismatch({
        message: `precondition: TodoistConformanceConfig.${key} is not configured`
      })
    }

    return value
  })

const successValue =
  (actionId: string) =>
  <A>(result: ActionResult<A>): Effect.Effect<A, TodoistConformanceActionFailed> => {
    if (Predicate.isTagged(result, 'Success')) {
      return Effect.succeed(result.value)
    }

    const { code, status } = result.error

    return Effect.fail(
      status === undefined
        ? new TodoistConformanceActionFailed({ actionId, code })
        : new TodoistConformanceActionFailed({ actionId, code, status })
    )
  }

/** The provider failure of a result, or `undefined` for a success. */
const failureOf = <A>(result: ActionResult<A>): ProviderFailure | undefined =>
  Predicate.isTagged(result, 'Failure') ? result.error : undefined

/** `code status` of a result for mismatch details (`success` for a success). */
const outcomeOf = <A>(result: ActionResult<A>): string => {
  const failure = failureOf(result)

  return failure === undefined ? 'success' : `${failure.code} ${failure.status ?? 'no-status'}`
}

const isNotFound = <A>(result: ActionResult<A>): boolean =>
  failureOf(result)?.code === 'todoist_not_found'

/** Decode an untyped value; a shape mismatch fails the claim with `message`. */
const decodeAs =
  <A>(schema: Schema.Schema<A> & { readonly DecodingServices: never }, message: string) =>
  (value: unknown): Effect.Effect<A, ConformanceMismatch> =>
    Schema.decodeUnknownEffect(schema)(value).pipe(
      Effect.mapError(() => new ConformanceMismatch({ message }))
    )

/** Longest failure summary embedded in a `TodoistConformanceRestoreFailed` message. */
const failureSummaryLength = 60

const truncated = (text: string, length: number): string =>
  text.length > length ? `${text.slice(0, length - 3).trimEnd()}...` : text

/** Short, sanitized summary of a failure (credential patterns redacted). */
const failureSummary = (cause: Cause.Cause<unknown>): string => {
  if (Cause.hasInterruptsOnly(cause)) {
    return 'interrupted'
  }

  const error = Cause.findErrorOption(cause)
  const value = Option.isSome(error) ? error.value : Cause.squash(cause)

  if (value instanceof TodoistConformanceActionFailed) {
    const status = value.status === undefined ? '' : ` ${value.status}`

    return `${truncated(sanitizeConformanceMessage(`${value.actionId} ${value.code}`), failureSummaryLength - status.length)}${status}`
  }

  const tag = Predicate.hasProperty(value, '_tag') ? String(value._tag) : 'defect'
  const message = Predicate.hasProperty(value, 'message') ? String(value.message) : ''

  const raw =
    message.length === 0
      ? tag
      : value instanceof ConformanceMismatch
        ? message
        : `${tag}: ${message}`

  return truncated(sanitizeConformanceMessage(raw), failureSummaryLength)
}

/** The project a task belongs to (Todoist answers `project_id`; `projectId` for older shapes). */
const projectOf = (task: TodoistTask): string | undefined => task.project_id ?? task.projectId

// Connector action shorthands.

const getProject = (projectId: string) =>
  todoistGetProjectAction.executeTyped({
    integration,
    input: TodoistProjectIdInput.make({ projectId })
  })

const deleteProject = (projectId: string) =>
  todoistDeleteProjectAction.executeTyped({
    integration,
    input: TodoistProjectIdInput.make({ projectId })
  })

const getTask = (taskId: string) =>
  todoistGetTaskAction.executeTyped({ integration, input: TodoistTaskIdInput.make({ taskId }) })

const updateTask = (fields: {
  readonly taskId: string
  readonly content?: string
  readonly dueDatetime?: string
}) =>
  todoistUpdateTaskAction
    .executeTyped({ integration, input: TodoistUpdateTaskInput.make(fields) })
    .pipe(Effect.flatMap(successValue(todoistUpdateTaskAction.id)), Effect.uninterruptible)

// Write-case projects: an invocation-unique namespace, the created project registered
// uninterruptibly with its create, and cleanup confined to that project, by id.

/** A registered cleanup target: the created project's id and its run-scoped name. */
export type TodoistOwnedProject = { readonly id: string; readonly name: string }

/** Projects the restore must delete; a case drops them once it has itself proven they are gone. */
type PendingProjects = Ref.Ref<ReadonlyArray<TodoistOwnedProject>>

const describeProject = (project: { readonly id: string; readonly name: string }) =>
  `project ${project.name} (id ${project.id})`

/**
 * Delete an owned project that may still exist, by id, then verify `todoist.get_project` answers
 * not-found. A not-found answer to the delete proves the project gone.
 */
const ensureProjectAbsent = (project: TodoistOwnedProject) =>
  Effect.gen(function* () {
    const deleted = yield* deleteProject(project.id)

    if (!Predicate.isTagged(deleted, 'Success') && !isNotFound(deleted)) {
      return yield* successValue(todoistDeleteProjectAction.id)(deleted).pipe(Effect.asVoid)
    }

    const after = yield* getProject(project.id)

    yield* expectConformance(
      isNotFound(after),
      'expected get_project of the case-created project to answer not found after restoring',
      { actual: outcomeOf(after) }
    )
  })

/**
 * Classify a failed or refused create of `target`: no status, a 5xx, or a transport or decoding
 * failure is ambiguous (the error names `target` for manual recovery); a 4xx is definitive.
 */
const classifyFailedCreate = <A>(
  actionId: string,
  target: string,
  exit: Exit.Exit<ActionResult<A>, ConnectorError>
):
  | { readonly kind: 'success'; readonly value: A }
  | { readonly kind: 'rejected'; readonly error: TodoistConformanceActionFailed }
  | { readonly kind: 'ambiguous'; readonly error: TodoistConformanceActionFailed } => {
  if (Exit.isFailure(exit)) {
    const error = Cause.findErrorOption(exit.cause)

    return {
      kind: 'ambiguous',
      error: new TodoistConformanceActionFailed({
        actionId,
        code: Option.isSome(error) ? error.value.cause : 'defect',
        createOutcome: 'unknown',
        target
      })
    }
  }

  const result = exit.value

  if (Predicate.isTagged(result, 'Success')) {
    return { kind: 'success', value: result.value }
  }

  const { code, status } = result.error

  if (status === undefined) {
    return {
      kind: 'ambiguous',
      error: new TodoistConformanceActionFailed({
        actionId,
        code,
        createOutcome: 'unknown',
        target
      })
    }
  }

  if (status >= 500) {
    return {
      kind: 'ambiguous',
      error: new TodoistConformanceActionFailed({
        actionId,
        code,
        status,
        createOutcome: 'unknown',
        target
      })
    }
  }

  return { kind: 'rejected', error: new TodoistConformanceActionFailed({ actionId, code, status }) }
}

/**
 * Fail with `error`, first handing its message to the `ConformanceCleanupReporter` when the fiber
 * was interrupted (`interrupted`, or an interruption still pending): an interruption may otherwise
 * replace this error, and with it the item to check by hand.
 */
const failReporting = <E extends { readonly message: string }>(
  unmask: <A, E2, R>(effect: Effect.Effect<A, E2, R>) => Effect.Effect<A, E2, R>,
  error: E,
  interrupted = false
) =>
  Effect.gen(function* () {
    if (interrupted || (yield* interruptPending(unmask))) {
      yield* reportCleanupProblem(error)
    }

    return yield* Effect.fail(error)
  })

/**
 * Create the case project `name` under `workProjectId`, run `use`, then ALWAYS delete every
 * pending project by id and verify it is gone.
 *
 * The create request, its decoding, and the registration of the created project run
 * uninterruptibly together; `use` runs interruptibly; the restore runs uninterruptibly after `use`
 * succeeds, fails, or is interrupted, and does nothing once `pending` is empty. A definitive create
 * rejection deletes nothing; an ambiguous one is reported as `createOutcome: 'unknown'` naming the
 * project; a create answering another name fails with `TodoistConformanceCleanupRefused` and
 * deletes nothing. A failed restore fails the case with `TodoistConformanceRestoreFailed`, which
 * says whether the claim itself held; otherwise the outcome of `use` is returned unchanged.
 */
const withOwnProject = <A, E, R>(
  caseId: string,
  name: string,
  use: (
    project: TodoistOwnedProject,
    created: TodoistProject,
    pending: PendingProjects
  ) => Effect.Effect<A, E, R>
) =>
  Effect.gen(function* () {
    const workProjectId = yield* requireSeed('workProjectId')
    const pending: PendingProjects = yield* Ref.make<ReadonlyArray<TodoistOwnedProject>>([])

    return yield* Effect.uninterruptibleMask(unmask =>
      Effect.gen(function* () {
        const created = classifyFailedCreate(
          todoistCreateProjectAction.id,
          `project ${name} under workProjectId`,
          yield* Effect.exit(
            todoistCreateProjectAction.executeTyped({
              integration,
              input: TodoistCreateProjectInput.make({ name, parentId: workProjectId })
            })
          )
        )

        switch (created.kind) {
          case 'rejected':
            return yield* created.error
          case 'ambiguous':
            return yield* failReporting(unmask, created.error)
          case 'success':
            break
        }

        const project = created.value

        if (project.name !== name) {
          return yield* failReporting(
            unmask,
            new TodoistConformanceCleanupRefused({ caseId, item: describeProject(project) })
          )
        }

        const owned: TodoistOwnedProject = { id: project.id, name }

        yield* Ref.set(pending, [owned])

        const outcome = yield* Effect.exit(unmask(use(owned, project, pending)))

        const restored = yield* Effect.exit(
          Ref.get(pending).pipe(
            Effect.flatMap(projects =>
              Effect.forEach(projects, ensureProjectAbsent, { discard: true })
            )
          )
        )

        if (Exit.isFailure(restored)) {
          return yield* failReporting(
            unmask,
            Exit.isSuccess(outcome)
              ? new TodoistConformanceRestoreFailed({
                  caseId,
                  project: describeProject(owned),
                  reason: failureSummary(restored.cause),
                  caseOutcome: 'claim held'
                })
              : new TodoistConformanceRestoreFailed({
                  caseId,
                  project: describeProject(owned),
                  reason: failureSummary(restored.cause),
                  caseOutcome: 'claim failed',
                  claimFailure: failureSummary(outcome.cause)
                }),
            Exit.isFailure(outcome) && Cause.hasInterrupts(outcome.cause)
          )
        }

        return yield* outcome
      })
    )
  })

/**
 * Create a task inside the case project (masked with its decoding). An ambiguous create is reported
 * as `createOutcome: 'unknown'` naming the task; a definitive rejection created nothing; a task
 * answered outside the case project is refused, never adopted.
 */
const createOwnTask = (
  caseId: string,
  project: TodoistOwnedProject,
  fields: { readonly content: string; readonly dueDate?: string }
) =>
  Effect.uninterruptibleMask(unmask =>
    Effect.gen(function* () {
      const created = classifyFailedCreate(
        todoistCreateTaskAction.id,
        `task "${fields.content}" in project ${project.name}`,
        yield* Effect.exit(
          todoistCreateTaskAction.executeTyped({
            integration,
            input: TodoistCreateTaskInput.make({ ...fields, projectId: project.id })
          })
        )
      )

      switch (created.kind) {
        case 'rejected':
          return yield* created.error
        case 'ambiguous':
          return yield* failReporting(unmask, created.error)
        case 'success':
          break
      }

      const task = created.value

      if (projectOf(task) !== project.id) {
        return yield* failReporting(
          unmask,
          new TodoistConformanceCleanupRefused({
            caseId,
            item: `task ${task.id} in project ${projectOf(task) ?? 'none'}`
          })
        )
      }

      return task
    })
  )

/** The case project name `yolk-conformance-<runId>-<suffix>`. */
const caseProjectName = (suffix: string) =>
  Effect.gen(function* () {
    const runId = yield* requireSeed('runId')

    return `${todoistConformanceMarker}-${runId}-${suffix}`
  })

const taskContent = `${todoistConformanceMarker} task: safe to delete`

// Read cases.

/** List page size, and the page cap. */
const listLimit = 2

const pageCap = 10

export const todoistTasksPagingCase: TodoistConformanceCase = defineConformanceCase({
  id: 'todoist.tasks.list-cursor-paging',
  title: 'A filtered task listing larger than the limit pages through next_cursor',
  safety: 'read',
  docs: '`todoist.list_tasks` sends GET /api/v1/tasks with `project_id`, `limit`, and `cursor` query parameters and decodes `{ results, next_cursor }`, requiring `next_cursor` (string or null) on every page; it returns `{ tasks, nextCursor }` and never follows a cursor by itself.',
  wire: '`todoist.list_tasks` with `limit: 2` for a project seeded with more than two active tasks answers at most two tasks and a string `next_cursor`; sending that cursor with the same `project_id` returns further tasks of that project (none repeated, compared by id), and the last page answers `next_cursor: null` present (not absent).',
  fixtures: [todoistTasksPagingFixture.id],
  run: Effect.gen(function* () {
    const projectId = yield* requireSeed('pagingProjectId')

    const listPage = (cursor: string | undefined) =>
      todoistListTasksAction
        .executeTyped({
          integration,
          input: TodoistListTasksInput.make({ projectId, limit: listLimit, cursor })
        })
        .pipe(Effect.flatMap(successValue(todoistListTasksAction.id)))

    const first = yield* listPage(undefined)

    if (first.nextCursor === null) {
      return yield* new ConformanceMismatch({
        message:
          first.tasks.length <= listLimit
            ? 'precondition: pagingProjectId needs more than two active tasks'
            : 'expected a next_cursor for a listing larger than the limit'
      })
    }

    const seen: Array<string> = []
    let page = first

    for (let count = 1; ; count++) {
      const ids = page.tasks.map(task => task.id)

      yield* expectConformance(
        ids.length <= listLimit,
        'expected at most limit tasks on every page',
        { actual: ids.length }
      )
      yield* expectConformance(
        page.tasks.every(task => projectOf(task) === projectId),
        'expected every task on every page to belong to the filtered project'
      )
      yield* expectConformance(
        ids.every(id => !seen.includes(id)),
        'expected a later page to repeat no task from an earlier page'
      )
      seen.push(...ids)

      if (page.nextCursor === null) {
        break
      }

      yield* expectConformance(
        page.nextCursor.length > 0,
        'expected a non-empty next_cursor while more tasks remain'
      )

      if (count >= pageCap) {
        return yield* new ConformanceMismatch({
          message: `precondition: pagingProjectId spans more than ${pageCap} pages; use a smaller project`
        })
      }

      page = yield* listPage(page.nextCursor)
    }

    yield* expectConformance(
      seen.length > listLimit,
      'expected the next_cursor pages to return further tasks'
    )
  })
})

/** A well-formed task id that addresses no task (synthetic, never account data). */
const absentTaskId = '6YolkAbsentTask0'

/** The error body field the connector appends to its failure message first. */
const TodoistErrorBody = Schema.Struct({ error: Schema.NonEmptyString })

const decodeErrorBody = Schema.decodeUnknownEffect(Schema.fromJsonString(TodoistErrorBody))

export const todoistNotFoundEnvelopeCase: TodoistConformanceCase = defineConformanceCase({
  id: 'todoist.errors.not-found-envelope',
  title: 'An unknown task id answers HTTP 404 with a JSON error message',
  safety: 'read',
  docs: 'The connector maps a non-2xx Todoist response by HTTP status (401/403 `todoist_unauthorized`, 404 `todoist_not_found`, 429 `todoist_rate_limited`, otherwise the action code), appends the first non-empty string of the JSON body fields `error`, `message`, `error_description`, `error_tag` to its failure message, and keeps the body as `underlying`.',
  wire: '`todoist.get_task` of a well-formed id that addresses no task answers HTTP 404 (`todoist_not_found`; unverified: that an unknown id answers 404, not 400) with a JSON body whose `error` is a non-empty string (unverified: the API v1 error body `{ error, error_code, error_extra, error_tag, http_code }`), so the connector message is `Todoist get task failed: <error>`.',
  fixtures: [todoistNotFoundEnvelopeFixture.id],
  run: Effect.gen(function* () {
    const failure = failureOf(yield* getTask(absentTaskId))

    if (failure === undefined) {
      return yield* new ConformanceMismatch({
        message: 'expected todoist.get_task of an unknown id to fail'
      })
    }

    yield* expectEqual(
      [failure.code, failure.status ?? null],
      ['todoist_not_found', 404],
      'expected an unknown task id to map to todoist_not_found with HTTP 404'
    )

    const body = Predicate.isString(failure.underlying)
      ? yield* decodeErrorBody(failure.underlying).pipe(
          Effect.result,
          Effect.map(result => (Result.isSuccess(result) ? result.success : undefined))
        )
      : undefined

    if (body === undefined) {
      return yield* new ConformanceMismatch({
        message: 'expected the 404 body to be JSON with a non-empty string error'
      })
    }

    yield* expectEqual(
      failure.message,
      `Todoist get task failed: ${body.error}`,
      'expected the connector message to end with the body error'
    )
  })
})

/** Label listing page size (the Todoist maximum), and the page cap. */
const labelPageSize = 200

export const todoistTaskLabelsCase: TodoistConformanceCase = defineConformanceCase({
  id: 'todoist.labels.task-labels-are-names',
  title: 'Task labels are label names, matching the personal label list',
  safety: 'read',
  docs: '`todoist.get_task` decodes `TodoistTask` with `labels` as an array of strings, and `todoist.create_task` / `todoist.update_task` send `labels` as given; `todoist.list_labels` sends GET /api/v1/labels and decodes `{ results: [{ id, name }], next_cursor }`.',
  wire: '`todoist.get_task` of the seeded task answers `labels` as label NAMES (not ids): every entry equals the `name` of a personal label that `todoist.list_labels` returns (paged with `limit: 200` until `next_cursor` is null).',
  fixtures: [todoistTaskLabelsFixture.id],
  run: Effect.gen(function* () {
    const taskId = yield* requireSeed('labeledTaskId')

    const task = yield* getTask(taskId).pipe(Effect.flatMap(successValue(todoistGetTaskAction.id)))

    const labels = task.labels ?? []

    if (labels.length === 0) {
      return yield* new ConformanceMismatch({
        message: 'precondition: labeledTaskId needs at least one personal label'
      })
    }

    const names: Array<string> = []
    let cursor: string | undefined

    for (let count = 1; ; count++) {
      const page = yield* todoistListLabelsAction
        .executeTyped({
          integration,
          input: TodoistPaginationInput.make({ limit: labelPageSize, cursor })
        })
        .pipe(Effect.flatMap(successValue(todoistListLabelsAction.id)))

      names.push(...page.labels.map(label => label.name))

      if (page.nextCursor === null) {
        break
      }

      if (count >= pageCap) {
        return yield* new ConformanceMismatch({
          message: `precondition: the account has more than ${pageCap * labelPageSize} labels`
        })
      }

      cursor = page.nextCursor
    }

    yield* expectConformance(
      labels.every(label => names.includes(label)),
      'expected every task label to be the name of a listed personal label',
      { actual: labels.filter(label => !names.includes(label)).length }
    )
  })
})

// Write cases.

const lifecycleCaseId = 'todoist.tasks.lifecycle-close'

const updatedTaskContent = `${todoistConformanceMarker} task updated: safe to delete`

export const todoistTaskLifecycleCase: TodoistConformanceCase = defineConformanceCase({
  id: lifecycleCaseId,
  title: 'A task created, read, updated, and closed drops out of the active task list',
  safety: 'write-reversible',
  docs: '`todoist.create_task` sends POST /api/v1/tasks and `todoist.update_task` POST /api/v1/tasks/{id} (JSON, snake_case, undefined fields omitted), both decoding the answer as `TodoistTask`; `todoist.get_task` GETs /tasks/{id}; `todoist.close_task` POSTs /tasks/{id}/close and treats any 2xx as closed without reading the body; `todoist.list_tasks` is documented as listing ACTIVE tasks.',
  wire: 'In the case-owned project: `todoist.create_task` answers the task with the requested `content` and `project_id`; `todoist.get_task` answers the same id and content; `todoist.update_task` with new `content` answers the same id with the new content; `todoist.close_task` answers 2xx; afterwards `todoist.list_tasks` for the project no longer lists the closed task. The case creates its own run-unique project under the seeded work project and deletes it (with the task) again, by id, even when a step fails.',
  fixtures: [todoistTaskLifecycleFixture.id],
  run: Effect.gen(function* () {
    const name = yield* caseProjectName('lifecycle')

    yield* withOwnProject(lifecycleCaseId, name, project =>
      Effect.gen(function* () {
        const task = yield* createOwnTask(lifecycleCaseId, project, { content: taskContent })

        yield* expectEqual(
          task.content,
          taskContent,
          'expected the created task to carry the requested content'
        )

        const fetched = yield* getTask(task.id).pipe(
          Effect.flatMap(successValue(todoistGetTaskAction.id))
        )

        yield* expectEqual(
          [fetched.id, fetched.content],
          [task.id, taskContent],
          'expected get_task to answer the created task'
        )

        const updated = yield* updateTask({ taskId: task.id, content: updatedTaskContent })

        yield* expectEqual(
          [updated.id, updated.content],
          [task.id, updatedTaskContent],
          'expected update_task to answer the same task with the new content'
        )

        yield* todoistCloseTaskAction
          .executeTyped({ integration, input: TodoistCloseTaskInput.make({ taskId: task.id }) })
          .pipe(Effect.flatMap(successValue(todoistCloseTaskAction.id)), Effect.uninterruptible)

        const active = yield* todoistListTasksAction
          .executeTyped({
            integration,
            input: TodoistListTasksInput.make({ projectId: project.id })
          })
          .pipe(Effect.flatMap(successValue(todoistListTasksAction.id)))

        yield* expectConformance(
          active.tasks.every(candidate => candidate.id !== task.id),
          'expected list_tasks to omit the closed task (active tasks only)'
        )
      })
    )
  })
})

const dueCaseId = 'todoist.tasks.due-dates'

/** A fixed synthetic day far in the future. */
const dueDate = '2030-01-15'

const dueDatetime = '2030-01-15T09:30:00Z'

const Due = Schema.Struct({ date: Schema.String, is_recurring: Schema.Boolean })

export const todoistDueDatesCase: TodoistConformanceCase = defineConformanceCase({
  id: dueCaseId,
  title: 'due_date sets a date-only due and due_datetime a timed due in due.date',
  safety: 'write-reversible',
  docs: '`todoist.create_task` and `todoist.update_task` send `dueDate` / `dueDatetime` as `due_date` / `due_datetime`; `TodoistTask.due` is passed to hosts untyped.',
  wire: 'In the case-owned project: `todoist.create_task` with `dueDate: "2030-01-15"` answers `due` with `date: "2030-01-15"` (no time) and `is_recurring: false`; `todoist.update_task` with `dueDatetime: "2030-01-15T09:30:00Z"` answers `due.date` carrying that instant (unverified: API v1 keeps a timed due in `due.date`, as `2030-01-15T09:30:00Z` or with fractional seconds, with no separate `datetime` field). The case creates its own run-unique project under the seeded work project and deletes it (with the task) again, by id, even when a step fails.',
  fixtures: [todoistDueDatesFixture.id],
  run: Effect.gen(function* () {
    const name = yield* caseProjectName('due')

    yield* withOwnProject(dueCaseId, name, project =>
      Effect.gen(function* () {
        const task = yield* createOwnTask(dueCaseId, project, { content: taskContent, dueDate })

        const dated = yield* decodeAs(
          Due,
          'expected the created task to carry a due object with date and is_recurring'
        )(task.due)

        yield* expectEqual(
          [dated.date, dated.is_recurring],
          [dueDate, false],
          'expected due_date to answer a date-only due { date: "2030-01-15", is_recurring: false }'
        )

        const updated = yield* updateTask({ taskId: task.id, dueDatetime })

        const timed = yield* decodeAs(
          Due,
          'expected the updated task to carry a due object with date and is_recurring'
        )(updated.due)

        yield* expectConformance(
          timed.date.includes('T') && Date.parse(timed.date) === Date.parse(dueDatetime),
          'expected due_datetime to answer due.date carrying the requested instant',
          { expected: dueDatetime, actual: timed.date }
        )
      })
    )
  })
})

const parentCaseId = 'todoist.projects.parent-id'

export const todoistProjectParentIdCase: TodoistConformanceCase = defineConformanceCase({
  id: parentCaseId,
  title: 'A project created with parent_id answers and reads back that parent',
  safety: 'write-reversible',
  docs: '`todoist.create_project` sends POST /api/v1/projects with `parent_id` (from `parentId`); `todoist.get_project` GETs /projects/{id}; both decode `TodoistProject`, whose optional `parent_id` is how hosts see the project hierarchy.',
  wire: '`todoist.create_project` with `parentId` set to the seeded work project answers the new project with `parent_id` equal to that id, and `todoist.get_project` of the new project reads the same `parent_id` back. The case creates its own run-unique project and deletes it again, by id, even when a step fails.',
  fixtures: [todoistProjectParentIdFixture.id],
  run: Effect.gen(function* () {
    const workProjectId = yield* requireSeed('workProjectId')
    const name = yield* caseProjectName('parent')

    yield* withOwnProject(parentCaseId, name, (project, created) =>
      Effect.gen(function* () {
        yield* expectEqual(
          created.parent_id ?? null,
          workProjectId,
          'expected create_project to answer parent_id naming the work project'
        )

        const fetched = yield* getProject(project.id).pipe(
          Effect.flatMap(successValue(todoistGetProjectAction.id))
        )

        yield* expectEqual(
          fetched.parent_id ?? null,
          workProjectId,
          'expected get_project to read parent_id back'
        )
      })
    )
  })
})

const deleteCaseId = 'todoist.projects.delete-then-not-found'

export const todoistProjectDeleteCase: TodoistConformanceCase = defineConformanceCase({
  id: deleteCaseId,
  title: 'A deleted project, and a task in it, answer not found',
  safety: 'write-reversible',
  docs: "`todoist.delete_project` sends DELETE /api/v1/projects/{id} and treats any 2xx as deleted without reading the body; `todoist.get_project` and `todoist.get_task` map HTTP 404 to `todoist_not_found`. The write cases' own cleanup deletes the case project by id and relies on this.",
  wire: 'In the case-owned project holding one task: `todoist.delete_project` answers 2xx; afterwards `todoist.get_project` answers HTTP 404 (`todoist_not_found`; unverified: that a deleted project answers 404 rather than a body marked `is_deleted`), and `todoist.get_task` of the task that was in it answers `todoist_not_found` too (unverified: that deleting a project deletes its tasks). The case creates its own run-unique project under the seeded work project and deletes it again whenever the claim did not.',
  fixtures: [todoistProjectDeleteFixture.id],
  run: Effect.gen(function* () {
    const name = yield* caseProjectName('delete')

    yield* withOwnProject(deleteCaseId, name, (project, _created, pending) =>
      Effect.gen(function* () {
        const task = yield* createOwnTask(deleteCaseId, project, { content: taskContent })

        yield* deleteProject(project.id).pipe(
          Effect.flatMap(successValue(todoistDeleteProjectAction.id)),
          Effect.uninterruptible
        )

        const after = yield* getProject(project.id)

        yield* expectConformance(
          isNotFound(after) && failureOf(after)?.status === 404,
          'expected get_project after delete_project to answer todoist_not_found (HTTP 404)',
          { actual: outcomeOf(after) }
        )
        yield* Ref.set(pending, [])

        const orphan = yield* getTask(task.id)

        yield* expectConformance(
          isNotFound(orphan),
          'expected get_task of a task in the deleted project to answer todoist_not_found',
          { actual: outcomeOf(orphan) }
        )
      })
    )
  })
})

/** Project listing page size (the Todoist maximum), and the pages read before giving up. */
const leftoverPageSize = 200

const leftoverPageCap = 20

/**
 * READ-ONLY and bounded: `name (id)` of every active project whose name starts with
 * `yolk-conformance-run-`, which earlier runs left behind (a killed process, a failed or ambiguous
 * cleanup). It reads at most 20 `todoist.list_projects` pages of 200 projects and then stops, so a
 * larger account may hide some leftovers. Every valid run id starts with `run-`, so every run's
 * projects match `todoistConformanceRunProjectPrefix`, wherever they were created. Live runners
 * call it before any write case and warn per leftover; nothing is ever deleted automatically.
 */
export const findTodoistConformanceLeftovers: Effect.Effect<
  ReadonlyArray<string>,
  TodoistConformanceError,
  TodoistConformanceRequirements
> = Effect.gen(function* () {
  const found: Array<string> = []
  let cursor: string | undefined

  for (let count = 1; count <= leftoverPageCap; count++) {
    const page = yield* todoistListProjectsAction
      .executeTyped({
        integration,
        input: TodoistPaginationInput.make({ limit: leftoverPageSize, cursor })
      })
      .pipe(Effect.flatMap(successValue(todoistListProjectsAction.id)))

    for (const project of page.projects) {
      if (project.name.startsWith(todoistConformanceRunProjectPrefix)) {
        found.push(`${project.name} (${project.id})`)
      }
    }

    if (page.nextCursor === null) {
      break
    }

    cursor = page.nextCursor
  }

  return found
})

/** Every Todoist conformance case, in fixture order. */
export const todoistConformanceCases: ReadonlyArray<TodoistConformanceCase> = [
  todoistTasksPagingCase,
  todoistNotFoundEnvelopeCase,
  todoistTaskLabelsCase,
  todoistTaskLifecycleCase,
  todoistDueDatesCase,
  todoistProjectParentIdCase,
  todoistProjectDeleteCase
]
