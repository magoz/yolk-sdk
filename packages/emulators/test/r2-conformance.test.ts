import { describe, expect, it } from '@effect/vitest'
import { Effect, Layer, Option } from 'effect'
import * as Schema from 'effect/Schema'
import {
  findR2PortFixtureSecrets,
  r2ConformanceCases,
  r2ConformanceFixtureSeeds,
  r2ConformanceFixtures,
  r2ConformanceSyntheticAccessKeyId,
  r2PortsLayerFromBackend,
  R2ConformanceConfig,
  type R2ConformanceCase
} from '@yolk-sdk/connectors/r2-storage/conformance'
import { scanPortFixtureForSecrets, type PortFixture } from '@yolk-sdk/conformance/fixture'
import {
  conformanceReportFailed,
  formatConformanceReport,
  runConformance
} from '@yolk-sdk/conformance/runner'
import { ApiKeyCredential } from '@yolk-sdk/connectors'
import { staticCredentialResolverLayer } from '@yolk-sdk/connectors/conformance'
import * as R2Storage from '@yolk-sdk/connectors/r2-storage'
import {
  makeR2Emulator,
  r2EmulatorDefaultSeed,
  r2EmulatorFixtures,
  r2EmulatorRoutes,
  type R2Emulator,
  type R2EmulatorFault,
  type R2EmulatorObject,
  type R2EmulatorSeed
} from '../src/r2.ts'

const now = new Date('2026-09-30T12:00:00.000Z')

/** The presign case needs the uploadUrl to name the access key id the connector passed. */
const syntheticAccessKey = r2ConformanceSyntheticAccessKeyId

const syntheticSecret = 'synthetic-r2-secret-access-key'

const credentialLayer = staticCredentialResolverLayer({
  [R2Storage.r2AccessKeyIdSlotId]: ApiKeyCredential.make({ key: syntheticAccessKey }),
  [R2Storage.r2SecretAccessKeySlotId]: ApiKeyCredential.make({ key: syntheticSecret })
})

/** The emulator is captured, so every case of one run shares its bucket. */
const emulatorLayer = (emulator: R2Emulator) => () =>
  Layer.mergeAll(
    r2PortsLayerFromBackend(emulator),
    credentialLayer,
    Layer.succeed(R2ConformanceConfig, r2ConformanceFixtureSeeds)
  )

const runOn = (emulator: R2Emulator, cases: ReadonlyArray<R2ConformanceCase>) =>
  runConformance(cases, {
    target: { kind: 'in-process' },
    now,
    fixtures: r2ConformanceFixtures,
    layer: emulatorLayer(emulator)
  })

const fixtureById = (id: string): PortFixture =>
  r2ConformanceFixtures.find(fixture => fixture.id === id) ?? expect.fail(`no fixture ${id}`)

const decodeObject = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Json))

const decodeString = Schema.decodeUnknownOption(Schema.String)

const stringAt = (value: unknown, key: string): string =>
  Option.getOrElse(
    Option.flatMap(decodeObject(value), object => decodeString(object[key])),
    () => expect.fail(`no string ${key}`)
  )

/** The object a put fixture stores: key and bytes from the request, etag from the answer. */
const storedBy = (putId: string, etagId: string = putId): R2EmulatorObject => {
  const put = fixtureById(putId)
  const answer = fixtureById(etagId)

  return {
    key: stringAt(put.request, 'key'),
    etag: stringAt(answer.response, 'etag'),
    bodyBase64: stringAt(put.request, 'bodyBase64')
  }
}

const createdObject = storedBy('r2.objects.create-if-absent.create.synthetic')

const originalUpdateObject = storedBy('r2.objects.update-if-match.create.synthetic')

const updatedObject = storedBy(
  'r2.objects.update-if-match.current.synthetic',
  'r2.objects.update-if-match.current.synthetic'
)

const createCaseId = 'r2.objects.create-if-absent'

const updateCaseId = 'r2.objects.update-if-match'

/** The seed plus `extra` objects (the connector cannot delete R2 objects, so writes stay). */
const seedWith = (...extra: ReadonlyArray<R2EmulatorObject>): R2EmulatorSeed => ({
  buckets: r2EmulatorDefaultSeed.buckets.map(bucket => ({
    ...bucket,
    objects: [...bucket.objects, ...extra]
  }))
})

/**
 * The documented state after the passed cases: each write case leaves its object (R2 objects
 * cannot be deleted through the connector); every read case leaves the seed.
 */
const documentedStateAfter = (caseIds: ReadonlyArray<string>): R2EmulatorSeed =>
  seedWith(
    ...(caseIds.includes(createCaseId) ? [createdObject] : []),
    ...(caseIds.includes(updateCaseId) ? [updatedObject] : [])
  )

const caseById = (id: string): R2ConformanceCase =>
  r2ConformanceCases.find(testCase => testCase.id === id) ?? expect.fail(`no case ${id}`)

/** Every text a reader of the emulator can see, besides the port answers. */
const everythingObservable = (emulator: R2Emulator, replies: ReadonlyArray<unknown> = []) =>
  JSON.stringify([
    emulator.ledger.entries(),
    emulator.state(),
    emulator.seed(),
    emulator.coverage(),
    emulator.faults.list(),
    replies
  ])

/** Each ledgered request, judged like a committed fixture by both port scans. */
const ledgerFindings = (emulator: R2Emulator) =>
  emulator.ledger.entries().flatMap(entry => {
    const asFixture: PortFixture = {
      id: `ledger.${entry.seq}`,
      port: entry.port,
      method: entry.method,
      request: entry.request,
      response: null
    }

    return [
      ...scanPortFixtureForSecrets(asFixture).map(issue => issue.location),
      ...findR2PortFixtureSecrets(asFixture)
    ]
  })

describe('R2 emulator cross-check (in-process, through the real port seam)', () => {
  it.effect('all six cases pass in sequence on one emulator, which keeps only their objects', () =>
    Effect.gen(function* () {
      const emulator = makeR2Emulator()
      const report = yield* runOn(emulator, r2ConformanceCases)

      expect(conformanceReportFailed(report), formatConformanceReport(report)).toBe(false)
      expect(report.summary).toEqual({ passed: 6, failed: 0, skipped: 0 })
      expect(emulator.state()).toEqual(
        documentedStateAfter(r2ConformanceCases.map(testCase => testCase.id))
      )

      // Every fixture answered exactly once, in case order, and nothing failed closed.
      expect(emulator.ledger.entries().map(entry => entry.fixtureId ?? entry.outcome)).toEqual(
        r2ConformanceFixtures.map(fixture => fixture.id)
      )
      expect(emulator.coverage()).toMatchObject({ notEmulatedCalls: 0, unusedFixtureIds: [] })
      expect(emulator.ledger.entries().every(entry => entry.evidence === 'unverified')).toBe(true)
    })
  )

  it.effect('each case alone passes, and only the write cases leave their object', () =>
    Effect.gen(function* () {
      for (const testCase of r2ConformanceCases) {
        const emulator = makeR2Emulator()
        const report = yield* runOn(emulator, [testCase])

        expect(report.summary, `${testCase.id}\n${formatConformanceReport(report)}`).toEqual({
          passed: 1,
          failed: 0,
          skipped: 0
        })
        expect(emulator.state(), testCase.id).toEqual(documentedStateAfter([testCase.id]))
        // One answered call per cited fixture. Identical requests (the seeded object's plain get)
        // may be answered by an equal fixture of another case: the first one unused.
        expect(
          emulator.ledger.entries().map(entry => entry.outcome),
          testCase.id
        ).toEqual(testCase.fixtures.map(() => 'answered'))
      }
    })
  )

  it.effect('a reused run id fails both write cases without writing, as the cases warn', () =>
    Effect.gen(function* () {
      const emulator = makeR2Emulator()

      yield* runOn(emulator, r2ConformanceCases)

      const after = emulator.state()

      emulator.ledger.clear()

      const again = yield* runOn(emulator, r2ConformanceCases)

      expect(
        again.results.filter(result => result.status === 'failed').map(result => result.id)
      ).toEqual([createCaseId, updateCaseId])
      expect(emulator.state()).toEqual(after)
      // The fresh-key creates are refused: the bucket already holds both keys.
      expect(
        emulator.ledger
          .entries()
          .filter(entry => entry.outcome === 'not-emulated')
          .map(entry => [entry.method, entry.reason])
      ).toEqual([
        ['put', 'state-conflict'],
        ['put', 'state-conflict']
      ])
    })
  )

  it.effect('the suite passes again after reset', () =>
    Effect.gen(function* () {
      const emulator = makeR2Emulator()

      yield* runOn(emulator, r2ConformanceCases)
      emulator.reset()

      expect(emulator.state()).toEqual(r2EmulatorDefaultSeed)
      expect((yield* runOn(emulator, r2ConformanceCases)).summary.failed).toBe(0)
    })
  )

  it.effect('a bucket without the seeded object fails the get cases closed', () =>
    Effect.gen(function* () {
      const emulator = makeR2Emulator({
        seed: { buckets: [{ name: 'yolk-synthetic-bucket', objects: [] }] }
      })

      const report = yield* runOn(emulator, [caseById('r2.objects.get-max-bytes')])

      expect(report.summary.failed).toBe(1)
      expect(emulator.ledger.entries()).toMatchObject([
        { method: 'get', outcome: 'not-emulated', reason: 'state-conflict' }
      ])
    })
  )
})

describe('R2 emulator credential guard (through the real port seam)', () => {
  it.effect('the access key id and secret never reach the ledger, state, coverage, or faults', () =>
    Effect.gen(function* () {
      const emulator = makeR2Emulator()

      emulator.faults.add({
        kind: 'failure',
        port: 'R2Presigner',
        method: 'presignPutObject',
        match: { key: 'never-requested' },
        failure: { kind: 'error', code: 'transport_failed', message: 'Synthetic drill.' }
      })

      const report = yield* runOn(emulator, r2ConformanceCases)

      expect(report.summary.failed).toBe(0)

      const observable = everythingObservable(emulator)

      expect(observable).not.toContain(syntheticAccessKey)
      expect(observable).not.toContain(syntheticSecret)
      expect(observable).not.toMatch(/accessKeyId|secretAccessKey|integration/)
      // Every ledgered request passes both port scans of the R2 conformance guard.
      expect(ledgerFindings(emulator)).toEqual([])
      // The presign request is recorded without credentials; the endpoint host is fixture data.
      expect(emulator.ledger.entries()[0]?.request).toEqual(
        fixtureById('r2.presign.put-upload-url.presign.synthetic').request
      )
    })
  )
})

const failure = { kind: 'error', code: 'transport_failed', message: 'Synthetic drill.' } as const

const keyOf = (fixtureId: string) => stringAt(fixtureById(fixtureId).request, 'key')

/** One fault per case that makes exactly that case fail. */
const drills: ReadonlyArray<readonly [string, R2EmulatorFault]> = [
  [
    'r2.presign.put-upload-url',
    { kind: 'failure', port: 'R2Presigner', method: 'presignPutObject', failure }
  ],
  [
    'r2.objects.get-max-bytes',
    {
      kind: 'failure',
      port: 'R2ObjectClient',
      method: 'get',
      match: { maxBytes: 43 },
      failure
    }
  ],
  [
    'r2.objects.get-expected-etag',
    {
      kind: 'failure',
      port: 'R2ObjectClient',
      method: 'get',
      match: { expectedEtag: '"00000000000000000000000000000000"' },
      failure
    }
  ],
  [
    'r2.objects.get-missing-not-found',
    {
      kind: 'failure',
      port: 'R2ObjectClient',
      method: 'get',
      match: { key: keyOf('r2.objects.get-missing-not-found.get.synthetic') },
      failure
    }
  ],
  [
    createCaseId,
    {
      kind: 'failure',
      port: 'R2ObjectClient',
      method: 'put',
      match: { key: createdObject.key },
      failure
    }
  ],
  [
    updateCaseId,
    {
      kind: 'failure',
      port: 'R2ObjectClient',
      method: 'put',
      match: { key: updatedObject.key, condition: { kind: 'etag' } },
      failure
    }
  ]
]

/** What each drilled case leaves: a faulted put writes nothing. */
const drilledState = (caseId: string, passed: ReadonlyArray<string>): R2EmulatorSeed =>
  caseId === updateCaseId
    ? seedWith(...(passed.includes(createCaseId) ? [createdObject] : []), originalUpdateObject)
    : documentedStateAfter(passed)

describe('R2 emulator drills', () => {
  it('cover every case exactly once', () => {
    expect(drills.map(([caseId]) => caseId)).toEqual(r2ConformanceCases.map(({ id }) => id))
  })

  it.effect('each drill fault fails exactly its targeted case and writes nothing', () =>
    Effect.gen(function* () {
      for (const [caseId, fault] of drills) {
        const emulator = makeR2Emulator()

        emulator.faults.add(fault)

        const report = yield* runOn(emulator, r2ConformanceCases)

        expect(
          report.results.filter(result => result.status === 'failed').map(result => result.id),
          `${caseId}\n${formatConformanceReport(report)}`
        ).toEqual([caseId])
        expect(
          emulator.ledger.entries().filter(entry => entry.outcome === 'fault').length,
          caseId
        ).toBe(1)
        expect(emulator.coverage().notEmulatedCalls, caseId).toBe(0)

        const passed = report.results
          .filter(result => result.status === 'passed')
          .map(result => result.id)

        expect(emulator.state(), caseId).toEqual(drilledState(caseId, passed))
      }
    })
  )

  it.effect('an ambiguous put names the exact bucket and key to check by hand', () =>
    Effect.gen(function* () {
      const emulator = makeR2Emulator()
      const [, fault] = drills.find(([caseId]) => caseId === createCaseId) ?? expect.fail('drill')

      emulator.faults.add(fault)

      const report = yield* runOn(emulator, [caseById(createCaseId)])

      expect(report.results[0]?.failure?.message).toContain(
        `write outcome unknown: object ${createdObject.key} in bucket yolk-synthetic-bucket`
      )
      expect(emulator.state()).toEqual(r2EmulatorDefaultSeed)
    })
  )
})

describe('R2 emulator fixture parity', () => {
  it('copies the connector R2 fixtures verbatim, byte for byte', () => {
    expect(r2EmulatorFixtures).toEqual(r2ConformanceFixtures)
    expect(JSON.stringify(r2EmulatorFixtures)).toBe(JSON.stringify(r2ConformanceFixtures))
  })

  it('replays every fixture in suite order with its complete answer, byte for byte', () => {
    const emulator = makeR2Emulator()

    for (const fixture of r2ConformanceFixtures) {
      const reply = emulator.call(fixture.port, fixture.method, fixture.request)

      expect(JSON.stringify(reply), fixture.id).toBe(
        JSON.stringify(
          fixture.failure === undefined
            ? { response: fixture.response }
            : { failure: fixture.failure }
        )
      )
    }

    expect(emulator.ledger.entries().map(entry => entry.fixtureId)).toEqual(
      r2ConformanceFixtures.map(fixture => fixture.id)
    )
  })

  it('manifests exactly the port methods the fixtures use, citing the cases that use them', () => {
    const fixtureRoutes = [
      ...new Set(r2EmulatorFixtures.map(fixture => `${fixture.port}.${fixture.method}`))
    ]

    expect(r2EmulatorRoutes.map(route => route.path)).toEqual(fixtureRoutes)

    for (const route of r2EmulatorRoutes) {
      expect(route).toMatchObject({ method: 'PORT', kind: 'connector', evidence: 'unverified' })
      expect(route.observedAt).toBeUndefined()

      const citing = r2ConformanceCases
        .filter(testCase =>
          testCase.fixtures.some(id =>
            r2ConformanceFixtures.some(
              fixture => fixture.id === id && `${fixture.port}.${fixture.method}` === route.path
            )
          )
        )
        .map(testCase => testCase.id)

      expect(route.caseIds, route.path).toEqual(citing)
    }

    expect(r2EmulatorRoutes.filter(route => route.write).map(route => route.path)).toEqual([
      'R2ObjectClient.put'
    ])
  })

  it('seeds the bucket and object the fixture seeds and get fixtures describe', () => {
    const [bucket] = r2EmulatorDefaultSeed.buckets
    const seeded = fixtureById('r2.objects.get-max-bytes.within-budget.synthetic')

    expect(r2EmulatorDefaultSeed.buckets).toHaveLength(1)
    expect(bucket?.name).toBe(r2ConformanceFixtureSeeds.bucket)
    expect(bucket?.objects).toEqual([
      {
        key: r2ConformanceFixtureSeeds.objectKey,
        etag: stringAt(seeded.response, 'etag'),
        bodyBase64: stringAt(seeded.response, 'bodyBase64')
      }
    ])
  })
})
