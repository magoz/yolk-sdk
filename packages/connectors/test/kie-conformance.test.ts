import { describe, expect, it } from '@effect/vitest'
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Predicate, Ref } from 'effect'
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
  type ReplayLedgerApi
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
import { KieConnector } from '@yolk-sdk/connectors/kie'
import {
  KieConformanceConfig,
  KieConformanceSeeds as KieConformanceSeedsSchema,
  kieConformanceAbsentTaskId,
  kieConformanceCases,
  kieConformanceFixtureSeeds,
  kieConformanceFixtures,
  kieConformanceInvalidApiKey,
  kieCreateImageTaskCase,
  kieCreateImageTaskFixture,
  kieCreateVideoTaskCase,
  kieCreateVideoTaskFixture,
  kieGetFailedTaskFixture,
  kieGetSuccessTaskFixture,
  kieTaskNotFoundFixture,
  kieUnauthorizedFixture,
  type KieConformanceCase,
  type KieConformanceSeeds
} from '@yolk-sdk/connectors/kie/conformance'

const now = new Date('2026-11-20T12:00:00.000Z')

const atTestNow = TestClock.setTime(now.getTime())

/** A synthetic API key (never valid anywhere; replay never checks it). */
const syntheticKey = 'synthetic-kie-replay-key-0001'

const credentialLayer = staticCredentialResolverLayer(ApiKeyCredential.make({ key: syntheticKey }))

const portsOver = (
  httpLayer: Layer.Layer<HttpClient.HttpClient>,
  seeds: KieConformanceSeeds = kieConformanceFixtureSeeds
) =>
  Layer.mergeAll(
    connectorHttpClientsFromEffectHttpClientLayer.pipe(Layer.provide(httpLayer)),
    credentialLayer,
    Layer.succeed(KieConformanceConfig, seeds)
  )

const fixturesFor = (
  testCase: Pick<ConformanceCase<unknown, unknown>, 'fixtures'>,
  fixtures: ReadonlyArray<WireFixture> = kieConformanceFixtures
) => fixtures.filter(fixture => testCase.fixtures.includes(fixture.id))

const replayLayerOver =
  (fixtures: ReadonlyArray<WireFixture> = kieConformanceFixtures) =>
  (testCase: KieConformanceCase) =>
    portsOver(ReplayHttpClient.layer(fixturesFor(testCase, fixtures)))

const ledgerCaseLayer =
  (
    ledgers: Ref.Ref<Map<string, ReplayLedgerApi>>,
    fixtures: ReadonlyArray<WireFixture> = kieConformanceFixtures,
    seeds: KieConformanceSeeds = kieConformanceFixtureSeeds
  ) =>
  (testCase: KieConformanceCase) =>
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

const synthetic = (id: string) => `${id}.synthetic`

const caseIds = [
  ['kie.tasks.get-success', 'read'],
  ['kie.tasks.get-failed', 'read'],
  ['kie.errors.task-not-found', 'read'],
  ['kie.errors.unauthorized', 'read'],
  ['kie.tasks.create-image-task', 'write-irreversible'],
  ['kie.tasks.create-video-task', 'write-irreversible']
] as const

const createCaseIds = ['kie.tasks.create-image-task', 'kie.tasks.create-video-task']

function textBody(response: WireResponse): string {
  if (isWireStreamResponse(response) || isWireBase64BodyResponse(response)) {
    return expect.fail('expected a text body')
  }

  return response.body
}

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))

const parsedBody = (response: WireResponse): Schema.Json =>
  Option.getOrElse(decodeJson(textBody(response)), (): Schema.Json => null)

const isRecord = (value: Schema.Json | undefined): value is Schema.JsonObject =>
  Predicate.isObject(value) && !Array.isArray(value)

describe('Kie conformance cases', () => {
  it('declare their safety, stay unverified, and are backed by one fixture each', () => {
    expect(kieConformanceCases.map(testCase => [testCase.id, testCase.safety])).toEqual(
      caseIds.map(([id, safety]) => [id, safety])
    )
    expect(kieConformanceFixtures.map(fixture => fixture.caseId)).toEqual(
      kieConformanceCases.map(testCase => testCase.id)
    )

    for (const testCase of kieConformanceCases) {
      expect(testCase.observed).toBeUndefined()
      expect(testCase.fixtures).toEqual([synthetic(testCase.id)])
    }
  })

  it('cite only real connector actions', () => {
    const actionIds = new Set(KieConnector.actions.map(action => action.id))

    for (const testCase of kieConformanceCases) {
      const cited = [...`${testCase.docs} ${testCase.wire}`.matchAll(/`(kie\.[a-z_]+)`/g)].flatMap(
        match => (match[1] === undefined || match[1] === 'kie.api_key' ? [] : [match[1]])
      )

      expect(cited.length, testCase.id).toBeGreaterThan(0)
      expect(cited.filter(id => !actionIds.has(id))).toEqual([])
    }
  })

  it('mark every guessed sub-claim unverified in wire', () => {
    expect(
      kieConformanceCases.flatMap(testCase =>
        [...testCase.wire.matchAll(/\bunverified: /g)].map(() => testCase.id)
      )
    ).toEqual(caseIds.map(([id]) => id))
  })

  it('say the create cases cannot be undone', () => {
    for (const testCase of [kieCreateImageTaskCase, kieCreateVideoTaskCase]) {
      expect(testCase.wire).toContain('write-irreversible')
      expect(testCase.docs).toContain('the connector cannot cancel or delete one')
    }
  })

  it.effect('ship synthetic fixtures without credentials that decode and pass the scan', () =>
    Effect.gen(function* () {
      for (const fixture of kieConformanceFixtures) {
        expect(yield* decodeWireFixture(fixture)).toEqual(fixture)
        expect(scanFixtureForSecrets(fixture)).toEqual([])
        expect(fixture).toMatchObject({
          evidence: 'unverified',
          account: 'synthetic',
          endpoint: 'https://api.kie.ai'
        })

        for (const { request, response } of fixture.exchanges) {
          expect(Object.keys(request.headers ?? {})).not.toContain('authorization')
          expect(request.headers?.['accept']).toBe('application/json')
          expect(request.url.startsWith('https://api.kie.ai/api/v1/jobs/')).toBe(true)
          expect(response.headers).toEqual({ 'content-type': 'application/json' })

          // Canonical JSON: the emulator answers these bytes.
          expect(JSON.stringify(parsedBody(response))).toBe(textBody(response))

          const envelope = parsedBody(response)

          expect(isRecord(envelope) ? Object.keys(envelope) : []).toEqual(['code', 'msg', 'data'])
        }
      }

      const serialized = JSON.stringify(kieConformanceFixtures)

      expect(serialized).not.toContain(syntheticKey)
      expect(serialized).not.toContain(kieConformanceInvalidApiKey)
    })
  )

  it('every answer is a minimal synthetic body (allowlist)', () => {
    // The only keys: the envelope, the created task, and the record fields the connector decodes.
    const keys = new Set([
      'code',
      'msg',
      'data',
      'taskId',
      'model',
      'state',
      'resultJson',
      'resultUrls',
      'failCode',
      'failMsg',
      'costTime',
      'completeTime',
      'createTime',
      'updateTime'
    ])

    const allowedString = (value: string) =>
      [
        'success',
        'fail',
        'recordInfo is null',
        'Unauthorized',
        'synthetic generation failure',
        'gpt-image-2-text-to-image',
        '500'
      ].includes(value) ||
      /^yolk_synthetic_task_(?:success|failed|created)_000\d$/.test(value) ||
      /^https:\/\/(?:[a-z]+\.)?example\.com\/yolk-synthetic\/[a-z0-9-]+\.png$/.test(value)

    const refusals = (value: Schema.Json): ReadonlyArray<string> => {
      if (Predicate.isString(value)) {
        // `resultJson` is JSON text.
        return value.startsWith('{')
          ? refusals(Option.getOrElse(decodeJson(value), (): Schema.Json => '<not json>'))
          : allowedString(value)
            ? []
            : [value]
      }

      if (Array.isArray(value)) return value.flatMap(refusals)

      return isRecord(value)
        ? Object.entries(value).flatMap(([key, item]) => [
            ...(keys.has(key) ? [] : [`key ${key}`]),
            ...refusals(item)
          ])
        : []
    }

    for (const fixture of kieConformanceFixtures) {
      for (const exchange of fixture.exchanges) {
        expect(refusals(parsedBody(exchange.response)), fixture.id).toEqual([])
      }
    }
  })

  it.effect('all pass on replay with unverified warnings', () =>
    Effect.gen(function* () {
      yield* atTestNow

      const report = yield* runConformance(kieConformanceCases, {
        target: { kind: 'replay' },
        now,
        fixtures: kieConformanceFixtures,
        layer: replayLayerOver()
      })

      expect(report.summary, formatConformanceReport(report)).toEqual({
        passed: 6,
        failed: 0,
        skipped: 0
      })
      expect(conformanceReportFailed(report)).toBe(false)

      for (const result of report.results) {
        expect(result.warnings).toEqual([
          { kind: 'unverified-case' },
          { kind: 'unverified-fixture', fixtureId: synthetic(result.id) }
        ])
      }

      expect(formatConformanceReport(report)).not.toContain(syntheticKey)
    })
  )

  it.effect('consume every recorded exchange in order and send the recorded requests', () =>
    Effect.gen(function* () {
      yield* atTestNow

      const ledgers = yield* Ref.make(new Map<string, ReplayLedgerApi>())

      const report = yield* runConformance(kieConformanceCases, {
        target: { kind: 'replay' },
        now,
        layer: ledgerCaseLayer(ledgers)
      })

      expect(report.summary.passed).toBe(6)

      for (const testCase of kieConformanceCases) {
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
          expect(entry.headers['authorization']).toBe('<redacted>')
        })
      }
    })
  )
})

describe('Kie conformance safety on a live target', () => {
  const statuses = (target: ConformanceTarget) =>
    atTestNow.pipe(
      Effect.andThen(
        runConformance(kieConformanceCases, { target, now, layer: replayLayerOver() })
      ),
      Effect.map(report =>
        report.results.map(result => [result.id, result.status, result.skipReason ?? null])
      )
    )

  it.effect('runs only the read cases by default, and never a create with reversible writes', () =>
    Effect.gen(function* () {
      const expected = caseIds.map(([id, safety]) =>
        safety === 'read' ? [id, 'passed', null] : [id, 'skipped', 'manual-only']
      )

      expect(yield* statuses({ kind: 'live', account: 'synthetic' })).toEqual(expected)
      expect(
        yield* statuses({ kind: 'live', account: 'synthetic', allowWrites: 'reversible' })
      ).toEqual(expected)
      expect(
        yield* statuses({ kind: 'live', account: 'synthetic', allowIrreversible: ['kie.tasks'] })
      ).toEqual(expected)
    })
  )

  it.effect('runs each create only when its exact id is requested', () =>
    Effect.gen(function* () {
      const results = yield* statuses({
        kind: 'live',
        account: 'synthetic',
        allowIrreversible: ['kie.tasks.create-image-task']
      })

      expect(results.map(([id, status]) => [id, status])).toEqual(
        caseIds.map(([id]) => [id, id === 'kie.tasks.create-video-task' ? 'skipped' : 'passed'])
      )
    })
  )
})

// Drills: replay a fixture that contradicts a claim, or drop it, and check that exactly that case
// fails.

const replaceResponse = (
  fixture: WireFixture,
  response: (original: WireResponse) => WireResponse
): WireFixture => {
  const [first, ...rest] = fixture.exchanges

  return { ...fixture, exchanges: [{ ...first, response: response(first.response) }, ...rest] }
}

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

const envelope = (code: number, msg: string, data: Schema.Json = null) =>
  JSON.stringify({ code, msg, data })

const mismatch = (message: string) => ({ kind: 'failure', tag: 'ConformanceMismatch', message })

const suiteFailures = (fixtures: ReadonlyArray<WireFixture>) =>
  Effect.gen(function* () {
    yield* atTestNow

    const report = yield* runConformance(kieConformanceCases, {
      target: { kind: 'replay' },
      now,
      layer: replayLayerOver(fixtures)
    })

    return report.results
      .filter(result => result.status === 'failed')
      .map(result => ({ id: result.id, failure: result.failure }))
  })

const withReplaced = (tampered: WireFixture) =>
  kieConformanceFixtures.map(fixture => (fixture.id === tampered.id ? tampered : fixture))

type ReportedFailure = { readonly kind: string; readonly tag: string; readonly message: string }

const actionFailed = (message: string): ReportedFailure => ({
  kind: 'failure',
  tag: 'KieConformanceActionFailed',
  message
})

const unknownTaskAdvice =
  'task outcome unknown: a task may exist and spend credits; look for a prompt naming run-synthetic in the Kie task log (the connector cannot cancel it)'

const tampers: ReadonlyArray<{
  readonly fixture: WireFixture
  readonly failure: ReportedFailure
}> = [
  {
    // A success record with no result URL in resultJson.
    fixture: replaceResponse(
      kieGetSuccessTaskFixture,
      replaceInBody(
        '"resultJson":"{\\"resultUrls\\":[\\"https://tempfile.example.com/yolk-synthetic/image-0001.png\\"]}"',
        '"resultJson":"{\\"resultUrls\\":[]}"'
      )
    ),
    failure: mismatch('expected a successful task to carry resultJson with at least one result URL')
  },
  {
    // A failed generation answered as an envelope error: the connector reports a failure.
    fixture: replaceResponse(
      kieGetFailedTaskFixture,
      withStatus(200, envelope(501, 'synthetic generation failure'))
    ),
    failure: actionFailed('kie.get_task failed: kie_generation_failed (HTTP 200) (Kie code 501)')
  },
  {
    // The unknown task answered as code 200 with no record: the connector cannot decode it.
    fixture: replaceResponse(kieTaskNotFoundFixture, withStatus(200, envelope(200, 'success'))),
    failure: { kind: 'failure', tag: 'ConnectorError', message: 'Invalid Kie response shape' }
  },
  {
    // The invalid key answered as a server error instead of 401.
    fixture: replaceResponse(
      kieUnauthorizedFixture,
      withStatus(500, envelope(500, 'Server error'))
    ),
    failure: mismatch(
      'expected an API key Kie does not accept to answer code 401 (kie_unauthorized)'
    )
  },
  {
    // A 2xx whose envelope says insufficient credits: definitive, nothing created.
    fixture: replaceResponse(
      kieCreateImageTaskFixture,
      withStatus(200, envelope(402, 'Credits insufficient'))
    ),
    failure: actionFailed(
      'kie.create_image_task failed: kie_insufficient_credits (HTTP 200) (Kie code 402)'
    )
  },
  {
    // An empty taskId: the connector decodes it, the claim does not hold.
    fixture: replaceResponse(
      kieCreateVideoTaskFixture,
      replaceInBody('"taskId":"yolk_synthetic_task_created_0002"', '"taskId":""')
    ),
    failure: mismatch('expected a non-empty taskId and the Wan 2.7 model')
  }
]

describe('Kie conformance drills (one per case)', () => {
  it('cover every case with a tamper', () => {
    expect(tampers.map(tamper => tamper.fixture.caseId)).toEqual(caseIds.map(([id]) => id))
  })

  for (const { fixture, failure } of tampers) {
    it.effect(`a tampered fixture fails exactly ${fixture.caseId}`, () =>
      Effect.gen(function* () {
        expect(yield* suiteFailures(withReplaced(fixture))).toEqual([
          { id: fixture.caseId, failure }
        ])
      })
    )
  }

  for (const [caseId] of caseIds) {
    it.effect(`a dropped fixture fails exactly ${caseId}`, () =>
      Effect.gen(function* () {
        const failures = yield* suiteFailures(
          kieConformanceFixtures.filter(fixture => fixture.caseId !== caseId)
        )

        expect(failures.map(failure => failure.id)).toEqual([caseId])
      })
    )
  }

  it.effect('the unauthorized claim holds for an envelope 401 at HTTP 200 too', () =>
    Effect.gen(function* () {
      expect(
        yield* suiteFailures(
          withReplaced(
            replaceResponse(kieUnauthorizedFixture, withStatus(200, envelope(401, 'Unauthorized')))
          )
        )
      ).toEqual([])
    })
  )

  it.effect('the not-found claim holds for an HTTP 404, and fails for an envelope 401', () =>
    Effect.gen(function* () {
      expect(
        yield* suiteFailures(
          withReplaced(
            replaceResponse(kieTaskNotFoundFixture, withStatus(404, envelope(404, 'Not found')))
          )
        )
      ).toEqual([])
      expect(
        yield* suiteFailures(
          withReplaced(
            replaceResponse(kieTaskNotFoundFixture, withStatus(200, envelope(401, 'Unauthorized')))
          )
        )
      ).toEqual([
        {
          id: 'kie.errors.task-not-found',
          failure: mismatch(
            'expected an unknown task id to answer a 4xx Kie code other than 401 and 402'
          )
        }
      ])
    })
  )

  it.effect('a failed task without failMsg or failCode fails the failure-detail claim', () =>
    Effect.gen(function* () {
      const bare = replaceResponse(
        kieGetFailedTaskFixture,
        replaceInBody(
          '"failCode":"500","failMsg":"synthetic generation failure"',
          '"failCode":"","failMsg":null'
        )
      )

      expect(yield* suiteFailures(withReplaced(bare))).toEqual([
        {
          id: 'kie.tasks.get-failed',
          failure: mismatch('expected a failed task to carry a non-empty failMsg or failCode')
        }
      ])
    })
  )
})

const connectionReset = (request: HttpClientRequest.HttpClientRequest) =>
  new HttpClientError.HttpClientError({
    reason: new HttpClientError.TransportError({ request, description: 'connection reset' })
  })

const imageDrill = (response: (original: WireResponse) => WireResponse) =>
  Effect.gen(function* () {
    yield* atTestNow

    const ledgers = yield* Ref.make(new Map<string, ReplayLedgerApi>())

    const report = yield* runConformance([kieCreateImageTaskCase], {
      target: { kind: 'replay' },
      now,
      layer: ledgerCaseLayer(ledgers, [replaceResponse(kieCreateImageTaskFixture, response)])
    })

    return {
      failure: report.results[0]?.failure,
      ...(yield* ledgerOf(ledgers, 'kie.tasks.create-image-task'))
    }
  })

describe('Kie conformance irreversible create safety', () => {
  for (const [label, status, body, message] of [
    [
      'an HTTP 4xx',
      422,
      envelope(422, 'Invalid input'),
      'kie.create_image_task failed: kie_validation (HTTP 422) (Kie code 422)'
    ],
    [
      'an envelope 4xx at HTTP 200',
      200,
      envelope(429, 'Rate limited'),
      'kie.create_image_task failed: kie_rate_limited (HTTP 200) (Kie code 429)'
    ]
  ] as const) {
    it.effect(`${label} create reports nothing created, without advice`, () =>
      Effect.gen(function* () {
        const { failure, entries } = yield* imageDrill(withStatus(status, body))

        expect(failure).toEqual(actionFailed(message))
        expect(entries.map(entry => `${entry.method} ${entry.url}`)).toEqual([
          'POST https://api.kie.ai/api/v1/jobs/createTask'
        ])
      })
    )
  }

  for (const [label, status, body, message] of [
    [
      'an HTTP 5xx',
      502,
      'Bad Gateway',
      'kie.create_image_task failed: kie_request_failed (HTTP 502) (Kie code 502)'
    ],
    [
      'an envelope 500 at HTTP 200',
      200,
      envelope(500, 'Server error'),
      'kie.create_image_task failed: kie_request_failed (HTTP 200) (Kie code 500)'
    ],
    [
      "Kie's 455 (service unavailable)",
      200,
      envelope(455, 'Service unavailable'),
      'kie.create_image_task failed: kie_unavailable (HTTP 200) (Kie code 455)'
    ],
    [
      'an envelope 408 at HTTP 200',
      200,
      envelope(408, 'Timeout'),
      'kie.create_image_task failed: kie_request_failed (HTTP 200) (Kie code 408)'
    ],
    [
      'a 2xx that is not JSON',
      200,
      'not json at all',
      'kie.create_image_task failed: validation_failed'
    ]
  ] as const) {
    it.effect(`${label} create is ambiguous and names the run id to look for`, () =>
      Effect.gen(function* () {
        const { failure } = yield* imageDrill(withStatus(status, body))

        expect(failure).toEqual(actionFailed(`${message}; ${unknownTaskAdvice}`))
      })
    )
  }

  it.effect('a create that fails in transport is ambiguous, and no failure carries the key', () =>
    Effect.gen(function* () {
      const dropping = HttpClient.make(request => Effect.fail(connectionReset(request)))

      const report = yield* runConformance(kieConformanceCases, {
        target: { kind: 'replay' },
        now,
        layer: () => portsOver(Layer.succeed(HttpClient.HttpClient, dropping))
      })

      expect(
        report.results.find(result => result.id === 'kie.tasks.create-image-task')?.failure
      ).toEqual(
        actionFailed(`kie.create_image_task failed: transport_failed; ${unknownTaskAdvice}`)
      )
      expect(report.summary.failed).toBe(6)
      expect(JSON.stringify(report)).not.toContain(syntheticKey)
    })
  )

  for (const [caseId, seed] of [
    ['kie.tasks.get-success', 'successTaskId'],
    ['kie.tasks.get-failed', 'failedTaskId'],
    ['kie.tasks.create-image-task', 'runId'],
    ['kie.tasks.create-video-task', 'runId'],
    ['kie.tasks.create-video-task', 'firstFrameUrl']
  ] as const) {
    it.effect(`${caseId} refuses before any request without ${seed}`, () =>
      Effect.gen(function* () {
        yield* atTestNow

        const { [seed]: _dropped, ...seeds } = kieConformanceFixtureSeeds
        const ledgers = yield* Ref.make(new Map<string, ReplayLedgerApi>())
        const testCase = kieConformanceCases.find(candidate => candidate.id === caseId)

        if (testCase === undefined) {
          return expect.fail(`no case ${caseId}`)
        }

        const report = yield* runConformance([testCase], {
          target: { kind: 'replay' },
          now,
          layer: ledgerCaseLayer(ledgers, kieConformanceFixtures, seeds)
        })

        expect(report.results[0]?.failure).toEqual(
          mismatch(`precondition: KieConformanceConfig.${seed} is not configured`)
        )
        expect((yield* ledgerOf(ledgers, caseId)).entries).toEqual([])
      })
    )
  }

  it('accepts seeds of the documented shapes only', () => {
    const decode = Schema.decodeUnknownOption(KieConformanceSeedsSchema)

    expect(Option.isSome(decode(kieConformanceFixtureSeeds))).toBe(true)
    expect(Option.isSome(decode({ successTaskId: kieConformanceAbsentTaskId }))).toBe(true)
    expect(Option.isNone(decode({ successTaskId: 'a/b' }))).toBe(true)
    expect(Option.isNone(decode({ failedTaskId: '' }))).toBe(true)
    expect(Option.isNone(decode({ firstFrameUrl: 'http://example.com/frame.png' }))).toBe(true)
    expect(Option.isNone(decode({ firstFrameUrl: 'https://user:pw@example.com/f.png' }))).toBe(true)
    expect(Option.isNone(decode({ runId: 'mine-0000beef' }))).toBe(true)
  })
})

// Interruption drills: the create is masked, so an interruption waits for its answer; an
// ambiguous answer still reaches the owner through the ConformanceCleanupReporter.

const capturingReporter = Effect.gen(function* () {
  const warnings = yield* Ref.make<ReadonlyArray<string>>([])

  return {
    warnings,
    reporter: { warn: (message: string) => Ref.update(warnings, list => [...list, message]) }
  }
})

/** A create client that holds the createTask response until released. */
const holdingCreate = (fixture: WireFixture) =>
  Effect.gen(function* () {
    const sent = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const { client, ledger } = yield* makeReplayHttpClient([fixture])

    const holding = HttpClient.transform(client, (response, request) =>
      request.url.endsWith('/createTask')
        ? response.pipe(
            Effect.tap(() => Deferred.succeed(sent, undefined)),
            Effect.tap(() => Deferred.await(release))
          )
        : response
    )

    return { sent, release, holding, ledger }
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

const ambiguousCreateFixture = replaceResponse(
  kieCreateImageTaskFixture,
  withStatus(502, 'Bad Gateway')
)

const sentinelCase = (ran: Ref.Ref<boolean>) =>
  defineConformanceCase({
    id: 'test.sentinel.after-interrupted-case',
    safety: 'read',
    docs: 'Synthetic sentinel: records whether it ran.',
    wire: 'Runs only if the run was not stopped.',
    fixtures: [],
    run: Ref.set(ran, true)
  })

describe('Kie conformance interruption reporting', () => {
  it.effect('reports an ambiguous create answered while the case is being interrupted', () =>
    Effect.gen(function* () {
      const { warnings, reporter } = yield* capturingReporter
      const { sent, release, holding } = yield* holdingCreate(ambiguousCreateFixture)

      const fiber = yield* kieCreateImageTaskCase.run.pipe(
        Effect.provide(portsOver(Layer.succeed(HttpClient.HttpClient, holding))),
        Effect.provideService(ConformanceCleanupReporter, reporter),
        Effect.forkChild
      )

      yield* interruptAfter(fiber, sent, release)

      expect(yield* Ref.get(warnings)).toEqual([
        `kie.create_image_task failed: kie_request_failed (HTTP 502) (Kie code 502); ${unknownTaskAdvice}`
      ])
    })
  )

  it.effect('finishes a masked successful create on interruption and reports nothing', () =>
    Effect.gen(function* () {
      const { warnings, reporter } = yield* capturingReporter

      const { sent, release, holding, ledger } = yield* holdingCreate(kieCreateImageTaskFixture)

      const fiber = yield* kieCreateImageTaskCase.run.pipe(
        Effect.provide(portsOver(Layer.succeed(HttpClient.HttpClient, holding))),
        Effect.provideService(ConformanceCleanupReporter, reporter),
        Effect.forkChild
      )

      const exit = yield* interruptAfter(fiber, sent, release)

      expect(Exit.hasInterrupts(exit)).toBe(true)
      expect(yield* ledger.remaining).toEqual([])
      expect(yield* Ref.get(warnings)).toEqual([])
    })
  )

  it.effect('reports nothing extra when an uninterrupted create is ambiguous', () =>
    Effect.gen(function* () {
      const { warnings, reporter } = yield* capturingReporter
      const { client } = yield* makeReplayHttpClient([ambiguousCreateFixture])

      const exit = yield* kieCreateImageTaskCase.run.pipe(
        Effect.provide(portsOver(Layer.succeed(HttpClient.HttpClient, client))),
        Effect.provideService(ConformanceCleanupReporter, reporter),
        Effect.exit
      )

      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* Ref.get(warnings)).toEqual([])
    })
  )

  it.effect('stops the whole run when interrupted during an ambiguous create', () =>
    Effect.gen(function* () {
      const sentinelRan = yield* Ref.make(false)
      const { warnings, reporter } = yield* capturingReporter
      const { sent, release, holding } = yield* holdingCreate(ambiguousCreateFixture)

      const fiber = yield* runConformance([kieCreateImageTaskCase, sentinelCase(sentinelRan)], {
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

      const reported = yield* Ref.get(warnings)

      expect(reported).toHaveLength(1)
      expect(reported[0]).toContain('task outcome unknown')
    })
  )

  it('every create case is masked the same way', () => {
    expect(createCaseIds).toEqual(
      kieConformanceCases
        .filter(testCase => testCase.safety === 'write-irreversible')
        .map(testCase => testCase.id)
    )
  })
})
