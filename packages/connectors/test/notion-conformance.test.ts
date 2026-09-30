import { describe, expect, it } from '@effect/vitest'
import { Deferred, Effect, Exit, Fiber, Layer, Ref } from 'effect'
import { TestClock } from 'effect/testing'
import { HttpClient } from 'effect/unstable/http'
import type { ConformanceCase } from '@yolk-sdk/conformance/case'
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
import { NotionConnector } from '@yolk-sdk/connectors/notion'
import {
  NotionConformanceConfig,
  notionArchiveInTrashCase,
  notionArchiveInTrashFixture,
  notionBlockChildrenPagingFixture,
  notionConformanceCases,
  notionConformanceFixtureSeeds,
  notionConformanceFixtures,
  findNotionConformanceLeftovers,
  notionDataSourceSplitFixture,
  notionErrorEnvelopeFixture,
  notionPropertyItemPagingCase,
  notionPropertyItemPagingFixture,
  notionSearchPagingCase,
  notionSearchPagingFixture,
  notionTitlePlainTextFixture,
  notionPinnedVersionCase,
  notionPinnedVersionFixture,
  type NotionConformanceCase,
  type NotionConformanceSeeds
} from '@yolk-sdk/connectors/notion/conformance'

const now = new Date('2026-09-30T12:00:00.000Z')

const atTestNow = TestClock.setTime(now.getTime())

const credentialLayer = staticCredentialResolverLayer(
  ApiKeyCredential.make({ key: 'synthetic-notion-integration-token' })
)

const portsOver = (
  httpLayer: Layer.Layer<HttpClient.HttpClient>,
  seeds: NotionConformanceSeeds = notionConformanceFixtureSeeds
) =>
  Layer.mergeAll(
    connectorHttpClientsFromEffectHttpClientLayer.pipe(Layer.provide(httpLayer)),
    credentialLayer,
    Layer.succeed(NotionConformanceConfig, seeds)
  )

const fixturesFor = (
  testCase: Pick<ConformanceCase<unknown, unknown>, 'fixtures'>,
  fixtures: ReadonlyArray<WireFixture> = notionConformanceFixtures
) => fixtures.filter(fixture => testCase.fixtures.includes(fixture.id))

const replayLayerOver =
  (fixtures: ReadonlyArray<WireFixture> = notionConformanceFixtures) =>
  (testCase: NotionConformanceCase) =>
    portsOver(ReplayHttpClient.layer(fixturesFor(testCase, fixtures)))

const ledgerCaseLayer =
  (
    ledgers: Ref.Ref<Map<string, ReplayLedgerApi>>,
    fixtures: ReadonlyArray<WireFixture> = notionConformanceFixtures,
    seeds: NotionConformanceSeeds = notionConformanceFixtureSeeds
  ) =>
  (testCase: NotionConformanceCase) =>
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

const exchangeIndices = (entries: ReadonlyArray<ReplayLedgerEntry>) =>
  entries.map(entry =>
    entry.match.outcome === 'matched'
      ? `${entry.method} ${entry.match.exchangeIndex}`
      : `unmatched ${entry.method}`
  )

const synthetic = (id: string) => `${id}.synthetic`

const notionOrigin = 'https://api.notion.com/v1/'

const caseIds = [
  ['notion.search.cursor-paging', 'read'],
  ['notion.api.pinned-version-accepted', 'read'],
  ['notion.errors.error-envelope', 'read'],
  ['notion.pages.title-plain-text', 'read'],
  ['notion.blocks.children-cursor-paging', 'read'],
  ['notion.pages.property-item-paging', 'read'],
  ['notion.data-sources.database-split', 'read'],
  ['notion.pages.archive-in-trash', 'write-reversible']
] as const

function textBody(response: WireResponse): string {
  if (isWireStreamResponse(response) || isWireBase64BodyResponse(response)) {
    return expect.fail('expected a text body')
  }

  return response.body
}

describe('Notion conformance cases', () => {
  it('declare their safety, stay unverified, and are backed by one fixture each', () => {
    expect(notionConformanceCases.map(testCase => [testCase.id, testCase.safety])).toEqual(
      caseIds.map(([id, safety]) => [id, safety])
    )
    expect(notionConformanceFixtures.map(fixture => fixture.caseId)).toEqual(
      notionConformanceCases.map(testCase => testCase.id)
    )

    for (const testCase of notionConformanceCases) {
      expect(testCase.observed).toBeUndefined()
      expect(testCase.fixtures).toEqual([synthetic(testCase.id)])
    }
  })

  it('cite only real connector actions, and say plainly where a raw request is sent', () => {
    const actionIds = new Set(NotionConnector.actions.map(action => action.id))

    for (const testCase of notionConformanceCases) {
      const cited = [...testCase.docs.matchAll(/`(notion\.[a-z_]+)`/g)].map(match => match[1])

      expect(cited.every(id => id !== undefined && actionIds.has(id))).toBe(true)
    }

    expect(notionPinnedVersionCase.docs).toContain('it sends no request of its own')
  })

  it.effect('ship synthetic fixtures that decode and pass the secret scan', () =>
    Effect.gen(function* () {
      for (const fixture of notionConformanceFixtures) {
        expect(yield* decodeWireFixture(fixture)).toEqual(fixture)
        expect(scanFixtureForSecrets(fixture)).toEqual([])
        expect(fixture).toMatchObject({ evidence: 'unverified', account: 'synthetic' })

        for (const { request, response } of fixture.exchanges) {
          expect(Object.keys(request.headers ?? {})).not.toContain('authorization')
          expect(request.url.startsWith(notionOrigin)).toBe(true)

          if (response.status >= 400) {
            // Notion error envelope: { object: "error", status, code, message }.
            expect(JSON.parse(textBody(response))).toMatchObject({
              object: 'error',
              status: response.status,
              code: expect.any(String),
              message: expect.any(String)
            })
          }
        }
      }
    })
  )

  it.effect('all pass on replay with unverified warnings', () =>
    Effect.gen(function* () {
      yield* atTestNow

      const report = yield* runConformance(notionConformanceCases, {
        target: { kind: 'replay' },
        now,
        fixtures: notionConformanceFixtures,
        layer: replayLayerOver()
      })

      expect(report.summary).toEqual({ passed: 8, failed: 0, skipped: 0 })
      expect(conformanceReportFailed(report)).toBe(false)

      for (const result of report.results) {
        expect(result.warnings).toEqual([
          { kind: 'unverified-case' },
          { kind: 'unverified-fixture', fixtureId: synthetic(result.id) }
        ])
      }

      expect(formatConformanceReport(report).split('\n').at(-1)).toBe(
        '8 passed, 0 failed, 0 skipped; target replay; started 2026-09-30T12:00:00.000Z'
      )
    })
  )

  it.effect('consume every recorded exchange in order and send the recorded requests', () =>
    Effect.gen(function* () {
      yield* atTestNow

      const ledgers = yield* Ref.make(new Map<string, ReplayLedgerApi>())

      const report = yield* runConformance(notionConformanceCases, {
        target: { kind: 'replay' },
        now,
        layer: ledgerCaseLayer(ledgers)
      })

      expect(report.summary.passed).toBe(8)

      for (const testCase of notionConformanceCases) {
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
          expect(entry.bodyJson).toEqual(exchange?.request.body)
          expect(entry.headers).toMatchObject(exchange?.request.headers ?? {})
          expect(entry.headers.authorization).toBe('<redacted>')
        })
      }
    })
  )

  it.effect('send the pinned Notion-Version on every action request', () =>
    Effect.gen(function* () {
      yield* atTestNow

      const ledgers = yield* Ref.make(new Map<string, ReplayLedgerApi>())

      yield* runConformance(notionConformanceCases, {
        target: { kind: 'replay' },
        now,
        layer: ledgerCaseLayer(ledgers)
      })

      for (const testCase of notionConformanceCases) {
        const { entries } = yield* ledgerOf(ledgers, testCase.id)

        expect(entries.length).toBeGreaterThan(0)

        for (const entry of entries) {
          expect(entry.headers['notion-version']).toBe('2025-09-03')
        }
      }
    })
  )
})

describe('Notion conformance safety on a live target', () => {
  const statuses = (target: ConformanceTarget) =>
    atTestNow.pipe(
      Effect.andThen(
        runConformance(notionConformanceCases, { target, now, layer: replayLayerOver() })
      ),
      Effect.map(report =>
        report.results.map(result => [result.id, result.status, result.skipReason ?? null])
      )
    )

  it.effect('runs only the read cases by default and skips the write', () =>
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

      expect(results.every(([, status]) => status === 'passed')).toBe(true)
      expect(results).toHaveLength(8)
    })
  )
})

// Drills.

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

const objectNotFound =
  '{"object":"error","status":404,"code":"object_not_found","message":"Synthetic placeholder: not found."}'

const serverError =
  '{"object":"error","status":500,"code":"internal_server_error","message":"Synthetic placeholder: server error."}'

const mismatch = (message: string) => ({ kind: 'failure', tag: 'ConformanceMismatch', message })

const suiteFailures = (fixtures: ReadonlyArray<WireFixture>) =>
  Effect.gen(function* () {
    yield* atTestNow

    const report = yield* runConformance(notionConformanceCases, {
      target: { kind: 'replay' },
      now,
      layer: replayLayerOver(fixtures)
    })

    return report.results
      .filter(result => result.status === 'failed')
      .map(result => ({ id: result.id, failure: result.failure }))
  })

const withReplaced = (tampered: WireFixture) =>
  notionConformanceFixtures.map(fixture => (fixture.id === tampered.id ? tampered : fixture))

const tampers: ReadonlyArray<{ readonly fixture: WireFixture; readonly message: string }> = [
  {
    fixture: replaceResponse(
      notionSearchPagingFixture,
      1,
      replaceInBody(
        '"id":"1f0000a0-0000-4000-8000-000000000002"',
        '"id":"1f0000a0-0000-4000-8000-000000000001"'
      )
    ),
    message: 'expected a later search page to repeat no earlier result'
  },
  {
    fixture: replaceResponse(
      notionPinnedVersionFixture,
      0,
      replaceInBody('"type":"bot"', '"type":"person"')
    ),
    message: 'expected notion.get_bot_user with Notion-Version 2025-09-03 to answer the bot user'
  },
  {
    fixture: replaceResponse(
      notionErrorEnvelopeFixture,
      0,
      replaceInBody('"code":"object_not_found"', '"code":"validation_error"')
    ),
    message:
      'expected the missing page response to carry the error envelope { object: "error", code: "object_not_found", status: 404 }'
  },
  {
    fixture: replaceResponse(
      notionTitlePlainTextFixture,
      0,
      replaceInBody('"plain_text":"Title Page"', '"plain_text":"Title Pages"')
    ),
    message: 'expected the joined plain_text to equal the seeded title'
  },
  {
    fixture: replaceResponse(
      notionBlockChildrenPagingFixture,
      1,
      replaceInBody(
        '"id":"1f0000c0-0000-4000-8000-000000000003"',
        '"id":"1f0000c0-0000-4000-8000-000000000001"'
      )
    ),
    message: 'expected a later block page to repeat no earlier block'
  },
  {
    fixture: replaceResponse(
      notionPropertyItemPagingFixture,
      2,
      replaceInBody('"type":"rich_text","rich_text":{"type"', '"type":"title","rich_text":{"type"')
    ),
    message: 'expected every property item to carry the property type'
  },
  {
    fixture: replaceResponse(
      notionDataSourceSplitFixture,
      2,
      replaceInBody('"type":"data_source_id"', '"type":"database_id"')
    ),
    message:
      'expected every queried page parent to be { type: "data_source_id" } naming the data source'
  },
  {
    fixture: replaceResponse(
      notionArchiveInTrashFixture,
      1,
      replaceInBody('"archived":true', '"archived":false')
    ),
    // in_trash stays true: the page is known trashed, so nothing is restored.
    message: 'expected the archive response to report archived true'
  }
]

describe('Notion conformance drills (one per case)', () => {
  it('cover every case with a tamper', () => {
    expect(tampers.map(tamper => tamper.fixture.caseId)).toEqual(caseIds.map(([id]) => id))
  })

  for (const { fixture, message } of tampers) {
    it.effect(`a tampered fixture fails exactly ${fixture.caseId}`, () =>
      Effect.gen(function* () {
        expect(yield* suiteFailures(withReplaced(fixture))).toEqual([
          { id: fixture.caseId, failure: mismatch(message) }
        ])
      })
    )
  }

  for (const [caseId] of caseIds) {
    it.effect(`a dropped fixture fails exactly ${caseId}`, () =>
      Effect.gen(function* () {
        const failures = yield* suiteFailures(
          notionConformanceFixtures.filter(fixture => fixture.caseId !== caseId)
        )

        expect(failures.map(failure => failure.id)).toEqual([caseId])
      })
    )
  }
})

const drill = (
  testCase: NotionConformanceCase,
  fixture: WireFixture,
  seeds: NotionConformanceSeeds = notionConformanceFixtureSeeds
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

const [createExchange, archiveExchange, readExchange] =
  notionArchiveInTrashFixture.exchanges.length === 3
    ? notionArchiveInTrashFixture.exchanges
    : expect.fail('expected three archive exchanges')

/** The GET of the case page answering the page as not yet trashed. */
const untrashedRead: WireExchange = {
  request: readExchange.request,
  response: { ...createExchange.response }
}

describe('Notion conformance restore', () => {
  it.effect('trashes the page in the restore when the archive request fails', () =>
    Effect.gen(function* () {
      const fixture: WireFixture = {
        ...notionArchiveInTrashFixture,
        exchanges: [
          createExchange,
          { ...archiveExchange, response: withStatus(500, serverError)(archiveExchange.response) },
          untrashedRead,
          archiveExchange
        ]
      }

      const { failure, entries, remaining } = yield* drill(notionArchiveInTrashCase, fixture)

      expect(failure).toEqual({
        kind: 'failure',
        tag: 'NotionConformanceActionFailed',
        message: 'notion.update_page failed: notion_update_page_failed (HTTP 500)'
      })
      // The restore's archive response shows the page trashed: that is proof enough.
      expect(exchangeIndices(entries)).toEqual(['POST 0', 'PATCH 1', 'GET 2', 'PATCH 3'])
      expect(remaining).toEqual([])
    })
  )

  it.effect('reports a failed restore instead of swallowing it', () =>
    Effect.gen(function* () {
      const fixture: WireFixture = {
        ...notionArchiveInTrashFixture,
        exchanges: [
          createExchange,
          { ...archiveExchange, response: withStatus(500, serverError)(archiveExchange.response) },
          untrashedRead,
          { ...archiveExchange, response: withStatus(500, serverError)(archiveExchange.response) }
        ]
      }

      const { failure } = yield* drill(notionArchiveInTrashCase, fixture)

      expect(failure?.tag).toBe('NotionConformanceRestoreFailed')
      expect(failure?.message).toBe(
        'notion.pages.archive-in-trash: restore failed; trash the case-created page by hand if it is not trashed yet (title starts with yolk-conformance, under parentPageId). Restore error: notion.update_page notion_update_page_failed 500. Claim failed first: notion.update_page notion_update_page_failed 500'
      )
      expect(failure?.message.length).toBeLessThanOrEqual(300)
    })
  )

  it.effect('reports an ambiguous create with manual-recovery advice and writes nothing more', () =>
    Effect.gen(function* () {
      const fixture: WireFixture = {
        ...notionArchiveInTrashFixture,
        exchanges: [
          { ...createExchange, response: withStatus(502, serverError)(createExchange.response) }
        ]
      }

      const { failure, entries } = yield* drill(notionArchiveInTrashCase, fixture)

      expect(failure).toEqual({
        kind: 'failure',
        tag: 'NotionConformanceActionFailed',
        message:
          'notion.create_page failed: notion_create_page_failed (HTTP 502); the page may exist anyway: trash the case-created page by hand if it is not trashed yet (title starts with yolk-conformance, under parentPageId).'
      })
      expect(exchangeIndices(entries)).toEqual(['POST 0'])
    })
  )

  it.effect('reports a 4xx create without the advice: nothing was created', () =>
    Effect.gen(function* () {
      const rejected =
        '{"object":"error","status":403,"code":"restricted_resource","message":"Synthetic placeholder: restricted."}'

      const { failure } = yield* drill(notionArchiveInTrashCase, {
        ...notionArchiveInTrashFixture,
        exchanges: [
          { ...createExchange, response: withStatus(403, rejected)(createExchange.response) }
        ]
      })

      expect(failure).toEqual({
        kind: 'failure',
        tag: 'NotionConformanceActionFailed',
        message: 'notion.create_page failed: notion_unauthorized (HTTP 403)'
      })
    })
  )

  it.effect('trashes the page when the case is interrupted mid-flow', () =>
    Effect.gen(function* () {
      const archiveSent = yield* Deferred.make<void>()

      const { client, ledger } = yield* makeReplayHttpClient([
        {
          ...notionArchiveInTrashFixture,
          exchanges: [createExchange, archiveExchange, untrashedRead, archiveExchange]
        }
      ])

      let archives = 0

      // Hold the first archive response until the case fiber is interrupted.
      const holdingArchive = HttpClient.transform(client, (response, request) =>
        request.method === 'PATCH' && archives++ === 0
          ? response.pipe(
              Effect.tap(() => Deferred.succeed(archiveSent, undefined)),
              Effect.andThen(Effect.never)
            )
          : response
      )

      const fiber = yield* notionArchiveInTrashCase.run.pipe(
        Effect.provide(portsOver(Layer.succeed(HttpClient.HttpClient, holdingArchive))),
        Effect.forkChild
      )

      yield* Deferred.await(archiveSent)
      yield* Fiber.interrupt(fiber)

      const exit = yield* Fiber.await(fiber)

      expect(Exit.hasInterrupts(exit)).toBe(true)
      expect(exchangeIndices(yield* ledger.entries)).toEqual([
        'POST 0',
        'PATCH 1',
        'GET 2',
        'PATCH 3'
      ])
      expect(yield* ledger.remaining).toEqual([])
    })
  )

  it.effect('a trashed page that reads back 404 fails the claim, not the restore', () =>
    Effect.gen(function* () {
      const gone: WireExchange = {
        request: readExchange.request,
        response: withStatus(404, objectNotFound)(readExchange.response)
      }

      const { failure, entries, remaining } = yield* drill(notionArchiveInTrashCase, {
        ...notionArchiveInTrashFixture,
        exchanges: [createExchange, archiveExchange, gone]
      })

      expect(failure).toEqual(
        mismatch('expected get_page of the archived page to still answer (not 404)')
      )
      expect(exchangeIndices(entries)).toEqual(['POST 0', 'PATCH 1', 'GET 2'])
      expect(remaining).toEqual([])
    })
  )

  it.effect('after a successful archive, a 404 read in the restore counts as trashed', () =>
    Effect.gen(function* () {
      // The archive answers without trash flags, so the restore still checks; the page reads 404.
      const flagless: WireExchange = {
        request: archiveExchange.request,
        response: {
          status: 200,
          headers: archiveExchange.response.headers,
          body: JSON.stringify({ object: 'page', id: '1f0000e0-0000-4000-8000-000000000001' })
        }
      }

      const gone: WireExchange = {
        request: readExchange.request,
        response: withStatus(404, objectNotFound)(readExchange.response)
      }

      const { failure, entries } = yield* drill(notionArchiveInTrashCase, {
        ...notionArchiveInTrashFixture,
        exchanges: [createExchange, flagless, gone]
      })

      expect(failure).toEqual(mismatch('expected the archive response to report archived true'))
      expect(exchangeIndices(entries)).toEqual(['POST 0', 'PATCH 1', 'GET 2'])
    })
  )

  it.effect('refuses a property id without a percent escape before any request', () =>
    Effect.gen(function* () {
      const { failure, entries } = yield* drill(
        notionPropertyItemPagingCase,
        notionPropertyItemPagingFixture,
        { ...notionConformanceFixtureSeeds, propertyId: 'title' }
      )

      expect(failure).toEqual(
        mismatch(
          'precondition: propertyId must contain a %XX escape (exactly as the page returns it), so the second percent-encoding is exercised'
        )
      )
      expect(entries).toEqual([])
    })
  )

  it.effect('sends the property id percent-encoded again and fails when Notion rejects it', () =>
    Effect.gen(function* () {
      const rejected = replaceResponse(
        notionPropertyItemPagingFixture,
        1,
        withStatus(404, objectNotFound)
      )

      const { failure, entries } = yield* drill(notionPropertyItemPagingCase, rejected)

      expect(failure).toEqual(
        mismatch('expected Notion to accept the property id percent-encoded again (HTTP 404)')
      )
      expect(entries.map(entry => entry.url)).toEqual([
        'https://api.notion.com/v1/pages/1f000000-0000-4000-8000-000000000003',
        'https://api.notion.com/v1/pages/1f000000-0000-4000-8000-000000000003/properties/Syn%253Ap?page_size=2'
      ])
    })
  )

  it.effect('refuses a property id the seeded page does not return', () =>
    Effect.gen(function* () {
      const { failure, entries } = yield* drill(
        notionPropertyItemPagingCase,
        notionPropertyItemPagingFixture,
        { ...notionConformanceFixtureSeeds, propertyId: 'Other%3Aq' }
      )

      expect(failure).toEqual(
        mismatch(
          'precondition: propertyId must be a property id of propertyPageId exactly as the page returns it'
        )
      )
      expect(exchangeIndices(entries)).toEqual(['GET 0'])
    })
  )

  it.effect('fails with a precondition before any request when a seed is missing', () =>
    Effect.gen(function* () {
      const { searchQuery: _dropped, ...seeds } = notionConformanceFixtureSeeds

      const { failure, entries } = yield* drill(
        notionSearchPagingCase,
        notionSearchPagingFixture,
        seeds
      )

      expect(failure).toEqual(
        mismatch('precondition: NotionConformanceConfig.searchQuery is not configured')
      )
      expect(entries).toEqual([])
    })
  )
})

describe('Notion conformance interruption reporting', () => {
  it.effect('reports a failed archive restore when the case is interrupted mid-archive', () =>
    Effect.gen(function* () {
      const archiveSent = yield* Deferred.make<void>()
      const releaseArchive = yield* Deferred.make<void>()
      const warnings = yield* Ref.make<ReadonlyArray<string>>([])

      const failedArchive = {
        ...archiveExchange,
        response: withStatus(500, serverError)(archiveExchange.response)
      }

      // The claim's archive (1) and the restore's archive (3) both answer 500.
      const { client } = yield* makeReplayHttpClient([
        {
          ...notionArchiveInTrashFixture,
          exchanges: [createExchange, failedArchive, untrashedRead, failedArchive]
        }
      ])

      let archives = 0

      // Hold the claim's archive response until the case fiber has been asked to stop.
      const holdingArchive = HttpClient.transform(client, (response, request) =>
        request.method === 'PATCH' && archives++ === 0
          ? response.pipe(
              Effect.tap(() => Deferred.succeed(archiveSent, undefined)),
              Effect.tap(() => Deferred.await(releaseArchive))
            )
          : response
      )

      const fiber = yield* notionArchiveInTrashCase.run.pipe(
        Effect.provide(portsOver(Layer.succeed(HttpClient.HttpClient, holdingArchive))),
        Effect.provideService(ConformanceCleanupReporter, {
          warn: message => Ref.update(warnings, list => [...list, message])
        }),
        Effect.forkChild
      )

      yield* Deferred.await(archiveSent)

      const interrupting = yield* Effect.forkChild(Fiber.interrupt(fiber))

      yield* Effect.yieldNow
      yield* Deferred.succeed(releaseArchive, undefined)
      yield* Fiber.join(interrupting)
      yield* Fiber.await(fiber)

      const reported = yield* Ref.get(warnings)

      // Whatever the fiber's exit, the owner sees the failed restore and what to do by hand.
      expect(reported).toHaveLength(1)
      expect(reported[0]).toContain(
        'notion.pages.archive-in-trash: restore failed; trash the case-created page by hand if it is not trashed yet'
      )
    })
  )
})

describe('Notion conformance leftover detection (read-only)', () => {
  const page = (id: string, title: string, trashed: boolean) => ({
    object: 'page',
    id,
    archived: trashed,
    in_trash: trashed,
    properties: {
      title: {
        id: 'title',
        type: 'title',
        title: [
          { type: 'text', text: { content: title, link: null }, plain_text: title, href: null }
        ]
      }
    }
  })

  const leftoversFixture: WireFixture = {
    id: 'notion.leftovers.synthetic',
    caseId: 'notion.leftovers',
    evidence: 'unverified',
    recordedAt: '2026-09-30',
    account: 'synthetic',
    endpoint: 'https://api.notion.com/v1',
    exchanges: [
      {
        request: {
          method: 'POST',
          url: 'https://api.notion.com/v1/search',
          headers: { 'content-type': 'application/json', 'notion-version': '2025-09-03' },
          body: {
            query: 'yolk-conformance',
            filter: { property: 'object', value: 'page' },
            page_size: 100
          }
        },
        response: {
          status: 200,
          headers: { 'content-type': 'application/json; charset=utf-8' },
          body: JSON.stringify({
            object: 'list',
            results: [
              page(
                '1f0000f0-0000-4000-8000-000000000001',
                'yolk-conformance page: safe to delete',
                false
              ),
              page(
                '1f0000f0-0000-4000-8000-000000000002',
                'yolk-conformance page: safe to delete',
                true
              ),
              page('1f0000f0-0000-4000-8000-000000000003', 'Notes about yolk-conformance', false)
            ],
            next_cursor: null,
            has_more: false
          })
        }
      }
    ]
  }

  it.effect('lists untrashed case pages earlier runs left behind, and nothing else', () =>
    Effect.gen(function* () {
      const { client, ledger } = yield* makeReplayHttpClient([leftoversFixture])

      const found = yield* findNotionConformanceLeftovers.pipe(
        Effect.provide(portsOver(Layer.succeed(HttpClient.HttpClient, client)))
      )

      expect(found).toEqual([
        'yolk-conformance page: safe to delete (1f0000f0-0000-4000-8000-000000000001)'
      ])
      expect((yield* ledger.entries).map(entry => entry.method)).toEqual(['POST'])
    })
  )
})
