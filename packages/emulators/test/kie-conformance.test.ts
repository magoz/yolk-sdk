/**
 * Cross-checks: the Kie emulator must satisfy the same conformance cases the replayed fixtures
 * satisfy, through the REAL Kie connector actions, both in-process (A) and over a loopback socket
 * (B), each case alone and all of them in sequence on one emulator; the reads end exactly at the
 * seed and each create records exactly its task; and each drill knob must make exactly its case
 * fail. Tests may import SDK packages; the emulator source never does.
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
import { kieApiBaseUrl } from '@yolk-sdk/connectors/kie'
import {
  KieConformanceConfig,
  kieConformanceCases,
  kieConformanceFixtureSeeds,
  kieConformanceInvalidApiKey
} from '@yolk-sdk/connectors/kie/conformance'
import {
  kieEmulatorOrigin,
  makeKieEmulator,
  type KieEmulator,
  type KieEmulatorDrills,
  type KieEmulatorOptions,
  type KieLedgerEntry
} from '../src/kie.ts'
import { serveFetchHandler } from '../src/node.ts'
import { EmulatedHttpClient, EmulatorRoute, InProcessHttpClient } from '../src/router.ts'

const now = new Date('2026-11-20T12:00:00.000Z')

/** A synthetic key the emulator accepts (never account data). */
const apiKey = 'synthetic-kie-emulator-key-0001'

const credentialLayer = staticCredentialResolverLayer(ApiKeyCredential.make({ key: apiKey }))

const portsOver = <E>(httpLayer: Layer.Layer<HttpClient.HttpClient, E>) =>
  Layer.mergeAll(
    connectorHttpClientsFromEffectHttpClientLayer.pipe(Layer.provide(httpLayer)),
    credentialLayer,
    Layer.succeed(KieConformanceConfig, kieConformanceFixtureSeeds)
  )

const inProcessLayer = (emulator: KieEmulator) =>
  InProcessHttpClient.layer([EmulatorRoute.handler(kieEmulatorOrigin, emulator.fetch)])

/** Real `FetchHttpClient` underneath; the recorded origin rewritten to a server on 127.0.0.1:0. */
const emulatedLayer = (emulator: KieEmulator) =>
  Layer.unwrap(
    serveFetchHandler(emulator.fetchOn(kieEmulatorOrigin)).pipe(
      Effect.map(server =>
        EmulatedHttpClient.layer([EmulatorRoute.url(kieEmulatorOrigin, server.url)]).pipe(
          Layer.provide(FetchHttpClient.layer)
        )
      )
    )
  )

type Emulators = ReadonlyMap<string, KieEmulator>

/** One fresh emulator per case (same seed), closed when the effect ends. */
const withEmulators = <A, E, R>(
  options: KieEmulatorOptions,
  use: (emulators: Emulators) => Effect.Effect<A, E, R>
) =>
  Effect.acquireUseRelease(
    Effect.promise(async () => {
      const emulators = new Map<string, KieEmulator>()

      for (const testCase of kieConformanceCases) {
        emulators.set(testCase.id, await makeKieEmulator(options))
      }

      return emulators
    }),
    use,
    emulators =>
      Effect.promise(() => Promise.all([...emulators.values()].map(emulator => emulator.close())))
  )

const withEmulator = <A, E, R>(
  options: KieEmulatorOptions,
  use: (emulator: KieEmulator) => Effect.Effect<A, E, R>
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => makeKieEmulator(options)),
    use,
    emulator => Effect.promise(() => emulator.close())
  )

const emulatorFor = (emulators: Emulators, caseId: string): KieEmulator => {
  const emulator = emulators.get(caseId)

  if (emulator === undefined) {
    throw new Error(`no emulator for ${caseId}`)
  }

  return emulator
}

const runAll = <E>(
  emulators: Emulators,
  target: ConformanceTarget,
  transport: (emulator: KieEmulator) => Layer.Layer<HttpClient.HttpClient, E>
) =>
  runConformance(kieConformanceCases, {
    target,
    now,
    layer: testCase => portsOver(transport(emulatorFor(emulators, testCase.id)))
  })

const caseCount = kieConformanceCases.length

const expectAllPassed = (report: ConformanceReport) => {
  expect(report.summary, formatConformanceReport(report)).toEqual({
    passed: caseCount,
    failed: 0,
    skipped: 0
  })
}

const requests = (entries: ReadonlyArray<KieLedgerEntry>) =>
  entries.map(entry => `${entry.method} ${entry.route ?? entry.path} ${entry.status}`)

/** The ledger requests each case sends, in order, with the status the emulator answered. */
const expectedRequests: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
  ['kie.tasks.get-success', ['GET /api/v1/jobs/recordInfo 200']],
  ['kie.tasks.get-failed', ['GET /api/v1/jobs/recordInfo 200']],
  ['kie.errors.task-not-found', ['GET /api/v1/jobs/recordInfo 200']],
  ['kie.errors.unauthorized', ['GET /api/v1/jobs/recordInfo 401']],
  ['kie.tasks.create-image-task', ['POST /api/v1/jobs/createTask 200']],
  ['kie.tasks.create-video-task', ['POST /api/v1/jobs/createTask 200']]
]

/** The models each case creates a task of (none for the reads). */
const createdModelsOf = (id: string): ReadonlyArray<string> => {
  switch (id) {
    case 'kie.tasks.create-image-task':
      return ['gpt-image-2-text-to-image']
    case 'kie.tasks.create-video-task':
      return ['wan/2-7-image-to-video']
    default:
      return []
  }
}

/** No key, accepted or rejected, ever reaches the ledger, the state, or a control-plane read. */
const expectNoKeys = async (emulator: KieEmulator) => {
  const reads = await Promise.all(
    ['ledger', 'state', 'coverage', 'faults'].map(route =>
      emulator
        .fetch(new Request(`${kieEmulatorOrigin}/_emulate/${route}`))
        .then(response => response.text())
    )
  )

  const recorded = [
    JSON.stringify(emulator.ledger.entries()),
    JSON.stringify(emulator.snapshot()),
    ...reads
  ].join('\n')

  expect(recorded).not.toContain(apiKey)
  expect(recorded).not.toContain(kieConformanceInvalidApiKey)
  expect(recorded.toLowerCase()).not.toContain('bearer')
}

/** A case ends at its seed, except the task a create records and the counter it advances. */
const expectEndState = (
  emulator: KieEmulator,
  id: string,
  seed: ReturnType<KieEmulator['snapshot']>
) => {
  const models = createdModelsOf(id)
  const state = emulator.snapshot()

  expect(
    state.createdTasks.map(task => task.model),
    id
  ).toEqual(models)
  expect({ ...state, createdTasks: [], nextCreated: 1 }, id).toEqual(seed)
  expect(state.nextCreated, id).toBe(1 + models.length)
}

describe('the base URL the connector calls is the emulated origin', () => {
  it('https://api.kie.ai', () => {
    expect(new URL(kieApiBaseUrl).origin).toBe(kieEmulatorOrigin)
  })
})

for (const [label, target, transport] of [
  ['A: in-process', { kind: 'in-process' }, inProcessLayer],
  ['B: emulated over a loopback socket', { kind: 'emulated' }, emulatedLayer]
] as const) {
  describe(`cross-check ${label}, through the real connector`, () => {
    it.effect(
      'passes every Kie case on its own emulator; reads end at the seed, creates record their task',
      () =>
        withEmulators({}, emulators =>
          Effect.gen(function* () {
            const seeds = new Map(
              [...emulators].map(([id, emulator]) => [id, emulator.snapshot()] as const)
            )

            const report = yield* runAll(emulators, target, transport)

            expectAllPassed(report)
            expect(report.target).toEqual(target)

            for (const [id, expected] of expectedRequests) {
              const emulator = emulatorFor(emulators, id)
              const seed = seeds.get(id)

              if (seed === undefined) throw new Error(`no seed for ${id}`)

              expect(requests(emulator.ledger.entries()), id).toEqual(expected)
              expect(
                emulator.ledger
                  .entries()
                  .every(
                    entry => entry.evidence === 'unverified' && entry.notEmulated === undefined
                  ),
                id
              ).toBe(true)

              expectEndState(emulator, id, seed)

              yield* Effect.promise(() => expectNoKeys(emulator))
            }

            expect(expectedRequests.map(([id]) => id)).toEqual(
              kieConformanceCases.map(testCase => testCase.id)
            )
          })
        ),
      60_000
    )

    it.effect(
      'passes every case in sequence on ONE emulator, twice (the creates mint new ids)',
      () =>
        withEmulator({}, emulator =>
          Effect.gen(function* () {
            const seed = emulator.snapshot()

            const runOnce = runConformance(kieConformanceCases, {
              target,
              now,
              layer: () => portsOver(transport(emulator))
            })

            expectAllPassed(yield* runOnce)
            expectAllPassed(yield* runOnce)

            const once = expectedRequests.flatMap(([, expected]) => expected)

            expect(requests(emulator.ledger.entries())).toEqual([...once, ...once])
            expect(emulator.ledger.entries().every(entry => entry.notEmulated === undefined)).toBe(
              true
            )
            expect(emulator.snapshot().createdTasks.map(task => task.taskId)).toEqual([
              'yolk_synthetic_task_created_0001',
              'yolk_synthetic_task_created_0002',
              'yolk_synthetic_task_created_0003',
              'yolk_synthetic_task_created_0004'
            ])
            expect({ ...emulator.snapshot(), createdTasks: [], nextCreated: 1 }).toEqual(seed)

            yield* Effect.promise(() => expectNoKeys(emulator))
          })
        ),
      60_000
    )
  })
}

const drill = (drills: KieEmulatorDrills) =>
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
  const drills: ReadonlyArray<readonly [KieEmulatorDrills, ExpectedFailure]> = [
    [
      { successWithoutResultUrls: true },
      {
        id: 'kie.tasks.get-success',
        tag: 'ConformanceMismatch',
        message: 'expected a successful task to carry resultJson with at least one result URL'
      }
    ],
    [
      { failedTaskAsEnvelopeError: true },
      {
        id: 'kie.tasks.get-failed',
        tag: 'KieConformanceActionFailed',
        message: 'kie.get_task failed: kie_generation_failed (HTTP 200) (Kie code 501)'
      }
    ],
    [
      { absentTaskAsSuccess: true },
      { id: 'kie.errors.task-not-found', tag: 'ConnectorError', message: 'Invalid Kie response' }
    ],
    [
      { unauthorizedAs5xx: true },
      {
        id: 'kie.errors.unauthorized',
        tag: 'ConformanceMismatch',
        message: 'expected an API key Kie does not accept to answer code 401 (kie_unauthorized)'
      }
    ],
    [
      { imageCreateInsufficientCredits: true },
      {
        id: 'kie.tasks.create-image-task',
        tag: 'KieConformanceActionFailed',
        message: 'kie.create_image_task failed: kie_insufficient_credits (HTTP 200) (Kie code 402)'
      }
    ],
    [
      { videoCreateEmptyTaskId: true },
      {
        id: 'kie.tasks.create-video-task',
        tag: 'KieConformanceActionFailed',
        message: 'kie.create_video_task failed: empty_task_id (HTTP 200); task outcome unknown'
      }
    ]
  ]

  it('has one drill per case', () => {
    expect(drills.map(([, failure]) => failure.id)).toEqual(
      kieConformanceCases.map(testCase => testCase.id)
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
