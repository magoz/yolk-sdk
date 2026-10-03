/**
 * Todoist conformance runner for a practice Todoist account (`pnpm conformance:todoist`).
 *
 * Default: DRY RUN. Prints every case id, its safety, and whether it would run under the chosen
 * flags, then exits without any network call or credential read.
 *
 * `--live --owner-approved --account <label>`: runs the cases against the real Todoist API v1 with
 * a `FetchHttpClient`, through the real connector actions. Refused whenever `CI` is non-empty and
 * without `--owner-approved`. Requires `TODOIST_API_TOKEN` (environment only, never a flag; the
 * practice account's API token) and the seed ids of every case that will run (flags or
 * environment, see the usage text). Read cases always run; `--allow-writes reversible` adds the
 * write-reversible cases, which each create their own `yolk-conformance-<runId>-*` project under
 * `--work-project` and delete it again by id. The runner generates a fresh random `runId` for every
 * invocation (it is never a flag), so concurrent runs never share a project; a definitive create
 * rejection deletes nothing, and an ambiguous create is reported with the exact project to check by
 * hand. There are no write-irreversible Todoist cases.
 *
 * `--record` (with `--live`) stages verified recordings all or nothing in a new run directory under
 * the gitignored `.conformance-recordings/todoist/`. Promotion is manual: scrub the staged files of
 * practice-account data (project and task names, label names, ids, user ids, cursors), copy them
 * into `packages/connectors/src/todoist/conformance/`, run `pnpm format:fix`, and update
 * `packages/connectors/test/todoist-conformance.test.ts` and
 * `scripts/test/run-todoist-conformance.test.ts` in the same change. See
 * `connector-conformance-internal.ts` for the shared gates.
 *
 * Never run live in CI.
 */
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { Layer } from 'effect'
import * as Schema from 'effect/Schema'
import type { HttpClient } from 'effect/http'
import {
  connectorHttpClientsFromEffectHttpClientLayer,
  staticCredentialResolverLayer
} from '../packages/connectors/src/conformance/index.ts'
import { ApiKeyCredential } from '../packages/connectors/src/credential.ts'
import {
  TodoistConformanceConfig,
  TodoistConformanceSeeds,
  findTodoistConformanceLeftovers,
  todoistConformanceCases,
  todoistConformanceFixtureSeeds,
  type TodoistConformanceError,
  type TodoistConformanceRequirements,
  type TodoistConformanceSeedKey
} from '../packages/connectors/src/todoist/conformance/index.ts'
import { todoistApiBaseUrl } from '../packages/connectors/src/todoist/index.ts'
import {
  recordingsRootFor,
  runConnectorConformanceCli,
  type CaseSpec,
  type ConnectorConformanceRunner,
  type SeedSource
} from './connector-conformance-internal.ts'

/** Where each seed id comes from. Flags win over environment variables. */
export const todoistSeedSources: ReadonlyArray<SeedSource<TodoistConformanceSeedKey>> = [
  {
    key: 'pagingProjectId',
    flag: '--paging-project',
    env: 'TODOIST_CONFORMANCE_PAGING_PROJECT',
    description: 'project holding more than two active tasks'
  },
  {
    key: 'labeledTaskId',
    flag: '--labeled-task',
    env: 'TODOIST_CONFORMANCE_LABELED_TASK',
    description: 'active task with at least one personal label'
  },
  {
    key: 'workProjectId',
    flag: '--work-project',
    env: 'TODOIST_CONFORMANCE_WORK_PROJECT',
    description: 'existing project the write cases create their own projects under'
  }
]

/** Seeds each case needs, and the fixture module `--record` rewrites for it. */
export const todoistCaseSpecs: ReadonlyArray<CaseSpec<TodoistConformanceSeedKey>> = [
  {
    caseId: 'todoist.tasks.list-cursor-paging',
    seeds: ['pagingProjectId'],
    optionalSeeds: [],
    fileName: 'tasks-paging.ts',
    exportName: 'todoistTasksPagingFixture',
    doc: 'A `limit=2` task listing of the seeded paging project, then the pages its `next_cursor` leads to.'
  },
  {
    caseId: 'todoist.errors.not-found-envelope',
    seeds: [],
    optionalSeeds: [],
    fileName: 'not-found-envelope.ts',
    exportName: 'todoistNotFoundEnvelopeFixture',
    doc: '`todoist.get_task` of a well-formed id that addresses no task: HTTP 404 with the JSON error body.'
  },
  {
    caseId: 'todoist.labels.task-labels-are-names',
    seeds: ['labeledTaskId'],
    optionalSeeds: [],
    fileName: 'task-labels.ts',
    exportName: 'todoistTaskLabelsFixture',
    doc: 'The seeded labeled task, then the personal label list.'
  },
  {
    caseId: 'todoist.tasks.lifecycle-close',
    seeds: ['workProjectId', 'runId'],
    optionalSeeds: [],
    fileName: 'task-lifecycle.ts',
    exportName: 'todoistTaskLifecycleFixture',
    doc: 'Project create, task create, read, update, and close, the active task list, then the project delete and a not-found lookup.'
  },
  {
    caseId: 'todoist.tasks.due-dates',
    seeds: ['workProjectId', 'runId'],
    optionalSeeds: [],
    fileName: 'due-dates.ts',
    exportName: 'todoistDueDatesFixture',
    doc: 'Project create, a task create with `due_date`, its update with `due_datetime`, then the project delete and a not-found lookup.'
  },
  {
    caseId: 'todoist.projects.parent-id',
    seeds: ['workProjectId', 'runId'],
    optionalSeeds: [],
    fileName: 'project-parent-id.ts',
    exportName: 'todoistProjectParentIdFixture',
    doc: 'Project create under the work project, its read-back, then the project delete and a not-found lookup.'
  },
  {
    caseId: 'todoist.projects.delete-then-not-found',
    seeds: ['workProjectId', 'runId'],
    optionalSeeds: [],
    fileName: 'project-delete.ts',
    exportName: 'todoistProjectDeleteFixture',
    doc: 'Project create, a task create in it, the project delete, then not-found lookups of the project and the task.'
  }
]

/** A fresh invocation-unique run id (`run-<8 hex>`), so concurrent live runs never share projects. */
export const generateRunId = (): string => `run-${randomBytes(4).toString('hex')}`

/** The live credential: the practice account's API token. */
export const liveCredential = (accessToken: string) => ApiKeyCredential.make({ key: accessToken })

const casePorts = (
  httpLayer: Layer.Layer<HttpClient.HttpClient>,
  accessToken: string,
  seeds: TodoistConformanceSeeds
) =>
  Layer.mergeAll(
    connectorHttpClientsFromEffectHttpClientLayer.pipe(Layer.provide(httpLayer)),
    staticCredentialResolverLayer(liveCredential(accessToken)),
    Layer.succeed(TodoistConformanceConfig, seeds)
  )

export const todoistRunner = {
  provider: 'todoist',
  displayName: 'Todoist',
  practiceTarget: 'a practice Todoist account',
  tokenEnv: 'TODOIST_API_TOKEN',
  tokenScopes: "the practice account's API token (Settings > Integrations > Developer)",
  endpoint: todoistApiBaseUrl,
  writeNote:
    'create their own yolk-conformance-<run id> project under --work-project (a fresh random run id per invocation) and delete it again by id',
  cases: todoistConformanceCases,
  seedSources: todoistSeedSources,
  generatedSeeds: { keys: ['runId'], generate: () => ({ runId: generateRunId() }) },
  caseSpecs: todoistCaseSpecs,
  fixtureSeeds: todoistConformanceFixtureSeeds,
  seedNoun: 'ids',
  seedsTypeName: 'TodoistConformanceSeeds',
  seedsExportName: 'todoistConformanceFixtureSeeds',
  configName: 'TodoistConformanceConfig',
  decodeSeeds: Schema.decodeUnknownOption(TodoistConformanceSeeds),
  invalidSeedsMessage:
    'Seed ids must be Todoist ids (letters, digits, underscores, and hyphens, at most 64 characters)',
  casePorts,
  recordedRequestHeaders: [],
  // Read-only: active `yolk-conformance-run-*` projects that earlier runs left behind.
  leftovers: findTodoistConformanceLeftovers,
  leftoverAdvice: 'delete it by hand after checking that no run is still using it',
  nameKeys: /^(?:name|full_name|email|string)$/,
  textKeys: /^(?:content|description)$/
} satisfies ConnectorConformanceRunner<
  TodoistConformanceSeedKey,
  TodoistConformanceSeeds,
  TodoistConformanceError,
  TodoistConformanceRequirements
>

/** Gitignored root of staged Todoist recordings. */
export const recordingsRoot = recordingsRootFor(todoistRunner.provider)

const invokedAsCli = (): boolean => {
  const invoked = process.argv[1]

  return invoked !== undefined && resolve(invoked) === fileURLToPath(import.meta.url)
}

if (invokedAsCli()) {
  runConnectorConformanceCli(todoistRunner)
}
