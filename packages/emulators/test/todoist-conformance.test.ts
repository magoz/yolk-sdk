/**
 * Cross-checks: the Todoist emulator must satisfy the same conformance cases the replayed fixtures
 * satisfy, through the REAL Todoist connector actions, both in-process (A) and over a loopback
 * socket (B); the read-only leftover lookup must fail closed (its listing has no fixture); and each
 * drill knob must make
 * exactly its case fail. Tests may import SDK packages; the emulator source never does.
 */
import { Effect, Layer } from 'effect'
import { FetchHttpClient, type HttpClient } from 'effect/http'
import { describe, expect, it } from '@effect/vitest'
import {
  formatConformanceReport,
  runConformance,
  type ConformanceReport,
  type ConformanceTarget
} from '@yolk-sdk/conformance/runner'
import { ApiKeyCredential } from '@yolk-sdk/connectors'
import {
  connectorHttpClientsFromEffectHttpClientLayer,
  staticCredentialResolverLayer
} from '@yolk-sdk/connectors/conformance'
import { todoistApiBaseUrl } from '@yolk-sdk/connectors/todoist'
import {
  TodoistConformanceConfig,
  findTodoistConformanceLeftovers,
  todoistConformanceCases,
  todoistConformanceFixtureSeeds,
  type TodoistConformanceSeeds
} from '@yolk-sdk/connectors/todoist/conformance'
import { serveFetchHandler } from '../src/node.ts'
import { EmulatedHttpClient, EmulatorRoute, InProcessHttpClient } from '../src/router.ts'
import {
  makeTodoistEmulator,
  type TodoistEmulator,
  type TodoistEmulatorDrills,
  type TodoistEmulatorOptions,
  type TodoistEmulatorState,
  type TodoistLedgerEntry
} from '../src/todoist.ts'

const origin = new URL(todoistApiBaseUrl).origin

const now = new Date('2026-09-30T12:00:00.000Z')

const apiToken = 'synthetic-todoist-api-token'

const credentialLayer = staticCredentialResolverLayer(ApiKeyCredential.make({ key: apiToken }))

const portsOver = <E>(
  httpLayer: Layer.Layer<HttpClient.HttpClient, E>,
  seeds: TodoistConformanceSeeds = todoistConformanceFixtureSeeds
) =>
  Layer.mergeAll(
    connectorHttpClientsFromEffectHttpClientLayer.pipe(Layer.provide(httpLayer)),
    credentialLayer,
    Layer.succeed(TodoistConformanceConfig, seeds)
  )

const inProcessLayer = (emulator: TodoistEmulator) =>
  InProcessHttpClient.layer([EmulatorRoute.handler(origin, emulator.fetch)])

/** Real `FetchHttpClient` underneath; the origin rewritten to a server on 127.0.0.1:0. */
const emulatedLayer = (emulator: TodoistEmulator) =>
  Layer.unwrap(
    serveFetchHandler(emulator.fetch).pipe(
      Effect.map(server =>
        EmulatedHttpClient.layer([EmulatorRoute.url(origin, server.url)]).pipe(
          Layer.provide(FetchHttpClient.layer)
        )
      )
    )
  )

type Emulators = ReadonlyMap<string, TodoistEmulator>

/** One fresh emulator per case (same seed), closed when the effect ends. */
const withEmulators = <A, E, R>(
  options: TodoistEmulatorOptions,
  use: (emulators: Emulators) => Effect.Effect<A, E, R>
) =>
  Effect.acquireUseRelease(
    Effect.promise(async () => {
      const emulators = new Map<string, TodoistEmulator>()

      for (const testCase of todoistConformanceCases) {
        emulators.set(
          testCase.id,
          await makeTodoistEmulator({ now: () => now.getTime(), ...options })
        )
      }

      return emulators
    }),
    use,
    emulators =>
      Effect.promise(() => Promise.all([...emulators.values()].map(emulator => emulator.close())))
  )

const emulatorFor = (emulators: Emulators, caseId: string): TodoistEmulator => {
  const emulator = emulators.get(caseId)

  if (emulator === undefined) {
    throw new Error(`no emulator for ${caseId}`)
  }

  return emulator
}

const runAll = <E>(
  emulators: Emulators,
  target: ConformanceTarget,
  transport: (emulator: TodoistEmulator) => Layer.Layer<HttpClient.HttpClient, E>,
  seeds: TodoistConformanceSeeds = todoistConformanceFixtureSeeds
) =>
  runConformance(todoistConformanceCases, {
    target,
    now,
    layer: testCase => portsOver(transport(emulatorFor(emulators, testCase.id)), seeds)
  })

const caseCount = todoistConformanceCases.length

const expectAllPassed = (report: ConformanceReport) => {
  expect(report.summary, formatConformanceReport(report)).toEqual({
    passed: caseCount,
    failed: 0,
    skipped: 0
  })
}

const requests = (entries: ReadonlyArray<TodoistLedgerEntry>) =>
  entries.map(entry => `${entry.method} ${entry.route ?? entry.path} ${entry.status}`)

/** The state without its id counters, which creates and 404s advance by design. */
const withoutCounters = ({ counters: _counters, ...state }: TodoistEmulatorState) => state

const readCaseIds = todoistConformanceCases
  .filter(testCase => testCase.safety === 'read')
  .map(testCase => testCase.id)

const writeCaseIds = todoistConformanceCases
  .filter(testCase => testCase.safety === 'write-reversible')
  .map(testCase => testCase.id)

describe('cross-check A: in-process emulator through the real connector', () => {
  // What "ends at the seed" means: every read case leaves the exact seed except the not-found
  // case, whose 404 advances the event-id counter; every write case deletes the project it
  // created (with its task) and ends at the seed except the id counters (project, task, and
  // event numbers), which only ever advance.
  it.effect(
    'passes every Todoist case; the state ends at the seed except the advanced id counters',
    () =>
      withEmulators({}, emulators =>
        Effect.gen(function* () {
          const seeds = new Map(
            [...emulators].map(([id, emulator]) => [id, emulator.snapshot()] as const)
          )

          const report = yield* runAll(emulators, { kind: 'in-process' }, inProcessLayer)

          expectAllPassed(report)
          expect(report.target).toEqual({ kind: 'in-process' })
          expect(readCaseIds).toHaveLength(3)
          expect(writeCaseIds).toHaveLength(4)

          const seedOf = (id: string): TodoistEmulatorState => {
            const seed = seeds.get(id)

            if (seed === undefined) throw new Error(`no seed for ${id}`)

            return seed
          }

          const stateOf = (id: string) => emulatorFor(emulators, id).snapshot()
          const ledgerOf = (id: string) => emulatorFor(emulators, id).ledger.entries()

          for (const id of [...readCaseIds, ...writeCaseIds]) {
            expect(withoutCounters(stateOf(id)), id).toEqual(withoutCounters(seedOf(id)))

            for (const [key, value] of Object.entries(stateOf(id).counters)) {
              const before = Object.entries(seedOf(id).counters).find(([name]) => name === key)

              expect(value, `${id} ${key}`).toBeGreaterThanOrEqual(before?.[1] ?? 0)
            }

            expect(
              ledgerOf(id).every(entry => entry.notEmulated === undefined),
              id
            ).toBe(true)
          }

          for (const id of [
            'todoist.tasks.list-cursor-paging',
            'todoist.labels.task-labels-are-names'
          ]) {
            expect(stateOf(id), id).toEqual(seedOf(id))
          }

          for (const id of writeCaseIds) {
            expect(stateOf(id).counters.nextProjectNumber, id).toBe(2)
          }

          // Two pages, the second through the cursor the first answered.
          expect(
            ledgerOf('todoist.tasks.list-cursor-paging').map(entry => [entry.query, entry.status])
          ).toEqual([
            [{ project_id: '6XSyntheticPage0', limit: '2' }, 200],
            [{ project_id: '6XSyntheticPage0', cursor: 'SyntheticTaskCursor0001', limit: '2' }, 200]
          ])

          expect(requests(ledgerOf('todoist.errors.not-found-envelope'))).toEqual([
            'GET /api/v1/tasks/{taskId} 404'
          ])

          expect(requests(ledgerOf('todoist.labels.task-labels-are-names'))).toEqual([
            'GET /api/v1/tasks/{taskId} 200',
            'GET /api/v1/labels 200'
          ])

          // The lifecycle fixture's exchanges, then the restore.
          expect(requests(ledgerOf('todoist.tasks.lifecycle-close'))).toEqual([
            'POST /api/v1/projects 200',
            'POST /api/v1/tasks 200',
            'GET /api/v1/tasks/{taskId} 200',
            'POST /api/v1/tasks/{taskId} 200',
            'POST /api/v1/tasks/{taskId}/close 204',
            'GET /api/v1/tasks 200',
            'DELETE /api/v1/projects/{projectId} 204',
            'GET /api/v1/projects/{projectId} 404'
          ])

          expect(requests(ledgerOf('todoist.tasks.due-dates'))).toEqual([
            'POST /api/v1/projects 200',
            'POST /api/v1/tasks 200',
            'POST /api/v1/tasks/{taskId} 200',
            'DELETE /api/v1/projects/{projectId} 204',
            'GET /api/v1/projects/{projectId} 404'
          ])

          expect(requests(ledgerOf('todoist.projects.parent-id'))).toEqual([
            'POST /api/v1/projects 200',
            'GET /api/v1/projects/{projectId} 200',
            'DELETE /api/v1/projects/{projectId} 204',
            'GET /api/v1/projects/{projectId} 404'
          ])

          // The delete case proves the project and its task gone; no restore follows.
          expect(requests(ledgerOf('todoist.projects.delete-then-not-found'))).toEqual([
            'POST /api/v1/projects 200',
            'POST /api/v1/tasks 200',
            'DELETE /api/v1/projects/{projectId} 204',
            'GET /api/v1/projects/{projectId} 404',
            'GET /api/v1/tasks/{taskId} 404'
          ])

          expect(ledgerOf('todoist.projects.parent-id')[0]?.body).toEqual({
            name: 'yolk-conformance-run-synthetic-parent',
            parent_id: '6XSyntheticWork0'
          })

          // No credential ever reaches a ledger or a state.
          for (const emulator of emulators.values()) {
            const recorded = JSON.stringify([
              emulator.ledger.entries(),
              emulator.snapshot(),
              emulator.coverage()
            ])

            expect(recorded).not.toContain(apiToken)
            expect(recorded.toLowerCase()).not.toContain('bearer')
          }
        })
      ),
    60_000
  )

  // The live runner generates a fresh `run-<hex>` per invocation: case projects take that name.
  it.effect('passes every Todoist case with a run-<hex> run id', () =>
    withEmulators({}, emulators =>
      Effect.gen(function* () {
        const report = yield* runAll(emulators, { kind: 'in-process' }, inProcessLayer, {
          ...todoistConformanceFixtureSeeds,
          runId: 'run-0a1b2c3d4e5f'
        })

        expectAllPassed(report)
        expect(emulatorFor(emulators, 'todoist.tasks.due-dates').ledger.entries()[0]?.body).toEqual(
          { name: 'yolk-conformance-run-0a1b2c3d4e5f-due', parent_id: '6XSyntheticWork0' }
        )
      })
    )
  )

  // No fixture records the project listing the leftover lookup sends, so the emulator answers it
  // 400 not-emulated (fixture-only): the lookup fails, and the repository runners print their
  // lookup-failed WARN (`could not look for leftovers (lookup failed:
  // todoist_list_projects_failed HTTP 400)`) instead of leftover warnings. Nothing is written.
  it.effect('the leftover lookup fails closed: its project listing is not emulated', () =>
    Effect.acquireUseRelease(
      Effect.promise(() => makeTodoistEmulator({ now: () => now.getTime() })),
      emulator =>
        Effect.gen(function* () {
          const seed = emulator.snapshot()

          const failure = yield* findTodoistConformanceLeftovers.pipe(
            Effect.provide(portsOver(inProcessLayer(emulator))),
            Effect.flip
          )

          expect(failure).toMatchObject({
            _tag: 'TodoistConformanceActionFailed',
            actionId: 'todoist.list_projects',
            code: 'todoist_list_projects_failed',
            status: 400
          })
          expect(emulator.snapshot()).toEqual(seed)
          expect(emulator.ledger.entries()).toEqual([
            expect.objectContaining({
              method: 'GET',
              path: '/<unrecognised>',
              query: {},
              status: 400,
              evidence: 'unknown-route',
              notEmulated: 'no emulated Todoist route for this method and path'
            })
          ])
        }),
      emulator => Effect.promise(() => emulator.close())
    )
  )
})

describe('one shared emulator', () => {
  // A shared emulator works when the write cases run one after another: each case deletes its
  // project before the next creates one (a seeded parent takes one sub-project, `child_order: 1`).
  it.effect(
    'passes all seven Todoist cases run sequentially against ONE emulator, ending at the seed except counters',
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => makeTodoistEmulator({ now: () => now.getTime() })),
        emulator =>
          Effect.gen(function* () {
            const seed = emulator.snapshot()

            const report = yield* runConformance(todoistConformanceCases, {
              target: { kind: 'in-process' },
              now,
              concurrency: 1,
              layer: () => portsOver(inProcessLayer(emulator))
            })

            expectAllPassed(report)
            expect(withoutCounters(emulator.snapshot())).toEqual(withoutCounters(seed))
            expect(emulator.snapshot().counters).toEqual({
              nextProjectNumber: 5,
              nextTaskNumber: 4,
              nextEventNumber: 7
            })
            expect(emulator.ledger.entries().every(entry => entry.notEmulated === undefined)).toBe(
              true
            )
            expect(JSON.stringify(emulator.ledger.entries())).not.toContain(apiToken)
          }),
        emulator => Effect.promise(() => emulator.close())
      ),
    60_000
  )
})

describe('cross-check B: emulated over a loopback socket', () => {
  it.effect(
    'passes every Todoist case through FetchHttpClient and EmulatedHttpClient',
    () =>
      withEmulators({}, emulators =>
        Effect.gen(function* () {
          const seeds = new Map(
            [...emulators].map(([id, emulator]) => [id, emulator.snapshot()] as const)
          )

          const report = yield* runAll(emulators, { kind: 'emulated' }, emulatedLayer)

          expectAllPassed(report)
          expect(report.target).toEqual({ kind: 'emulated' })

          for (const testCase of todoistConformanceCases) {
            const emulator = emulatorFor(emulators, testCase.id)
            const entries = emulator.ledger.entries()
            const seed = seeds.get(testCase.id)

            // The same end-at-seed proof as cross-check A: only the id counters moved.
            if (seed === undefined) throw new Error(`no seed for ${testCase.id}`)

            expect(withoutCounters(emulator.snapshot()), testCase.id).toEqual(withoutCounters(seed))
            expect(
              entries.every(entry => entry.notEmulated === undefined),
              testCase.id
            ).toBe(true)

            expect(entries.length, testCase.id).toBeGreaterThan(0)
            expect(
              entries.every(entry => entry.evidence === 'unverified'),
              testCase.id
            ).toBe(true)
            expect(JSON.stringify(entries), testCase.id).not.toContain(apiToken)
          }
        })
      ),
    60_000
  )
})

const drill = (drills: TodoistEmulatorDrills) =>
  withEmulators({ drills }, emulators => runAll(emulators, { kind: 'in-process' }, inProcessLayer))

const expectOnlyFailure = (
  report: ConformanceReport,
  failure: { readonly id: string; readonly tag: string; readonly message: string }
) => {
  expect(report.summary, formatConformanceReport(report)).toEqual({
    passed: caseCount - 1,
    failed: 1,
    skipped: 0
  })

  const failed = report.results.filter(result => result.status === 'failed')

  expect(failed.map(result => result.id)).toEqual([failure.id])
  expect(failed[0]?.failure?.tag).toBe(failure.tag)
  expect(failed[0]?.failure?.message).toContain(failure.message)
}

describe('disagreement drills (tests-only knobs): each fails exactly its case', () => {
  it.effect.each([
    [
      { cursorRestarts: true },
      'todoist.tasks.list-cursor-paging',
      'expected a later page to repeat no task from an earlier page'
    ],
    [
      { notFoundWithoutError: true },
      'todoist.errors.not-found-envelope',
      'expected the 404 body to be JSON with a non-empty string error'
    ],
    [
      { taskLabelsAsIds: true },
      'todoist.labels.task-labels-are-names',
      'expected every task label to be the name of a listed personal label'
    ],
    [
      { listIncludesClosed: true },
      'todoist.tasks.lifecycle-close',
      'expected list_tasks to omit the closed task'
    ],
    [
      { ignoreDue: true },
      'todoist.tasks.due-dates',
      'expected the created task to answer a due whose date starts with 2030-01-15'
    ],
    [
      { createOmitsParent: true },
      'todoist.projects.parent-id',
      'expected create_project to answer parent_id naming the work project'
    ],
    [
      { deleteKeepsTasks: true },
      'todoist.projects.delete-then-not-found',
      'which was in the deleted project, to answer todoist_not_found'
    ]
  ] as const)(
    '%o fails only %s',
    ([drills, id, message]) =>
      Effect.gen(function* () {
        expectOnlyFailure(yield* drill(drills), { id, tag: 'ConformanceMismatch', message })
      }),
    60_000
  )
})
