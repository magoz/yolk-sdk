/**
 * GitHub emulator unit tests: the manifest, the fixture data copies, the drift test (every
 * fixture replayed and each complete response compared byte for byte, minted values substituted
 * only at exact field paths), the documented request-shape latitude, fail-closed 400 not-emulated
 * answers that write nothing and use up no fault, the constant-text ledger of unrecognised
 * requests and Authorization headers, bearer scrubbing, origins, faults through the real
 * connector, clock-safe recovery, seeds, and the control plane. Tests may import SDK packages; the
 * emulator source never does.
 */
import { Effect, Layer } from 'effect'
import { afterEach, describe, expect, it } from '@effect/vitest'
import * as Schema from 'effect/Schema'
import { isWireBase64BodyResponse, isWireStreamResponse } from '@yolk-sdk/conformance/fixture'
import { BearerTokenCredential } from '@yolk-sdk/connectors'
import {
  connectorHttpClientsFromEffectHttpClientLayer,
  staticCredentialResolverLayer
} from '@yolk-sdk/connectors/conformance'
import { githubCreateIssueAction, githubListLabelsAction } from '@yolk-sdk/connectors/github'
import {
  githubCommentLifecycleFixture,
  githubConformanceCases,
  githubConformanceFixtureSeeds,
  githubConformanceFixtures,
  githubConformanceIntegration,
  githubIssueLifecycleFixture,
  githubLabelsPagingFixture
} from '@yolk-sdk/connectors/github/conformance'
import {
  GithubEmulatorInputInvalid,
  emulatorEvidenceHeader,
  githubEmulatorErrorBodies,
  githubEmulatorRoutes,
  makeGithubEmulator,
  type GithubEmulator,
  type GithubEmulatorOptions
} from '../src/github.ts'
import { EmulatorRoute, InProcessHttpClient } from '../src/router.ts'

const origin = 'https://api.github.com'

const token = 'synthetic-github-unit-token'

const repoPath = '/repos/yolk-synthetic/conformance-practice'

const at = (time: string) => Date.parse(`2026-09-30T${time}.000Z`)

/** A clock answering `times` in order (each read takes the next), then the last one. */
const scriptedClock = (times: ReadonlyArray<number>) => {
  let reads = 0

  return () => times[Math.min(reads++, times.length - 1)] ?? 0
}

const open: Array<GithubEmulator> = []

afterEach(async () => {
  await Promise.all(open.splice(0).map(emulator => emulator.close()))
})

const emulator = async (options: GithubEmulatorOptions = {}): Promise<GithubEmulator> => {
  const created = await makeGithubEmulator({ now: () => at('12:00:05'), ...options })

  open.push(created)

  return created
}

type CallOptions = {
  readonly body?: unknown
  readonly rawBody?: string
  readonly authorization?: string | null
  readonly accept?: string | null
  readonly apiVersion?: string | null
  readonly contentType?: string
  readonly origin?: string
  readonly handler?: (request: Request) => Promise<Response>
}

const call = (
  target: GithubEmulator,
  method: string,
  path: string,
  options: CallOptions = {}
): Promise<Response> => {
  const headers = new Headers({ 'user-agent': 'yolk-sdk-connectors' })

  const authorization =
    options.authorization === undefined ? `Bearer ${token}` : options.authorization

  const accept = options.accept === undefined ? 'application/vnd.github+json' : options.accept

  const apiVersion = options.apiVersion === undefined ? '2026-03-10' : options.apiVersion

  if (authorization !== null) headers.set('authorization', authorization)

  if (accept !== null) headers.set('accept', accept)

  if (apiVersion !== null) headers.set('x-github-api-version', apiVersion)

  const body =
    options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body))

  if (body !== undefined) headers.set('content-type', options.contentType ?? 'application/json')

  return (options.handler ?? target.fetch)(
    new Request(`${options.origin ?? origin}${path}`, { method, headers, body })
  )
}

const repo = (path: string) => `${repoPath}${path}`

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

const validRequest = (target: GithubEmulator) => call(target, 'GET', repo('/labels?per_page=100'))

/**
 * Every refusal: 400 not-emulated naming `reason`, the state unchanged, and a match-all fault
 * installed beforehand left unused, still answering the next valid request.
 */
const expectRefusedWithoutFault = async (
  target: GithubEmulator,
  send: () => Promise<Response>,
  reason: string
): Promise<string> => {
  const seed = target.snapshot()

  target.faults.clear()
  target.faults.add({ kind: 'status', status: 503, count: 1 })

  const text = await expectNotEmulated(await send(), reason)

  expect(target.snapshot()).toEqual(seed)
  expect(target.faults.list()[0]).toMatchObject({ applied: 0, remaining: 1 })
  expect(target.ledger.entries().at(-1)).toMatchObject({ status: 400 })
  expect(target.ledger.entries().at(-1)?.notEmulated).toContain(reason)
  expect(target.ledger.entries().at(-1)?.fault).toBeUndefined()

  expect((await validRequest(target)).status).toBe(503)
  expect(target.faults.list()[0]).toMatchObject({ applied: 1, remaining: 0 })

  return text
}

/** Every `/_emulate/*` read, as text. */
const controlReads = (target: GithubEmulator) =>
  Promise.all(
    ['ledger', 'state', 'coverage', 'faults'].map(route =>
      target.fetch(new Request(`${origin}/_emulate/${route}`)).then(response => response.text())
    )
  )

const createIssue = (target: GithubEmulator, title = 'yolk-conformance run-abc lifecycle: x') =>
  call(target, 'POST', repo('/issues'), { body: { title, body: 'Synthetic body.' } })

const createComment = (target: GithubEmulator, body = 'yolk-conformance run-abc comment: x') =>
  call(target, 'POST', repo('/issues/1/comments'), { body: { body } })

const jsonOf = async (response: Response): Promise<unknown> => response.json()

describe('route evidence manifest', () => {
  it('lists every route as an unverified connector route linked to GitHub cases', () => {
    const caseIds = new Set(githubConformanceCases.map(testCase => testCase.id))

    expect(githubEmulatorRoutes.map(route => `${route.method} ${route.path}`)).toEqual([
      'GET /repos/{owner}/{repo}/labels',
      'GET /repos/{owner}/{repo}/issues/{issueNumber}',
      'GET /search/issues',
      'GET /repos/{owner}/{repo}/contents/{path+}',
      'POST /repos/{owner}/{repo}/issues/{issueNumber}/comments',
      'GET /repos/{owner}/{repo}/issues/{issueNumber}/comments',
      'DELETE /repos/{owner}/{repo}/issues/comments/{commentId}',
      'POST /repos/{owner}/{repo}/issues/{issueNumber}/labels',
      'DELETE /repos/{owner}/{repo}/issues/{issueNumber}/labels/{name}',
      'POST /repos/{owner}/{repo}/issues',
      'PATCH /repos/{owner}/{repo}/issues/{issueNumber}'
    ])
    expect(
      githubEmulatorRoutes
        .filter(route => route.write)
        .map(route => `${route.method} ${route.path}`)
    ).toEqual([
      'POST /repos/{owner}/{repo}/issues/{issueNumber}/comments',
      'DELETE /repos/{owner}/{repo}/issues/comments/{commentId}',
      'POST /repos/{owner}/{repo}/issues/{issueNumber}/labels',
      'DELETE /repos/{owner}/{repo}/issues/{issueNumber}/labels/{name}',
      'POST /repos/{owner}/{repo}/issues',
      'PATCH /repos/{owner}/{repo}/issues/{issueNumber}'
    ])

    for (const route of githubEmulatorRoutes) {
      expect(Object.keys(route).sort()).toEqual([
        'caseIds',
        'evidence',
        'kind',
        'method',
        'path',
        'write'
      ])
      expect(route).toMatchObject({ kind: 'connector', evidence: 'unverified' })
      expect(route.caseIds.length, route.path).toBeGreaterThan(0)
      expect(route.caseIds.every(caseId => caseIds.has(caseId))).toBe(true)
    }

    expect(new Set(githubEmulatorRoutes.flatMap(route => route.caseIds))).toEqual(caseIds)
  })

  it('has a handler behind every manifest route', async () => {
    const target = await emulator()

    for (const route of githubEmulatorRoutes) {
      const path = route.path
        .replace('{owner}', 'yolk-synthetic')
        .replace('{repo}', 'conformance-practice')
        .replace('{issueNumber}', '7')
        .replace('{commentId}', '7')
        .replace('{name}', 'bug')
        .replace('{path+}', 'docs/missing.txt')

      await call(target, route.method, path, {
        body: route.method === 'GET' || route.method === 'DELETE' ? undefined : {}
      })
    }

    expect(target.coverage().routes.every(route => route.requests === 1)).toBe(true)
    expect(target.coverage().unknownRouteRequests).toBe(0)
    expect(target.ledger.entries().every(entry => entry.evidence === 'unverified')).toBe(true)
  })
})

describe('fixture data copies', () => {
  it('the default seed holds the fixture entities and the fixture seeds', async () => {
    const state = (await emulator()).snapshot()
    const seeds = githubConformanceFixtureSeeds

    expect([state.repository.owner, state.repository.repo]).toEqual([seeds.owner, seeds.repo])
    expect(state.issues.map(issue => [String(issue.number), issue.state, issue.labels])).toEqual([
      [seeds.workIssueNumber, 'open', ['bug']]
    ])
    expect(state.files.map(file => file.path)).toEqual([seeds.filePath])
    expect(state.labels.map(label => label.name)).toContain(seeds.labelName)
    expect(state.counters).toEqual({ nextIssueNumber: 42, nextCommentId: 9000000001 })
    expect(state.comments).toEqual([])
    expect(state.deletedComments).toEqual([])
  })

  it('the default labels are the paging fixture labels, byte for byte', async () => {
    const target = await emulator()
    const listing = await call(target, 'GET', repo('/labels?per_page=100'))

    const recorded = githubLabelsPagingFixture.exchanges
      .slice(0, 3)
      .flatMap(exchange =>
        'body' in exchange.response ? JSON.parse(exchange.response.body ?? '[]') : []
      )

    expect(await listing.text()).toBe(JSON.stringify(recorded))
    expect(listing.headers.get('link')).toBeNull()
  })

  it('the error bodies are the fixtures, byte for byte', () => {
    const recordedBodies = githubConformanceFixtures
      .flatMap(fixture => fixture.exchanges)
      .map(exchange => exchange.response)
      .filter(response => response.status >= 400)
      .map(response => ('body' in response ? response.body : undefined))

    expect(new Set(recordedBodies)).toEqual(
      new Set(Object.values(githubEmulatorErrorBodies).map(body => JSON.stringify(body)))
    )
  })
})

/** The recorded body text of a response (the GitHub fixtures record only text bodies). */
const recordedText = (
  response: (typeof githubConformanceFixtures)[number]['exchanges'][number]['response']
) => {
  if (isWireStreamResponse(response) || isWireBase64BodyResponse(response)) {
    throw new Error('GitHub fixtures record text bodies only')
  }

  return response.body ?? ''
}

/**
 * The clock reads of each write fixture: the created comment, and the created then closed issue.
 */
const fixtureClock = new Map<string, ReadonlyArray<number>>([
  [githubCommentLifecycleFixture.id, [at('12:00:05')]],
  [githubIssueLifecycleFixture.id, [at('12:00:00'), at('12:00:10')]]
])

type Fixture = (typeof githubConformanceFixtures)[number]

/** A stand-in recorded response for an index past the fixture (never compared). */
const githubNoBody = { status: 204, headers: {}, body: '' }

/** Send every request of `fixture` (URLs rewritten by `rewrite`) and answer the responses. */
const replay = async (target: GithubEmulator, fixture: Fixture, rewrite = (url: string) => url) => {
  const answers: Array<{ readonly response: Response; readonly text: string }> = []

  for (const exchange of fixture.exchanges) {
    const headers = new Headers(exchange.request.headers)

    headers.set('authorization', `Bearer ${token}`)

    const body = exchange.request.body

    const response = await target.fetch(
      new Request(rewrite(exchange.request.url), {
        method: exchange.request.method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
      })
    )

    answers.push({ response, text: await response.text() })
  }

  return answers
}

/** Status, every header (the evidence header aside), and the body text equal the recording. */
const expectRecorded = (
  fixture: Fixture,
  answers: ReadonlyArray<{ readonly response: Response; readonly text: string }>,
  comparable: (index: number, text: string) => string = (_index, text) => text
) => {
  expect(answers).toHaveLength(fixture.exchanges.length)

  for (const [index, exchange] of fixture.exchanges.entries()) {
    const label = `${index} ${exchange.request.method} ${exchange.request.url}`
    const answer = answers[index]

    if (answer === undefined) throw new Error(label)

    const { response, text } = answer

    expect(response.status, label).toBe(exchange.response.status)
    expect(response.headers.get(emulatorEvidenceHeader), label).toBe('unverified')
    expect(
      Object.fromEntries([...response.headers].filter(([name]) => name !== emulatorEvidenceHeader)),
      label
    ).toEqual(exchange.response.headers)
    expect(comparable(index, text), label).toBe(recordedText(exchange.response))
  }
}

describe('drift: every fixture replayed, each complete response byte for byte', () => {
  // A fresh default emulator mints exactly the fixtures' values (issue 42, comment 9000000001,
  // and the scripted clock's times), so nothing is substituted.
  it.each(githubConformanceFixtures.map(fixture => [fixture.id, fixture] as const))(
    '%s',
    async (_id, fixture) => {
      const target = await emulator({ now: scriptedClock(fixtureClock.get(fixture.id) ?? [0]) })

      expectRecorded(fixture, await replay(target, fixture))
      expect(target.ledger.entries().every(entry => entry.notEmulated === undefined)).toBe(true)
    }
  )

  const isFields = Schema.is(Schema.Record(Schema.String, Schema.Json))

  /**
   * `actual` with the `minted` fields of one object (top level, or the array item at `index`)
   * replaced by `recorded`'s, after checking each holds exactly the minted value.
   */
  const substitute = (
    actual: Schema.Json,
    recorded: Schema.Json,
    index: number | undefined,
    minted: Readonly<Record<string, Schema.Json>>
  ): string => {
    const objectAt = (value: Schema.Json) => {
      const target = index === undefined ? value : Array.isArray(value) ? value[index] : undefined

      if (!isFields(target)) throw new Error('no object where minted values are substituted')

      return target
    }

    const actualObject = objectAt(actual)
    const recordedObject = objectAt(recorded)
    const replaced = { ...actualObject }

    for (const [key, value] of Object.entries(minted)) {
      expect(actualObject[key], key).toEqual(value)
      replaced[key] = recordedObject[key] ?? null
    }

    if (index === undefined) return JSON.stringify(replaced)

    return JSON.stringify(
      Array.isArray(actual) ? actual.map((item, at) => (at === index ? replaced : item)) : actual
    )
  }

  it('a second comment run mints comment 9000000002, substituted only at its id paths', async () => {
    const fixture = githubCommentLifecycleFixture
    const target = await emulator({ now: scriptedClock([at('12:00:05'), at('12:00:05')]) })

    await replay(target, fixture)

    const answers = await replay(target, fixture, url => url.replace('9000000001', '9000000002'))
    const id = 9000000002

    const minted = {
      url: `${origin}${repoPath}/issues/comments/${id}`,
      html_url: `https://github.com/yolk-synthetic/conformance-practice/issues/1#issuecomment-${id}`,
      id,
      node_id: `IC_kwSynthetic${id}`
    }

    expectRecorded(fixture, answers, (index, text) => {
      // The create answer (top level) and the listing that shows the comment (its first item);
      // the other answers carry no minted value.
      if (index > 1) return text

      const recorded = JSON.parse(recordedText(fixture.exchanges[index]?.response ?? githubNoBody))

      return substitute(JSON.parse(text), recorded, index === 0 ? undefined : 0, minted)
    })
  })

  it('a second lifecycle run mints issue 43, substituted only at its number paths', async () => {
    const fixture = githubIssueLifecycleFixture
    const clock = [at('12:00:00'), at('12:00:10')]
    const target = await emulator({ now: scriptedClock([...clock, ...clock]) })

    await replay(target, fixture)

    const answers = await replay(target, fixture, url => url.replace('/issues/42', '/issues/43'))

    expectRecorded(fixture, answers, (index, text) =>
      substitute(
        JSON.parse(text),
        JSON.parse(recordedText(fixture.exchanges[index]?.response ?? githubNoBody)),
        undefined,
        {
          url: `${origin}${repoPath}/issues/43`,
          html_url: 'https://github.com/yolk-synthetic/conformance-practice/issues/43',
          id: 3000000043,
          node_id: 'I_kwSynthetic43',
          number: 43
        }
      )
    )
  })
})

describe('request-shape latitude', () => {
  it('accepts query parameters in any order, content-type parameters, and extra headers', async () => {
    const target = await emulator()

    expect((await createComment(target)).status).toBe(201)

    const listed = await call(
      target,
      'GET',
      repo('/issues/1/comments?since=2026-09-30T12:00:05Z&per_page=100')
    )

    expect(listed.status).toBe(200)
    expect(await jsonOf(listed)).toHaveLength(1)

    const created = await call(target, 'POST', repo('/issues'), {
      body: { body: '', title: 'Any title' },
      contentType: 'application/json; charset=utf-8'
    })

    expect(created.status).toBe(201)
    expect(await jsonOf(created)).toMatchObject({ number: 42, title: 'Any title', body: '' })
  })

  it('answers any since timestamp: later ones list nothing (the recorded empty listing)', async () => {
    const target = await emulator()

    await createComment(target)

    const later = await call(
      target,
      'GET',
      repo('/issues/1/comments?per_page=100&since=2026-09-30T12:00:06Z')
    )

    expect(later.status).toBe(200)
    expect(await later.text()).toBe('[]')
    expect(later.headers.get('link')).toBeNull()
  })

  it('mints Link paging for any per_page in the recorded form', async () => {
    const target = await emulator()

    const link = (perPage: number, page: number) =>
      `<${origin}/repositories/100000001/labels?per_page=${perPage}&page=${page}>`

    const first = await call(target, 'GET', repo('/labels?per_page=3'))

    expect(await jsonOf(first)).toHaveLength(3)
    expect(first.headers.get('link')).toBe(`${link(3, 2)}; rel="next", ${link(3, 2)}; rel="last"`)

    const last = await call(target, 'GET', repo('/labels?page=2&per_page=3'))

    expect(await jsonOf(last)).toHaveLength(2)
    expect(last.headers.get('link')).toBe(`${link(3, 1)}; rel="prev", ${link(3, 1)}; rel="first"`)

    const after = await call(target, 'GET', repo('/labels?per_page=5&page=2'))

    expect(await after.text()).toBe('[]')
    expect(after.headers.get('link')).toBe(
      `${link(5, 1)}; rel="prev", ${link(5, 1)}; rel="last", ${link(5, 1)}; rel="first"`
    )
  })

  it('answers the recorded 404 for any number not reached and the 422 for any overlong search', async () => {
    const target = await emulator()

    for (const number of ['42', '100', '9999999999']) {
      const response = await call(target, 'GET', repo(`/issues/${number}`))

      expect(response.status, number).toBe(404)
      expect(await response.text()).toBe(JSON.stringify(githubEmulatorErrorBodies.issueNotFound))
    }

    const query = `repo:yolk-synthetic/conformance-practice ${'x'.repeat(257)}`
    const search = await call(target, 'GET', `/search/issues?q=${encodeURIComponent(query)}`)

    expect(search.status).toBe(422)
    expect(await search.text()).toBe(JSON.stringify(githubEmulatorErrorBodies.searchTooLong))
  })

  it('the created issue reads back, renames keep updated_at, and closing stamps the clock', async () => {
    const target = await emulator({ now: scriptedClock([at('12:00:00'), at('12:00:30')]) })

    await createIssue(target)

    const renamed = await call(target, 'PATCH', repo('/issues/42'), { body: { title: 'Renamed' } })

    expect(await jsonOf(renamed)).toMatchObject({
      title: 'Renamed',
      updated_at: '2026-09-30T12:00:00Z',
      closed_at: null
    })

    const closed = await call(target, 'PATCH', repo('/issues/42'), {
      body: { state_reason: 'completed', state: 'closed' }
    })

    expect(await jsonOf(closed)).toMatchObject({
      state: 'closed',
      state_reason: 'completed',
      updated_at: '2026-09-30T12:00:30Z',
      closed_at: '2026-09-30T12:00:30Z'
    })
  })
})

describe('fail closed: 400 not-emulated, nothing written, a matching fault left unused', () => {
  it.each([
    [
      'a missing bearer',
      'GET',
      repo('/issues/1'),
      { authorization: null },
      'Authorization: Bearer'
    ],
    ['another Accept', 'GET', repo('/issues/1'), { accept: 'application/json' }, 'Accept other'],
    ['no API version', 'GET', repo('/issues/1'), { apiVersion: null }, 'X-GitHub-Api-Version'],
    [
      'another API version',
      'GET',
      repo('/issues/1'),
      { apiVersion: '2022-11-28' },
      'X-GitHub-Api-Version'
    ],
    ['another origin', 'GET', repo('/issues/1'), { origin: 'https://example.test' }, 'recorded on'],
    [
      'another repository',
      'GET',
      '/repos/yolk-synthetic/other-practice/issues/1',
      {},
      'a repository other than the seeded one'
    ],
    ['a query on an issue read', 'GET', repo('/issues/1?x=1'), {}, 'query parameter x'],
    ['an implied issue (below the counter, not held)', 'GET', repo('/issues/5'), {}, 'implied'],
    ['labels without per_page', 'GET', repo('/labels'), {}, 'per_page'],
    ['labels per_page 0', 'GET', repo('/labels?per_page=0'), {}, 'per_page must be'],
    ['labels per_page 101', 'GET', repo('/labels?per_page=101'), {}, 'per_page must be'],
    ['an explicit page=1', 'GET', repo('/labels?per_page=2&page=1'), {}, 'page must be'],
    [
      'a label page two past the last',
      'GET',
      repo('/labels?per_page=2&page=5'),
      {},
      'beyond the one after the last'
    ],
    [
      'a repeated query key',
      'GET',
      repo('/labels?per_page=2&per_page=2'),
      {},
      'repeated query parameters'
    ],
    ['an unknown label query key', 'GET', repo('/labels?per_page=2&sort=name'), {}, 'sort'],
    [
      'a credential query key (redacted in the ledger)',
      'GET',
      repo('/labels?per_page=2&access_token=synthetic-secret'),
      {},
      'access_token'
    ],
    [
      'a search of at most 256 characters',
      'GET',
      `/search/issues?q=${encodeURIComponent('repo:yolk-synthetic/conformance-practice bug')}`,
      {},
      'at most 256 characters'
    ],
    [
      'a search without the repo qualifier',
      'GET',
      `/search/issues?q=${'x'.repeat(300)}`,
      {},
      'repo:<owner>/<repo> qualifier'
    ],
    [
      'a search of another repository',
      'GET',
      `/search/issues?q=${encodeURIComponent(`repo:yolk-synthetic/other ${'x'.repeat(300)}`)}`,
      {},
      'a repository other than the seeded one'
    ],
    [
      'a search with sort',
      'GET',
      `/search/issues?q=${encodeURIComponent(`repo:yolk-synthetic/conformance-practice ${'x'.repeat(300)}`)}&sort=created`,
      {},
      'query parameter sort'
    ],
    ['a missing file', 'GET', repo('/contents/docs/missing.txt'), {}, 'no seeded file'],
    ['a contents ref', 'GET', repo('/contents/docs/synthetic-notes.txt?ref=main'), {}, 'ref'],
    [
      'comments without since',
      'GET',
      repo('/issues/1/comments?per_page=100'),
      {},
      'query parameter since'
    ],
    [
      'comments per_page other than 100',
      'GET',
      repo('/issues/1/comments?per_page=50&since=2026-09-30T12:00:00Z'),
      {},
      'per_page other than 100'
    ],
    [
      'comments with page',
      'GET',
      repo('/issues/1/comments?per_page=100&page=1'),
      {},
      'query parameter page'
    ],
    [
      'a since with milliseconds',
      'GET',
      repo('/issues/1/comments?per_page=100&since=2026-09-30T12:00:00.000Z'),
      {},
      'since must be'
    ],
    [
      'comments of an implied issue',
      'GET',
      repo('/issues/5/comments?per_page=100&since=2026-09-30T12:00:00Z'),
      {},
      'does not hold'
    ],
    [
      'deleting a comment never held',
      'DELETE',
      repo('/issues/comments/9000000001'),
      {},
      'never held'
    ],
    [
      'a comment with an extra key',
      'POST',
      repo('/issues/1/comments'),
      { body: { body: 'x', extra: 1 } },
      "key 'extra'"
    ],
    ['an empty comment', 'POST', repo('/issues/1/comments'), { body: { body: '' } }, 'non-empty'],
    [
      'a comment that is not JSON',
      'POST',
      repo('/issues/1/comments'),
      { rawBody: 'body=x', contentType: 'application/x-www-form-urlencoded' },
      'application/json'
    ],
    [
      'a comment on an implied issue',
      'POST',
      repo('/issues/7/comments'),
      { body: { body: 'x' } },
      'does not hold'
    ],
    [
      'an issue create without body',
      'POST',
      repo('/issues'),
      { body: { title: 'x' } },
      "without 'body'"
    ],
    [
      'an issue create with labels',
      'POST',
      repo('/issues'),
      { body: { title: 'x', body: 'y', labels: ['bug'] } },
      "key 'labels'"
    ],
    [
      'an issue create with an empty title',
      'POST',
      repo('/issues'),
      { body: { title: '', body: 'y' } },
      'non-empty'
    ],
    [
      'renaming the seeded issue',
      'PATCH',
      repo('/issues/1'),
      { body: { title: 'x' } },
      'not created here'
    ],
    [
      'closing as not planned (the restore shape)',
      'PATCH',
      repo('/issues/1'),
      { body: { state: 'closed', state_reason: 'not_planned' } },
      'closed as completed'
    ],
    [
      'an update of the body',
      'PATCH',
      repo('/issues/1'),
      { body: { body: 'x' } },
      'issue updates other than'
    ],
    [
      'adding two labels',
      'POST',
      repo('/issues/1/labels'),
      { body: { labels: ['question', 'synthetic-conformance'] } },
      'exactly one label'
    ],
    [
      'adding a label the repository lacks (it would create it)',
      'POST',
      repo('/issues/1/labels'),
      { body: { labels: ['wontfix'] } },
      'does not have'
    ],
    [
      'adding a label the issue has',
      'POST',
      repo('/issues/1/labels'),
      { body: { labels: ['bug'] } },
      'already has'
    ],
    [
      'removing a label the repository lacks',
      'DELETE',
      repo('/issues/1/labels/wontfix'),
      {},
      'does not have'
    ],
    [
      'removing a label from an implied issue',
      'DELETE',
      repo('/issues/5/labels/bug'),
      {},
      'does not hold'
    ]
  ] as const)('%s', async (_label, method, path, options, reason) => {
    const target = await emulator()

    await expectRefusedWithoutFault(target, () => call(target, method, path, options), reason)

    expect(JSON.stringify(target.ledger.entries())).not.toContain('synthetic-secret')
    expect(JSON.stringify(target.ledger.entries())).not.toContain(token)
  })

  // `setup` writes through the emulator first (recorded flows only).
  it.each([
    [
      'an issue read while it holds a comment',
      (target: GithubEmulator) => createComment(target),
      'GET',
      repo('/issues/1'),
      {},
      'holds comments'
    ],
    [
      'a listing of two comments (order unrecorded)',
      async (target: GithubEmulator) => {
        await createComment(target)
        await createComment(target)
      },
      'GET',
      repo('/issues/1/comments?per_page=100&since=2026-09-30T12:00:00Z'),
      {},
      'more than one comment'
    ],
    [
      'renaming a closed issue',
      async (target: GithubEmulator) => {
        await createIssue(target)
        await call(target, 'PATCH', repo('/issues/42'), {
          body: { state: 'closed', state_reason: 'completed' }
        })
      },
      'PATCH',
      repo('/issues/42'),
      { body: { title: 'x' } },
      'closed issue'
    ],
    [
      'commenting on a closed issue',
      async (target: GithubEmulator) => {
        await createIssue(target)
        await call(target, 'PATCH', repo('/issues/42'), {
          body: { state: 'closed', state_reason: 'completed' }
        })
      },
      'POST',
      repo('/issues/42/comments'),
      { body: { body: 'x' } },
      'closed issue'
    ],
    [
      'adding a label that sorts before the issue labels',
      async (target: GithubEmulator) => {
        await call(target, 'POST', repo('/issues/1/labels'), {
          body: { labels: ['question'] }
        })
      },
      'POST',
      repo('/issues/1/labels'),
      { body: { labels: ['enhancement'] } },
      'does not sort after'
    ]
  ] as const)('%s', async (_label, setup, method, path, options, reason) => {
    const target = await emulator()

    await setup(target)

    await expectRefusedWithoutFault(target, () => call(target, method, path, options), reason)
  })
})

describe('unrecognised requests are ledgered without request text', () => {
  const unrecognisedEntry = (method: string) => ({
    seq: 1,
    method,
    path: '/<unrecognised>',
    query: {},
    headers: {},
    status: 400,
    evidence: 'unknown-route',
    notEmulated: 'no emulated GitHub route for this method and path'
  })

  it.each([
    ['GET', repo(`/issues?state=open&q=${token}`)],
    ['GET', repo(`/pulls?${token}=1`)],
    ['GET', repo('/issues/01')],
    ['GET', repo('/issues/abc')],
    ['GET', repo(`/issues/1/labels/${token}%20x`)],
    ['GET', repo('/contents/docs%2Fsynthetic-notes.txt')],
    ['GET', repo('/contents/docs//synthetic-notes.txt')],
    ['GET', repo('/contents/.github/x')],
    ['GET', '/repos/yolk%2Dsynthetic/conformance-practice/issues/1'],
    ['GET', `/repositories/100000001/labels?per_page=2&page=2`],
    ['PUT', repo('/issues/1/lock')],
    ['DELETE', repo(`/issues/${token}`)]
  ] as const)('%s %s', async (method, path) => {
    const target = await emulator()

    const text = await expectRefusedWithoutFault(
      target,
      () => call(target, method, path),
      'no emulated GitHub route for this method and path'
    )

    expect(target.ledger.entries()[0]).toEqual(unrecognisedEntry(method))
    expect([text, JSON.stringify(target.ledger.entries())].join('\n')).not.toContain(token)
  })
})

describe('an unrecognisable Authorization header is ledgered without request text', () => {
  const secret = 'Q7GithubSecretValue'

  it.each([
    ['another scheme', `token ${secret}`, repo(`/labels?per_page=2&q=${secret}`)],
    ['a bearer shorter than 8 characters', 'Bearer short', repo('/labels?per_page=2')],
    [
      'extra words, the value as a query key',
      `Bearer ${secret} extra`,
      repo(`/labels?${secret}=1`)
    ],
    [
      'extra words, the value in the path',
      `Bearer ${secret} extra`,
      repo(`/issues/1/labels/${secret}`)
    ],
    [
      'duplicated headers combined',
      `Bearer ${secret}, Bearer ${secret}`,
      repo(`/labels?per_page=2&q=${secret}`)
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
      headers: {},
      status: 400,
      evidence: 'unknown-route',
      notEmulated: 'an unrecognisable Authorization header is not emulated'
    })

    expect(
      [text, JSON.stringify(target.ledger.entries()), ...(await controlReads(target))].join('\n')
    ).not.toContain(secret)
  })
})

describe('the bearer value is never ledgered or echoed', () => {
  // A token in the label-name characters, so a path that carries it is a recognised shape.
  const secret = 'Q7GithubSecretValue'
  const bearer = { authorization: `Bearer ${secret}` }

  it.each([
    ['in a query value', 'GET', repo(`/labels?per_page=2&q=${secret}`), {}, 'the query repeats'],
    ['as a query key', 'GET', repo(`/labels?per_page=2&${secret}=1`), {}, 'the query repeats'],
    [
      'percent-encoded in a query value',
      'GET',
      repo(`/labels?per_page=2&q=${encodeURIComponent(secret).replace('Q', '%51')}`),
      {},
      'the query repeats'
    ],
    [
      'in the path',
      'DELETE',
      repo(`/issues/1/labels/${secret}`),
      {},
      'the request path repeats the credential'
    ],
    [
      'in a body value',
      'POST',
      repo('/issues/1/comments'),
      { body: { body: `see ${secret}` } },
      'the request body repeats the credential'
    ],
    [
      'JSON-escaped in a body value',
      'POST',
      repo('/issues'),
      { rawBody: `{"title":"x","body":"${secret.replace('G', '\\u0047')}"}` },
      'the request body repeats the credential'
    ],
    [
      'JSON-escaped as a body key',
      'POST',
      repo('/issues/1/comments'),
      { rawBody: `{"body":"x","${secret.replace('G', '\\u0047')}":1}` },
      'the request body repeats the credential'
    ],
    [
      'in a recorded header value',
      'GET',
      repo('/labels?per_page=2'),
      { apiVersion: secret },
      'X-GitHub-Api-Version other'
    ]
  ] as const)('%s', async (_label, method, path, options, reason) => {
    const target = await emulator()

    const text = await expectRefusedWithoutFault(
      target,
      () => call(target, method, path, { ...bearer, ...options }),
      reason
    )

    expect(
      [text, JSON.stringify(target.ledger.entries()), ...(await controlReads(target))].join('\n')
    ).not.toContain(secret)
  })

  // JSON numbers normalise (`1.2345678e7` parses to `12345678`): an all-digit bearer must still
  // never reach the ledger.
  it('an exponent-notation number repeating an all-digit bearer', async () => {
    const target = await emulator()

    const text = await expectRefusedWithoutFault(
      target,
      () =>
        call(target, 'POST', repo('/issues'), {
          rawBody: '{"title":"x","body":"y","n":[1.2345678e7]}',
          authorization: 'Bearer 12345678'
        }),
      'the request body repeats the credential'
    )

    expect(target.ledger.entries()[0]?.body).toBeUndefined()
    expect([text, ...(await controlReads(target))].join('\n')).not.toContain('12345678')
  })

  it('answers recognised requests without the bearer anywhere', async () => {
    const target = await emulator()

    const responses = [
      await createComment(target),
      await call(target, 'GET', repo('/issues/99999999')),
      await call(target, 'GET', repo('/labels?per_page=2'))
    ]

    const texts = await Promise.all(responses.map(response => response.text()))

    expect([...texts, ...(await controlReads(target))].join('\n')).not.toContain(token)
  })
})

describe('origins', () => {
  it('answers only on the recorded origin; fetchOn serves it behind a rewrite', async () => {
    const target = await emulator()
    const loopback = 'http://127.0.0.1:9'

    await expectNotEmulated(
      await call(target, 'GET', repo('/issues/1'), { origin: loopback }),
      'recorded on https://api.github.com only'
    )

    const served = await call(target, 'GET', repo('/issues/1'), {
      origin: loopback,
      handler: target.fetchOn(origin)
    })

    expect(served.status).toBe(200)
  })
})

describe('faults', () => {
  const connectorLayer = (target: GithubEmulator) =>
    Layer.mergeAll(
      connectorHttpClientsFromEffectHttpClientLayer.pipe(
        Layer.provide(InProcessHttpClient.layer([EmulatorRoute.handler(origin, target.fetch)]))
      ),
      staticCredentialResolverLayer(BearerTokenCredential.make({ token }))
    )

  const integration = githubConformanceIntegration('yolk-synthetic', 'conformance-practice')

  it.effect('a 429 fault reaches the connector as github_rate_limited and writes nothing', () =>
    Effect.gen(function* () {
      const target = yield* Effect.promise(() => emulator())
      const seed = target.snapshot()

      target.faults.add({
        kind: 'status',
        status: 429,
        headers: { 'retry-after': '7' },
        match: { method: 'POST' },
        count: 1
      })

      const created = yield* githubCreateIssueAction
        .executeTyped({ integration, input: { title: 'x', body: 'y' } })
        .pipe(Effect.provide(connectorLayer(target)))

      expect(created).toMatchObject({
        _tag: 'Failure',
        error: { code: 'github_rate_limited', status: 429, retryAfterMs: 7000 }
      })
      expect(target.snapshot()).toEqual(seed)
      expect(target.ledger.entries()[0]).toMatchObject({ status: 429, fault: 'status' })

      const listed = yield* githubListLabelsAction
        .executeTyped({ integration, input: { perPage: 2 } })
        .pipe(Effect.provide(connectorLayer(target)))

      expect(listed).toMatchObject({ _tag: 'Success', value: { hasNextPage: true } })
    })
  )

  it('answers the default emulator-fault body and validates faults (400-599, headers)', async () => {
    const target = await emulator()

    target.faults.add({ kind: 'status', status: 500, count: 1 })

    const faulted = await validRequest(target)

    expect(faulted.status).toBe(500)
    expect(await faulted.json()).toEqual({
      error: { type: 'emulator_fault', message: 'Emulator fault: status 500.' }
    })
    expect(() => target.faults.add({ kind: 'status', status: 204 })).toThrow(
      GithubEmulatorInputInvalid
    )
    expect(() =>
      target.faults.add({ kind: 'status', status: 503, headers: { location: '/x' } })
    ).toThrow(GithubEmulatorInputInvalid)
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
    const failed = await createIssue(target)

    expect(failed.status).toBe(500)
    expect(failed.headers.get(emulatorEvidenceHeader)).toBe('unverified')
    expect(await failed.json()).toEqual({
      error: { type: 'emulator_error', message: 'the emulator could not build the response' }
    })
    expect(target.ledger.entries()[0]).toMatchObject({
      status: 500,
      responseError: 'the route handler failed'
    })
    expect((await createComment(target)).status).toBe(500)
    expect(target.snapshot()).toEqual(seed)

    // Reads, the recorded errors, and not-emulated answers need no clock.
    expect((await call(target, 'GET', repo('/issues/1'))).status).toBe(200)
    expect((await call(target, 'GET', repo('/issues/99999999'))).status).toBe(404)
    await expectNotEmulated(await call(target, 'GET', repo('/pulls')), 'no emulated GitHub route')

    await target.close()

    const closed = await validRequest(target)

    expect(closed.status).toBe(503)
    expect(await closed.json()).toEqual({
      error: { type: 'emulator_error', message: 'the emulator is closed' }
    })
  })

  it('a clock answering a non-finite instant fails the write the same way', async () => {
    const target = await emulator({ now: () => Number.NaN })

    expect((await createIssue(target)).status).toBe(500)
    expect(target.snapshot().issues).toHaveLength(1)
  })
})

describe('seeds', () => {
  it('builds the empty profile and replaces parts of a profile', async () => {
    const empty = await emulator({ seed: { profile: 'empty' } })

    expect(empty.snapshot()).toMatchObject({
      labels: [],
      issues: [],
      files: [],
      counters: { nextIssueNumber: 1, nextCommentId: 1 }
    })
    // No fixture records an empty first label page.
    await expectNotEmulated(await validRequest(empty), 'without labels')
    // Every number is unreached in an empty repository.
    expect((await call(empty, 'GET', repo('/issues/1'))).status).toBe(404)

    const custom = await emulator({
      seed: {
        issues: [
          {
            number: 60,
            id: 60,
            nodeId: 'I_kwCustom60',
            title: 'Custom',
            body: null,
            state: 'open',
            stateReason: null,
            labels: [],
            user: { login: 'yolk-synthetic-bot', id: 1000001, type: 'User', siteAdmin: false },
            authorAssociation: 'OWNER',
            createdAt: '2026-09-30T12:00:00Z',
            updatedAt: '2026-09-30T12:00:00Z',
            closedAt: null
          }
        ]
      }
    })

    // Minted numbers start above the highest seeded one.
    expect(custom.snapshot().counters.nextIssueNumber).toBe(61)
    expect(await jsonOf(await createIssue(custom))).toMatchObject({ number: 61 })
    await expectNotEmulated(await call(custom, 'GET', repo('/issues/1')), 'implied')
  })

  it('rejects invalid seeds and options at build, and invalid seeds on seed()', async () => {
    const issue = (fields: Readonly<Record<string, Schema.Json>>) => ({
      number: 1,
      id: 1,
      nodeId: 'I_kwCustom1',
      title: 'x',
      body: null,
      state: 'open',
      stateReason: null,
      labels: [],
      user: { login: 'yolk-synthetic-bot', id: 1000001, type: 'User', siteAdmin: false },
      authorAssociation: 'OWNER',
      createdAt: '2026-09-30T12:00:00Z',
      updatedAt: '2026-09-30T12:00:00Z',
      closedAt: null,
      ...fields
    })

    const label = (name: string) => ({
      id: 1,
      nodeId: 'a',
      name,
      color: 'ffffff',
      default: false,
      description: null
    })

    // Parsed from JSON, as a host passing untyped input would.
    const cases: ReadonlyArray<{
      readonly reason: string
      readonly options: GithubEmulatorOptions
    }> = JSON.parse(
      JSON.stringify([
        { reason: 'extra', options: { seed: { extra: true } } },
        {
          reason: 'duplicate label name bug',
          options: { seed: { labels: [label('bug'), { ...label('bug'), id: 2 }] } }
        },
        { reason: 'nextIssueNumber must lie above', options: { seed: { nextIssueNumber: 1 } } },
        { reason: 'Expected', options: { seed: { labels: [label('good first issue')] } } },
        {
          reason: 'also a folder',
          options: {
            seed: {
              files: [
                { path: 'docs', sha: '0'.repeat(40), text: 'x' },
                { path: 'docs/a.txt', sha: '1'.repeat(40), text: 'y' }
              ]
            }
          }
        },
        { reason: 'names missing label bug', options: { seed: { labels: [] } } },
        {
          reason: 'minted form',
          options: { seed: { issues: [issue({ id: 3000000042, nodeId: 'I_kwSynthetic1' })] } }
        },
        {
          reason: 'minted form',
          options: { seed: { issues: [issue({ nodeId: 'I_kwSynthetic50' })] } }
        },
        { reason: 'unknown drill knob nope', options: { drills: { nope: true } } },
        { reason: 'must be a boolean', options: { drills: { linkOmitsNext: 'yes' } } }
      ])
    )

    const target = await emulator()
    const before = target.snapshot()

    for (const { reason, options } of cases) {
      await expect(makeGithubEmulator(options), reason).rejects.toThrow(reason)

      if (options.seed !== undefined) {
        await expect(target.seed(options.seed), reason).rejects.toBeInstanceOf(
          GithubEmulatorInputInvalid
        )
        expect(target.snapshot()).toEqual(before)
      }
    }
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

    await validRequest(target)
    await createIssue(target)
    await call(target, 'GET', repo('/pulls'))

    const coverage: unknown = await (await control('GET', 'coverage')).json()

    expect(coverage).toMatchObject({ unknownRouteRequests: 1, notEmulatedRequests: 1 })
    expect(
      target
        .coverage()
        .routes.filter(route => route.requests > 0)
        .map(route => `${route.method} ${route.path}`)
    ).toEqual(['GET /repos/{owner}/{repo}/labels', 'POST /repos/{owner}/{repo}/issues'])

    const state: unknown = await (await control('GET', 'state')).json()

    expect(state).toMatchObject({ state: { counters: { nextIssueNumber: 43 } }, ledgerEntries: 3 })

    expect((await control('POST', 'faults', { kind: 'status', status: 500 })).status).toBe(201)
    expect((await control('POST', 'faults', { kind: 'status', status: 204 })).status).toBe(400)
    expect(await (await control('GET', 'faults')).json()).toMatchObject({ faults: [{ id: 1 }] })
    expect(await (await control('DELETE', 'faults')).json()).toEqual({ cleared: 1 })

    expect(await (await control('POST', 'reset')).json()).toEqual({ reset: true })
    expect(target.snapshot().issues).toHaveLength(1)
    expect(target.snapshot().counters.nextIssueNumber).toBe(42)
    expect(target.ledger.entries()).toEqual([])

    expect(await (await control('POST', 'seed', { profile: 'empty' })).json()).toEqual({
      seeded: true,
      labels: 0,
      issues: 0,
      files: 0
    })
    expect((await control('POST', 'seed', { profile: 'nope' })).status).toBe(400)
    await target.reset()
    expect(target.snapshot().issues).toHaveLength(0)

    expect((await control('PUT', 'reset')).status).toBe(405)
    expect((await control('GET', 'nope')).status).toBe(404)
    expect(await (await control('DELETE', 'ledger')).json()).toEqual({ cleared: 0 })
    // Control-plane requests are never ledgered.
    expect(target.ledger.entries()).toEqual([])
  })
})
