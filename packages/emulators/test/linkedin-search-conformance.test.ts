/**
 * Cross-checks: the LinkedIn search emulator must satisfy the same conformance cases the replayed
 * fixtures satisfy, through the REAL LinkedIn search connector actions (Exa people search, Enrich
 * Layer profile and email), both in-process and over loopback sockets (one per origin), each case
 * alone and all of them in sequence on one emulator; every case is a read, so each emulator ends
 * exactly at its seed; and each drill knob must make exactly its case fail. Tests may import SDK
 * packages; the emulator source never does.
 */
import { Effect, Layer } from 'effect'
import { FetchHttpClient, type HttpClient } from 'effect/unstable/http'
import { describe, expect, it } from '@effect/vitest'
import {
  formatConformanceReport,
  runConformance,
  type ConformanceReport,
  type ConformanceTarget
} from '@yolk-sdk/conformance/runner'
import {
  connectorHttpClientsFromEffectHttpClientLayer,
  staticCredentialResolverLayer
} from '@yolk-sdk/connectors/conformance'
import { enrichLayerApiBaseUrl, exaApiBaseUrl } from '@yolk-sdk/connectors/linkedin-search'
import {
  LinkedInSearchConformanceConfig,
  linkedInSearchConformanceCases,
  linkedInSearchConformanceCredentials,
  linkedInSearchConformanceFixtureSeeds
} from '@yolk-sdk/connectors/linkedin-search/conformance'
import {
  linkedInSearchEmulatorEnrichLayerOrigin,
  linkedInSearchEmulatorExaOrigin,
  makeLinkedInSearchEmulator,
  type LinkedInSearchEmulator,
  type LinkedInSearchEmulatorDrills,
  type LinkedInSearchEmulatorOptions,
  type LinkedInSearchLedgerEntry
} from '../src/linkedin-search.ts'
import { serveFetchHandler } from '../src/node.ts'
import { EmulatedHttpClient, EmulatorRoute, InProcessHttpClient } from '../src/router.ts'

const now = new Date('2026-10-01T12:00:00.000Z')

/** Synthetic keys the emulator accepts (never account data). */
const exaApiKey = 'synthetic-exa-emulator-key-0001'

const enrichLayerApiKey = 'synthetic-enrich-layer-emulator-key-0001'

/** The synthetic invalid keys the unauthorized cases send (the default seed rejects them). */
const rejectedKeys = [
  'yolk-conformance-invalid-exa-key',
  'yolk-conformance-invalid-enrich-layer-key'
]

const credentialLayer = staticCredentialResolverLayer(
  linkedInSearchConformanceCredentials({ exaApiKey, enrichLayerApiKey })
)

const portsOver = <E>(httpLayer: Layer.Layer<HttpClient.HttpClient, E>) =>
  Layer.mergeAll(
    connectorHttpClientsFromEffectHttpClientLayer.pipe(Layer.provide(httpLayer)),
    credentialLayer,
    Layer.succeed(LinkedInSearchConformanceConfig, linkedInSearchConformanceFixtureSeeds)
  )

const inProcessLayer = (emulator: LinkedInSearchEmulator) =>
  InProcessHttpClient.layer([
    EmulatorRoute.handler(linkedInSearchEmulatorExaOrigin, emulator.fetch),
    EmulatorRoute.handler(linkedInSearchEmulatorEnrichLayerOrigin, emulator.fetch)
  ])

/**
 * Real `FetchHttpClient` underneath; each recorded origin rewritten to its own server on
 * 127.0.0.1:0 serving the emulator's handler for that origin (the rewrite loses the origin, and
 * every route answers only on the origin its fixtures record).
 */
const emulatedLayer = (emulator: LinkedInSearchEmulator) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const exa = yield* serveFetchHandler(emulator.fetchOn(linkedInSearchEmulatorExaOrigin))

      const enrichLayer = yield* serveFetchHandler(
        emulator.fetchOn(linkedInSearchEmulatorEnrichLayerOrigin)
      )

      return EmulatedHttpClient.layer([
        EmulatorRoute.url(linkedInSearchEmulatorExaOrigin, exa.url),
        EmulatorRoute.url(linkedInSearchEmulatorEnrichLayerOrigin, enrichLayer.url)
      ]).pipe(Layer.provide(FetchHttpClient.layer))
    })
  )

type Emulators = ReadonlyMap<string, LinkedInSearchEmulator>

/** One fresh emulator per case (same seed), closed when the effect ends. */
const withEmulators = <A, E, R>(
  options: LinkedInSearchEmulatorOptions,
  use: (emulators: Emulators) => Effect.Effect<A, E, R>
) =>
  Effect.acquireUseRelease(
    Effect.promise(async () => {
      const emulators = new Map<string, LinkedInSearchEmulator>()

      for (const testCase of linkedInSearchConformanceCases) {
        emulators.set(testCase.id, await makeLinkedInSearchEmulator(options))
      }

      return emulators
    }),
    use,
    emulators =>
      Effect.promise(() => Promise.all([...emulators.values()].map(emulator => emulator.close())))
  )

const withEmulator = <A, E, R>(
  options: LinkedInSearchEmulatorOptions,
  use: (emulator: LinkedInSearchEmulator) => Effect.Effect<A, E, R>
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => makeLinkedInSearchEmulator(options)),
    use,
    emulator => Effect.promise(() => emulator.close())
  )

const emulatorFor = (emulators: Emulators, caseId: string): LinkedInSearchEmulator => {
  const emulator = emulators.get(caseId)

  if (emulator === undefined) {
    throw new Error(`no emulator for ${caseId}`)
  }

  return emulator
}

const runAll = <E>(
  emulators: Emulators,
  target: ConformanceTarget,
  transport: (emulator: LinkedInSearchEmulator) => Layer.Layer<HttpClient.HttpClient, E>
) =>
  runConformance(linkedInSearchConformanceCases, {
    target,
    now,
    layer: testCase => portsOver(transport(emulatorFor(emulators, testCase.id)))
  })

const caseCount = linkedInSearchConformanceCases.length

const expectAllPassed = (report: ConformanceReport) => {
  expect(report.summary, formatConformanceReport(report)).toEqual({
    passed: caseCount,
    failed: 0,
    skipped: 0
  })
}

const requests = (entries: ReadonlyArray<LinkedInSearchLedgerEntry>) =>
  entries.map(entry => `${entry.method} ${entry.route ?? entry.path} ${entry.status}`)

/** The ledger requests each case sends, in order, with the status the emulator answered. */
const expectedRequests: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
  ['linkedin-search.search.people-results', ['POST /search 200']],
  ['linkedin-search.search.num-results-limit', ['POST /search 200', 'POST /search 200']],
  ['linkedin-search.profile.get-profile', ['GET /api/v2/profile 200']],
  ['linkedin-search.email.lookup-answer', ['GET /api/v2/profile/email 200']],
  ['linkedin-search.errors.exa-unauthorized', ['POST /search 401']],
  [
    'linkedin-search.errors.enrich-layer-unauthorized',
    ['GET /api/v2/profile 401', 'GET /api/v2/profile/email 401']
  ],
  ['linkedin-search.errors.profile-not-found', ['GET /api/v2/profile 404']]
]

/** No key, accepted or rejected, ever reaches the ledger, the state, or a control-plane read. */
const expectNoKeys = async (emulator: LinkedInSearchEmulator) => {
  const reads = await Promise.all(
    ['ledger', 'state', 'coverage', 'faults'].map(route =>
      emulator
        .fetch(new Request(`${linkedInSearchEmulatorExaOrigin}/_emulate/${route}`))
        .then(response => response.text())
    )
  )

  const recorded = [
    JSON.stringify(emulator.ledger.entries()),
    JSON.stringify(emulator.snapshot()),
    ...reads
  ].join('\n')

  for (const key of [exaApiKey, enrichLayerApiKey, ...rejectedKeys]) {
    expect(recorded).not.toContain(key)
  }

  expect(recorded.toLowerCase()).not.toContain('bearer')
}

describe('the base URLs the connector calls are the emulated origins', () => {
  it('Exa and Enrich Layer', () => {
    expect(new URL(exaApiBaseUrl).origin).toBe(linkedInSearchEmulatorExaOrigin)
    expect(new URL(enrichLayerApiBaseUrl).origin).toBe(linkedInSearchEmulatorEnrichLayerOrigin)
  })
})

describe('cross-check A: in-process emulator through the real connector', () => {
  it.effect(
    'passes every LinkedIn search case; every case (a read) ends exactly at its seed',
    () =>
      withEmulators({}, emulators =>
        Effect.gen(function* () {
          const seeds = new Map(
            [...emulators].map(([id, emulator]) => [id, emulator.snapshot()] as const)
          )

          const report = yield* runAll(emulators, { kind: 'in-process' }, inProcessLayer)

          expectAllPassed(report)
          expect(linkedInSearchConformanceCases.every(testCase => testCase.safety === 'read')).toBe(
            true
          )

          for (const [id, expected] of expectedRequests) {
            const emulator = emulatorFor(emulators, id)

            expect(emulator.snapshot(), id).toEqual(seeds.get(id))
            expect(requests(emulator.ledger.entries()), id).toEqual(expected)
            // The error cases' refusals are the fixtures' 401 and 404, never not-emulated.
            expect(
              emulator.ledger.entries().every(entry => entry.notEmulated === undefined),
              id
            ).toBe(true)

            yield* Effect.promise(() => expectNoKeys(emulator))
          }

          expect(expectedRequests.map(([id]) => id)).toEqual(
            linkedInSearchConformanceCases.map(testCase => testCase.id)
          )
        })
      ),
    60_000
  )

  it.effect(
    'passes every case twice in sequence on ONE emulator, ending at the seed',
    () =>
      withEmulator({}, emulator =>
        Effect.gen(function* () {
          const seed = emulator.snapshot()

          const runOnce = runConformance(linkedInSearchConformanceCases, {
            target: { kind: 'in-process' },
            now,
            layer: () => portsOver(inProcessLayer(emulator))
          })

          expectAllPassed(yield* runOnce)
          expectAllPassed(yield* runOnce)

          const once = expectedRequests.flatMap(([, expected]) => expected)

          expect(requests(emulator.ledger.entries())).toEqual([...once, ...once])
          expect(emulator.ledger.entries().every(entry => entry.notEmulated === undefined)).toBe(
            true
          )
          expect(emulator.snapshot()).toEqual(seed)

          yield* Effect.promise(() => expectNoKeys(emulator))
        })
      ),
    60_000
  )
})

describe('cross-check B: emulated over loopback sockets', () => {
  it.effect(
    'passes every LinkedIn search case through FetchHttpClient and EmulatedHttpClient',
    () =>
      withEmulators({}, emulators =>
        Effect.gen(function* () {
          const seeds = new Map(
            [...emulators].map(([id, emulator]) => [id, emulator.snapshot()] as const)
          )

          const report = yield* runAll(emulators, { kind: 'emulated' }, emulatedLayer)

          expectAllPassed(report)
          expect(report.target).toEqual({ kind: 'emulated' })

          for (const [id, expected] of expectedRequests) {
            const emulator = emulatorFor(emulators, id)
            const entries = emulator.ledger.entries()

            expect(requests(entries), id).toEqual(expected)
            expect(
              entries.every(
                entry => entry.evidence === 'unverified' && entry.notEmulated === undefined
              ),
              id
            ).toBe(true)
            expect(emulator.snapshot(), id).toEqual(seeds.get(id))

            yield* Effect.promise(() => expectNoKeys(emulator))
          }
        })
      ),
    60_000
  )

  it.effect(
    'passes every case in sequence on ONE emulator over the sockets',
    () =>
      withEmulator({}, emulator =>
        Effect.gen(function* () {
          const seed = emulator.snapshot()

          const report = yield* runConformance(linkedInSearchConformanceCases, {
            target: { kind: 'emulated' },
            now,
            layer: () => portsOver(emulatedLayer(emulator))
          })

          expectAllPassed(report)
          expect(requests(emulator.ledger.entries())).toEqual(
            expectedRequests.flatMap(([, expected]) => expected)
          )
          expect(emulator.snapshot()).toEqual(seed)
          expect(emulator.ledger.entries().every(entry => entry.notEmulated === undefined)).toBe(
            true
          )

          yield* Effect.promise(() => expectNoKeys(emulator))
        })
      ),
    60_000
  )
})

const drill = (drills: LinkedInSearchEmulatorDrills) =>
  withEmulators({ drills }, emulators => runAll(emulators, { kind: 'in-process' }, inProcessLayer))

type ExpectedFailure = {
  readonly id: string
  readonly tag: string
  readonly message: string
}

const expectFailure = (report: ConformanceReport, failure: ExpectedFailure) => {
  expect(report.summary, formatConformanceReport(report)).toEqual({
    passed: caseCount - 1,
    failed: 1,
    skipped: 0
  })

  const failed = report.results.filter(result => result.status === 'failed')

  expect(failed.map(result => result.id)).toEqual([failure.id])
  expect(failed[0]?.failure?.tag, failure.id).toBe(failure.tag)
  expect(failed[0]?.failure?.message, failure.id).toContain(failure.message)
}

describe('disagreement drills (tests-only knobs): each fails exactly its case', () => {
  const drills: ReadonlyArray<readonly [LinkedInSearchEmulatorDrills, ExpectedFailure]> = [
    [
      { defaultSearchWithoutText: true },
      {
        id: 'linkedin-search.search.people-results',
        tag: 'ConformanceMismatch',
        message: 'expected at least one result to carry the text the connector requests'
      }
    ],
    [
      { numResultsIgnored: true },
      {
        id: 'linkedin-search.search.num-results-limit',
        tag: 'ConformanceMismatch',
        message: 'expected 1 to 2 results for numResults: 2'
      }
    ],
    [
      { profileAnswersEmptyObject: true },
      {
        id: 'linkedin-search.profile.get-profile',
        tag: 'ConformanceMismatch',
        message: 'expected the 2xx profile answer to be a JSON object with at least one field'
      }
    ],
    [
      { emailAnswerOmitsEmail: true },
      {
        id: 'linkedin-search.email.lookup-answer',
        tag: 'ConformanceMismatch',
        message: 'expected the email answer to carry an email (string or null) or an email_queue'
      }
    ],
    [
      { exaUnauthorizedAs5xx: true },
      {
        id: 'linkedin-search.errors.exa-unauthorized',
        tag: 'ConformanceMismatch',
        message: 'expected linkedin_search.search with an unknown Exa key to answer a 4xx status'
      }
    ],
    [
      { enrichLayerUnauthorizedAs2xx: true },
      {
        id: 'linkedin-search.errors.enrich-layer-unauthorized',
        tag: 'ConformanceMismatch',
        message: 'expected linkedin_search.profile with an unknown Enrich Layer key to fail'
      }
    ],
    [
      { absentProfileAs2xx: true },
      {
        id: 'linkedin-search.errors.profile-not-found',
        tag: 'ConformanceMismatch',
        message: 'expected linkedin_search.profile for a profile URL that names no profile to fail'
      }
    ]
  ]

  // One drill per case: together they cover every case exactly once.
  it('has one drill per case', () => {
    expect(drills.map(([, failure]) => failure.id)).toEqual(
      linkedInSearchConformanceCases.map(testCase => testCase.id)
    )
  })

  for (const [knobs, failure] of drills) {
    it.effect(
      `${Object.keys(knobs).join(', ')} fails only ${failure.id}`,
      () =>
        Effect.gen(function* () {
          expectFailure(yield* drill(knobs), failure)
        }),
      60_000
    )
  }
})
