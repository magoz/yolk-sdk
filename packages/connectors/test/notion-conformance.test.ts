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
  notionDataSourceSplitFixture,
  notionErrorEnvelopeFixture,
  notionPropertyItemPagingFixture,
  notionSearchPagingCase,
  notionSearchPagingFixture,
  notionTitlePlainTextFixture,
  notionVersionHeaderCase,
  notionVersionHeaderFixture,
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
  ['notion.api.version-header-required', 'read'],
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

    expect(notionVersionHeaderCase.docs).toContain('No action omits the header')
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

  it.effect('send Notion-Version on every action request and omit it only on the raw one', () =>
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

        entries.forEach((entry, index) => {
          const raw = testCase.id === notionVersionHeaderCase.id && index === 0

          expect(entry.headers['notion-version']).toBe(raw ? undefined : '2025-09-03')
        })
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
    fixture: replaceResponse(notionVersionHeaderFixture, 0, response => ({
      status: 200,
      headers: response.headers,
      body: textBody(notionVersionHeaderFixture.exchanges[1]?.response ?? response)
    })),
    message: 'expected notion.conformance.unversioned_get without Notion-Version to answer HTTP 400'
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
      1,
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
      replaceInBody('"in_trash":true', '"in_trash":false')
    ),
    message: 'expected the archive response to report archived true and in_trash true'
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
          archiveExchange,
          readExchange
        ]
      }

      const { failure, entries, remaining } = yield* drill(notionArchiveInTrashCase, fixture)

      expect(failure).toEqual({
        kind: 'failure',
        tag: 'NotionConformanceActionFailed',
        message: 'notion.update_page failed: notion_update_page_failed (HTTP 500)'
      })
      expect(exchangeIndices(entries)).toEqual(['POST 0', 'PATCH 1', 'GET 2', 'PATCH 3', 'GET 4'])
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
          exchanges: [createExchange, archiveExchange, untrashedRead, archiveExchange, readExchange]
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
        'PATCH 3',
        'GET 4'
      ])
      expect(yield* ledger.remaining).toEqual([])
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
