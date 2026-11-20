/**
 * Kie emulator unit tests: the manifest, the fixture data copies, the drift test (every fixture
 * replayed and each complete response compared byte for byte; only the created task ids are
 * minted, and in suite order they equal the fixtures'), the documented request-shape latitude,
 * fail-closed 400 not-emulated answers that change no state and use up no fault, the constant-text
 * ledger of unrecognised requests, the bearer and the rejected key never ledgered, stored, or
 * echoed, faults that write nothing, seeds, and the control plane. Tests may import SDK packages;
 * the emulator source never does.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from '@effect/vitest'
import type * as Schema from 'effect/Schema'
import { isWireBase64BodyResponse, isWireStreamResponse } from '@yolk-sdk/conformance/fixture'
import {
  kieConformanceCases,
  kieConformanceFixtureSeeds,
  kieConformanceFixtures,
  kieConformanceImagePrompt,
  kieConformanceInvalidApiKey,
  kieCreateImageTaskFixture,
  kieCreateVideoTaskFixture,
  kieUnauthorizedFixture
} from '@yolk-sdk/connectors/kie/conformance'
import {
  KieEmulatorInputInvalid,
  emulatorEvidenceHeader,
  kieEmulatorErrorBodies,
  kieEmulatorOrigin,
  kieEmulatorRoutes,
  makeKieEmulator,
  type KieEmulator,
  type KieEmulatorOptions
} from '../src/kie.ts'

const origin = kieEmulatorOrigin

/** A synthetic key the emulator accepts (never account data). */
const token = 'synthetic-kie-unit-key'

const open: Array<KieEmulator> = []

afterEach(async () => {
  await Promise.all(open.splice(0).map(emulator => emulator.close()))
})

const emulator = async (options: KieEmulatorOptions = {}): Promise<KieEmulator> => {
  const created = await makeKieEmulator(options)

  open.push(created)

  return created
}

type CallOptions = {
  readonly body?: unknown
  readonly rawBody?: string
  readonly authorization?: string | null
  readonly contentType?: string
  readonly accept?: string | null
  readonly headers?: Readonly<Record<string, string>>
}

const call = (
  target: KieEmulator,
  method: string,
  url: string,
  options: CallOptions = {}
): Promise<Response> => {
  const headers = new Headers({ 'user-agent': 'yolk-sdk-connectors', ...options.headers })

  const authorization =
    options.authorization === undefined ? `Bearer ${token}` : options.authorization

  if (authorization !== null) headers.set('authorization', authorization)

  const accept = options.accept === undefined ? 'application/json' : options.accept

  if (accept !== null) headers.set('accept', accept)

  const body =
    options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body))

  if (body !== undefined) headers.set('content-type', options.contentType ?? 'application/json')

  return target.fetch(new Request(url, { method, headers, body }))
}

const recordInfoUrl = (taskId: string) =>
  `${origin}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`

const createUrl = `${origin}/api/v1/jobs/createTask`

const imageBody = (input: Readonly<Record<string, Schema.Json>> = {}) => ({
  model: 'gpt-image-2-text-to-image',
  input: {
    prompt: kieConformanceImagePrompt('run-synthetic'),
    aspect_ratio: '1:1',
    resolution: '1K',
    ...input
  }
})

const videoBody = (input: Readonly<Record<string, Schema.Json>> = {}) => ({
  model: 'wan/2-7-image-to-video',
  input: {
    prompt: 'a synthetic video prompt',
    first_frame_url: kieConformanceFixtureSeeds.firstFrameUrl ?? '',
    resolution: '720p',
    duration: 5,
    ...input
  }
})

/** Assert a 400 not-emulated naming `reason`. */
const expectNotEmulated = async (response: Response, reason: string): Promise<string> => {
  expect(response.status).toBe(400)

  const text = await response.text()
  const body: unknown = JSON.parse(text)

  expect(body).toEqual({ error: { type: 'not_emulated', message: expect.any(String) } })
  expect(JSON.stringify(body)).toContain(reason)

  return text
}

const validRequest = (target: KieEmulator) =>
  call(target, 'GET', recordInfoUrl(kieConformanceFixtureSeeds.successTaskId ?? ''))

/**
 * Every refusal: 400 not-emulated naming `reason`, the state unchanged, and a match-all fault
 * installed beforehand left unused, still answering the next valid request.
 */
const expectRefusedWithoutFault = async (
  target: KieEmulator,
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
const controlReads = (target: KieEmulator) =>
  Promise.all(
    ['ledger', 'state', 'coverage', 'faults'].map(route =>
      target.fetch(new Request(`${origin}/_emulate/${route}`)).then(response => response.text())
    )
  )

const digest = (key: string) => createHash('sha256').update(`${origin} ${key}`).digest('hex')

describe('route evidence manifest', () => {
  it('lists the read and the create (a connector write), linked to the Kie cases', () => {
    const caseIds = new Set(kieConformanceCases.map(testCase => testCase.id))

    expect(kieEmulatorRoutes.map(route => [route.method, route.path, route.write])).toEqual([
      ['GET', '/api/v1/jobs/recordInfo', false],
      ['POST', '/api/v1/jobs/createTask', true]
    ])

    for (const route of kieEmulatorRoutes) {
      expect(Object.keys(route).sort()).toEqual([
        'caseIds',
        'evidence',
        'kind',
        'method',
        'path',
        'write'
      ])
      expect(route).toMatchObject({ kind: 'connector', evidence: 'unverified' })
      expect(route.caseIds.every(caseId => caseIds.has(caseId))).toBe(true)
    }

    expect(new Set(kieEmulatorRoutes.flatMap(route => route.caseIds))).toEqual(caseIds)
    expect(kieEmulatorRoutes[1]?.caseIds).toEqual(
      kieConformanceCases
        .filter(testCase => testCase.safety === 'write-irreversible')
        .map(testCase => testCase.id)
    )
  })

  it('has a handler behind every manifest route', async () => {
    const target = await emulator()

    await validRequest(target)
    await call(target, 'POST', createUrl, { body: imageBody() })

    expect(target.coverage().routes.every(route => route.requests === 1)).toBe(true)
    expect(target.coverage().unknownRouteRequests).toBe(0)
    expect(target.ledger.entries().map(entry => entry.status)).toEqual([200, 200])
    expect(target.ledger.entries().every(entry => entry.evidence === 'unverified')).toBe(true)
  })
})

/** The recorded body text of a response (the Kie fixtures record text bodies). */
const recordedText = (
  response: (typeof kieConformanceFixtures)[number]['exchanges'][number]['response']
) => {
  if (isWireStreamResponse(response) || isWireBase64BodyResponse(response)) {
    throw new Error('Kie fixtures record text bodies only')
  }

  return response.body
}

describe('fixture data copies', () => {
  it('the default seed holds the fixture tasks and only the digest of the rejected key', async () => {
    const state = (await emulator()).snapshot()

    expect(state.tasks.map(task => [task.taskId, task.state])).toEqual([
      [kieConformanceFixtureSeeds.successTaskId, 'success'],
      [kieConformanceFixtureSeeds.failedTaskId, 'fail']
    ])
    expect(state.absentTaskIds).toEqual(['yolk_conformance_absent_task_0000'])
    expect(state.rejectedKeyDigests).toEqual([digest(kieConformanceInvalidApiKey)])
    expect(state.createdTasks).toEqual([])
    expect(state.nextCreated).toBe(1)
    expect(JSON.stringify(state)).not.toContain(kieConformanceInvalidApiKey)
  })

  it('the error bodies are the fixtures, byte for byte', () => {
    const recordedBodies = kieConformanceFixtures
      .flatMap(fixture => fixture.exchanges)
      .map(exchange => recordedText(exchange.response))
      .filter(text => !text.includes('"code":200'))

    expect(new Set(recordedBodies)).toEqual(
      new Set(Object.values(kieEmulatorErrorBodies).map(body => JSON.stringify(body)))
    )
  })
})

type Fixture = (typeof kieConformanceFixtures)[number]

/** The bearer each fixture is replayed with: the rejected key for the unauthorized one. */
const fixtureKey = (fixture: Fixture): string =>
  fixture.id === kieUnauthorizedFixture.id ? kieConformanceInvalidApiKey : token

/** Send every request of `fixture` and answer the responses. */
const replay = async (target: KieEmulator, fixture: Fixture) => {
  const answers: Array<{ readonly response: Response; readonly text: string }> = []

  for (const exchange of fixture.exchanges) {
    const headers = new Headers(exchange.request.headers)

    headers.set('authorization', `Bearer ${fixtureKey(fixture)}`)

    const body = exchange.request.body

    const response = await target.fetch(
      new Request(exchange.request.url, {
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
  substitute: (text: string) => string = text => text
) => {
  expect(answers).toHaveLength(fixture.exchanges.length)

  for (const [index, exchange] of fixture.exchanges.entries()) {
    const label = `${index} ${exchange.request.method} ${exchange.request.url}`
    const answer = answers[index]

    if (answer === undefined) throw new Error(label)

    expect(answer.response.status, label).toBe(exchange.response.status)
    expect(answer.response.headers.get(emulatorEvidenceHeader), label).toBe('unverified')
    expect(
      Object.fromEntries(
        [...answer.response.headers].filter(([name]) => name !== emulatorEvidenceHeader)
      ),
      label
    ).toEqual(exchange.response.headers)
    expect(substitute(answer.text), label).toBe(recordedText(exchange.response))
  }
}

describe('drift: every fixture replayed, each complete response byte for byte', () => {
  it('every fixture in suite order on ONE emulator: the created ids are the fixtures', async () => {
    const target = await emulator()

    for (const fixture of kieConformanceFixtures) {
      expectRecorded(fixture, await replay(target, fixture))
    }

    expect(target.ledger.entries().every(entry => entry.notEmulated === undefined)).toBe(true)
    expect(target.snapshot().createdTasks.map(task => [task.taskId, task.model])).toEqual([
      ['yolk_synthetic_task_created_0001', 'gpt-image-2-text-to-image'],
      ['yolk_synthetic_task_created_0002', 'wan/2-7-image-to-video']
    ])
  })

  it.each(kieConformanceFixtures.map(fixture => [fixture.id, fixture] as const))(
    '%s alone (only the minted task id substituted)',
    async (_id, fixture) => {
      const target = await emulator()

      // A fresh emulator mints the first id; the video fixture records the second.
      const minted = (text: string) =>
        fixture.id === kieCreateVideoTaskFixture.id
          ? text.replace('yolk_synthetic_task_created_0001', 'yolk_synthetic_task_created_0002')
          : text

      expectRecorded(fixture, await replay(target, fixture), minted)
      expect(target.ledger.entries().every(entry => entry.notEmulated === undefined)).toBe(true)
    }
  )

  it('the reads end at the seed; each create records exactly its task and advances the counter', async () => {
    const target = await emulator()
    const seed = target.snapshot()

    for (const fixture of kieConformanceFixtures.slice(0, 4)) {
      await replay(target, fixture)
    }

    expect(target.snapshot()).toEqual(seed)

    await replay(target, kieCreateImageTaskFixture)

    expect(target.snapshot()).toEqual({
      ...seed,
      createdTasks: [
        {
          taskId: 'yolk_synthetic_task_created_0001',
          model: 'gpt-image-2-text-to-image',
          input: imageBody().input
        }
      ],
      nextCreated: 2
    })
  })
})

describe('request-shape latitude', () => {
  it('accepts JSON key order, content-type parameters, extra headers, and any prompt', async () => {
    const target = await emulator()

    const reordered = await call(target, 'POST', createUrl, {
      rawBody: JSON.stringify({
        input: { resolution: '1K', prompt: 'another synthetic prompt', aspect_ratio: '1:1' },
        model: 'gpt-image-2-text-to-image'
      }),
      contentType: 'application/json; charset=utf-8',
      headers: { 'x-synthetic-extra': '1' }
    })

    expect(reordered.status).toBe(200)
    expect(await reordered.json()).toEqual({
      code: 200,
      msg: 'success',
      data: { taskId: 'yolk_synthetic_task_created_0001' }
    })
  })

  it('accepts any https first frame and a prompt at the model limit', async () => {
    const target = await emulator()

    const answers = await Promise.all([
      call(target, 'POST', createUrl, {
        body: videoBody({ first_frame_url: 'https://frames.example.com/a/b.png?v=1' })
      }),
      call(target, 'POST', createUrl, { body: videoBody({ prompt: 'x'.repeat(5000) }) }),
      call(target, 'POST', createUrl, { body: imageBody({ prompt: 'x'.repeat(20_000) }) })
    ])

    expect(answers.map(answer => answer.status)).toEqual([200, 200, 200])
    expect(target.snapshot().nextCreated).toBe(4)
  })

  it('a rejected key answers the recorded 401 for any well-formed task id', async () => {
    const target = await emulator()
    const rejected = { authorization: `Bearer ${kieConformanceInvalidApiKey}` }

    const answers = await Promise.all(
      ['yolk_synthetic_task_success_0001', 'any-task-id', 'x'].map(taskId =>
        call(target, 'GET', recordInfoUrl(taskId), rejected)
      )
    )

    expect(answers.map(answer => answer.status)).toEqual([401, 401, 401])
    expect(await answers[1]?.text()).toBe(JSON.stringify(kieEmulatorErrorBodies.unauthorized))
  })
})

describe('the request-shape latitude bullet', () => {
  /** The bullet's text in a file, without comment markers, list markers, emphasis, or wrapping. */
  const bulletIn = (relative: string): string => {
    const text = readFileSync(new URL(relative, import.meta.url), 'utf8')
    const start = text.indexOf('Request-shape latitude (`/kie`')
    const end = text.indexOf('is not emulated.', start)

    expect(start, relative).toBeGreaterThan(-1)

    return text
      .slice(start, end)
      .replace(/^\s*\*\s?/gm, '')
      .replace(/\*\*/g, '')
      .replace(/\s+/g, ' ')
      .replace('deviations). Any', 'deviations): any')
      .trim()
  }

  it('has four copies that agree word for word', () => {
    const copies = [
      '../src/kie.ts',
      '../AGENTS.md',
      '../README.md',
      '../../../apps/docs/content/docs/api-reference/emulators.mdx'
    ].map(bulletIn)

    expect(new Set(copies).size, copies.join('\n\n')).toBe(1)
  })
})

describe('fail closed: 400 not-emulated, state unchanged, a matching fault left unused', () => {
  it.each([
    ['another model', () => ({ ...imageBody(), model: 'gpt-image-2-image-to-image' }), 'a model'],
    ['a callBackUrl', () => ({ ...imageBody(), callBackUrl: 'https://example.com/hook' }), 'key'],
    ['input_urls', () => imageBody({ input_urls: ['https://example.com/a.png'] }), 'key'],
    ['another aspect ratio', () => imageBody({ aspect_ratio: '16:9' }), 'recorded 1:1 at 1K'],
    ['another resolution', () => imageBody({ resolution: '2K' }), 'recorded 1:1 at 1K'],
    ['an empty prompt', () => imageBody({ prompt: '' }), 'prompt must be'],
    ['an overlong prompt', () => imageBody({ prompt: 'x'.repeat(20_001) }), 'prompt must be'],
    ['a numeric prompt', () => imageBody({ prompt: 7 }), 'prompt must be'],
    ['another duration', () => videoBody({ duration: 10 }), 'recorded 720p for 5 s'],
    ['another video resolution', () => videoBody({ resolution: '1080p' }), 'recorded 720p'],
    ['an overlong video prompt', () => videoBody({ prompt: 'x'.repeat(5001) }), 'prompt must be'],
    [
      'an http first frame',
      () => videoBody({ first_frame_url: 'http://example.com/a.png' }),
      'https'
    ],
    [
      'a first frame with credentials',
      () => videoBody({ first_frame_url: 'https://user:pw@example.com/a.png' }),
      'https'
    ],
    ['a missing input', () => ({ model: 'gpt-image-2-text-to-image' }), "without 'input'"],
    ['a body that is no object', () => [imageBody()], 'must be a JSON object']
  ] as const)('create: %s', async (_label, body, reason) => {
    const target = await emulator()

    await expectRefusedWithoutFault(
      target,
      () => call(target, 'POST', createUrl, { body: body() }),
      reason
    )
  })

  it.each([
    ['a task id the state does not hold', recordInfoUrl('yolk_unknown_task'), 'neither'],
    [
      'a created task (no fixture records one)',
      recordInfoUrl('yolk_synthetic_task_created_0001'),
      'neither'
    ],
    ['a malformed task id', recordInfoUrl('a/b'), 'taskId must be'],
    ['a missing taskId', `${origin}/api/v1/jobs/recordInfo`, 'without query parameter taskId'],
    ['a repeated taskId', `${recordInfoUrl('x')}&taskId=y`, 'repeated query parameters'],
    ['another query parameter', `${recordInfoUrl('x')}&extra=1`, 'a query parameter this route'],
    ['an encoded parameter name', `${origin}/api/v1/jobs/recordInfo?%74askId=x`, 'plain form'],
    ['an empty query component', `${recordInfoUrl('x')}&`, 'empty query components']
  ] as const)('recordInfo: %s', async (_label, url, reason) => {
    const target = await emulator()

    await expectRefusedWithoutFault(target, () => call(target, 'GET', url), reason)
  })

  it.each([
    [
      'a create with the rejected key (no fixture records it)',
      (target: KieEmulator) =>
        call(target, 'POST', createUrl, {
          body: imageBody(),
          authorization: `Bearer ${kieConformanceInvalidApiKey}`
        }),
      'a create with a key the seed marks as rejected'
    ],
    [
      'a query parameter on the create',
      (target: KieEmulator) => call(target, 'POST', `${createUrl}?x=1`, { body: imageBody() }),
      'a query parameter this route'
    ],
    [
      'a create without a JSON content type',
      (target: KieEmulator) =>
        call(target, 'POST', createUrl, {
          rawBody: JSON.stringify(imageBody()),
          contentType: 'text/plain'
        }),
      'content'
    ],
    [
      'another Accept',
      (target: KieEmulator) => validRequestWith(target, { accept: 'text/html' }),
      'Accept other than application/json'
    ],
    [
      'a missing Accept',
      (target: KieEmulator) => validRequestWith(target, { accept: null }),
      'Accept other than application/json'
    ],
    [
      'a missing Authorization header',
      (target: KieEmulator) => validRequestWith(target, { authorization: null }),
      'Authorization: Bearer'
    ],
    [
      'the read on another origin',
      (target: KieEmulator) =>
        call(target, 'GET', recordInfoUrl('x').replace(origin, 'https://kie.ai')),
      'recorded on'
    ]
  ] as const)('%s', async (_label, send, reason) => {
    const target = await emulator()

    await expectRefusedWithoutFault(target, () => send(target), reason)
  })
})

const validRequestWith = (target: KieEmulator, options: CallOptions) =>
  call(target, 'GET', recordInfoUrl(kieConformanceFixtureSeeds.successTaskId ?? ''), options)

describe('unrecognised requests are ledgered without request text', () => {
  const unrecognisedReason = 'no emulated Kie route for this method and path'

  it.each([
    ['GET', `${origin}/api/v1/jobs/createTask?taskId=${token}`],
    ['POST', `${origin}/api/v1/jobs/recordInfo/${token}`],
    ['GET', `${origin}/api/v1/chat/credit`],
    ['GET', `${origin}/api/v1/jobs/%72ecordInfo?taskId=x`],
    ['DELETE', `${origin}/api/v1/jobs/recordInfo?taskId=${token}`]
  ] as const)('%s %s', async (method, url) => {
    const target = await emulator()

    const text = await expectRefusedWithoutFault(
      target,
      () => call(target, method, url),
      unrecognisedReason
    )

    expect(target.ledger.entries()[0]).toMatchObject({
      path: '/<unrecognised>',
      query: {},
      notEmulated: unrecognisedReason
    })
    expect([text, JSON.stringify(target.ledger.entries())].join('\n')).not.toContain(token)
  })
})

describe('credentials: never ledgered, stored, or echoed', () => {
  it('the bearer and the rejected key reach no answer, ledger entry, state, or control read', async () => {
    const target = await emulator()

    await validRequest(target)
    await call(target, 'POST', createUrl, { body: imageBody() })
    await call(target, 'GET', recordInfoUrl('x'), {
      authorization: `Bearer ${kieConformanceInvalidApiKey}`
    })

    const recorded = [
      JSON.stringify(target.ledger.entries()),
      JSON.stringify(target.snapshot()),
      ...(await controlReads(target))
    ].join('\n')

    expect(recorded).not.toContain(token)
    expect(recorded).not.toContain(kieConformanceInvalidApiKey)
    expect(recorded.toLowerCase()).not.toContain('bearer')
  })

  it.each([
    ['in the query', recordInfoUrl(token), undefined],
    ['in the prompt', createUrl, imageBody({ prompt: `see ${token}` })],
    ['percent-encoded in the prompt', createUrl, imageBody({ prompt: encodeURIComponent(token) })]
  ] as const)(
    'a request repeating the bearer %s is refused with constant text',
    async (_l, url, body) => {
      const target = await emulator()

      const response =
        body === undefined
          ? await call(target, 'GET', url)
          : await call(target, 'POST', url, { body })

      expect(response.status).toBe(400)

      const recorded = [
        await response.text(),
        JSON.stringify(target.ledger.entries()),
        ...(await controlReads(target))
      ].join('\n')

      expect(recorded).not.toContain(token)
      expect(target.snapshot().createdTasks).toEqual([])
    }
  )
})

describe('faults write nothing', () => {
  it('a faulted create records no task and mints no id', async () => {
    const target = await emulator()
    const seed = target.snapshot()

    target.faults.add({ kind: 'status', status: 500, count: 1 })

    expect((await call(target, 'POST', createUrl, { body: imageBody() })).status).toBe(500)
    expect(target.snapshot()).toEqual(seed)

    const created = await call(target, 'POST', createUrl, { body: imageBody() })

    expect(await created.json()).toMatchObject({
      data: { taskId: 'yolk_synthetic_task_created_0001' }
    })
  })
})

describe('seeds and the control plane', () => {
  it('rejects invalid seeds with constant text that never quotes a key', async () => {
    for (const seed of [
      { rejectedKeys: ['0123456789abcdef'] },
      { rejectedKeys: ['synthetic-key-0001', 'synthetic-key-0001'] },
      { absentTaskIds: ['yolk_synthetic_task_created_0001'] },
      {
        absentTaskIds: ['dup'],
        tasks: [
          {
            taskId: 'dup',
            model: 'm',
            state: 'success' as const,
            resultJson: null,
            failCode: null,
            failMsg: null,
            costTime: null,
            completeTime: null,
            createTime: null,
            updateTime: null
          }
        ]
      }
    ]) {
      const failure = await makeKieEmulator({ seed }).then(
        () => undefined,
        (error: unknown) => error
      )

      expect(failure).toBeInstanceOf(KieEmulatorInputInvalid)
      expect(String(failure)).not.toContain('0123456789abcdef')
      expect(String(failure)).not.toContain('synthetic-key-0001')
    }
  })

  it('reset restores the seed (the counter included)', async () => {
    const target = await emulator()
    const seed = target.snapshot()

    await call(target, 'POST', createUrl, { body: imageBody() })

    expect(target.snapshot()).not.toEqual(seed)

    await target.reset()

    expect(target.snapshot()).toEqual(seed)
  })

  it("a seed with no tasks answers the fixtures' task reads not-emulated", async () => {
    const target = await emulator({ seed: { tasks: [], absentTaskIds: [] } })

    await expectNotEmulated(await validRequest(target), 'neither')
  })
})
