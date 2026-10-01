/**
 * Todoist emulator unit tests: the manifest, every fixture replayed against the default seed (the
 * drift test: the emulator's answers equal the fixtures, created ids and `event_id`s aside), the
 * documented request-shape latitude, fail-closed 400 not-emulated answers that write nothing and
 * use up no fault, faults through the real connector, clock-safe recovery, seeds, and the control
 * plane. Tests may import SDK packages; the emulator source never does.
 */
import { Effect, Layer, Predicate } from 'effect'
import { afterEach, describe, expect, it } from '@effect/vitest'
import { isWireBase64BodyResponse, isWireStreamResponse } from '@yolk-sdk/conformance/fixture'
import { ApiKeyCredential } from '@yolk-sdk/connectors'
import {
  connectorHttpClientsFromEffectHttpClientLayer,
  staticCredentialResolverLayer
} from '@yolk-sdk/connectors/conformance'
import { TodoistCreateTaskInput, todoistCreateTaskAction } from '@yolk-sdk/connectors/todoist'
import {
  todoistConformanceCases,
  todoistConformanceFixtureSeeds,
  todoistConformanceFixtures,
  todoistConformanceIntegration
} from '@yolk-sdk/connectors/todoist/conformance'
import { EmulatorRoute, InProcessHttpClient } from '../src/router.ts'
import {
  TodoistEmulatorInputInvalid,
  emulatorEvidenceHeader,
  makeTodoistEmulator,
  todoistEmulatorRoutes,
  type TodoistEmulator,
  type TodoistEmulatorOptions
} from '../src/todoist.ts'

const origin = 'https://api.todoist.com'

const token = 'synthetic-todoist-unit-token'

const start = Date.parse('2026-09-30T12:00:00.000Z')

/** A clock that moves one second per read (the fixtures' project then task timestamps). */
const tickingClock = () => {
  let reads = 0

  return () => start + 1000 * reads++
}

const open: Array<TodoistEmulator> = []

afterEach(async () => {
  await Promise.all(open.splice(0).map(emulator => emulator.close()))
})

const emulator = async (options: TodoistEmulatorOptions = {}): Promise<TodoistEmulator> => {
  const created = await makeTodoistEmulator({ now: tickingClock(), ...options })

  open.push(created)

  return created
}

type CallOptions = {
  readonly body?: unknown
  readonly rawBody?: string
  readonly authorization?: string | null
  readonly contentType?: string
}

const call = (
  target: TodoistEmulator,
  method: string,
  path: string,
  options: CallOptions = {}
): Promise<Response> => {
  const headers = new Headers()

  const authorization =
    options.authorization === undefined ? `Bearer ${token}` : options.authorization

  if (authorization !== null) headers.set('authorization', authorization)

  const body =
    options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body))

  if (body !== undefined) headers.set('content-type', options.contentType ?? 'application/json')

  return target.fetch(new Request(`${origin}${path}`, { method, headers, body }))
}

const api = (path: string) => `/api/v1${path}`

const createProject = (target: TodoistEmulator, suffix = 'parent', runId = 'run-synthetic') =>
  call(target, 'POST', api('/projects'), {
    body: { name: `yolk-conformance-${runId}-${suffix}`, parent_id: '6XSyntheticWork0' }
  })

/** Assert a 400 not-emulated naming `reason`; returns the raw response (headers and body text). */
const expectNotEmulated = async (response: Response, reason: string): Promise<string> => {
  expect(response.status).toBe(400)

  const text = await response.text()
  const body: unknown = JSON.parse(text)

  expect(body).toEqual({ error: { type: 'not_emulated', message: expect.any(String) } })
  expect(JSON.stringify(body)).toContain(reason)

  return [...response.headers]
    .map(([name, value]) => `${name}: ${value}`)
    .concat(text)
    .join('\n')
}

describe('manifest', () => {
  it('lists the nine emulated routes, unverified connector routes citing known case ids', () => {
    expect(todoistEmulatorRoutes.map(route => [route.method, route.path, route.write])).toEqual([
      ['GET', '/api/v1/tasks', false],
      ['POST', '/api/v1/tasks', true],
      ['GET', '/api/v1/tasks/{taskId}', false],
      ['POST', '/api/v1/tasks/{taskId}', true],
      ['POST', '/api/v1/tasks/{taskId}/close', true],
      ['GET', '/api/v1/labels', false],
      ['POST', '/api/v1/projects', true],
      ['GET', '/api/v1/projects/{projectId}', false],
      ['DELETE', '/api/v1/projects/{projectId}', true]
    ])

    const caseIds = new Set(todoistConformanceCases.map(testCase => testCase.id))

    for (const route of todoistEmulatorRoutes) {
      expect(route.kind).toBe('connector')
      expect(route.evidence).toBe('unverified')
      expect(
        route.caseIds.every(id => caseIds.has(id)),
        route.path
      ).toBe(true)
    }

    // Every case is cited by at least one route, and every route cites a case (fixture-only).
    expect(
      [...caseIds].filter(id => !todoistEmulatorRoutes.some(r => r.caseIds.includes(id)))
    ).toEqual([])
    expect(todoistEmulatorRoutes.filter(route => route.caseIds.length === 0)).toEqual([])
  })

  it('seeds the fixture ids by default', async () => {
    const state = (await emulator()).snapshot()

    expect(state.projects.map(project => project.id)).toEqual([
      todoistConformanceFixtureSeeds.workProjectId,
      todoistConformanceFixtureSeeds.pagingProjectId
    ])
    expect(state.tasks.some(task => task.id === todoistConformanceFixtureSeeds.labeledTaskId)).toBe(
      true
    )
  })
})

/** Ids of fixture creates the emulator answered with its own ids, and `event_id`s. */
const normalized = (text: string, ids: ReadonlyMap<string, string>): string => {
  let result = text

  for (const [emulatorId, fixtureId] of ids) {
    result = result.replaceAll(emulatorId, fixtureId)
  }

  return result.replace(/"event_id":"[0-9]{32}"/g, '"event_id":"<event>"')
}

describe('drift: every fixture exchange answered as recorded', () => {
  // Fixtures are copied as data; if a fixture changes, this fails until the emulator follows it.
  it.each(todoistConformanceFixtures.map(fixture => [fixture.id, fixture] as const))(
    '%s',
    async (_id, fixture) => {
      const target = await emulator()
      const ids = new Map<string, string>()

      const toEmulator = (text: string) => {
        let result = text

        for (const [emulatorId, fixtureId] of ids) result = result.replaceAll(fixtureId, emulatorId)

        return result
      }

      for (const [index, exchange] of fixture.exchanges.entries()) {
        const url = new URL(exchange.request.url)
        const body = exchange.request.body

        const response = await call(
          target,
          exchange.request.method,
          toEmulator(`${url.pathname}${url.search}`),
          body === undefined ? {} : { rawBody: toEmulator(JSON.stringify(body)) }
        )

        const recorded = exchange.response

        if (isWireStreamResponse(recorded) || isWireBase64BodyResponse(recorded)) {
          throw new Error('Todoist fixtures record text bodies')
        }

        const text = await response.text()

        expect(response.status, `${fixture.id} #${index}`).toBe(recorded.status)
        expect(response.headers.get('content-type'), `${fixture.id} #${index}`).toBe(
          recorded.headers['content-type'] ?? null
        )
        expect(response.headers.get(emulatorEvidenceHeader)).toBe('unverified')

        // Learn the created ids: the fixture's id stands for the emulator's.
        if (exchange.request.method === 'POST' && /\/(projects|tasks)$/.test(url.pathname)) {
          const created: unknown = JSON.parse(text)
          const recordedBody: unknown = JSON.parse(recorded.body)

          if (
            Predicate.hasProperty(created, 'id') &&
            Predicate.hasProperty(recordedBody, 'id') &&
            Predicate.isString(created.id) &&
            Predicate.isString(recordedBody.id)
          ) {
            ids.set(created.id, recordedBody.id)
          }
        }

        expect(normalized(text, ids), `${fixture.id} #${index}`).toBe(
          normalized(recorded.body, new Map())
        )
      }

      expect(target.ledger.entries().every(entry => entry.notEmulated === undefined)).toBe(true)
    }
  )

  it('answers the read fixtures byte for byte (no normalization)', async () => {
    const target = await emulator()

    for (const fixtureId of [
      'todoist.tasks.list-cursor-paging.synthetic',
      'todoist.errors.not-found-envelope.synthetic',
      'todoist.labels.task-labels-are-names.synthetic'
    ]) {
      const fixture = todoistConformanceFixtures.find(candidate => candidate.id === fixtureId)

      for (const exchange of fixture?.exchanges ?? []) {
        const url = new URL(exchange.request.url)
        const response = await call(target, 'GET', `${url.pathname}${url.search}`)
        const recorded = exchange.response

        expect('body' in recorded && recorded.body).toBe(await response.text())
      }
    }
  })
})

describe('request-shape latitude', () => {
  it('accepts query parameters in any order, content-type parameters, and any run-<hex> run id', async () => {
    const target = await emulator()

    const first = await call(target, 'GET', api('/tasks?limit=2&project_id=6XSyntheticPage0'))

    expect(first.status).toBe(200)

    const page: unknown = await first.json()

    expect(page).toMatchObject({ next_cursor: 'SyntheticTaskCursor0001' })

    const second = await call(
      target,
      'GET',
      api('/tasks?limit=2&cursor=SyntheticTaskCursor0001&project_id=6XSyntheticPage0')
    )

    expect(await second.json()).toMatchObject({ next_cursor: null })

    const created = await call(target, 'POST', api('/projects'), {
      body: { name: 'yolk-conformance-run-9f8e7d-lifecycle', parent_id: '6XSyntheticWork0' },
      contentType: 'application/json; charset=utf-8'
    })

    expect(created.status).toBe(200)
    expect(await created.json()).toMatchObject({
      id: '6XEmuProject0001',
      name: 'yolk-conformance-run-9f8e7d-lifecycle',
      parent_id: '6XSyntheticWork0'
    })
  })

  it('accepts an update with both fields and any non-empty content', async () => {
    const target = await emulator()

    await createProject(target, 'due')

    const task = await call(target, 'POST', api('/tasks'), {
      body: { content: 'Any synthetic content', project_id: '6XEmuProject0001' }
    })

    expect(task.status).toBe(200)

    const updated = await call(target, 'POST', api('/tasks/6XEmuTask0000001'), {
      body: { content: 'Changed synthetic content', due_datetime: '2030-01-15T12:00:00Z' }
    })

    expect(await updated.json()).toMatchObject({
      content: 'Changed synthetic content',
      due: { date: '2030-01-15T12:00:00Z', timezone: 'UTC' }
    })
  })
})

/** A valid request on another route: it must still find the fault a refused request left. */
const validLabelListing = (target: TodoistEmulator) => call(target, 'GET', api('/labels?limit=200'))

/**
 * Add a match-all fault, send the refused request, and prove: a 400 not-emulated with `reason`,
 * nothing written, the fault untouched, and the fault still answering the next valid request.
 */
const expectRefusedWithoutFault = async (
  target: TodoistEmulator,
  send: () => Promise<Response>,
  reason: string
) => {
  const seed = target.snapshot()

  target.faults.clear()
  target.faults.add({ kind: 'status', status: 503, count: 1 })

  const text = await expectNotEmulated(await send(), reason)

  expect(target.snapshot()).toEqual(seed)
  expect(target.faults.list()[0]).toMatchObject({ applied: 0, remaining: 1 })
  expect(target.ledger.entries().at(-1)).toMatchObject({ status: 400 })
  expect(target.ledger.entries().at(-1)?.notEmulated).toContain(reason)
  expect(target.ledger.entries().at(-1)?.fault).toBeUndefined()

  expect((await validLabelListing(target)).status).toBe(503)
  expect(target.faults.list()[0]).toMatchObject({ applied: 1, remaining: 0 })

  return text
}

describe('fail closed: 400 not-emulated, nothing written, a matching fault left unused', () => {
  it.each([
    [
      'an unknown route',
      'GET',
      api('/sections'),
      {},
      'no emulated Todoist route for this method and path'
    ],
    ['an unknown method', 'PATCH', api('/tasks/6XSyntheticLabel'), {}, 'no emulated Todoist route'],
    ['the REST v2 path', 'GET', '/rest/v2/tasks', {}, 'no emulated Todoist route'],
    ['a missing bearer', 'GET', api('/tasks/6XSyntheticLabel'), { authorization: null }, 'Bearer'],
    [
      'a non-bearer credential',
      'GET',
      api('/labels?limit=200'),
      { authorization: 'Basic eA==' },
      'an unrecognisable Authorization header'
    ],
    [
      'a bearer shorter than 8 characters',
      'GET',
      api('/labels?limit=200'),
      { authorization: 'Bearer short' },
      'an unrecognisable Authorization header'
    ],
    ['an unknown query key', 'GET', api('/tasks?project_id=6XSyntheticPage0&label=x'), {}, 'label'],
    [
      'a repeated query key',
      'GET',
      api('/tasks?project_id=6XSyntheticPage0&project_id=6XSyntheticWork0'),
      {},
      'repeated'
    ],
    ['a filter listing', 'GET', api('/tasks/filter?query=today'), {}, 'no emulated Todoist route'],
    ['a listing without project_id', 'GET', api('/tasks?limit=2'), {}, 'project_id'],
    [
      'a listing of an unknown project',
      'GET',
      api('/tasks?project_id=6XUnknown&limit=2'),
      {},
      'unknown project'
    ],
    [
      'a task limit of 1 (the fixtures send 2)',
      'GET',
      api('/tasks?project_id=6XSyntheticPage0&limit=1'),
      {},
      'limit must be 2'
    ],
    [
      'a task limit above 2',
      'GET',
      api('/tasks?project_id=6XSyntheticPage0&limit=3'),
      {},
      'limit must be 2'
    ],
    [
      'an unlimited listing of three tasks',
      'GET',
      api('/tasks?project_id=6XSyntheticPage0'),
      {},
      'without limit'
    ],
    [
      'a listing of the seeded work project with limit=2 (no fixture records it)',
      'GET',
      api('/tasks?project_id=6XSyntheticWork0&limit=2'),
      {},
      'task listings other than the paging project'
    ],
    [
      'a listing of the seeded work project without limit',
      'GET',
      api('/tasks?project_id=6XSyntheticWork0'),
      {},
      'task listings other than the paging project'
    ],
    [
      'a cursor this emulator did not issue',
      'GET',
      api('/tasks?project_id=6XSyntheticPage0&cursor=SyntheticTaskCursor0001&limit=2'),
      {},
      'did not issue'
    ],
    ['labels without limit', 'GET', api('/labels'), {}, 'without limit'],
    ['labels paging', 'GET', api('/labels?limit=2'), {}, 'paging labels'],
    ['labels with a cursor', 'GET', api('/labels?limit=200&cursor=x'), {}, 'cursor'],
    [
      'the project listing (no fixture records it)',
      'GET',
      api('/projects?limit=200'),
      {},
      'no emulated Todoist route for this method and path'
    ],
    [
      'reading the seeded work project (no fixture records its object)',
      'GET',
      api('/projects/6XSyntheticWork0'),
      {},
      'reading a seeded project'
    ],
    [
      'reading the seeded paging project',
      'GET',
      api('/projects/6XSyntheticPage0'),
      {},
      'reading a seeded project'
    ],
    [
      'deleting a seeded project',
      'DELETE',
      api('/projects/6XSyntheticPage0'),
      {},
      'seeded or unknown'
    ],
    ['deleting an unknown project', 'DELETE', api('/projects/6XUnknown'), {}, 'seeded or unknown'],
    [
      'closing a seeded task',
      'POST',
      api('/tasks/6XSynPagingTask1/close'),
      {},
      'seeded, unknown, or closed'
    ],
    [
      'an id outside the id characters',
      'GET',
      api('/tasks/bad.id'),
      {},
      'no emulated Todoist route'
    ],
    [
      'a credential query key (redacted in the ledger)',
      'GET',
      api('/labels?limit=200&access_token=synthetic-secret'),
      {},
      'access_token'
    ]
  ] as const)('%s', async (_label, method, path, options, reason) => {
    const target = await emulator()

    await expectRefusedWithoutFault(target, () => call(target, method, path, options), reason)

    expect(JSON.stringify(target.ledger.entries())).not.toContain('synthetic-secret')
    expect(JSON.stringify(target.ledger.entries())).not.toContain(token)
  })

  // `setup`: the seed only, a case project (`6XEmuProject0001`), or that project with a task
  // (`6XEmuTask0000001`) in it.
  it.each([
    [
      'a project without parent_id',
      'seed',
      '/projects',
      { name: 'yolk-conformance-run-synthetic-parent' },
      'parent_id'
    ],
    [
      'a project with an extra field',
      'seed',
      '/projects',
      {
        name: 'yolk-conformance-run-synthetic-parent',
        parent_id: '6XSyntheticWork0',
        color: 'red'
      },
      'color'
    ],
    [
      'a project outside the run namespace',
      'seed',
      '/projects',
      { name: 'Groceries', parent_id: '6XSyntheticWork0' },
      'project names'
    ],
    [
      'a project with another suffix',
      'seed',
      '/projects',
      { name: 'yolk-conformance-run-synthetic-other', parent_id: '6XSyntheticWork0' },
      'project names'
    ],
    [
      'a run id over 40 characters',
      'seed',
      '/projects',
      { name: `yolk-conformance-run-${'a'.repeat(37)}-due`, parent_id: '6XSyntheticWork0' },
      'project names'
    ],
    [
      'a project under an unknown parent',
      'seed',
      '/projects',
      { name: 'yolk-conformance-run-synthetic-parent', parent_id: '6XUnknown' },
      'existing seeded project'
    ],
    [
      'a project under a case project',
      'project',
      '/projects',
      { name: 'yolk-conformance-run-synthetic-parent', parent_id: '6XEmuProject0001' },
      'existing seeded project'
    ],
    [
      'a second sub-project under one parent (child_order 2 is unrecorded)',
      'project',
      '/projects',
      { name: 'yolk-conformance-run-synthetic-due', parent_id: '6XSyntheticWork0' },
      'second sub-project'
    ],
    ['a task without project_id', 'project', '/tasks', { content: 'x' }, 'project_id'],
    [
      'a task with labels',
      'project',
      '/tasks',
      { content: 'x', project_id: '6XEmuProject0001', labels: ['synthetic-errand'] },
      'labels'
    ],
    [
      'a task with an empty content',
      'project',
      '/tasks',
      { content: '', project_id: '6XEmuProject0001' },
      'non-empty'
    ],
    [
      'a task due on another day',
      'project',
      '/tasks',
      { content: 'x', project_id: '6XEmuProject0001', due_date: '2030-01-16' },
      'due_date'
    ],
    [
      'a task with due_string',
      'project',
      '/tasks',
      { content: 'x', project_id: '6XEmuProject0001', due_string: 'tomorrow' },
      'due_string'
    ],
    [
      'a task in a seeded project',
      'project',
      '/tasks',
      { content: 'x', project_id: '6XSyntheticWork0' },
      'outside a case project'
    ],
    [
      'a second task in one case project (child_order 2 is unrecorded)',
      'task',
      '/tasks',
      { content: 'x', project_id: '6XEmuProject0001' },
      'second task'
    ],
    [
      'an update of an unknown task',
      'task',
      '/tasks/6XUnknownTask',
      { content: 'x' },
      'seeded, unknown, or closed'
    ],
    [
      'an update of a seeded task',
      'task',
      '/tasks/6XSyntheticLabel',
      { content: 'x' },
      'seeded, unknown, or closed'
    ],
    ['an empty update', 'task', '/tasks/6XEmuTask0000001', {}, 'without content or due_datetime'],
    [
      'an update at another instant',
      'task',
      '/tasks/6XEmuTask0000001',
      { due_datetime: '2030-01-15T13:00:00Z' },
      'due_datetime'
    ],
    ['an update of the priority', 'task', '/tasks/6XEmuTask0000001', { priority: 4 }, 'priority'],
    [
      'closing with a body',
      'task',
      '/tasks/6XEmuTask0000001/close',
      { reason: 'x' },
      'request body'
    ],
    [
      'a body repeating the bearer credential',
      'task',
      '/tasks/6XEmuTask0000001',
      { content: `hi ${token}` },
      'the request body repeats the credential'
    ],
    [
      'a body key repeating the bearer credential',
      'task',
      '/tasks/6XEmuTask0000001',
      { content: 'x', [token]: 1 },
      'the request body repeats the credential'
    ]
  ] as const)('%s', async (_label, setup, path, body, reason) => {
    const target = await emulator()

    if (setup !== 'seed') expect((await createProject(target, 'lifecycle')).status).toBe(200)

    if (setup === 'task') {
      const task = await call(target, 'POST', api('/tasks'), {
        body: { content: 'x', project_id: '6XEmuProject0001' }
      })

      expect(task.status).toBe(200)
    }

    await expectRefusedWithoutFault(target, () => call(target, 'POST', api(path), { body }), reason)
    expect(JSON.stringify(target.ledger.entries())).not.toContain(token)
  })

  it('refuses writes that are not JSON or not application/json, and closed tasks', async () => {
    const target = await emulator()

    await expectRefusedWithoutFault(
      target,
      () =>
        call(target, 'POST', api('/projects'), { rawBody: '{', contentType: 'application/json' }),
      'not JSON'
    )
    await expectRefusedWithoutFault(
      target,
      () =>
        call(target, 'POST', api('/projects'), {
          rawBody: 'name=x',
          contentType: 'application/x-www-form-urlencoded'
        }),
      'not JSON'
    )
    await expectRefusedWithoutFault(
      target,
      () =>
        call(target, 'POST', api('/projects'), {
          body: { name: 'yolk-conformance-run-synthetic-due', parent_id: '6XSyntheticWork0' },
          contentType: 'text/plain'
        }),
      'application/json'
    )

    // A closed task cannot be read, updated, or closed again, and leaves the active listing.
    target.faults.clear()
    await createProject(target, 'lifecycle')
    await call(target, 'POST', api('/tasks'), {
      body: { content: 'x', project_id: '6XEmuProject0001' }
    })
    expect((await call(target, 'POST', api('/tasks/6XEmuTask0000001/close'))).status).toBe(204)

    await expectRefusedWithoutFault(
      target,
      () => call(target, 'GET', api('/tasks/6XEmuTask0000001')),
      'closed task'
    )
    await expectRefusedWithoutFault(
      target,
      () => call(target, 'POST', api('/tasks/6XEmuTask0000001/close')),
      'seeded, unknown, or closed'
    )

    const listing: unknown = await (
      await call(target, 'GET', api('/tasks?project_id=6XEmuProject0001'))
    ).json()

    expect(listing).toEqual({ results: [], next_cursor: null })
  })

  it('refuses a listing of a case project with limit=2 (only the unlimited one is recorded)', async () => {
    const target = await emulator()

    await createProject(target, 'lifecycle')
    await expectRefusedWithoutFault(
      target,
      () => call(target, 'GET', api('/tasks?project_id=6XEmuProject0001&limit=2')),
      'task listings other than the paging project'
    )
  })

  it('validates cursors by issuance: another project_id or limit, and none after a reset', async () => {
    const target = await emulator()

    await call(target, 'GET', api('/tasks?project_id=6XSyntheticPage0&limit=2'))
    await expectRefusedWithoutFault(
      target,
      () =>
        call(
          target,
          'GET',
          api('/tasks?project_id=6XSyntheticPage0&cursor=SyntheticTaskCursor0001')
        ),
      'task listings other than the paging project'
    )
    target.faults.clear()
    await createProject(target, 'lifecycle')
    await expectRefusedWithoutFault(
      target,
      () =>
        call(
          target,
          'GET',
          api('/tasks?project_id=6XEmuProject0001&cursor=SyntheticTaskCursor0001')
        ),
      'another project_id or limit'
    )
    await expectRefusedWithoutFault(
      target,
      () =>
        call(
          target,
          'GET',
          api('/tasks?project_id=6XSyntheticWork0&cursor=SyntheticTaskCursor0001&limit=2')
        ),
      'task listings other than the paging project'
    )

    await target.reset()

    await expectRefusedWithoutFault(
      target,
      () =>
        call(
          target,
          'GET',
          api('/tasks?project_id=6XSyntheticPage0&cursor=SyntheticTaskCursor0001&limit=2')
        ),
      'did not issue'
    )
  })
})

describe('deletes and not-found answers', () => {
  it('deleting a project removes its tasks; later reads answer the 404 envelope with new event ids', async () => {
    const target = await emulator()

    await createProject(target, 'delete')
    await call(target, 'POST', api('/tasks'), {
      body: { content: 'x', project_id: '6XEmuProject0001' }
    })

    expect((await call(target, 'DELETE', api('/projects/6XEmuProject0001'))).status).toBe(204)

    const project = await call(target, 'GET', api('/projects/6XEmuProject0001'))
    const task = await call(target, 'GET', api('/tasks/6XEmuTask0000001'))

    expect(project.status).toBe(404)
    expect(await project.json()).toEqual({
      error: 'Project not found',
      error_code: 478,
      error_extra: { event_id: '00000000000000000000000000000001' },
      error_tag: 'NOT_FOUND',
      http_code: 404
    })
    expect(await task.json()).toMatchObject({
      error: 'Task not found',
      error_extra: { event_id: '00000000000000000000000000000002' }
    })
    expect(target.snapshot().counters).toEqual({
      nextProjectNumber: 2,
      nextTaskNumber: 2,
      nextEventNumber: 3
    })
  })
})

const portsOver = (target: TodoistEmulator) =>
  Layer.mergeAll(
    connectorHttpClientsFromEffectHttpClientLayer.pipe(
      Layer.provide(InProcessHttpClient.layer([EmulatorRoute.handler(origin, target.fetch)]))
    ),
    staticCredentialResolverLayer(ApiKeyCredential.make({ key: token }))
  )

const createTaskThroughConnector = (target: TodoistEmulator) =>
  todoistCreateTaskAction
    .executeTyped({
      integration: todoistConformanceIntegration,
      input: TodoistCreateTaskInput.make({ content: 'x', projectId: '6XEmuProject0001' })
    })
    .pipe(Effect.provide(portsOver(target)))

describe('unrecognised requests are ledgered without request text', () => {
  it.each([
    ['GET', api(`/sections?q=${token}`)],
    ['GET', api(`/projects?limit=200&${token}=1`)],
    ['GET', api('/tasks/6X%53yntheticLabel')],
    ['DELETE', api(`/tasks/${token}`)],
    ['PATCH', api('/tasks/6XSyntheticLabel')],
    ['GET', `/rest/v2/tasks?filter=${token}`]
  ] as const)('%s %s', async (method, path) => {
    const target = await emulator()

    const text = await expectRefusedWithoutFault(
      target,
      () => call(target, method, path),
      'no emulated Todoist route for this method and path'
    )

    expect(target.ledger.entries()[0]).toEqual({
      seq: 1,
      method,
      path: '/<unrecognised>',
      query: {},
      status: 400,
      evidence: 'unknown-route',
      notEmulated: 'no emulated Todoist route for this method and path'
    })
    expect([text, JSON.stringify(target.ledger.entries())].join('\n')).not.toContain(token)
  })
})

describe('an unrecognisable Authorization header is ledgered without request text', () => {
  const secret = 'Q7TodoistSecretValue'

  it.each([
    [
      'extra words, the value in a query value',
      `Bearer ${secret} extra`,
      api(`/labels?limit=200&q=${secret}`)
    ],
    [
      'extra words, the value as a query key',
      `Bearer ${secret} extra`,
      api(`/labels?limit=200&${secret}=1`)
    ],
    ['extra words, the value in the path', `Bearer ${secret} extra`, api(`/tasks/${secret}`)],
    [
      'duplicated headers combined',
      `Bearer ${secret}, Bearer ${secret}`,
      api(`/labels?limit=200&q=${secret}`)
    ]
  ] as const)('%s', async (_label, authorization, path) => {
    const target = await emulator()

    const text = await expectRefusedWithoutFault(
      target,
      () => call(target, 'GET', path, { authorization }),
      'an unrecognisable Authorization header is not emulated'
    )

    expect(target.ledger.entries()[0]).toEqual({
      seq: 1,
      method: 'GET',
      path: '/<unrecognised>',
      query: {},
      status: 400,
      evidence: 'unknown-route',
      notEmulated: 'an unrecognisable Authorization header is not emulated'
    })

    const control = await Promise.all(
      ['ledger', 'state', 'coverage', 'faults'].map(route =>
        target.fetch(new Request(`${origin}/_emulate/${route}`)).then(response => response.text())
      )
    )

    expect([text, JSON.stringify(target.ledger.entries()), ...control].join('\n')).not.toContain(
      secret
    )
  })
})

describe('the bearer value is never ledgered or echoed', () => {
  it.each([
    ['in a query value', 'GET', api(`/labels?limit=200&q=${token}`), {}, 'the query parameter q'],
    ['as a query key', 'GET', api(`/labels?limit=200&${token}=1`), {}, 'the query parameter'],
    ['in the path', 'GET', api(`/tasks/${token}`), {}, 'the request path repeats the credential'],
    [
      'JSON-escaped in a body value',
      'POST',
      api('/projects'),
      {
        rawBody: `{"name":"yolk-conformance-run-synthetic-parent","parent_id":"${token.replace('s', '\\u0073')}"}`
      },
      'the request body repeats the credential'
    ],
    [
      'JSON-escaped as a body key',
      'POST',
      api('/projects'),
      {
        rawBody: `{"name":"yolk-conformance-run-synthetic-parent","parent_id":"6XSyntheticWork0","${token.replace('s', '\\u0073')}":1}`
      },
      'the request body repeats the credential'
    ]
  ] as const)('%s', async (_label, method, path, options, reason) => {
    const target = await emulator()

    await expectRefusedWithoutFault(target, () => call(target, method, path, options), reason)

    const control = await Promise.all(
      ['ledger', 'state', 'coverage', 'faults'].map(route =>
        target.fetch(new Request(`${origin}/_emulate/${route}`)).then(response => response.text())
      )
    )

    expect([JSON.stringify(target.ledger.entries()), ...control].join('\n')).not.toContain(token)
  })

  // JSON numbers normalise (`1.2345678e7` parses to `12345678`): an all-digit bearer must still
  // never reach the ledger.
  it.each([
    ['a project name', '{"name":1.2345678e7,"parent_id":"6XSyntheticWork0"}'],
    [
      'an unknown body field',
      '{"name":"yolk-conformance-run-synthetic-parent","parent_id":"6XSyntheticWork0","n":[1.2345678e7]}'
    ]
  ])('an exponent-notation number repeating an all-digit bearer (%s)', async (_label, rawBody) => {
    const target = await emulator()
    const seed = target.snapshot()

    target.faults.add({
      kind: 'status',
      status: 503,
      count: 1,
      match: { method: 'POST', route: '/api/v1/projects' }
    })

    await expectNotEmulated(
      await call(target, 'POST', api('/projects'), { rawBody, authorization: 'Bearer 12345678' }),
      'the request body repeats the credential'
    )

    expect(target.snapshot()).toEqual(seed)
    expect(target.ledger.entries()[0]?.body).toBeUndefined()
    expect(target.faults.list()[0]).toMatchObject({ applied: 0, remaining: 1 })

    const control = await Promise.all(
      ['ledger', 'state', 'coverage', 'faults'].map(route =>
        target.fetch(new Request(`${origin}/_emulate/${route}`)).then(response => response.text())
      )
    )

    expect(control.join('\n')).not.toContain('12345678')
  })
})

describe('faults', () => {
  it.effect('a 429 fault reaches the connector as todoist_rate_limited and writes nothing', () =>
    Effect.gen(function* () {
      const target = yield* Effect.promise(() => emulator())

      yield* Effect.promise(() => createProject(target, 'lifecycle'))
      target.ledger.clear()

      const seed = target.snapshot()

      target.faults.add({
        kind: 'status',
        status: 429,
        headers: { 'retry-after': '2' },
        match: { method: 'POST', route: '/api/v1/tasks' },
        count: 1
      })

      const limited = yield* createTaskThroughConnector(target)

      expect(
        Predicate.isTagged(limited, 'Failure') ? [limited.error.code, limited.error.status] : []
      ).toEqual(['todoist_rate_limited', 429])
      expect(target.snapshot()).toEqual(seed)
      expect(target.ledger.entries()[0]).toMatchObject({ status: 429, fault: 'status' })
      expect(target.faults.list()[0]).toMatchObject({ applied: 1, remaining: 0 })

      // Used up: the next create runs.
      const created = yield* createTaskThroughConnector(target)

      expect(Predicate.isTagged(created, 'Success')).toBe(true)
      expect(target.snapshot().tasks).toHaveLength(seed.tasks.length + 1)
    })
  )

  it('a fault on the route is left for the next eligible request when a request is refused', async () => {
    const target = await emulator()

    await createProject(target, 'lifecycle')
    target.faults.add({
      kind: 'status',
      status: 429,
      match: { method: 'POST', route: '/api/v1/tasks' },
      count: 1
    })

    const seed = target.snapshot()

    for (const body of [
      { content: 'x', project_id: '6XEmuProject0001', labels: ['synthetic-errand'] },
      { content: 'x', project_id: '6XEmuProject0001', due_string: 'tomorrow' },
      { content: 'x', project_id: '6XSyntheticWork0' }
    ]) {
      expect((await call(target, 'POST', api('/tasks'), { body })).status).toBe(400)
    }

    expect(target.snapshot()).toEqual(seed)
    expect(target.faults.list()[0]).toMatchObject({ applied: 0, remaining: 1 })

    const limited = await call(target, 'POST', api('/tasks'), {
      body: { content: 'x', project_id: '6XEmuProject0001' }
    })

    expect(limited.status).toBe(429)
    expect(target.snapshot()).toEqual(seed)
    expect(target.faults.list()[0]).toMatchObject({ applied: 1, remaining: 0 })
    expect(
      (
        await call(target, 'POST', api('/tasks'), {
          body: { content: 'x', project_id: '6XEmuProject0001' }
        })
      ).status
    ).toBe(200)
  })

  it('answers the default emulator-fault body and validates faults (400-599, headers)', async () => {
    const target = await emulator()

    target.faults.add({ kind: 'status', status: 503, match: { path: '/api/v1/labels' } })

    const faulted = await call(target, 'GET', api('/labels?limit=200'))

    expect(faulted.status).toBe(503)
    expect(faulted.headers.get(emulatorEvidenceHeader)).toBe('unverified')
    expect(await faulted.json()).toEqual({
      error: { type: 'emulator_fault', message: 'Emulator fault: status 503.' }
    })

    for (const fault of [
      { kind: 'status', status: 200 },
      { kind: 'status', status: 302 },
      { kind: 'status', status: 600 },
      { kind: 'status', status: 429, headers: { location: 'https://example.test' } },
      { kind: 'status', status: 429, headers: { 'content-length': '1' } },
      { kind: 'status', status: 429, extra: true }
    ]) {
      // @ts-expect-error -- invalid input on purpose
      expect(() => target.faults.add(fault)).toThrow(TodoistEmulatorInputInvalid)
    }
  })
})

describe('clock-safe recovery', () => {
  it('a throwing clock fails only the writes that read it (500, ledgered), never recovery', async () => {
    const target = await emulator({
      now: () => {
        throw new Error('synthetic clock failure')
      }
    })

    const seed = target.snapshot()
    const failed = await createProject(target)

    expect(failed.status).toBe(500)
    expect(failed.headers.get(emulatorEvidenceHeader)).toBe('unverified')
    expect(await failed.json()).toEqual({
      error: {
        type: 'emulator_error',
        message: 'Synthetic: the emulator could not build the response.'
      }
    })
    expect(target.ledger.entries()[0]).toMatchObject({
      status: 500,
      responseError: 'the route handler failed'
    })
    expect(target.snapshot()).toEqual(seed)

    // Reads, not-found answers, and not-emulated answers need no clock.
    expect((await call(target, 'GET', api('/tasks/6XSyntheticLabel'))).status).toBe(200)
    expect((await call(target, 'GET', api('/tasks/6XAbsent'))).status).toBe(404)
    await expectNotEmulated(
      await call(target, 'GET', api('/sections')),
      'no emulated Todoist route'
    )

    await target.close()

    const closed = await call(target, 'GET', api('/labels?limit=200'))

    expect(closed.status).toBe(503)
    expect(await closed.json()).toEqual({
      error: { type: 'emulator_error', message: 'Synthetic: the emulator is closed.' }
    })
  })

  it('a clock answering a non-finite instant fails the write the same way', async () => {
    const target = await emulator({ now: () => Number.NaN })

    expect((await createProject(target)).status).toBe(500)
    expect(target.snapshot().projects).toHaveLength(2)
  })
})

describe('seeds', () => {
  it('builds the empty profile and replaces parts of a profile', async () => {
    const empty = await emulator({ seed: { profile: 'empty' } })

    expect(empty.snapshot().projects.map(project => project.id)).toEqual(['6XSyntheticWork0'])
    expect(empty.snapshot().tasks).toEqual([])

    const custom = await emulator({
      seed: {
        labels: [
          { id: 'L1', name: 'synthetic-only', color: 'charcoal', order: 1, is_favorite: false }
        ],
        tasks: [
          { id: 'T1', project_id: '6XSyntheticWork0', content: 'x', labels: ['synthetic-only'] }
        ]
      }
    })

    expect(await (await call(custom, 'GET', api('/tasks/T1'))).json()).toMatchObject({
      labels: ['synthetic-only'],
      added_at: '2026-09-20T10:00:00.000000Z'
    })
  })

  it.each([
    [
      {
        projects: [
          { id: 'P1', name: 'a' },
          { id: 'P1', name: 'b' }
        ]
      },
      'duplicate project id'
    ],
    [{ tasks: [{ id: 'T1', project_id: 'missing', content: 'x' }] }, 'missing project'],
    [
      { tasks: [{ id: 'T1', project_id: '6XSyntheticWork0', content: 'x', labels: ['nope'] }] },
      'label'
    ],
    [{ projects: [{ id: 'P1', name: 'a', parent_id: 'missing' }] }, 'missing parent'],
    [{ projects: [{ id: 'bad id', name: 'a' }] }, 'is not 1-64'],
    // Minted ids start at 1: a seeded id in their namespace could collide with a created item.
    [{ projects: [{ id: '6XEmuProject0001', name: 'a' }] }, 'reserved for ids the emulator mints'],
    [
      { tasks: [{ id: '6XEmuTask0000001', project_id: '6XSyntheticWork0', content: 'x' }] },
      'reserved for ids the emulator mints'
    ],
    [
      {
        labels: [{ id: '6XEmuLabel', name: 'x', color: 'charcoal', order: 1, is_favorite: false }]
      },
      'reserved for ids the emulator mints'
    ],
    [{ profile: 'other' }, 'profile'],
    [{ unknown: true }, 'unknown']
  ])('rejects an invalid seed (%o)', async (seed, reason) => {
    // @ts-expect-error -- invalid input on purpose
    await expect(makeTodoistEmulator({ seed })).rejects.toThrow(reason)
  })
})

describe('control plane', () => {
  it('serves the ledger, faults, state, seed, reset, and coverage', async () => {
    const target = await emulator()

    const control = (method: string, path: string, body?: unknown) =>
      target.fetch(
        new Request(`${origin}/_emulate/${path}`, {
          method,
          body: body === undefined ? undefined : JSON.stringify(body)
        })
      )

    await call(target, 'GET', api('/tasks?project_id=6XSyntheticPage0&limit=2'))
    await createProject(target)
    await call(target, 'GET', api('/sections'))

    expect(target.cursors().map(cursor => cursor.id)).toEqual(['SyntheticTaskCursor0001'])

    const coverage: unknown = await (await control('GET', 'coverage')).json()

    expect(coverage).toMatchObject({ unknownRouteRequests: 1, notEmulatedRequests: 1 })
    expect(
      target
        .coverage()
        .routes.filter(route => route.requests > 0)
        .map(r => r.path)
    ).toEqual(['/api/v1/tasks', '/api/v1/projects'])

    const state: unknown = await (await control('GET', 'state')).json()

    expect(state).toMatchObject({
      runtime: { cursors: [{ id: 'SyntheticTaskCursor0001', offset: 2 }] },
      ledgerEntries: 3
    })

    expect((await control('POST', 'faults', { kind: 'status', status: 500 })).status).toBe(201)
    expect((await control('POST', 'faults', { kind: 'status', status: 204 })).status).toBe(400)
    expect(await (await control('GET', 'faults')).json()).toMatchObject({ faults: [{ id: 1 }] })
    expect(await (await control('DELETE', 'faults')).json()).toEqual({ cleared: 1 })

    expect(await (await control('POST', 'reset')).json()).toEqual({ reset: true })
    expect(target.snapshot().projects).toHaveLength(2)
    expect(target.cursors()).toEqual([])
    expect(target.ledger.entries()).toEqual([])

    expect(await (await control('POST', 'seed', { profile: 'empty' })).json()).toEqual({
      seeded: true,
      projects: 1,
      tasks: 0,
      labels: 0
    })
    expect((await control('POST', 'seed', { profile: 'nope' })).status).toBe(400)
    await target.reset()
    expect(target.snapshot().projects).toHaveLength(1)

    expect((await control('PUT', 'reset')).status).toBe(405)
    expect((await control('GET', 'nope')).status).toBe(404)
    expect(await (await control('DELETE', 'ledger')).json()).toEqual({ cleared: 0 })
    // Control-plane requests are never ledgered.
    expect(target.ledger.entries()).toEqual([])
  })
})
