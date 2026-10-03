import { describe, expect, it } from '@effect/vitest'
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Ref } from 'effect'
import * as Schema from 'effect/Schema'
import { TestClock } from 'effect/testing'
import { HttpClient, HttpClientError, type HttpClientRequest } from 'effect/http'
import { defineConformanceCase, type ConformanceCase } from '@yolk-sdk/conformance/case'
import {
  decodeWireFixture,
  isWireBase64BodyResponse,
  isWireStreamResponse,
  scanFixtureForSecrets,
  type WireExchange,
  type WireFixture,
  type WireResponse
} from '@yolk-sdk/conformance/fixture'
import {
  makeReplayHttpClient,
  ReplayHttpClient,
  type ReplayLedgerApi,
  type ReplayLedgerEntry
} from '@yolk-sdk/conformance/replay'
import {
  conformanceReportFailed,
  formatConformanceReport,
  runConformance,
  type ConformanceTarget
} from '@yolk-sdk/conformance/runner'
import { ApiKeyCredential } from '@yolk-sdk/connectors'
import {
  ConformanceCleanupReporter,
  connectorHttpClientsFromEffectHttpClientLayer,
  staticCredentialResolverLayer
} from '@yolk-sdk/connectors/conformance'
import { TodoistConnector } from '@yolk-sdk/connectors/todoist'
import {
  TodoistConformanceConfig,
  TodoistConformanceSeeds as TodoistConformanceSeedsSchema,
  findTodoistConformanceLeftovers,
  todoistConformanceCases,
  todoistConformanceFixtureSeeds,
  todoistConformanceFixtures,
  todoistDueDatesFixture,
  todoistNotFoundEnvelopeFixture,
  todoistProjectDeleteFixture,
  todoistProjectParentIdCase,
  todoistProjectParentIdFixture,
  todoistTaskLabelsFixture,
  todoistTaskLifecycleCase,
  todoistTaskLifecycleFixture,
  todoistTasksPagingCase,
  todoistTasksPagingFixture,
  type TodoistConformanceCase,
  type TodoistConformanceSeeds
} from '@yolk-sdk/connectors/todoist/conformance'

const now = new Date('2026-09-30T12:00:00.000Z')

const atTestNow = TestClock.setTime(now.getTime())

const credentialLayer = staticCredentialResolverLayer(
  ApiKeyCredential.make({ key: 'synthetic-todoist-api-token' })
)

const portsOver = (
  httpLayer: Layer.Layer<HttpClient.HttpClient>,
  seeds: TodoistConformanceSeeds = todoistConformanceFixtureSeeds
) =>
  Layer.mergeAll(
    connectorHttpClientsFromEffectHttpClientLayer.pipe(Layer.provide(httpLayer)),
    credentialLayer,
    Layer.succeed(TodoistConformanceConfig, seeds)
  )

const fixturesFor = (
  testCase: Pick<ConformanceCase<unknown, unknown>, 'fixtures'>,
  fixtures: ReadonlyArray<WireFixture> = todoistConformanceFixtures
) => fixtures.filter(fixture => testCase.fixtures.includes(fixture.id))

const replayLayerOver =
  (fixtures: ReadonlyArray<WireFixture> = todoistConformanceFixtures) =>
  (testCase: TodoistConformanceCase) =>
    portsOver(ReplayHttpClient.layer(fixturesFor(testCase, fixtures)))

/** Replay layer that also hands its ledger to the test, keyed by case id. */
const ledgerCaseLayer =
  (
    ledgers: Ref.Ref<Map<string, ReplayLedgerApi>>,
    fixtures: ReadonlyArray<WireFixture> = todoistConformanceFixtures,
    seeds: TodoistConformanceSeeds = todoistConformanceFixtureSeeds
  ) =>
  (testCase: TodoistConformanceCase) =>
    portsOver(
      Layer.unwrap(
        makeReplayHttpClient(fixturesFor(testCase, fixtures)).pipe(
          Effect.tap(({ ledger }) =>
            Ref.update(ledgers, current => new Map(current).set(testCase.id, ledger))
          ),
          Effect.map(({ client }) => Layer.succeed(HttpClient.HttpClient, client))
        )
      ),
      seeds
    )

const ledgerOf = (ledgers: Ref.Ref<Map<string, ReplayLedgerApi>>, caseId: string) =>
  Effect.gen(function* () {
    const ledger = (yield* Ref.get(ledgers)).get(caseId)

    if (ledger === undefined) {
      return expect.fail(`no ledger for ${caseId}`)
    }

    return { entries: yield* ledger.entries, remaining: yield* ledger.remaining }
  })

const apiBase = 'https://api.todoist.com/api/v1/'

/** `METHOD route exchangeIndex` per ledger entry (route without the query string). */
const exchangeIndices = (entries: ReadonlyArray<ReplayLedgerEntry>) =>
  entries.map(entry =>
    entry.match.outcome === 'matched'
      ? `${entry.method} ${entry.url.slice(apiBase.length).split('?', 1)[0]} ${entry.match.exchangeIndex}`
      : `unmatched ${entry.method} ${entry.url}`
  )

const synthetic = (id: string) => `${id}.synthetic`

const caseIds = [
  ['todoist.tasks.list-cursor-paging', 'read'],
  ['todoist.errors.not-found-envelope', 'read'],
  ['todoist.labels.task-labels-are-names', 'read'],
  ['todoist.tasks.lifecycle-close', 'write-reversible'],
  ['todoist.tasks.due-dates', 'write-reversible'],
  ['todoist.projects.parent-id', 'write-reversible'],
  ['todoist.projects.delete-then-not-found', 'write-reversible']
] as const

function textBody(response: WireResponse): string {
  if (isWireStreamResponse(response) || isWireBase64BodyResponse(response)) {
    return expect.fail('expected a text body')
  }

  return response.body
}

describe('Todoist conformance cases', () => {
  it('declare their safety, stay unverified, and are backed by one fixture each', () => {
    expect(todoistConformanceCases.map(testCase => [testCase.id, testCase.safety])).toEqual(
      caseIds.map(([id, safety]) => [id, safety])
    )
    expect(todoistConformanceFixtures.map(fixture => fixture.caseId)).toEqual(
      todoistConformanceCases.map(testCase => testCase.id)
    )

    for (const testCase of todoistConformanceCases) {
      expect(testCase.observed).toBeUndefined()
      expect(testCase.fixtures).toEqual([synthetic(testCase.id)])
    }
  })

  it('cite only real connector actions', () => {
    const actionIds = new Set(TodoistConnector.actions.map(action => action.id))

    for (const testCase of todoistConformanceCases) {
      const cited = [...`${testCase.docs} ${testCase.wire}`.matchAll(/`(todoist\.[a-z_]+)`/g)].map(
        match => match[1]
      )

      expect(cited.length).toBeGreaterThan(0)
      expect(cited.filter(id => id === undefined || !actionIds.has(id))).toEqual([])
    }
  })

  it('mark every guessed sub-claim unverified in wire', () => {
    expect(
      todoistConformanceCases.flatMap(testCase =>
        [...testCase.wire.matchAll(/\bunverified: /g)].map(() => testCase.id)
      )
    ).toEqual([
      'todoist.errors.not-found-envelope',
      'todoist.errors.not-found-envelope',
      'todoist.tasks.due-dates',
      'todoist.projects.delete-then-not-found',
      'todoist.projects.delete-then-not-found'
    ])
  })

  it.effect('ship synthetic fixtures that decode and pass the secret scan', () =>
    Effect.gen(function* () {
      for (const fixture of todoistConformanceFixtures) {
        expect(yield* decodeWireFixture(fixture)).toEqual(fixture)
        expect(scanFixtureForSecrets(fixture)).toEqual([])
        expect(fixture).toMatchObject({ evidence: 'unverified', account: 'synthetic' })

        for (const { request, response } of fixture.exchanges) {
          expect(Object.keys(request.headers ?? {})).not.toContain('authorization')
          expect(request.url.startsWith(apiBase)).toBe(true)

          if (response.status >= 400) {
            // Todoist API v1 errors: JSON with a string `error` (unverified shape).
            expect(JSON.parse(textBody(response))).toMatchObject({
              error: expect.any(String),
              http_code: response.status
            })
          }
        }
      }
    })
  )

  it.effect('all pass on replay with unverified warnings', () =>
    Effect.gen(function* () {
      yield* atTestNow

      const report = yield* runConformance(todoistConformanceCases, {
        target: { kind: 'replay' },
        now,
        fixtures: todoistConformanceFixtures,
        layer: replayLayerOver()
      })

      expect(report.summary).toEqual({ passed: 7, failed: 0, skipped: 0 })
      expect(conformanceReportFailed(report)).toBe(false)

      for (const result of report.results) {
        expect(result.warnings).toEqual([
          { kind: 'unverified-case' },
          { kind: 'unverified-fixture', fixtureId: synthetic(result.id) }
        ])
      }

      expect(formatConformanceReport(report).split('\n').at(-1)).toBe(
        '7 passed, 0 failed, 0 skipped; target replay; started 2026-09-30T12:00:00.000Z'
      )
    })
  )

  it.effect('consume every recorded exchange in order and send the recorded requests', () =>
    Effect.gen(function* () {
      yield* atTestNow

      const ledgers = yield* Ref.make(new Map<string, ReplayLedgerApi>())

      const report = yield* runConformance(todoistConformanceCases, {
        target: { kind: 'replay' },
        now,
        layer: ledgerCaseLayer(ledgers)
      })

      expect(report.summary.passed).toBe(7)

      for (const testCase of todoistConformanceCases) {
        const { entries, remaining } = yield* ledgerOf(ledgers, testCase.id)
        const [fixture] = fixturesFor(testCase)

        if (fixture === undefined) {
          return expect.fail(`no fixture for ${testCase.id}`)
        }

        expect(remaining).toEqual([])
        expect(entries).toHaveLength(fixture.exchanges.length)

        entries.forEach((entry, index) => {
          const exchange: WireExchange | undefined = fixture.exchanges[index]

          expect(entry.match).toEqual({
            outcome: 'matched',
            fixtureId: fixture.id,
            exchangeIndex: index
          })
          expect(entry.bodyJson ?? entry.bodyText).toEqual(exchange?.request.body)
          expect(entry.headers).toMatchObject(exchange?.request.headers ?? {})
          expect(entry.headers.authorization).toBe('<redacted>')
        })
      }
    })
  )
})

describe('Todoist conformance safety on a live target', () => {
  // A replay layer under a `live` target proves the policy without any network.
  const statuses = (target: ConformanceTarget) =>
    atTestNow.pipe(
      Effect.andThen(
        runConformance(todoistConformanceCases, { target, now, layer: replayLayerOver() })
      ),
      Effect.map(report =>
        report.results.map(result => [result.id, result.status, result.skipReason ?? null])
      )
    )

  it.effect('runs only the read cases by default and skips every write', () =>
    Effect.gen(function* () {
      expect(yield* statuses({ kind: 'live', account: 'synthetic' })).toEqual(
        caseIds.map(([id, safety]) =>
          safety === 'read' ? [id, 'passed', null] : [id, 'skipped', 'writes-not-allowed']
        )
      )
    })
  )

  it.effect('runs every case when reversible writes are allowed', () =>
    Effect.gen(function* () {
      const results = yield* statuses({
        kind: 'live',
        account: 'synthetic',
        allowWrites: 'reversible'
      })

      expect(results.map(([, status]) => status)).toEqual(Array(7).fill('passed'))
    })
  )

  it('has no write-irreversible case', () => {
    expect(todoistConformanceCases.some(testCase => testCase.safety === 'write-irreversible')).toBe(
      false
    )
  })
})

// Drills: replay a fixture that contradicts a claim, or drop it, and check that exactly that case
// fails (and, for write cases, still removes what it created).

/** Replace exchange `index`'s response, keeping the fixture id so the case still selects it. */
const replaceResponse = (
  fixture: WireFixture,
  index: number,
  response: (original: WireResponse) => WireResponse
): WireFixture => {
  const swap = (exchange: WireExchange, position: number): WireExchange =>
    position === index ? { ...exchange, response: response(exchange.response) } : exchange

  const [first, ...rest] = fixture.exchanges

  return {
    ...fixture,
    exchanges: [swap(first, 0), ...rest.map((exchange, offset) => swap(exchange, offset + 1))]
  }
}

/** A copy of `fixture` (same id) without the exchanges at `indices`. */
const withoutExchanges = (fixture: WireFixture, indices: ReadonlyArray<number>): WireFixture => {
  const [first, ...rest] = fixture.exchanges.filter((_, index) => !indices.includes(index))

  return first === undefined
    ? expect.fail(`no exchanges left in ${fixture.id}`)
    : { ...fixture, exchanges: [first, ...rest] }
}

/** Replace the first occurrence of `from` in a text body, failing if it is not there. */
const replaceInBody =
  (from: string, to: string) =>
  (response: WireResponse): WireResponse => {
    const body = textBody(response)

    expect(body).toContain(from)

    return { status: response.status, headers: response.headers, body: body.replace(from, to) }
  }

const withStatus =
  (status: number, body: string) =>
  (response: WireResponse): WireResponse => ({ status, headers: response.headers, body })

const exchangeAt = (fixture: WireFixture, index: number): WireExchange =>
  fixture.exchanges[index] ?? expect.fail(`no exchange ${index} in ${fixture.id}`)

const serverError =
  '{"error":"Service unavailable","error_code":0,"error_tag":"SERVICE_UNAVAILABLE","http_code":503}'

const mismatch = (message: string) => ({ kind: 'failure', tag: 'ConformanceMismatch', message })

/** Run the whole suite on replay with `fixtures`; return the failed case ids and failures. */
const suiteFailures = (fixtures: ReadonlyArray<WireFixture>) =>
  Effect.gen(function* () {
    yield* atTestNow

    const report = yield* runConformance(todoistConformanceCases, {
      target: { kind: 'replay' },
      now,
      layer: replayLayerOver(fixtures)
    })

    return report.results
      .filter(result => result.status === 'failed')
      .map(result => ({ id: result.id, failure: result.failure }))
  })

const withReplaced = (tampered: WireFixture) =>
  todoistConformanceFixtures.map(fixture => (fixture.id === tampered.id ? tampered : fixture))

const lifecycleTaskBody = textBody(exchangeAt(todoistTaskLifecycleFixture, 2).response)

type ReportedFailure = { readonly kind: string; readonly tag: string; readonly message: string }

/** One tamper per case: the fixture edit and the failure the case reports. */
const tampers: ReadonlyArray<{
  readonly fixture: WireFixture
  readonly message?: string
  readonly failure?: ReportedFailure
}> = [
  {
    fixture: replaceResponse(
      todoistTasksPagingFixture,
      1,
      replaceInBody('"id":"6XSynPagingTask3"', '"id":"6XSynPagingTask1"')
    ),
    message: 'expected a later page to repeat no task from an earlier page'
  },
  {
    fixture: replaceResponse(
      todoistNotFoundEnvelopeFixture,
      0,
      withStatus(
        400,
        '{"error":"Invalid argument value","error_code":20,"error_tag":"INVALID_ARGUMENT_VALUE","http_code":400}'
      )
    ),
    message: 'expected an unknown task id to map to todoist_not_found with HTTP 404'
  },
  {
    fixture: replaceResponse(
      todoistTaskLabelsFixture,
      1,
      replaceInBody('"name":"synthetic-waiting"', '"name":"synthetic-later"')
    ),
    message: 'expected every task label to be the name of a listed personal label'
  },
  {
    fixture: replaceResponse(
      todoistTaskLifecycleFixture,
      5,
      replaceInBody('"results":[]', `"results":[${lifecycleTaskBody}]`)
    ),
    message: 'expected list_tasks to omit the closed task (active tasks only)'
  },
  {
    // Todoist rejects due_datetime as sent: the update is not accepted.
    fixture: replaceResponse(
      todoistDueDatesFixture,
      2,
      withStatus(
        400,
        '{"error":"Invalid argument value","error_code":20,"error_tag":"INVALID_ARGUMENT_VALUE","http_code":400}'
      )
    ),
    failure: {
      kind: 'failure',
      tag: 'TodoistConformanceActionFailed',
      message: 'todoist.update_task failed: todoist_update_task_failed (HTTP 400)'
    }
  },
  {
    fixture: replaceResponse(
      todoistProjectParentIdFixture,
      1,
      replaceInBody('"parent_id":"6XSyntheticWork0"', '"parent_id":null')
    ),
    message: 'expected get_project to read parent_id back'
  },
  {
    fixture: replaceResponse(todoistProjectDeleteFixture, 4, () => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: textBody(exchangeAt(todoistProjectDeleteFixture, 1).response)
    })),
    message:
      'expected get_task of task 6XSynDeleteTask1, which was in the deleted project, to answer todoist_not_found; check it by hand'
  }
]

describe('Todoist conformance drills (one per case)', () => {
  it('cover every case with a tamper', () => {
    expect(tampers.map(tamper => tamper.fixture.caseId)).toEqual(caseIds.map(([id]) => id))
  })

  for (const { fixture, message, failure } of tampers) {
    it.effect(`a tampered fixture fails exactly ${fixture.caseId}`, () =>
      Effect.gen(function* () {
        expect(yield* suiteFailures(withReplaced(fixture))).toEqual([
          {
            id: fixture.caseId,
            failure: failure ?? mismatch(message ?? expect.fail('tamper without an outcome'))
          }
        ])
      })
    )
  }

  for (const [index, message] of [
    [1, 'expected the created task to answer a due whose date starts with 2030-01-15'],
    [2, 'expected the updated task to answer a due whose date starts with 2030-01-15']
  ] as const) {
    it.effect(
      `a due field Todoist ignores (due: null, exchange ${index}) fails exactly the due case`,
      () =>
        Effect.gen(function* () {
          const ignored = replaceResponse(
            todoistDueDatesFixture,
            index,
            replaceInBody(
              textBody(exchangeAt(todoistDueDatesFixture, index).response).match(
                /"due":\{[^}]*\}/
              )?.[0] ?? expect.fail('no due in the fixture'),
              '"due":null'
            )
          )

          expect(yield* suiteFailures(withReplaced(ignored))).toEqual([
            { id: 'todoist.tasks.due-dates', failure: mismatch(message) }
          ])
        })
    )
  }

  it.effect('the due case accepts any due representation Todoist answers', () =>
    Effect.gen(function* () {
      // The connector passes `due` through untyped: neither is_recurring nor the timed form matter.
      const bare = replaceResponse(
        replaceResponse(
          todoistDueDatesFixture,
          1,
          replaceInBody(
            '"due":{"date":"2030-01-15","timezone":null,"string":"Jan 15 2030","lang":"en","is_recurring":false}',
            '"due":{"date":"2030-01-15"}'
          )
        ),
        2,
        replaceInBody(
          '"due":{"date":"2030-01-15T12:00:00Z","timezone":"UTC","string":"Jan 15 2030 12:00","lang":"en","is_recurring":false}',
          '"due":{"date":"2030-01-15T12:00:00.000000Z","datetime":"2030-01-15T12:00:00.000000Z"}'
        )
      )

      expect(yield* suiteFailures(withReplaced(bare))).toEqual([])
    })
  )

  for (const [caseId] of caseIds) {
    it.effect(`a dropped fixture fails exactly ${caseId}`, () =>
      Effect.gen(function* () {
        const failures = yield* suiteFailures(
          todoistConformanceFixtures.filter(fixture => fixture.caseId !== caseId)
        )

        expect(failures.map(failure => failure.id)).toEqual([caseId])
      })
    )
  }
})

const drill = (
  testCase: TodoistConformanceCase,
  fixture: WireFixture,
  seeds: TodoistConformanceSeeds = todoistConformanceFixtureSeeds
) =>
  Effect.gen(function* () {
    yield* atTestNow

    const ledgers = yield* Ref.make(new Map<string, ReplayLedgerApi>())

    const report = yield* runConformance([testCase], {
      target: { kind: 'replay' },
      now,
      layer: ledgerCaseLayer(ledgers, [fixture], seeds)
    })

    expect(conformanceReportFailed(report)).toBe(true)

    return { failure: report.results[0]?.failure, ...(yield* ledgerOf(ledgers, testCase.id)) }
  })

const lifecycleProject = 'project yolk-conformance-run-synthetic-lifecycle (id 6XSynLifecycle01)'

const deleteCalls = (entries: ReadonlyArray<ReplayLedgerEntry>) =>
  entries.flatMap(entry => (entry.method === 'DELETE' ? [entry.url.slice(apiBase.length)] : []))

const lifecycleTamper = tampers[3]?.fixture ?? expect.fail('missing lifecycle tamper')

const deleteFailing = (fixture: WireFixture) =>
  replaceResponse(fixture, 6, withStatus(500, serverError))

describe('Todoist conformance restore', () => {
  it.effect('still deletes the case project, by id, when a claim fails mid-flow', () =>
    Effect.gen(function* () {
      const { entries, remaining } = yield* drill(todoistTaskLifecycleCase, lifecycleTamper)

      expect(exchangeIndices(entries)).toEqual([
        'POST projects 0',
        'POST tasks 1',
        'GET tasks/6XSynLifeTask001 2',
        'POST tasks/6XSynLifeTask001 3',
        'POST tasks/6XSynLifeTask001/close 4',
        'GET tasks 5',
        'DELETE projects/6XSynLifecycle01 6',
        'GET projects/6XSynLifecycle01 7'
      ])
      expect(remaining).toEqual([])
    })
  )

  it.effect('reports a failed restore, naming the project, instead of swallowing it', () =>
    Effect.gen(function* () {
      const { failure } = yield* drill(
        todoistTaskLifecycleCase,
        deleteFailing(todoistTaskLifecycleFixture)
      )

      expect(failure).toEqual({
        kind: 'failure',
        tag: 'TodoistConformanceRestoreFailed',
        message: `todoist.tasks.lifecycle-close: restore failed; delete ${lifecycleProject} by hand if it still exists. Restore error: todoist.delete_project todoist_delete_project_failed 500. Claim held first.`
      })
    })
  )

  it.effect('reports both a failed claim and a failed restore', () =>
    Effect.gen(function* () {
      const { failure } = yield* drill(todoistTaskLifecycleCase, deleteFailing(lifecycleTamper))

      expect(failure?.tag).toBe('TodoistConformanceRestoreFailed')
      expect(failure?.message).toContain(
        'Restore error: todoist.delete_project todoist_delete_project_failed 500.'
      )
      expect(failure?.message).toContain('Claim failed first: expected list_tasks to omit the')
    })
  )

  it.effect('fails the restore when the project is still found after deleting it', () =>
    Effect.gen(function* () {
      const stillThere = replaceResponse(todoistTaskLifecycleFixture, 7, () => ({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: textBody(exchangeAt(todoistTaskLifecycleFixture, 0).response)
      }))

      const { failure } = yield* drill(todoistTaskLifecycleCase, stillThere)

      expect(failure?.tag).toBe('TodoistConformanceRestoreFailed')
      expect(failure?.message).toContain(`delete ${lifecycleProject} by hand if it still exists.`)
      expect(failure?.message).toContain(
        'Restore error: expected get_project of the case-created project to answe... Claim held first.'
      )
      expect(failure?.message).toContain('Claim held first.')
    })
  )

  it.effect('accepts a not-found answer to the restore delete, then still verifies', () =>
    Effect.gen(function* () {
      yield* atTestNow

      const gone = replaceResponse(
        todoistTaskLifecycleFixture,
        6,
        withStatus(
          404,
          '{"error":"Project not found","error_code":478,"error_tag":"NOT_FOUND","http_code":404}'
        )
      )

      const ledgers = yield* Ref.make(new Map<string, ReplayLedgerApi>())

      const report = yield* runConformance([todoistTaskLifecycleCase], {
        target: { kind: 'replay' },
        now,
        layer: ledgerCaseLayer(ledgers, [gone])
      })

      const { entries, remaining } = yield* ledgerOf(ledgers, todoistTaskLifecycleCase.id)

      expect(report.summary.passed).toBe(1)
      expect(exchangeIndices(entries).slice(-2)).toEqual([
        'DELETE projects/6XSynLifecycle01 6',
        'GET projects/6XSynLifecycle01 7'
      ])
      expect(remaining).toEqual([])
    })
  )

  for (const seed of ['pagingProjectId', 'workProjectId', 'runId'] as const) {
    it.effect(`fails with a precondition before any request without ${seed}`, () =>
      Effect.gen(function* () {
        const { [seed]: _dropped, ...seeds } = todoistConformanceFixtureSeeds

        const testCase =
          seed === 'pagingProjectId' ? todoistTasksPagingCase : todoistTaskLifecycleCase

        const { failure, entries } = yield* drill(
          testCase,
          fixturesFor(testCase)[0] ?? expect.fail('no fixture'),
          seeds
        )

        expect(failure).toEqual(
          mismatch(`precondition: TodoistConformanceConfig.${seed} is not configured`)
        )
        expect(entries).toEqual([])
      })
    )
  }

  it.effect('finishes a masked in-flight update, then deletes the project on interruption', () =>
    Effect.gen(function* () {
      const updateSent = yield* Deferred.make<void>()
      const releaseUpdate = yield* Deferred.make<void>()

      const { client, ledger } = yield* makeReplayHttpClient([todoistTaskLifecycleFixture])

      // Hold the update response until the case fiber has been asked to stop.
      const holdingUpdate = HttpClient.transform(client, (response, request) =>
        request.method === 'POST' && request.url.endsWith('/tasks/6XSynLifeTask001')
          ? response.pipe(
              Effect.tap(() => Deferred.succeed(updateSent, undefined)),
              Effect.tap(() => Deferred.await(releaseUpdate))
            )
          : response
      )

      const fiber = yield* todoistTaskLifecycleCase.run.pipe(
        Effect.provide(portsOver(Layer.succeed(HttpClient.HttpClient, holdingUpdate))),
        Effect.forkChild
      )

      yield* Deferred.await(updateSent)

      // The update is masked: the interruption waits for it, then no further claim (close) runs.
      const interrupting = yield* Effect.forkChild(Fiber.interrupt(fiber))

      yield* Effect.yieldNow
      yield* Deferred.succeed(releaseUpdate, undefined)
      yield* Fiber.join(interrupting)

      const exit = yield* Fiber.await(fiber)

      expect(Exit.hasInterrupts(exit)).toBe(true)
      expect(exchangeIndices(yield* ledger.entries)).toEqual([
        'POST projects 0',
        'POST tasks 1',
        'GET tasks/6XSynLifeTask001 2',
        'POST tasks/6XSynLifeTask001 3',
        'DELETE projects/6XSynLifecycle01 6',
        'GET projects/6XSynLifecycle01 7'
      ])
    })
  )

  it.effect('registers a project create in flight when interrupted, then deletes it by id', () =>
    Effect.gen(function* () {
      const createSent = yield* Deferred.make<void>()
      const releaseCreate = yield* Deferred.make<void>()

      // The create (0), then only the restore's delete and lookup.
      const { client, ledger } = yield* makeReplayHttpClient([
        withoutExchanges(todoistTaskLifecycleFixture, [1, 2, 3, 4, 5])
      ])

      // Todoist has created the project, but its response is held back until the test releases it.
      const holdingCreate = HttpClient.transform(client, (response, request) =>
        request.method === 'POST' && request.url.endsWith('/projects')
          ? response.pipe(
              Effect.tap(() => Deferred.succeed(createSent, undefined)),
              Effect.tap(() => Deferred.await(releaseCreate))
            )
          : response
      )

      const fiber = yield* todoistTaskLifecycleCase.run.pipe(
        Effect.provide(portsOver(Layer.succeed(HttpClient.HttpClient, holdingCreate))),
        Effect.forkChild
      )

      yield* Deferred.await(createSent)

      const interrupting = yield* Effect.forkChild(Fiber.interrupt(fiber))

      yield* Effect.yieldNow
      yield* Deferred.succeed(releaseCreate, undefined)
      yield* Fiber.join(interrupting)

      const exit = yield* Fiber.await(fiber)

      expect(Exit.hasInterrupts(exit)).toBe(true)
      expect(exchangeIndices(yield* ledger.entries)).toEqual([
        'POST projects 0',
        'DELETE projects/6XSynLifecycle01 1',
        'GET projects/6XSynLifecycle01 2'
      ])
    })
  )

  it.effect('reports a transport failure of a read without a status', () =>
    Effect.gen(function* () {
      const dropping = HttpClient.make(request => Effect.fail(connectionReset(request)))

      const report = yield* runConformance([todoistTasksPagingCase], {
        target: { kind: 'replay' },
        now,
        layer: () => portsOver(Layer.succeed(HttpClient.HttpClient, dropping))
      })

      expect(report.results[0]?.failure).toEqual({
        kind: 'failure',
        tag: 'ConnectorError',
        message: 'HTTP request failed before a complete response'
      })
    })
  )
})

const connectionReset = (request: HttpClientRequest.HttpClientRequest) =>
  new HttpClientError.HttpClientError({
    reason: new HttpClientError.TransportError({ request, description: 'connection reset' })
  })

// Ownership drills: definitive rejections delete nothing, ambiguous creates are reported with the
// exact item, and cleanup never leaves the run namespace.

const lifecycleCreateTarget = 'project yolk-conformance-run-synthetic-lifecycle under workProjectId'

describe('Todoist conformance write ownership', () => {
  it.effect('deletes nothing after a definitive project create rejection', () =>
    Effect.gen(function* () {
      const rejected = withoutExchanges(
        replaceResponse(
          todoistTaskLifecycleFixture,
          0,
          withStatus(
            403,
            '{"error":"Maximum number of projects reached","error_code":49,"error_tag":"MAX_PROJECTS_LIMIT_REACHED","http_code":403}'
          )
        ),
        [1, 2, 3, 4, 5, 6, 7]
      )

      const { failure, entries, remaining } = yield* drill(todoistTaskLifecycleCase, rejected)

      expect(failure).toEqual({
        kind: 'failure',
        tag: 'TodoistConformanceActionFailed',
        message: 'todoist.create_project failed: todoist_unauthorized (HTTP 403)'
      })
      expect(exchangeIndices(entries)).toEqual(['POST projects 0'])
      expect(remaining).toEqual([])
    })
  )

  it.effect('reports an ambiguous 5xx project create with the exact name and deletes nothing', () =>
    Effect.gen(function* () {
      const ambiguous = withoutExchanges(
        replaceResponse(todoistTaskLifecycleFixture, 0, withStatus(503, serverError)),
        [1, 2, 3, 4, 5, 6, 7]
      )

      const { failure, entries } = yield* drill(todoistTaskLifecycleCase, ambiguous)

      expect(failure).toEqual({
        kind: 'failure',
        tag: 'TodoistConformanceActionFailed',
        message: `todoist.create_project failed: todoist_create_project_failed (HTTP 503); create outcome unknown: delete ${lifecycleCreateTarget} by hand if it exists`
      })
      expect(deleteCalls(entries)).toEqual([])
    })
  )

  it.effect('reports a 408 project create as ambiguous (the request may still land)', () =>
    Effect.gen(function* () {
      const timedOut = withoutExchanges(
        replaceResponse(
          todoistTaskLifecycleFixture,
          0,
          withStatus(
            408,
            '{"error":"Request timeout","error_code":0,"error_tag":"TIMEOUT","http_code":408}'
          )
        ),
        [1, 2, 3, 4, 5, 6, 7]
      )

      const { failure, entries } = yield* drill(todoistTaskLifecycleCase, timedOut)

      expect(failure).toEqual({
        kind: 'failure',
        tag: 'TodoistConformanceActionFailed',
        message: `todoist.create_project failed: todoist_create_project_failed (HTTP 408); create outcome unknown: delete ${lifecycleCreateTarget} by hand if it exists`
      })
      expect(deleteCalls(entries)).toEqual([])
    })
  )

  it.effect(
    'a created project under another parent fails the parent claim and is still deleted',
    () =>
      Effect.gen(function* () {
        const orphaned = withoutExchanges(
          replaceResponse(
            todoistProjectParentIdFixture,
            0,
            replaceInBody('"parent_id":"6XSyntheticWork0"', '"parent_id":null')
          ),
          [1]
        )

        const { failure, entries, remaining } = yield* drill(todoistProjectParentIdCase, orphaned)

        expect(failure).toEqual(
          mismatch('expected create_project to answer parent_id naming the work project')
        )
        expect(deleteCalls(entries)).toEqual(['projects/6XSynParentProj1'])
        expect(remaining).toEqual([])
      })
  )

  it.effect('reports a project create that fails in transport as ambiguous', () =>
    Effect.gen(function* () {
      const dropping = HttpClient.make(request => Effect.fail(connectionReset(request)))

      const report = yield* runConformance([todoistTaskLifecycleCase], {
        target: { kind: 'replay' },
        now,
        layer: () => portsOver(Layer.succeed(HttpClient.HttpClient, dropping))
      })

      expect(report.results[0]?.failure).toEqual({
        kind: 'failure',
        tag: 'TodoistConformanceActionFailed',
        message: `todoist.create_project failed: transport_failed; create outcome unknown: delete ${lifecycleCreateTarget} by hand if it exists`
      })
    })
  )

  it.effect('refuses to adopt a created project that lacks the run-scoped name', () =>
    Effect.gen(function* () {
      const renamed = withoutExchanges(
        replaceResponse(
          todoistTaskLifecycleFixture,
          0,
          replaceInBody(
            '"name":"yolk-conformance-run-synthetic-lifecycle"',
            '"name":"Someone else project"'
          )
        ),
        [1, 2, 3, 4, 5, 6, 7]
      )

      const { failure, entries } = yield* drill(todoistTaskLifecycleCase, renamed)

      expect(failure).toEqual({
        kind: 'failure',
        tag: 'TodoistConformanceCleanupRefused',
        message:
          'todoist.tasks.lifecycle-close: cleanup refused; a create answered project Someone else project (id 6XSynLifecycle01), outside the run namespace, so nothing was deleted there; check it by hand.'
      })
      expect(deleteCalls(entries)).toEqual([])
    })
  )

  for (const [label, from, to, item] of [
    [
      "the work project's id",
      '"id":"6XSynLifecycle01"',
      '"id":"6XSyntheticWork0"',
      'project yolk-conformance-run-synthetic-lifecycle (id 6XSyntheticWork0)'
    ],
    [
      "the paging project's id",
      '"id":"6XSynLifecycle01"',
      '"id":"6XSyntheticPage0"',
      'project yolk-conformance-run-synthetic-lifecycle (id 6XSyntheticPage0)'
    ]
  ] as const) {
    it.effect(`refuses to adopt a created project answered with ${label}`, () =>
      Effect.gen(function* () {
        const foreign = withoutExchanges(
          replaceResponse(todoistTaskLifecycleFixture, 0, replaceInBody(from, to)),
          [1, 2, 3, 4, 5, 6, 7]
        )

        const { failure, entries } = yield* drill(todoistTaskLifecycleCase, foreign)

        expect(failure).toEqual({
          kind: 'failure',
          tag: 'TodoistConformanceCleanupRefused',
          message: `todoist.tasks.lifecycle-close: cleanup refused; a create answered ${item}, outside the run namespace, so nothing was deleted there; check it by hand.`
        })
        expect(deleteCalls(entries)).toEqual([])
      })
    )
  }

  it.effect('refuses a task answered outside the case project, and still deletes the project', () =>
    Effect.gen(function* () {
      const outside = withoutExchanges(
        replaceResponse(
          todoistTaskLifecycleFixture,
          1,
          replaceInBody('"project_id":"6XSynLifecycle01"', '"project_id":"6XSyntheticInbox"')
        ),
        [2, 3, 4, 5]
      )

      const { failure, entries, remaining } = yield* drill(todoistTaskLifecycleCase, outside)

      expect(failure).toEqual({
        kind: 'failure',
        tag: 'TodoistConformanceCleanupRefused',
        message:
          'todoist.tasks.lifecycle-close: cleanup refused; a create answered task 6XSynLifeTask001 in project 6XSyntheticInbox, outside the run namespace, so nothing was deleted there; check it by hand.'
      })
      expect(deleteCalls(entries)).toEqual(['projects/6XSynLifecycle01'])
      expect(remaining).toEqual([])
    })
  )

  it.effect('reports an ambiguous task create with the exact task, and deletes the project', () =>
    Effect.gen(function* () {
      const ambiguous = withoutExchanges(
        replaceResponse(todoistTaskLifecycleFixture, 1, withStatus(500, serverError)),
        [2, 3, 4, 5]
      )

      const { failure, entries, remaining } = yield* drill(todoistTaskLifecycleCase, ambiguous)

      expect(failure).toEqual({
        kind: 'failure',
        tag: 'TodoistConformanceActionFailed',
        message:
          'todoist.create_task failed: todoist_create_task_failed (HTTP 500); create outcome unknown: delete task "yolk-conformance task: safe to delete" in project yolk-conformance-run-synthetic-lifecycle by hand if it exists'
      })
      expect(deleteCalls(entries)).toEqual(['projects/6XSynLifecycle01'])
      expect(remaining).toEqual([])
    })
  )
})

describe('Todoist conformance leftover detection (read-only)', () => {
  const listing = (body: Schema.Json, cursor?: string): WireExchange => ({
    request: {
      method: 'GET',
      url:
        cursor === undefined
          ? `${apiBase}projects?limit=200`
          : `${apiBase}projects?cursor=${cursor}&limit=200`
    },
    response: {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }
  })

  const project = (id: string, name: string) => ({ id, name, parent_id: null })

  const leftoversFixture: WireFixture = {
    id: 'todoist.leftovers.synthetic',
    caseId: 'todoist.leftovers',
    evidence: 'unverified',
    recordedAt: '2026-09-30',
    account: 'synthetic',
    endpoint: 'https://api.todoist.com/api/v1',
    exchanges: [
      listing({
        results: [
          project('6XSynLeftover001', 'yolk-conformance-run-0000beef-lifecycle'),
          project('6XSynKeepMe00001', 'Keep Me'),
          project('6XSynAbsent00001', 'yolk-conformance-absent')
        ],
        next_cursor: 'SyntheticProjectCursor1'
      }),
      listing(
        {
          results: [project('6XSynLeftover002', 'yolk-conformance-run-0000cafe-due')],
          next_cursor: null
        },
        'SyntheticProjectCursor1'
      )
    ]
  }

  it.effect('lists run-scoped projects earlier runs left behind, and nothing else', () =>
    Effect.gen(function* () {
      const { client, ledger } = yield* makeReplayHttpClient([leftoversFixture])

      const found = yield* findTodoistConformanceLeftovers.pipe(
        Effect.provide(portsOver(Layer.succeed(HttpClient.HttpClient, client)))
      )

      expect(found).toEqual([
        'yolk-conformance-run-0000beef-lifecycle (6XSynLeftover001)',
        'yolk-conformance-run-0000cafe-due (6XSynLeftover002)'
      ])
      // Read-only: only listing requests were sent.
      expect((yield* ledger.entries).map(entry => `${entry.method} ${entry.url}`)).toEqual([
        `GET ${apiBase}projects?limit=200`,
        `GET ${apiBase}projects?cursor=SyntheticProjectCursor1&limit=200`
      ])
    })
  )

  it('requires the run- prefix in every run id, so the leftover lookup sees every run', () => {
    const decode = Schema.decodeUnknownOption(TodoistConformanceSeedsSchema)

    expect(Option.isSome(decode({ runId: 'run-0000beef' }))).toBe(true)
    expect(Option.isNone(decode({ runId: 'mine-0000beef' }))).toBe(true)
    expect(Option.isNone(decode({ runId: 'run-' }))).toBe(true)
    expect(Option.isNone(decode({ workProjectId: 'has space' }))).toBe(true)
  })
})

// Interruption drills: a cleanup problem raised while the case is being interrupted still reaches
// the owner through the ConformanceCleanupReporter, with the exact project to check.

const capturingReporter = Effect.gen(function* () {
  const warnings = yield* Ref.make<ReadonlyArray<string>>([])

  return {
    warnings,
    reporter: { warn: (message: string) => Ref.update(warnings, list => [...list, message]) }
  }
})

type HoldMoment = 'during the update claim' | 'during the restore delete'

/** A lifecycle client whose restore delete answers 500, holding one request at `moment`. */
const holdingLifecycle = (moment: HoldMoment, fixture: WireFixture) =>
  Effect.gen(function* () {
    const sent = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const { client } = yield* makeReplayHttpClient([fixture])

    const hold = <A, E, R>(response: Effect.Effect<A, E, R>) =>
      response.pipe(
        Effect.tap(() => Deferred.succeed(sent, undefined)),
        Effect.tap(() => Deferred.await(release))
      )

    const holding = HttpClient.transform(client, (response, request) =>
      (moment === 'during the update claim' &&
        request.method === 'POST' &&
        request.url.endsWith('/tasks/6XSynLifeTask001')) ||
      (moment === 'during the restore delete' && request.method === 'DELETE')
        ? hold(response)
        : response
    )

    return { sent, release, holding }
  })

const interruptAfter = <A, E>(
  fiber: Fiber.Fiber<A, E>,
  sent: Deferred.Deferred<void>,
  release: Deferred.Deferred<void>
) =>
  Effect.gen(function* () {
    yield* Deferred.await(sent)

    const interrupting = yield* Effect.forkChild(Fiber.interrupt(fiber))

    yield* Effect.yieldNow
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(interrupting)

    return yield* Fiber.await(fiber)
  })

describe('Todoist conformance interruption reporting', () => {
  for (const moment of ['during the update claim', 'during the restore delete'] as const) {
    it.effect(`reports a failed restore when interrupted ${moment}`, () =>
      Effect.gen(function* () {
        const { warnings, reporter } = yield* capturingReporter

        const { sent, release, holding } = yield* holdingLifecycle(
          moment,
          deleteFailing(todoistTaskLifecycleFixture)
        )

        const fiber = yield* todoistTaskLifecycleCase.run.pipe(
          Effect.provide(portsOver(Layer.succeed(HttpClient.HttpClient, holding))),
          Effect.provideService(ConformanceCleanupReporter, reporter),
          Effect.forkChild
        )

        yield* interruptAfter(fiber, sent, release)

        const reported = yield* Ref.get(warnings)

        // Whatever the fiber's exit, the owner sees the restore failure and the project to check.
        expect(reported).toHaveLength(1)
        expect(reported[0]).toContain(
          `todoist.tasks.lifecycle-close: restore failed; delete ${lifecycleProject} by hand if it still exists.`
        )
      })
    )
  }

  it.effect(
    'reports an ambiguous project create answered while the case is being interrupted',
    () =>
      Effect.gen(function* () {
        const createSent = yield* Deferred.make<void>()
        const releaseCreate = yield* Deferred.make<void>()
        const { warnings, reporter } = yield* capturingReporter

        const { client } = yield* makeReplayHttpClient([
          withoutExchanges(
            replaceResponse(todoistTaskLifecycleFixture, 0, withStatus(503, serverError)),
            [1, 2, 3, 4, 5, 6, 7]
          )
        ])

        const holdingCreate = HttpClient.transform(client, (response, request) =>
          request.method === 'POST' && request.url.endsWith('/projects')
            ? response.pipe(
                Effect.tap(() => Deferred.succeed(createSent, undefined)),
                Effect.tap(() => Deferred.await(releaseCreate))
              )
            : response
        )

        const fiber = yield* todoistTaskLifecycleCase.run.pipe(
          Effect.provide(portsOver(Layer.succeed(HttpClient.HttpClient, holdingCreate))),
          Effect.provideService(ConformanceCleanupReporter, reporter),
          Effect.forkChild
        )

        yield* interruptAfter(fiber, createSent, releaseCreate)

        expect(yield* Ref.get(warnings)).toEqual([
          `todoist.create_project failed: todoist_create_project_failed (HTTP 503); create outcome unknown: delete ${lifecycleCreateTarget} by hand if it exists`
        ])
      })
  )

  it.effect(
    'reports nothing extra when an uninterrupted restore fails (the report carries it)',
    () =>
      Effect.gen(function* () {
        const { warnings, reporter } = yield* capturingReporter
        const { client } = yield* makeReplayHttpClient([deleteFailing(todoistTaskLifecycleFixture)])

        const exit = yield* todoistTaskLifecycleCase.run.pipe(
          Effect.provide(portsOver(Layer.succeed(HttpClient.HttpClient, client))),
          Effect.provideService(ConformanceCleanupReporter, reporter),
          Effect.exit
        )

        expect(Exit.isFailure(exit)).toBe(true)
        expect(yield* Ref.get(warnings)).toEqual([])
      })
  )
})

// Run-level interruption drills: runConformance over [the lifecycle case, a sentinel]. Interrupting
// the lifecycle case must stop the run: the sentinel never starts, whether the restore fails or
// succeeds.

const sentinelCase = (ran: Ref.Ref<boolean>) =>
  defineConformanceCase({
    id: 'test.sentinel.after-interrupted-case',
    safety: 'read',
    docs: 'Synthetic sentinel: records whether it ran.',
    wire: 'Runs only if the run was not stopped.',
    fixtures: [],
    run: Ref.set(ran, true)
  })

describe('Todoist conformance run interruption', () => {
  for (const moment of ['during the update claim', 'during the restore delete'] as const) {
    it.effect(`stops the whole run when interrupted ${moment} with a failing restore`, () =>
      Effect.gen(function* () {
        const sentinelRan = yield* Ref.make(false)
        const { warnings, reporter } = yield* capturingReporter

        const { sent, release, holding } = yield* holdingLifecycle(
          moment,
          deleteFailing(todoistTaskLifecycleFixture)
        )

        const fiber = yield* runConformance([todoistTaskLifecycleCase, sentinelCase(sentinelRan)], {
          target: { kind: 'replay' },
          now,
          layer: () => portsOver(Layer.succeed(HttpClient.HttpClient, holding))
        }).pipe(Effect.provideService(ConformanceCleanupReporter, reporter), Effect.forkChild)

        const exit = yield* interruptAfter(fiber, sent, release)

        expect(yield* Ref.get(sentinelRan)).toBe(false)

        // Same shape as the Dropbox drill (effect 4.0.0-rc.115): the run ends with the case's own
        // RestoreFailed and no Interrupt in the cause, produces no report, and resumes no case.
        if (Exit.isSuccess(exit)) {
          return expect.fail('expected the interrupted run to fail')
        }

        expect(Cause.hasInterrupts(exit.cause)).toBe(false)
        expect(Cause.squash(exit.cause)).toMatchObject({ _tag: 'TodoistConformanceRestoreFailed' })

        const reported = yield* Ref.get(warnings)

        expect(reported).toHaveLength(1)
        expect(reported[0]).toContain(`delete ${lifecycleProject} by hand if it still exists.`)
      })
    )
  }

  // The CLI's exit-130 branch (and its after-interrupt leftover lookup) depends on this shape.
  it.effect(
    'ends interrupt-only, without a report or a later case, when the cleanup succeeds',
    () =>
      Effect.gen(function* () {
        const sentinelRan = yield* Ref.make(false)
        const { warnings, reporter } = yield* capturingReporter

        const { sent, release, holding } = yield* holdingLifecycle(
          'during the update claim',
          todoistTaskLifecycleFixture
        )

        const fiber = yield* runConformance([todoistTaskLifecycleCase, sentinelCase(sentinelRan)], {
          target: { kind: 'replay' },
          now,
          layer: () => portsOver(Layer.succeed(HttpClient.HttpClient, holding))
        }).pipe(Effect.provideService(ConformanceCleanupReporter, reporter), Effect.forkChild)

        const exit = yield* interruptAfter(fiber, sent, release)

        expect(yield* Ref.get(sentinelRan)).toBe(false)

        if (Exit.isSuccess(exit)) {
          return expect.fail('expected the interrupted run to be interrupted')
        }

        expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        expect(yield* Ref.get(warnings)).toEqual([])
      })
  )
})
