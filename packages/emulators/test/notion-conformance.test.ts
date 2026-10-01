/**
 * Cross-checks: the Notion emulator must satisfy the same conformance cases the replayed fixtures
 * satisfy, through the REAL Notion connector actions, both in-process and over a loopback socket;
 * the read-only leftover lookup must work against it; and each drill knob must make exactly its
 * case fail. Tests may import SDK packages; the emulator source never does.
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
import { ApiKeyCredential } from '@yolk-sdk/connectors'
import {
  connectorHttpClientsFromEffectHttpClientLayer,
  staticCredentialResolverLayer
} from '@yolk-sdk/connectors/conformance'
import { notionApiBaseUrl } from '@yolk-sdk/connectors/notion'
import {
  NotionConformanceConfig,
  findNotionConformanceLeftovers,
  notionConformanceCases,
  notionConformanceFixtureSeeds
} from '@yolk-sdk/connectors/notion/conformance'
import {
  makeNotionEmulator,
  type NotionEmulator,
  type NotionEmulatorDrills,
  type NotionEmulatorOptions,
  type NotionEmulatorState,
  type NotionLedgerEntry
} from '../src/notion.ts'
import { serveFetchHandler } from '../src/node.ts'
import { EmulatedHttpClient, EmulatorRoute, InProcessHttpClient } from '../src/router.ts'

const origin = new URL(notionApiBaseUrl).origin

const now = new Date('2026-09-29T15:00:00.000Z')

const integrationToken = 'synthetic-notion-integration-token'

const credentialLayer = staticCredentialResolverLayer(
  ApiKeyCredential.make({ key: integrationToken })
)

const portsOver = <E>(httpLayer: Layer.Layer<HttpClient.HttpClient, E>) =>
  Layer.mergeAll(
    connectorHttpClientsFromEffectHttpClientLayer.pipe(Layer.provide(httpLayer)),
    credentialLayer,
    Layer.succeed(NotionConformanceConfig, notionConformanceFixtureSeeds)
  )

const inProcessLayer = (emulator: NotionEmulator) =>
  InProcessHttpClient.layer([EmulatorRoute.handler(origin, emulator.fetch)])

/** Real `FetchHttpClient` underneath; the origin rewritten to a server on 127.0.0.1:0. */
const emulatedLayer = (emulator: NotionEmulator) =>
  Layer.unwrap(
    serveFetchHandler(emulator.fetch).pipe(
      Effect.map(server =>
        EmulatedHttpClient.layer([EmulatorRoute.url(origin, server.url)]).pipe(
          Layer.provide(FetchHttpClient.layer)
        )
      )
    )
  )

type Emulators = ReadonlyMap<string, NotionEmulator>

/** One fresh emulator per case (same seed), closed when the effect ends. */
const withEmulators = <A, E, R>(
  options: NotionEmulatorOptions,
  use: (emulators: Emulators) => Effect.Effect<A, E, R>
) =>
  Effect.acquireUseRelease(
    Effect.promise(async () => {
      const emulators = new Map<string, NotionEmulator>()

      for (const testCase of notionConformanceCases) {
        emulators.set(
          testCase.id,
          await makeNotionEmulator({ now: () => now.getTime(), ...options })
        )
      }

      return emulators
    }),
    use,
    emulators =>
      Effect.promise(() => Promise.all([...emulators.values()].map(emulator => emulator.close())))
  )

const withEmulator = <A, E, R>(
  options: NotionEmulatorOptions,
  use: (emulator: NotionEmulator) => Effect.Effect<A, E, R>
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => makeNotionEmulator({ now: () => now.getTime(), ...options })),
    use,
    emulator => Effect.promise(() => emulator.close())
  )

const emulatorFor = (emulators: Emulators, caseId: string): NotionEmulator => {
  const emulator = emulators.get(caseId)

  if (emulator === undefined) {
    throw new Error(`no emulator for ${caseId}`)
  }

  return emulator
}

const runAll = <E>(
  emulators: Emulators,
  target: ConformanceTarget,
  transport: (emulator: NotionEmulator) => Layer.Layer<HttpClient.HttpClient, E>
) =>
  runConformance(notionConformanceCases, {
    target,
    now,
    layer: testCase => portsOver(transport(emulatorFor(emulators, testCase.id)))
  })

const caseCount = notionConformanceCases.length

const expectAllPassed = (report: ConformanceReport) => {
  expect(report.summary, formatConformanceReport(report)).toEqual({
    passed: caseCount,
    failed: 0,
    skipped: 0
  })
}

const requests = (entries: ReadonlyArray<NotionLedgerEntry>) =>
  entries.map(entry => `${entry.method} ${entry.route ?? entry.path} ${entry.status}`)

const archiveCaseId = 'notion.pages.archive-in-trash'

/**
 * The state without what the write case leaves by design: the page id counter (which only
 * advances) and the case's own page, which Notion keeps in the trash (archiving is the
 * connector's delete; the case claims the trashed page still reads back).
 */
const withoutCounterAndTrashedCasePages = ({
  counters: _counters,
  ...state
}: NotionEmulatorState) => ({
  ...state,
  pages: state.pages.filter(
    page =>
      !(
        page.archived &&
        page.inTrash &&
        JSON.stringify(page.properties).includes('yolk-conformance page')
      )
  )
})

const readCaseIds = notionConformanceCases
  .filter(testCase => testCase.safety === 'read')
  .map(testCase => testCase.id)

describe('cross-check A: in-process emulator through the real connector', () => {
  // What "ends at the seed" means: every read case leaves the exact seed; the write case ends at
  // the seed except the advanced page counter and its own page, now in the trash.
  it.effect(
    'passes every Notion case; read cases leave the exact seed, the write case only adds its own trashed page',
    () =>
      withEmulators({}, emulators =>
        Effect.gen(function* () {
          const seeds = new Map(
            [...emulators].map(([id, emulator]) => [id, emulator.snapshot()] as const)
          )

          const report = yield* runAll(emulators, { kind: 'in-process' }, inProcessLayer)

          expectAllPassed(report)
          expect(readCaseIds).toHaveLength(7)

          const seedOf = (id: string): NotionEmulatorState => {
            const seed = seeds.get(id)

            if (seed === undefined) throw new Error(`no seed for ${id}`)

            return seed
          }

          const stateOf = (id: string) => emulatorFor(emulators, id).snapshot()
          const ledgerOf = (id: string) => emulatorFor(emulators, id).ledger.entries()

          for (const id of readCaseIds) {
            expect(stateOf(id), id).toEqual(seedOf(id))
          }

          // The error case's two refusals are the fixture's 404 and 400, never not-emulated.
          for (const testCase of notionConformanceCases) {
            expect(
              ledgerOf(testCase.id).every(entry => entry.notEmulated === undefined),
              testCase.id
            ).toBe(true)
            expect(
              ledgerOf(testCase.id).every(
                entry => entry.headers['notion-version'] === '2025-09-03'
              ),
              testCase.id
            ).toBe(true)
          }

          const archived = stateOf(archiveCaseId)
          const seed = seedOf(archiveCaseId)

          expect(withoutCounterAndTrashedCasePages(archived)).toEqual(
            withoutCounterAndTrashedCasePages(seed)
          )
          expect(archived.counters.nextPageNumber).toBe(seed.counters.nextPageNumber + 1)
          expect(archived.pages.length).toBe(seed.pages.length + 1)
          expect(archived.pages.at(-1)).toMatchObject({
            archived: true,
            inTrash: true,
            parent: { type: 'page_id', page_id: notionConformanceFixtureSeeds.parentPageId }
          })

          expect(requests(ledgerOf(archiveCaseId))).toEqual([
            'POST /v1/pages 200',
            'PATCH /v1/pages/{pageId} 200',
            'GET /v1/pages/{pageId} 200'
          ])

          expect(requests(ledgerOf('notion.errors.error-envelope'))).toEqual([
            'GET /v1/pages/{pageId} 404',
            'GET /v1/pages/{pageId} 400'
          ])

          // Double encoding reached the emulator: the raw path carries `%253A`.
          expect(
            ledgerOf('notion.pages.property-item-paging')
              .filter(entry => entry.route === '/v1/pages/{pageId}/properties/{propertyId}')
              .map(entry => entry.path)
          ).toEqual([
            '/v1/pages/1f000000-0000-4000-8000-000000000003/properties/Syn%253Ap',
            '/v1/pages/1f000000-0000-4000-8000-000000000003/properties/Syn%253Ap'
          ])

          for (const emulator of emulators.values()) {
            const recorded = JSON.stringify([emulator.ledger.entries(), emulator.snapshot()])

            expect(recorded).not.toContain(integrationToken)
            expect(recorded.toLowerCase()).not.toContain('bearer')
          }
        })
      ),
    60_000
  )

  it.effect(
    'passes every case on one shared emulator; the leftover lookup is not emulated before or after it',
    () =>
      withEmulator({}, emulator =>
        Effect.gen(function* () {
          const lookup = findNotionConformanceLeftovers.pipe(
            Effect.provide(portsOver(inProcessLayer(emulator)))
          )

          // No fixture records a search answer without results, so on the clean workspace the
          // read-only lookup fails with its action-failed error (the live runner prints its
          // lookup-failed WARN) and writes nothing.
          const seeded = emulator.snapshot()

          expect(yield* Effect.flip(lookup)).toMatchObject({
            _tag: 'NotionConformanceActionFailed',
            code: 'notion_search_failed',
            status: 400
          })
          expect(emulator.ledger.entries().at(-1)).toMatchObject({
            route: '/v1/search',
            status: 400,
            notEmulated: expect.stringContaining('without matches')
          })
          expect(emulator.snapshot()).toEqual(seeded)
          emulator.ledger.clear()

          const report = yield* runConformance(notionConformanceCases, {
            target: { kind: 'in-process' },
            now,
            layer: () => portsOver(inProcessLayer(emulator))
          })

          expectAllPassed(report)
          expect(emulator.ledger.entries().every(entry => entry.notEmulated === undefined)).toBe(
            true
          )

          // The archived case page now matches the lookup's search, and no fixture records a
          // search answer with a trashed page: the lookup fails closed instead of guessing.
          const afterRun = emulator.snapshot()
          const failed = yield* Effect.flip(lookup)

          expect(emulator.snapshot()).toEqual(afterRun)

          expect(failed).toMatchObject({
            _tag: 'NotionConformanceActionFailed',
            code: 'notion_search_failed',
            status: 400
          })
          expect(emulator.ledger.entries().at(-1)?.notEmulated).toContain('trashed page')
        })
      ),
    60_000
  )

  it.effect('the leftover lookup lists a case page an earlier run left untrashed', () =>
    withEmulator({}, emulator =>
      Effect.gen(function* () {
        // An earlier run created its page and stopped before the archive.
        const created = yield* Effect.promise(() =>
          emulator.fetch(
            new Request(`${origin}/v1/pages`, {
              method: 'POST',
              headers: {
                authorization: `Bearer ${integrationToken}`,
                'notion-version': '2025-09-03',
                'content-type': 'application/json'
              },
              body: JSON.stringify({
                parent: { page_id: notionConformanceFixtureSeeds.parentPageId },
                properties: {
                  title: { title: [{ text: { content: 'yolk-conformance page: safe to delete' } }] }
                }
              })
            })
          )
        )

        expect(created.status).toBe(200)

        const leftovers = yield* findNotionConformanceLeftovers.pipe(
          Effect.provide(portsOver(inProcessLayer(emulator)))
        )

        expect(leftovers).toEqual([
          'yolk-conformance page: safe to delete (1f0000e0-0000-4000-8000-000000000001)'
        ])
        expect(emulator.ledger.entries().map(entry => entry.route)).toEqual([
          '/v1/pages',
          '/v1/search'
        ])
      })
    )
  )
})

describe('cross-check B: emulated over a loopback socket', () => {
  it.effect(
    'passes every Notion case through FetchHttpClient and EmulatedHttpClient',
    () =>
      withEmulators({}, emulators =>
        Effect.gen(function* () {
          const seeds = new Map(
            [...emulators].map(([id, emulator]) => [id, emulator.snapshot()] as const)
          )

          const report = yield* runAll(emulators, { kind: 'emulated' }, emulatedLayer)

          expectAllPassed(report)
          expect(report.target).toEqual({ kind: 'emulated' })

          for (const testCase of notionConformanceCases) {
            const entries = emulatorFor(emulators, testCase.id).ledger.entries()

            expect(entries.length, testCase.id).toBeGreaterThan(0)
            expect(
              entries.every(
                entry => entry.evidence === 'unverified' && entry.notEmulated === undefined
              ),
              testCase.id
            ).toBe(true)
          }

          for (const id of readCaseIds) {
            expect(emulatorFor(emulators, id).snapshot(), id).toEqual(seeds.get(id))
          }

          // The write case leaves only its own trashed page and the advanced counter.
          const archived = emulatorFor(emulators, archiveCaseId).snapshot()
          const seed = seeds.get(archiveCaseId) ?? archived

          expect(withoutCounterAndTrashedCasePages(archived)).toEqual(
            withoutCounterAndTrashedCasePages(seed)
          )
          expect(archived.pages.length).toBe(seed.pages.length + 1)
          expect(archived.counters.nextPageNumber).toBe(seed.counters.nextPageNumber + 1)
        })
      ),
    60_000
  )
})

const drill = (drills: NotionEmulatorDrills) =>
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
  const drills: ReadonlyArray<readonly [NotionEmulatorDrills, ExpectedFailure]> = [
    [
      { searchRepeatsResults: true },
      {
        id: 'notion.search.cursor-paging',
        tag: 'ConformanceMismatch',
        message: 'expected a later search page to repeat no earlier result'
      }
    ],
    [
      { botUserAsPerson: true },
      {
        id: 'notion.api.pinned-version-accepted',
        tag: 'ConformanceMismatch',
        message: 'to answer the bot user'
      }
    ],
    [
      { envelopeStatusMismatch: true },
      {
        id: 'notion.errors.error-envelope',
        tag: 'ConformanceMismatch',
        message: 'to carry the error envelope'
      }
    ],
    [
      { omitTitlePlainText: true },
      {
        id: 'notion.pages.title-plain-text',
        tag: 'ConformanceMismatch',
        message: 'expected every title item to be text with plain_text'
      }
    ],
    [
      { blockCursorRepeats: true },
      {
        id: 'notion.blocks.children-cursor-paging',
        tag: 'ConformanceMismatch',
        message: 'expected a later block page to repeat no earlier block'
      }
    ],
    [
      { rejectDoubleEncodedPropertyId: true },
      {
        id: 'notion.pages.property-item-paging',
        tag: 'ConformanceMismatch',
        message: 'expected Notion to accept the property id percent-encoded again (HTTP 400)'
      }
    ],
    [
      { rowParentAsDatabase: true },
      {
        id: 'notion.data-sources.database-split',
        tag: 'ConformanceMismatch',
        message: 'expected every queried page parent to be { type: "data_source_id" }'
      }
    ],
    [
      { trashedPageNotFound: true },
      {
        id: 'notion.pages.archive-in-trash',
        tag: 'ConformanceMismatch',
        message: 'expected get_page of the archived page to still answer (not 404)'
      }
    ]
  ]

  // One drill per case: together they cover every case exactly once.
  it('has one drill per case', () => {
    expect(drills.map(([, failure]) => failure.id)).toEqual(
      notionConformanceCases.map(testCase => testCase.id)
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
