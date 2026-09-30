import { describe, expect, it } from '@effect/vitest'
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Ref } from 'effect'
import * as Schema from 'effect/Schema'
import { defineConformanceCase, type ConformanceCase } from '@yolk-sdk/conformance/case'
import {
  decodePortFixture,
  scanPortFixtureForSecrets,
  type PortFixture
} from '@yolk-sdk/conformance/fixture'
import {
  conformanceReportFailed,
  formatConformanceReport,
  runConformance,
  type ConformanceTarget
} from '@yolk-sdk/conformance/runner'
import { ApiKeyCredential } from '@yolk-sdk/connectors'
import {
  ConformanceCleanupReporter,
  staticCredentialResolverLayer
} from '@yolk-sdk/connectors/conformance'
import * as R2Storage from '@yolk-sdk/connectors/r2-storage'
import {
  R2ConformanceConfig,
  R2ConformanceSeeds as R2ConformanceSeedsSchema,
  findR2PortFixtureSecrets,
  makeR2ReplayBackend,
  r2ConformanceCases,
  r2ConformanceFixtureSeeds,
  r2ConformanceFixtures,
  r2ConformanceIntegration,
  r2ConformanceSyntheticAccessKeyId,
  r2ConformanceSyntheticCredential,
  r2ConformanceSyntheticSignature,
  r2CreateIfAbsentCase,
  r2ObjectClientPortName,
  r2PortsFromBackend,
  r2PortsLayerFromBackend,
  r2PresignUploadUrlCase,
  r2PresignerPortName,
  scrubR2PortFixture,
  scrubR2PresignedUrl,
  type R2ConformanceCase,
  type R2ConformanceSeeds,
  type R2Replay
} from '@yolk-sdk/connectors/r2-storage/conformance'

const now = new Date('2026-09-30T12:00:00.000Z')

/** Replay signs with the placeholder key id the committed presigned URLs name. */
const syntheticAccessKey = r2ConformanceSyntheticAccessKeyId

const syntheticSecret = 'synthetic-r2-secret-access-key'

const credentialLayer = staticCredentialResolverLayer({
  [R2Storage.r2AccessKeyIdSlotId]: ApiKeyCredential.make({ key: syntheticAccessKey }),
  [R2Storage.r2SecretAccessKeySlotId]: ApiKeyCredential.make({ key: syntheticSecret })
})

const fixturesFor = (
  testCase: Pick<ConformanceCase<unknown, unknown>, 'fixtures'>,
  fixtures: ReadonlyArray<PortFixture> = r2ConformanceFixtures
) => testCase.fixtures.flatMap(id => fixtures.filter(fixture => fixture.id === id))

/** Per-case replay layer; `replays` receives each case's replay so tests can read its ledger. */
const replayLayer =
  (
    replays: Map<string, R2Replay> = new Map(),
    fixtures: ReadonlyArray<PortFixture> = r2ConformanceFixtures,
    seeds: R2ConformanceSeeds = r2ConformanceFixtureSeeds
  ) =>
  (testCase: R2ConformanceCase) =>
    Layer.mergeAll(
      Layer.suspend(() => {
        const replay = makeR2ReplayBackend(fixturesFor(testCase, fixtures))

        replays.set(testCase.id, replay)

        return r2PortsLayerFromBackend(replay.backend)
      }),
      credentialLayer,
      Layer.succeed(R2ConformanceConfig, seeds)
    )

/** Replay may run every case, the write-irreversible ones included. */
const everyCase: ConformanceTarget = { kind: 'replay' }

const caseIds = [
  ['r2.presign.put-upload-url', 'read'],
  ['r2.objects.get-max-bytes', 'read'],
  ['r2.objects.get-expected-etag', 'read'],
  ['r2.objects.get-missing-not-found', 'read'],
  ['r2.objects.create-if-absent', 'write-irreversible'],
  ['r2.objects.update-if-match', 'write-irreversible']
] as const

const mismatch = (message: string) => ({ kind: 'failure', tag: 'ConformanceMismatch', message })

const suiteFailures = (fixtures: ReadonlyArray<PortFixture>) =>
  Effect.gen(function* () {
    const report = yield* runConformance(r2ConformanceCases, {
      target: everyCase,
      now,
      layer: replayLayer(new Map(), fixtures)
    })

    return report.results
      .filter(result => result.status === 'failed')
      .map(result => ({ id: result.id, failure: result.failure }))
  })

const fixtureById = (id: string): PortFixture =>
  r2ConformanceFixtures.find(fixture => fixture.id === id) ?? expect.fail(`no fixture ${id}`)

/** The suite's fixtures with `id` replaced by `replacement` (same id). */
const withFixture = (id: string, replacement: (fixture: PortFixture) => PortFixture) =>
  r2ConformanceFixtures.map(fixture => (fixture.id === id ? replacement(fixture) : fixture))

const answering =
  (response: Schema.Json) =>
  (fixture: PortFixture): PortFixture => ({
    id: fixture.id,
    port: fixture.port,
    method: fixture.method,
    request: fixture.request,
    response
  })

const failing =
  (code: string) =>
  (fixture: PortFixture): PortFixture => ({
    id: fixture.id,
    port: fixture.port,
    method: fixture.method,
    request: fixture.request,
    failure: { kind: 'error', code, message: 'Synthetic failure.' }
  })

const presignId = 'r2.presign.put-upload-url.presign.synthetic'

const PresignAnswer = Schema.Struct({ uploadUrl: Schema.String })

const presignedUrl = (() => {
  const fixture = fixtureById(presignId)

  const answer =
    fixture.failure === undefined
      ? Schema.decodeUnknownOption(PresignAnswer)(fixture.response)
      : Option.none()

  return Option.isSome(answer) ? answer.value.uploadUrl : expect.fail('no presigned url')
})()

const withParam = (name: string, value: string | undefined) => {
  const url = new URL(presignedUrl)

  if (value === undefined) url.searchParams.delete(name)
  else url.searchParams.set(name, value)

  return url.toString()
}

const seededObject = (() => {
  const fixture = fixtureById('r2.objects.get-max-bytes.within-budget.synthetic')

  return fixture.failure === undefined ? fixture.response : expect.fail('no seeded object')
})()

describe('R2 conformance cases', () => {
  it('declare their safety, stay unverified, and cite existing fixtures in order', () => {
    expect(r2ConformanceCases.map(testCase => [testCase.id, testCase.safety])).toEqual(
      caseIds.map(([id, safety]) => [id, safety])
    )
    expect(r2ConformanceCases.flatMap(testCase => testCase.fixtures)).toEqual(
      r2ConformanceFixtures.map(fixture => fixture.id)
    )

    for (const testCase of r2ConformanceCases) {
      expect(testCase.observed).toBeUndefined()
      expect(testCase.fixtures.every(id => id.startsWith(`${testCase.id}.`))).toBe(true)
    }
  })

  it('cite only the real connector action and host-only helpers', () => {
    const actionIds = new Set(R2Storage.R2StorageConnector.actions.map(action => action.id))
    const exported = new Set(Object.keys(R2Storage))

    for (const testCase of r2ConformanceCases) {
      const text = `${testCase.docs} ${testCase.wire}`
      const actions = [...text.matchAll(/`(r2_storage\.[a-z_]+)`/g)].map(match => match[1])

      const helpers = [...text.matchAll(/`((?:get|create|update)R2Object)`/g)].map(
        match => match[1]
      )

      expect(actions.length + helpers.length).toBeGreaterThan(0)
      expect(actions.filter(id => id === undefined || !actionIds.has(id))).toEqual([])
      expect(helpers.filter(name => name === undefined || !exported.has(name))).toEqual([])
    }
  })

  it('mark every guessed sub-claim unverified in wire', () => {
    expect(
      r2ConformanceCases.flatMap(testCase =>
        [...testCase.wire.matchAll(/\bunverified: /g)].map(() => testCase.id)
      )
    ).toEqual([
      'r2.presign.put-upload-url',
      'r2.presign.put-upload-url',
      'r2.objects.get-max-bytes',
      'r2.objects.update-if-match'
    ])
  })

  it.effect('ship synthetic port fixtures that decode and pass both secret scans', () =>
    Effect.gen(function* () {
      expect(new Set(r2ConformanceFixtures.map(fixture => fixture.id)).size).toBe(
        r2ConformanceFixtures.length
      )

      for (const fixture of r2ConformanceFixtures) {
        expect(yield* decodePortFixture(fixture)).toEqual(fixture)
        expect(scanPortFixtureForSecrets(fixture)).toEqual([])
        expect(findR2PortFixtureSecrets(fixture)).toEqual([])
        expect(fixture.observed).toBeUndefined()
        expect([r2PresignerPortName, r2ObjectClientPortName]).toContain(fixture.port)

        const text = JSON.stringify(fixture)

        for (const host of text.match(/[a-z0-9.-]+\.(?:com|net|org|io|dev)\b/g) ?? []) {
          expect.fail(`non-synthetic host in ${fixture.id}: ${host}`)
        }

        expect(text).not.toMatch(/"(?:accessKeyId|secretAccessKey|credentials?)"/)
      }
    })
  )
})

describe('R2 conformance on replay', () => {
  it.effect('every case passes against its own fixtures and consumes all of them', () =>
    Effect.gen(function* () {
      const replays = new Map<string, R2Replay>()

      const report = yield* runConformance(r2ConformanceCases, {
        target: everyCase,
        now,
        fixtures: r2ConformanceFixtures,
        layer: replayLayer(replays)
      })

      expect(conformanceReportFailed(report), formatConformanceReport(report)).toBe(false)
      expect(report.summary).toEqual({ passed: 6, failed: 0, skipped: 0 })

      for (const testCase of r2ConformanceCases) {
        const replay = replays.get(testCase.id)

        expect(replay?.ledger.remaining(), testCase.id).toEqual([])
        expect(
          replay?.ledger.entries().map(entry => entry.fixtureId ?? entry.outcome),
          testCase.id
        ).toEqual(testCase.fixtures)
      }

      for (const result of report.results) {
        expect(result.warnings[0]).toEqual({ kind: 'unverified-case' })
        expect(
          result.warnings.slice(1).every(warning => warning.kind === 'unverified-fixture')
        ).toBe(true)
      }
    })
  )

  it.effect('the bridge never hands the R2 credentials to a backend', () =>
    Effect.gen(function* () {
      const replays = new Map<string, R2Replay>()

      yield* runConformance(r2ConformanceCases, {
        target: everyCase,
        now,
        layer: replayLayer(replays)
      })

      const presign = replays.get(r2PresignUploadUrlCase.id)?.ledger.entries()[0]

      expect(presign?.request).toEqual({
        endpoint: 'https://synthetic-account.r2.example.test',
        bucket: 'yolk-synthetic-bucket',
        key: 'yolk-conformance/run-synthetic/presign.txt',
        contentType: 'text/plain'
      })

      const requests = [...replays.values()].flatMap(replay =>
        replay.ledger.entries().map(entry => JSON.stringify(entry.request))
      )

      expect(requests).toHaveLength(r2ConformanceFixtures.length)

      for (const request of requests) {
        expect(request).not.toContain(syntheticAccessKey)
        expect(request).not.toContain(syntheticSecret)
        expect(request).not.toContain('integration')
      }
    })
  )
})

describe('R2 conformance safety on a live target', () => {
  const statuses = (target: ConformanceTarget) =>
    runConformance(r2ConformanceCases, { target, now, layer: replayLayer() }).pipe(
      Effect.map(report =>
        report.results.map(result => [result.id, result.status, result.skipReason ?? null])
      )
    )

  it.effect('never runs a write, reversible writes allowed or not, unless named by exact id', () =>
    Effect.gen(function* () {
      const expected = caseIds.map(([id, safety]) =>
        safety === 'read' ? [id, 'passed', null] : [id, 'skipped', 'manual-only']
      )

      expect(yield* statuses({ kind: 'live', account: 'synthetic' })).toEqual(expected)
      expect(
        yield* statuses({ kind: 'live', account: 'synthetic', allowWrites: 'reversible' })
      ).toEqual(expected)

      const named = yield* statuses({
        kind: 'live',
        account: 'synthetic',
        allowIrreversible: [r2CreateIfAbsentCase.id]
      })

      expect(named.flatMap(([id, status]) => (status === 'passed' ? [id] : []))).toEqual([
        ...caseIds.flatMap(([id, safety]) => (safety === 'read' ? [id] : [])),
        r2CreateIfAbsentCase.id
      ])
    })
  )
})

// Drills: replay a fixture that contradicts a claim, or drop one, and check that exactly that case
// fails with its exact mismatch.

const tampers: ReadonlyArray<{
  readonly caseId: string
  readonly fixtures: ReadonlyArray<PortFixture>
  readonly message: string
}> = [
  {
    caseId: 'r2.presign.put-upload-url',
    fixtures: withFixture(
      presignId,
      answering({ uploadUrl: withParam('X-Amz-Expires', '700000') })
    ),
    message: 'expected X-Amz-Expires from 1 to 604800 seconds'
  },
  {
    // The host ignores maxBytes and answers the whole object.
    caseId: 'r2.objects.get-max-bytes',
    fixtures: withFixture(
      'r2.objects.get-max-bytes.over-budget.synthetic',
      answering(seededObject)
    ),
    message: 'expected the port get with maxBytes below the object size to fail response_too_large'
  },
  {
    // The host ignores expectedEtag and answers the object.
    caseId: 'r2.objects.get-expected-etag',
    fixtures: withFixture('r2.objects.get-expected-etag.stale.synthetic', answering(seededObject)),
    message: 'expected the port get with a stale expectedEtag to fail conflict'
  },
  {
    // A missing object answered as an empty success.
    caseId: 'r2.objects.get-missing-not-found',
    fixtures: withFixture(
      'r2.objects.get-missing-not-found.get.synthetic',
      answering({ etag: '"d41d8cd98f00b204e9800998ecf8427e"', size: 0, bodyBase64: '' })
    ),
    message: 'expected the port get of a missing key to fail not_found'
  },
  {
    // The second create overwrites instead of failing conflict.
    caseId: 'r2.objects.create-if-absent',
    fixtures: withFixture(
      'r2.objects.create-if-absent.create-again.synthetic',
      answering({ etag: '"c0ffee00c0ffee00c0ffee00c0ffee09"', size: 67 })
    ),
    message: 'expected a second create of the same key to fail conflict at the port'
  },
  {
    // A stale If-Match is ignored.
    caseId: 'r2.objects.update-if-match',
    fixtures: withFixture(
      'r2.objects.update-if-match.stale.synthetic',
      answering({ etag: '"c0ffee00c0ffee00c0ffee00c0ffee09"', size: 74 })
    ),
    message: 'expected an update with a stale etag to fail conflict at the port'
  }
]

describe('R2 conformance drills (one per case)', () => {
  it('cover every case with a tamper', () => {
    expect(tampers.map(tamper => tamper.caseId)).toEqual(caseIds.map(([id]) => id))
  })

  for (const { caseId, fixtures, message } of tampers) {
    it.effect(`a tampered fixture fails exactly ${caseId}`, () =>
      Effect.gen(function* () {
        expect(yield* suiteFailures(fixtures)).toEqual([{ id: caseId, failure: mismatch(message) }])
      })
    )
  }

  for (const [label, url, message] of [
    [
      'an unsigned content type',
      withParam('X-Amz-SignedHeaders', 'host'),
      'expected X-Amz-SignedHeaders to list host and content-type'
    ],
    [
      'a missing signature',
      withParam('X-Amz-Signature', undefined),
      'expected uploadUrl to carry X-Amz-Algorithm AWS4-HMAC-SHA256, X-Amz-Credential, and X-Amz-Signature'
    ],
    [
      'another bucket',
      presignedUrl.replace('/yolk-synthetic-bucket/', '/other-bucket/'),
      "expected uploadUrl to address the bucket and key over https on the endpoint's host"
    ],
    [
      'plain http',
      presignedUrl.replace('https://', 'http://'),
      "expected uploadUrl to address the bucket and key over https on the endpoint's host"
    ],
    [
      'another access key id (the host signed with its own keys)',
      withParam('X-Amz-Credential', 'yolk-synthetic-other-key-id/20260930/auto/s3/aws4_request'),
      'expected the uploadUrl X-Amz-Credential to name the access key id the connector passed'
    ],
    [
      'a zero expiry',
      withParam('X-Amz-Expires', '0'),
      'expected X-Amz-Expires from 1 to 604800 seconds'
    ]
  ] as const) {
    it.effect(`a presigned URL with ${label} fails exactly the presign case`, () =>
      Effect.gen(function* () {
        expect(yield* suiteFailures(withFixture(presignId, answering({ uploadUrl: url })))).toEqual(
          [{ id: 'r2.presign.put-upload-url', failure: mismatch(message) }]
        )
      })
    )
  }

  it.effect('bytes that differ but decode to the same text fail exactly the etag case', () =>
    Effect.gen(function* () {
      // [0xff, 0x00] and [0xfe, 0x00] both decode to the same replacement text: compare bytes.
      const object = (bytes: ReadonlyArray<number>) => ({
        etag: '"a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5"',
        size: bytes.length,
        bodyBase64: btoa(String.fromCharCode(...bytes))
      })

      const answers = new Map<string, ReadonlyArray<number>>([
        ['r2.objects.get-expected-etag.plain.synthetic', [0xff, 0x00]],
        ['r2.objects.get-expected-etag.current.synthetic', [0xfe, 0x00]]
      ])

      const tampered = r2ConformanceFixtures.map(fixture => {
        const bytes = answers.get(fixture.id)

        return bytes === undefined ? fixture : answering(object(bytes))(fixture)
      })

      expect(new TextDecoder().decode(new Uint8Array([0xff, 0x00]))).toBe(
        new TextDecoder().decode(new Uint8Array([0xfe, 0x00]))
      )
      expect(yield* suiteFailures(tampered)).toEqual([
        {
          id: 'r2.objects.get-expected-etag',
          failure: mismatch(
            'expected a get with the current etag to pass it to the port and answer the same bytes'
          )
        }
      ])
    })
  )

  it.effect('a virtual-hosted presigned URL (the bucket as a subdomain) passes', () =>
    Effect.gen(function* () {
      const virtualHosted = presignedUrl.replace(
        'https://synthetic-account.r2.example.test/yolk-synthetic-bucket/',
        'https://yolk-synthetic-bucket.synthetic-account.r2.example.test/'
      )

      expect(
        yield* suiteFailures(withFixture(presignId, answering({ uploadUrl: virtualHosted })))
      ).toEqual([])
    })
  )

  for (const [caseId] of caseIds) {
    it.effect(`dropping the last fixture of ${caseId} fails exactly that case`, () =>
      Effect.gen(function* () {
        const testCase =
          r2ConformanceCases.find(candidate => candidate.id === caseId) ?? expect.fail(caseId)

        const dropped = testCase.fixtures.at(-1)

        const failures = yield* suiteFailures(
          r2ConformanceFixtures.filter(fixture => fixture.id !== dropped)
        )

        expect(failures.map(failure => failure.id)).toEqual([caseId])
      })
    )
  }

  for (const seed of ['endpoint', 'bucket', 'objectKey', 'runId'] as const) {
    it.effect(`fails with a precondition before any port call without ${seed}`, () =>
      Effect.gen(function* () {
        const { [seed]: _dropped, ...seeds } = r2ConformanceFixtureSeeds
        const replays = new Map<string, R2Replay>()

        const casesBySeed = {
          endpoint: r2PresignUploadUrlCase,
          bucket: r2PresignUploadUrlCase,
          objectKey: r2ConformanceCases[1] ?? expect.fail('no get case'),
          runId: r2CreateIfAbsentCase
        }

        const testCase = casesBySeed[seed]

        const report = yield* runConformance([testCase], {
          target: everyCase,
          now,
          layer: replayLayer(replays, r2ConformanceFixtures, seeds)
        })

        expect(report.results[0]?.failure).toEqual(
          mismatch(`precondition: R2ConformanceConfig.${seed} is not configured`)
        )
        expect(replays.get(testCase.id)?.ledger.entries()).toEqual([])
      })
    )
  }
})

// Irreversible-write classification: a definitive rejection writes nothing, an ambiguous put is
// reported with the exact bucket and key, and nothing is ever deleted (the connector cannot).

const createTarget =
  'object yolk-conformance/run-synthetic/create-if-absent.txt in bucket yolk-synthetic-bucket'

const createId = 'r2.objects.create-if-absent.create.synthetic'

const runCase = (
  testCase: R2ConformanceCase,
  fixtures: ReadonlyArray<PortFixture>,
  seeds: R2ConformanceSeeds = r2ConformanceFixtureSeeds
) =>
  Effect.gen(function* () {
    const replays = new Map<string, R2Replay>()

    const report = yield* runConformance([testCase], {
      target: everyCase,
      now,
      layer: replayLayer(replays, fixtures, seeds)
    })

    return {
      failure: report.results[0]?.failure,
      calls: (replays.get(testCase.id)?.ledger.entries() ?? []).map(
        entry => `${entry.method} ${entry.outcome}`
      )
    }
  })

describe('R2 conformance write classification', () => {
  for (const code of ['upstream_failed', 'transport_failed', 'rate_limited']) {
    it.effect(`reports an ambiguous ${code} create with the exact bucket and key`, () =>
      Effect.gen(function* () {
        const { failure, calls } = yield* runCase(
          r2CreateIfAbsentCase,
          withFixture(createId, failing(code))
        )

        expect(failure).toEqual({
          kind: 'failure',
          tag: 'R2ConformanceActionFailed',
          message: `createR2Object failed: ${code}; write outcome unknown: ${createTarget} may have been written; check it by hand (the connector cannot delete it)`
        })
        expect(calls).toEqual(['put matched'])
      })
    )
  }

  it.effect('reports an unanswered create (not emulated) as ambiguous', () =>
    Effect.gen(function* () {
      const { failure, calls } = yield* runCase(
        r2CreateIfAbsentCase,
        r2ConformanceFixtures.filter(fixture => fixture.id !== createId)
      )

      expect(failure?.message).toBe(
        `createR2Object failed: transport_failed; write outcome unknown: ${createTarget} may have been written; check it by hand (the connector cannot delete it)`
      )
      expect(calls).toEqual(['put unmatched'])
    })
  )

  it.effect(
    'a conflict on the first create is definitive: nothing written, nothing more sent',
    () =>
      Effect.gen(function* () {
        const { failure, calls } = yield* runCase(
          r2CreateIfAbsentCase,
          withFixture(createId, failing('conflict'))
        )

        expect(failure).toEqual({
          kind: 'failure',
          tag: 'R2ConformanceActionFailed',
          message: 'createR2Object failed: conflict'
        })
        expect(calls).toEqual(['put matched'])
      })
  )

  it.effect('a refusal before the port is definitive and sends nothing', () =>
    Effect.gen(function* () {
      // The connector's own bucket check refuses before the port is called.
      const { failure, calls } = yield* runCase(r2CreateIfAbsentCase, r2ConformanceFixtures, {
        ...r2ConformanceFixtureSeeds,
        bucket: 'Not_A_Bucket'
      })

      expect(failure).toEqual({
        kind: 'failure',
        tag: 'R2ConformanceActionFailed',
        message: 'createR2Object failed: invalid_input'
      })
      expect(calls).toEqual([])
    })
  )

  it.effect('a host put that dies when invoked still reached the port: ambiguous', () =>
    Effect.gen(function* () {
      const replay = makeR2ReplayBackend(createFixtures)
      const ports = r2PortsFromBackend(replay.backend)

      const exit = yield* r2CreateIfAbsentCase.run.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(R2Storage.R2Presigner, R2Storage.R2Presigner.of(ports.presigner)),
            Layer.succeed(
              R2Storage.R2ObjectClient,
              R2Storage.R2ObjectClient.of({
                get: ports.objects.get,
                put: () => {
                  throw new Error('host adapter bug')
                }
              })
            ),
            credentialLayer,
            Layer.succeed(R2ConformanceConfig, r2ConformanceFixtureSeeds)
          )
        ),
        Effect.exit
      )

      if (Exit.isSuccess(exit)) {
        return expect.fail('expected the create case to fail')
      }

      expect(Cause.squash(exit.cause)).toMatchObject({
        _tag: 'R2ConformanceActionFailed',
        message: `createR2Object failed: defect; write outcome unknown: ${createTarget} may have been written; check it by hand (the connector cannot delete it)`
      })
    })
  )

  it('requires the run- prefix in every run id and valid bucket seeds', () => {
    const decode = Schema.decodeUnknownOption(R2ConformanceSeedsSchema)

    expect(Option.isSome(decode(r2ConformanceFixtureSeeds))).toBe(true)
    expect(Option.isNone(decode({ runId: 'mine-0000beef' }))).toBe(true)
    expect(Option.isNone(decode({ endpoint: 'http://insecure.example.test' }))).toBe(true)
    expect(Option.isNone(decode({ endpoint: 'https://user:pass@host.example.test' }))).toBe(true)
    expect(Option.isNone(decode({ bucket: 'Not_A_Bucket' }))).toBe(true)
    expect(Option.isNone(decode({ objectKey: 'fixtures/../secret' }))).toBe(true)
  })
})

// Presigned URLs carry their credential in the query string: committed fixtures hold only the
// synthetic placeholders, anything else is refused, and a recording can be scrubbed first.

describe('R2 presigned URL guard', () => {
  const liveSignature = 'a1'.repeat(32)

  const liveUrl = (() => {
    const url = new URL(presignedUrl)

    url.searchParams.set('X-Amz-Signature', liveSignature)
    url.searchParams.set(
      'X-Amz-Credential',
      '0123456789abcdef0123456789abcdef/20260930/auto/s3/aws4_request'
    )
    url.searchParams.set('X-Amz-Security-Token', 'synthetic-session-token-value')

    return url.toString()
  })()

  const livePresign = answering({ uploadUrl: liveUrl })(fixtureById(presignId))

  it('refuses a live signature, credential, or session token in the shared and the R2 scan', () => {
    expect(scanPortFixtureForSecrets(livePresign)).toEqual([
      { kind: 'credential_query_param', location: 'response.uploadUrl' }
    ])
    expect(findR2PortFixtureSecrets(livePresign)).toEqual([
      'response.uploadUrl: a live X-Amz-Credential',
      'response.uploadUrl: a live X-Amz-Signature',
      'response.uploadUrl: X-Amz-Security-Token'
    ])

    for (const [name, value, finding] of [
      ['X-Amz-Signature', liveSignature, 'a live X-Amz-Signature'],
      [
        'X-Amz-Credential',
        '0123456789abcdef0123456789abcdef/20260930/auto/s3/aws4_request',
        'a live X-Amz-Credential'
      ],
      // A shared-marker value that is not the exact R2 placeholder is still refused.
      ['X-Amz-Signature', 'yolk-synthetic-other', 'a live X-Amz-Signature']
    ] as const) {
      const fixture = answering({ uploadUrl: withParam(name, value) })(fixtureById(presignId))

      expect(findR2PortFixtureSecrets(fixture)).toEqual([`response.uploadUrl: ${finding}`])
      expect(JSON.stringify(findR2PortFixtureSecrets(fixture))).not.toContain(value)
    }
  })

  const missing = fixtureById('r2.objects.get-missing-not-found.get.synthetic')

  const failingWith = (message: string): PortFixture => ({
    id: missing.id,
    port: missing.port,
    method: missing.method,
    request: missing.request,
    failure: { kind: 'error', code: 'not_found', message }
  })

  it('finds escaped and percent-encoded parameters the shared scan cannot see', () => {
    // An S3 XML error echoing the request URL, `&` escaped as `&amp;`.
    const escaped = failingWith(
      '<Error><Code>AccessDenied</Code><Url>https://synthetic-account.r2.example.test/b/k?X-Amz-Algorithm=AWS4-HMAC-SHA256&amp;X-Amz-Credential=0123456789abcdef0123456789abcdef%2F20260930%2Fauto%2Fs3%2Faws4_request&amp;X-Amz-Date=20260930T120000Z</Url></Error>'
    )

    expect(scanPortFixtureForSecrets(escaped)).toEqual([])
    expect(findR2PortFixtureSecrets(escaped)).toEqual(['failure.message: a live X-Amz-Credential'])

    const encoded = failingWith(
      `redirected from ${encodeURIComponent(withParam('X-Amz-Signature', liveSignature))}`
    )

    expect(scanPortFixtureForSecrets(encoded)).toEqual([])
    // Fully encoded, the whole rest of the URL is one raw value (its `&` is `%26`), so even the
    // placeholder credential before the live signature is refused: fail closed.
    expect(findR2PortFixtureSecrets(encoded)).toEqual([
      'failure.message: a live X-Amz-Credential',
      'failure.message: a live X-Amz-Signature'
    ])
  })

  it('refuses placeholders with anything appended, in both scans', () => {
    const encodedCredential = encodeURIComponent(r2ConformanceSyntheticCredential)

    for (const uploadUrl of [
      withParam('X-Amz-Signature', `${r2ConformanceSyntheticSignature}0123abcdef0123abcdef`),
      presignedUrl.replace(encodedCredential, `${encodedCredential}%2Fextra`),
      presignedUrl.replace(
        `X-Amz-Signature=${r2ConformanceSyntheticSignature}`,
        `X-Amz-Signature=${encodeURIComponent(r2ConformanceSyntheticSignature)}%2D0123abcd`
      )
    ]) {
      const fixture = answering({ uploadUrl })(fixtureById(presignId))

      expect(scanPortFixtureForSecrets(fixture), uploadUrl).toEqual([
        { kind: 'credential_query_param', location: 'response.uploadUrl' }
      ])
      expect(findR2PortFixtureSecrets(fixture), uploadUrl).toHaveLength(1)
    }
  })

  /** Both promotion scans on one presign answer, as a person promoting a recording runs them. */
  const bothScans = (uploadUrl: string) => {
    const fixture = answering({ uploadUrl })(fixtureById(presignId))

    return {
      shared: scanPortFixtureForSecrets(fixture).map(issue => issue.location),
      r2: findR2PortFixtureSecrets(fixture)
    }
  }

  const signatureParam = `X-Amz-Signature=${r2ConformanceSyntheticSignature}`

  it("refuses a placeholder followed by a raw `?` or `'`; `>` ends the value", () => {
    expect(bothScans(presignedUrl.replace(signatureParam, `${signatureParam}?0123abcdef`))).toEqual(
      {
        shared: ['response.uploadUrl'],
        r2: ['response.uploadUrl: a live X-Amz-Signature']
      }
    )

    // `'` is legal raw inside a query value (RFC 3986), so it continues the value.
    expect(bothScans(presignedUrl.replace(signatureParam, `${signatureParam}'x`))).toEqual({
      shared: ['response.uploadUrl'],
      r2: ['response.uploadUrl: a live X-Amz-Signature']
    })
    expect(bothScans(presignedUrl.replace(signatureParam, `${signatureParam}>x`))).toEqual({
      shared: [],
      r2: []
    })
  })

  it('refuses an encoded name whose placeholder value carries an encoded delimiter', () => {
    const encodedName = 'X%2DAmz%2DSignature'

    for (const suffix of ['%3F0123456789abcdef', '%260123456789abcdef', '%23x', '%20x']) {
      const uploadUrl = `https://storage.example.test/b/k?${encodedName}=${r2ConformanceSyntheticSignature}${suffix}`

      // The shared scan cannot read an encoded name; the R2 guard reads the whole raw value.
      expect(bothScans(uploadUrl), suffix).toEqual({
        shared: [],
        r2: ['response.uploadUrl: a live X-Amz-Signature']
      })
    }

    // Fail closed: an encoded name is never canonical, even with the exact placeholder.
    expect(
      bothScans(
        `https://storage.example.test/b/k?${encodedName}=${r2ConformanceSyntheticSignature}&x-id=PutObject`
      )
    ).toEqual({ shared: [], r2: ['response.uploadUrl: a live X-Amz-Signature'] })
  })

  it('refuses a doubly encoded live URL, and a fully encoded synthetic one', () => {
    const live = withParam('X-Amz-Signature', liveSignature)

    for (const text of [
      `from ${encodeURIComponent(encodeURIComponent(live))}`,
      `from ${encodeURIComponent(encodeURIComponent(encodeURIComponent(live)))}`
    ]) {
      expect(findR2PortFixtureSecrets(failingWith(text))).toEqual([
        'failure.message: a live X-Amz-Credential',
        'failure.message: a live X-Amz-Signature'
      ])
    }

    expect(bothScans(encodeURIComponent(presignedUrl))).toEqual({
      shared: [],
      r2: [
        'response.uploadUrl: a live X-Amz-Credential',
        'response.uploadUrl: a live X-Amz-Signature'
      ]
    })
  })

  it('refuses encoded letters in any credential name, with any value, the exact one included', () => {
    const cases = [
      ['%58-Amz-Signature', 'a live X-Amz-Signature'],
      ['%2558-Amz-Signature', 'a live X-Amz-Signature'],
      ['%78-amz-signature', 'a live X-Amz-Signature'],
      ['X-%41mz-Signature', 'a live X-Amz-Signature'],
      ['X-Amz-%43redential', 'a live X-Amz-Credential'],
      ['X-Amz-Cr%2545dential', 'a live X-Amz-Credential'],
      ['X-Amz-%53ecurity-Token', 'X-Amz-Security-Token'],
      ['X-Amz-Security-%54oken', 'X-Amz-Security-Token']
    ] as const

    for (const [name, finding] of cases) {
      const exact = name.toLowerCase().includes('credential')
        ? encodeURIComponent(r2ConformanceSyntheticCredential)
        : r2ConformanceSyntheticSignature

      for (const value of [
        exact,
        `${r2ConformanceSyntheticSignature}%3F0123abcdef`,
        liveSignature
      ]) {
        const uploadUrl = `https://storage.example.test/b/k?${name}=${value}&x-id=PutObject`

        expect(
          findR2PortFixtureSecrets(answering({ uploadUrl })(fixtureById(presignId))),
          `${name}=${value}`
        ).toEqual([`response.uploadUrl: ${finding}`])
      }
    }
  })

  it('accepts a mixed-case raw name with the exact placeholder, and refuses one in prose', () => {
    const mixed = presignedUrl
      .replace('X-Amz-Signature=', 'x-AMZ-signature=')
      .replace('X-Amz-Credential=', 'X-AMZ-CREDENTIAL=')

    expect(bothScans(mixed)).toEqual({ shared: [], r2: [] })
    expect(bothScans(`${presignedUrl}&other=1`)).toEqual({ shared: [], r2: [] })
    // The raw (unencoded) credential spelling is not what the fixtures or scrubber write: refused.
    expect(
      bothScans(
        presignedUrl.replace(
          encodeURIComponent(r2ConformanceSyntheticCredential),
          r2ConformanceSyntheticCredential
        )
      ).r2
    ).toEqual(['response.uploadUrl: a live X-Amz-Credential'])
    expect(
      findR2PortFixtureSecrets({
        ...fixtureById(presignId),
        note: 'The URL carries an X-Amz-Signature parameter.'
      })
    ).toEqual(['note: a live X-Amz-Signature'])
    expect(
      findR2PortFixtureSecrets({
        ...fixtureById(presignId),
        request: { 'X-Amz-Security-Token': null }
      })
    ).toEqual(['request.X-Amz-Security-Token: X-Amz-Security-Token'])
  })

  it('refuses a JSON-escaped live parameter', () => {
    expect(
      findR2PortFixtureSecrets(
        failingWith(
          `{"url":"https://h.example.test/b/k?x=1\\u0026X-Amz-Signature=${liveSignature}"}`
        )
      )
    ).toEqual(['failure.message: a live X-Amz-Signature'])
  })

  it('accepts a clean placeholder followed by another parameter, and refuses a later live one', () => {
    expect(bothScans(`${presignedUrl}&other=1`)).toEqual({ shared: [], r2: [] })
    expect(bothScans(`${presignedUrl}?X-Amz-Signature=${liveSignature}`)).toEqual({
      shared: ['response.uploadUrl'],
      r2: ['response.uploadUrl: a live X-Amz-Signature']
    })
  })

  it('refuses a live URL that follows the synthetic one in the same string', () => {
    const twoUrls = failingWith(
      `PUT ${presignedUrl} failed; retried /yolk-synthetic-bucket/k?X-Amz-Signature=${liveSignature}`
    )

    expect(scanPortFixtureForSecrets(twoUrls)).toEqual([
      { kind: 'credential_query_param', location: 'failure.message' }
    ])
    expect(findR2PortFixtureSecrets(twoUrls)).toEqual(['failure.message: a live X-Amz-Signature'])
  })

  it('refuses the placeholders under another parameter, and a look-alike password', () => {
    for (const query of [
      `token=${r2ConformanceSyntheticSignature}`,
      `X-Amz-Security-Token=${r2ConformanceSyntheticSignature}`,
      'password=yolk-synthetic-Hunter2!'
    ]) {
      const fixture = answering({ uploadUrl: `${presignedUrl}&${query}` })(fixtureById(presignId))

      expect(scanPortFixtureForSecrets(fixture), query).toEqual([
        { kind: 'credential_query_param', location: 'response.uploadUrl' }
      ])
    }
  })

  it('leaves credential fields to the shared scan and redaction', () => {
    const withKeys: PortFixture = {
      ...fixtureById(presignId),
      request: { accessKeyId: 'live-key-id', secretAccessKey: 'live-secret', sessionToken: 'x' }
    }

    expect(scanPortFixtureForSecrets(withKeys)).toEqual([
      { kind: 'credential_field', location: 'request.accessKeyId' },
      { kind: 'credential_field', location: 'request.secretAccessKey' },
      { kind: 'credential_field', location: 'request.sessionToken' }
    ])
    expect(scrubR2PortFixture(withKeys).request).toEqual({})
  })

  it.effect('scrubs a live presigned URL to the placeholders, and the case still passes', () =>
    Effect.gen(function* () {
      const scrubbed = scrubR2PortFixture(livePresign)

      expect(findR2PortFixtureSecrets(scrubbed)).toEqual([])
      expect(scanPortFixtureForSecrets(scrubbed)).toEqual([])
      expect(JSON.stringify(scrubbed)).not.toContain(liveSignature)
      expect(JSON.stringify(scrubbed)).not.toContain('0123456789abcdef0123456789abcdef')

      const url = new URL(scrubR2PresignedUrl(liveUrl))

      expect(url.searchParams.get('X-Amz-Signature')).toBe(r2ConformanceSyntheticSignature)
      expect(url.searchParams.get('X-Amz-Credential')).toBe(r2ConformanceSyntheticCredential)
      expect(url.searchParams.has('X-Amz-Security-Token')).toBe(false)

      expect(yield* suiteFailures(withFixture(presignId, () => scrubbed))).toEqual([])
    })
  )

  it('scrubs presigned URLs embedded in failure messages and notes, but not escaped ones', () => {
    const embedded = scrubR2PortFixture({
      ...failingWith(`redirected to ${liveUrl} (then failed)`),
      note: `recorded from ${liveUrl}`
    })

    expect(findR2PortFixtureSecrets(embedded)).toEqual([])
    expect(scanPortFixtureForSecrets(embedded)).toEqual([])
    expect(embedded.failure?.message).toMatch(/^redirected to https:\/\/.* \(then failed\)$/)

    // Percent-encoded URLs are left alone: both scans must be rerun after scrubbing.
    const encoded = scrubR2PortFixture(failingWith(`from ${encodeURIComponent(liveUrl)}`))

    expect(findR2PortFixtureSecrets(encoded)).not.toEqual([])
  })

  it('leaves text without presigned-URL parameters unchanged', () => {
    expect(scrubR2PresignedUrl('https://files.example.test/a.txt')).toBe(
      'https://files.example.test/a.txt'
    )
    expect(scrubR2PresignedUrl('not a url')).toBe('not a url')
  })

  it.effect('the bridge fails closed on backend answers of the wrong shape', () =>
    Effect.gen(function* () {
      const ports = r2PortsFromBackend({ call: () => ({ response: { unexpected: true } }) })

      const presigned = yield* ports.presigner
        .presignPutObject(
          R2Storage.R2PresignInput.make({
            endpoint: 'https://synthetic-account.r2.example.test',
            accessKeyId: syntheticAccessKey,
            secretAccessKey: syntheticSecret,
            bucket: 'yolk-synthetic-bucket',
            key: 'k',
            contentType: 'text/plain'
          })
        )
        .pipe(Effect.flip)

      expect(presigned.cause).toBe('validation_failed')

      const got = yield* ports.objects
        .get({
          integration: r2ConformanceIntegration(
            'https://synthetic-account.r2.example.test',
            'yolk-synthetic-bucket'
          ),
          bucket: 'yolk-synthetic-bucket',
          key: 'k',
          maxBytes: 1
        })
        .pipe(Effect.flip)

      expect(got.code).toBe('invalid_metadata')
    })
  )
})

// Interruption: a put in flight completes (it is masked), an ambiguous put answered meanwhile
// reaches the ConformanceCleanupReporter, and the run stops: no later case starts.

const capturingReporter = Effect.gen(function* () {
  const warnings = yield* Ref.make<ReadonlyArray<string>>([])

  return {
    warnings,
    reporter: { warn: (message: string) => Ref.update(warnings, list => [...list, message]) }
  }
})

/** Replay ports whose first put waits for `release` after signalling `sent`. */
const holdingPorts = (fixtures: ReadonlyArray<PortFixture>) =>
  Effect.gen(function* () {
    const sent = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const replay = makeR2ReplayBackend(fixtures)
    const ports = r2PortsFromBackend(replay.backend)
    const puts = yield* Ref.make(0)

    const layer = Layer.mergeAll(
      Layer.succeed(R2Storage.R2Presigner, R2Storage.R2Presigner.of(ports.presigner)),
      Layer.succeed(
        R2Storage.R2ObjectClient,
        R2Storage.R2ObjectClient.of({
          get: ports.objects.get,
          put: request =>
            Ref.getAndUpdate(puts, count => count + 1).pipe(
              Effect.flatMap(count =>
                count === 0
                  ? Deferred.succeed(sent, undefined).pipe(
                      Effect.andThen(Deferred.await(release)),
                      Effect.andThen(ports.objects.put(request))
                    )
                  : ports.objects.put(request)
              )
            )
        })
      ),
      credentialLayer,
      Layer.succeed(R2ConformanceConfig, r2ConformanceFixtureSeeds)
    )

    return { sent, release, layer, replay }
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

const sentinelCase = (ran: Ref.Ref<boolean>) =>
  defineConformanceCase({
    id: 'test.sentinel.after-interrupted-case',
    safety: 'read',
    docs: 'Synthetic sentinel: records whether it ran.',
    wire: 'Runs only if the run was not stopped.',
    fixtures: [],
    run: Ref.set(ran, true)
  })

const createFixtures = fixturesFor(r2CreateIfAbsentCase)

describe('R2 conformance interruption', () => {
  it.effect('finishes a masked put in flight, then runs no further port call', () =>
    Effect.gen(function* () {
      const { sent, release, layer, replay } = yield* holdingPorts(createFixtures)

      const fiber = yield* r2CreateIfAbsentCase.run.pipe(Effect.provide(layer), Effect.forkChild)
      const exit = yield* interruptAfter(fiber, sent, release)

      expect(Exit.hasInterrupts(exit)).toBe(true)
      expect(replay.ledger.entries().map(entry => entry.fixtureId)).toEqual([createId])
    })
  )

  it.effect('reports an ambiguous put answered while the case is being interrupted', () =>
    Effect.gen(function* () {
      const { warnings, reporter } = yield* capturingReporter

      const { sent, release, layer } = yield* holdingPorts(
        withFixture(createId, failing('upstream_failed')).filter(fixture =>
          r2CreateIfAbsentCase.fixtures.includes(fixture.id)
        )
      )

      const fiber = yield* r2CreateIfAbsentCase.run.pipe(
        Effect.provide(layer),
        Effect.provideService(ConformanceCleanupReporter, reporter),
        Effect.forkChild
      )

      yield* interruptAfter(fiber, sent, release)

      expect(yield* Ref.get(warnings)).toEqual([
        `createR2Object failed: upstream_failed; write outcome unknown: ${createTarget} may have been written; check it by hand (the connector cannot delete it)`
      ])
    })
  )

  it.effect(
    'reports nothing extra when an uninterrupted put is ambiguous (the report has it)',
    () =>
      Effect.gen(function* () {
        const { warnings, reporter } = yield* capturingReporter

        const exit = yield* r2CreateIfAbsentCase.run.pipe(
          Effect.provide(
            replayLayer(
              new Map(),
              withFixture(createId, failing('upstream_failed'))
            )(r2CreateIfAbsentCase)
          ),
          Effect.provideService(ConformanceCleanupReporter, reporter),
          Effect.exit
        )

        expect(Exit.isFailure(exit)).toBe(true)
        expect(yield* Ref.get(warnings)).toEqual([])
      })
  )

  it.effect('stops the whole run when interrupted during an ambiguous put', () =>
    Effect.gen(function* () {
      const sentinelRan = yield* Ref.make(false)
      const { warnings, reporter } = yield* capturingReporter

      const { sent, release, layer } = yield* holdingPorts(
        withFixture(createId, failing('upstream_failed')).filter(fixture =>
          r2CreateIfAbsentCase.fixtures.includes(fixture.id)
        )
      )

      const fiber = yield* runConformance([r2CreateIfAbsentCase, sentinelCase(sentinelRan)], {
        target: everyCase,
        now,
        layer: () => layer
      }).pipe(Effect.provideService(ConformanceCleanupReporter, reporter), Effect.forkChild)

      const exit = yield* interruptAfter(fiber, sent, release)

      expect(yield* Ref.get(sentinelRan)).toBe(false)

      if (Exit.isSuccess(exit)) {
        return expect.fail('expected the interrupted run to fail')
      }

      expect(Cause.hasInterrupts(exit.cause)).toBe(false)
      expect(Cause.squash(exit.cause)).toMatchObject({ _tag: 'R2ConformanceActionFailed' })
      expect(yield* Ref.get(warnings)).toHaveLength(1)
    })
  )

  it.effect('ends interrupt-only, without a later case, when the put in flight succeeds', () =>
    Effect.gen(function* () {
      const sentinelRan = yield* Ref.make(false)
      const { warnings, reporter } = yield* capturingReporter
      const { sent, release, layer } = yield* holdingPorts(createFixtures)

      const fiber = yield* runConformance([r2CreateIfAbsentCase, sentinelCase(sentinelRan)], {
        target: everyCase,
        now,
        layer: () => layer
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
