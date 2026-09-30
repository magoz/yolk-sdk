import { describe, expect, it } from '@effect/vitest'
import { Effect, Exit, Fiber, Deferred, Layer, Ref } from 'effect'
import { TestClock } from 'effect/testing'
import { HttpClient, HttpClientError } from 'effect/unstable/http'
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
import { BearerTokenCredential } from '@yolk-sdk/connectors'
import {
  connectorHttpClientsFromEffectHttpClientLayer,
  staticCredentialResolverLayer
} from '@yolk-sdk/connectors/conformance'
import { DropboxConnector } from '@yolk-sdk/connectors/dropbox'
import {
  DropboxConformanceConfig,
  dropboxConformanceCases,
  dropboxConformanceFixtureSeeds,
  dropboxConformanceFixtures,
  dropboxCopyMoveMetadataCase,
  dropboxCopyMoveMetadataFixture,
  dropboxCreateFolderConflictCase,
  dropboxCreateFolderConflictFixture,
  dropboxDeleteThenNotFoundFixture,
  dropboxListFolderPagingCase,
  dropboxListFolderPagingFixture,
  dropboxNotFoundEnvelopeFixture,
  dropboxPathLowerLookupFixture,
  dropboxSearchContinueFixture,
  dropboxUploadRevPreconditionCase,
  dropboxUploadRevPreconditionFixture,
  type DropboxConformanceCase,
  type DropboxConformanceSeeds
} from '@yolk-sdk/connectors/dropbox/conformance'

const now = new Date('2026-09-30T12:00:00.000Z')

const atTestNow = TestClock.setTime(now.getTime())

const credentialLayer = staticCredentialResolverLayer(
  BearerTokenCredential.make({ token: 'synthetic-dropbox-access-token' })
)

const portsOver = (
  httpLayer: Layer.Layer<HttpClient.HttpClient>,
  seeds: DropboxConformanceSeeds = dropboxConformanceFixtureSeeds
) =>
  Layer.mergeAll(
    connectorHttpClientsFromEffectHttpClientLayer.pipe(Layer.provide(httpLayer)),
    credentialLayer,
    Layer.succeed(DropboxConformanceConfig, seeds)
  )

const fixturesFor = (
  testCase: Pick<ConformanceCase<unknown, unknown>, 'fixtures'>,
  fixtures: ReadonlyArray<WireFixture> = dropboxConformanceFixtures
) => fixtures.filter(fixture => testCase.fixtures.includes(fixture.id))

const replayLayerOver =
  (fixtures: ReadonlyArray<WireFixture> = dropboxConformanceFixtures) =>
  (testCase: DropboxConformanceCase) =>
    portsOver(ReplayHttpClient.layer(fixturesFor(testCase, fixtures)))

/** Replay layer that also hands its ledger to the test, keyed by case id. */
const ledgerCaseLayer =
  (
    ledgers: Ref.Ref<Map<string, ReplayLedgerApi>>,
    fixtures: ReadonlyArray<WireFixture> = dropboxConformanceFixtures,
    seeds: DropboxConformanceSeeds = dropboxConformanceFixtureSeeds
  ) =>
  (testCase: DropboxConformanceCase) =>
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

/** `METHOD route exchangeIndex` per ledger entry. */
const exchangeIndices = (entries: ReadonlyArray<ReplayLedgerEntry>) =>
  entries.map(entry =>
    entry.match.outcome === 'matched'
      ? `${entry.url.slice(entry.url.indexOf('/2/') + 3)} ${entry.match.exchangeIndex}`
      : `unmatched ${entry.url}`
  )

const synthetic = (id: string) => `${id}.synthetic`

const caseIds = [
  ['dropbox.files.list-folder-cursor-paging', 'read'],
  ['dropbox.files.path-lower-lookup', 'read'],
  ['dropbox.files.search-continue', 'read'],
  ['dropbox.errors.not-found-409-envelope', 'read'],
  ['dropbox.files.create-folder-conflict', 'write-reversible'],
  ['dropbox.files.delete-then-not-found', 'write-reversible'],
  ['dropbox.files.copy-move-metadata', 'write-reversible'],
  ['dropbox.files.upload-rev-precondition', 'write-reversible']
] as const

const dropboxOrigins = ['https://api.dropboxapi.com/2/', 'https://content.dropboxapi.com/2/']

describe('Dropbox conformance cases', () => {
  it('declare their safety, stay unverified, and are backed by one fixture each', () => {
    expect(dropboxConformanceCases.map(testCase => [testCase.id, testCase.safety])).toEqual(
      caseIds.map(([id, safety]) => [id, safety])
    )
    expect(dropboxConformanceFixtures.map(fixture => fixture.caseId)).toEqual(
      dropboxConformanceCases.map(testCase => testCase.id)
    )

    for (const testCase of dropboxConformanceCases) {
      expect(testCase.observed).toBeUndefined()
      expect(testCase.fixtures).toEqual([synthetic(testCase.id)])
    }
  })

  it('cite only real connector actions or the host-only upload helpers', () => {
    const actionIds = new Set(DropboxConnector.actions.map(action => action.id))

    for (const testCase of dropboxConformanceCases) {
      const cited = [...testCase.docs.matchAll(/`(dropbox\.[a-z_]+)`/g)].map(match => match[1])

      expect(cited.every(id => id !== undefined && actionIds.has(id))).toBe(true)
    }

    expect(dropboxUploadRevPreconditionCase.docs).toContain('`createDropboxFile`')
    expect(dropboxUploadRevPreconditionCase.docs).toContain('`updateDropboxFile`')
  })

  it.effect('ship synthetic fixtures that decode and pass the secret scan', () =>
    Effect.gen(function* () {
      for (const fixture of dropboxConformanceFixtures) {
        expect(yield* decodeWireFixture(fixture)).toEqual(fixture)
        expect(scanFixtureForSecrets(fixture)).toEqual([])
        expect(fixture).toMatchObject({ evidence: 'unverified', account: 'synthetic' })

        for (const { request, response } of fixture.exchanges) {
          expect(Object.keys(request.headers ?? {})).not.toContain('authorization')
          expect(dropboxOrigins.some(origin => request.url.startsWith(origin))).toBe(true)

          if (response.status >= 400) {
            // Dropbox route errors: HTTP 409 with { error_summary, error: { ".tag" } }.
            expect(response.status).toBe(409)
            expect(JSON.parse(textBody(response))).toMatchObject({
              error_summary: expect.any(String),
              error: { '.tag': expect.any(String) }
            })
          }
        }
      }
    })
  )

  it.effect('all pass on replay with unverified warnings', () =>
    Effect.gen(function* () {
      yield* atTestNow

      const report = yield* runConformance(dropboxConformanceCases, {
        target: { kind: 'replay' },
        now,
        fixtures: dropboxConformanceFixtures,
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

      const report = yield* runConformance(dropboxConformanceCases, {
        target: { kind: 'replay' },
        now,
        layer: ledgerCaseLayer(ledgers)
      })

      expect(report.summary.passed).toBe(8)

      for (const testCase of dropboxConformanceCases) {
        const { entries, remaining } = yield* ledgerOf(ledgers, testCase.id)
        const [fixture] = fixturesFor(testCase)

        if (fixture === undefined) {
          return expect.fail(`no fixture for ${testCase.id}`)
        }

        expect(remaining).toEqual([])
        expect(entries).toHaveLength(fixture.exchanges.length)

        entries.forEach((entry, index) => {
          const exchange: WireExchange | undefined = fixture.exchanges[index]
          const recordedBody = exchange?.request.body

          expect(entry.match).toEqual({
            outcome: 'matched',
            fixtureId: fixture.id,
            exchangeIndex: index
          })
          // Uploads send raw bytes; RPC requests send JSON.
          expect(entry.bodyJson ?? entry.bodyText).toEqual(recordedBody)
          expect(entry.headers).toMatchObject(exchange?.request.headers ?? {})
          expect(entry.headers.authorization).toBe('<redacted>')
        })
      }
    })
  )

  it.effect('send strict add and rev-update uploads with no rename', () =>
    Effect.gen(function* () {
      yield* atTestNow

      const ledgers = yield* Ref.make(new Map<string, ReplayLedgerApi>())

      yield* runConformance([dropboxUploadRevPreconditionCase], {
        target: { kind: 'replay' },
        now,
        layer: ledgerCaseLayer(ledgers)
      })

      const { entries } = yield* ledgerOf(ledgers, dropboxUploadRevPreconditionCase.id)

      const args = entries
        .filter(entry => entry.url === 'https://content.dropboxapi.com/2/files/upload')
        .map(entry => JSON.parse(entry.headers['dropbox-api-arg'] ?? 'null'))

      expect(args.map(arg => [arg.mode, arg.autorename, arg.strict_conflict])).toEqual([
        ['add', false, true],
        [{ '.tag': 'update', update: 'a1b2c3d4e5f60040' }, false, true],
        [{ '.tag': 'update', update: 'a1b2c3d4e5f60040' }, false, true],
        ['add', false, true]
      ])
    })
  )
})

describe('Dropbox conformance safety on a live target', () => {
  // A replay layer under a `live` target proves the policy without any network.
  const statuses = (target: ConformanceTarget) =>
    atTestNow.pipe(
      Effect.andThen(
        runConformance(dropboxConformanceCases, { target, now, layer: replayLayerOver() })
      ),
      Effect.map(report =>
        report.results.map(result => [result.id, result.status, result.skipReason ?? null])
      )
    )

  it.effect('runs only the read cases by default and skips every write', () =>
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

  it('has no write-irreversible case', () => {
    expect(dropboxConformanceCases.some(testCase => testCase.safety === 'write-irreversible')).toBe(
      false
    )
  })
})

// Drills: replay a fixture that contradicts a claim, or drop it, and check that exactly that case
// fails (and, for write cases, still removes what it created).

function textBody(response: WireResponse): string {
  if (isWireStreamResponse(response) || isWireBase64BodyResponse(response)) {
    return expect.fail('expected a text body')
  }

  return response.body
}

/** Replace exchange `index`'s response, keeping the fixture id so the case still selects it. */
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

/** A copy of `fixture` (same id) without the exchanges at `indices`. */
const withoutExchanges = (fixture: WireFixture, indices: ReadonlyArray<number>): WireFixture => {
  const [first, ...rest] = fixture.exchanges.filter((_, index) => !indices.includes(index))

  return first === undefined
    ? expect.fail(`no exchanges left in ${fixture.id}`)
    : { ...fixture, exchanges: [first, ...rest] }
}

/** Replace the first occurrence of `from` in a text body, failing if it is not there. */
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

const notFoundBody =
  '{"error_summary": "path/not_found/.", "error": {".tag": "path", "path": {".tag": "not_found"}}}'

const serverError = '{"error_summary": "internal_error/.", "error": {".tag": "internal_error"}}'

const mismatch = (message: string) => ({ kind: 'failure', tag: 'ConformanceMismatch', message })

/** Run the whole suite on replay with `fixtures`; return the failed case ids and failures. */
const suiteFailures = (fixtures: ReadonlyArray<WireFixture>) =>
  Effect.gen(function* () {
    yield* atTestNow

    const report = yield* runConformance(dropboxConformanceCases, {
      target: { kind: 'replay' },
      now,
      layer: replayLayerOver(fixtures)
    })

    return report.results
      .filter(result => result.status === 'failed')
      .map(result => ({ id: result.id, failure: result.failure }))
  })

const withReplaced = (tampered: WireFixture) =>
  dropboxConformanceFixtures.map(fixture => (fixture.id === tampered.id ? tampered : fixture))

/** One tamper per case: the fixture edit and the mismatch the case reports. */
const tampers: ReadonlyArray<{
  readonly fixture: WireFixture
  readonly message: string
}> = [
  {
    fixture: replaceResponse(
      dropboxListFolderPagingFixture,
      1,
      replaceInBody(
        '"path_lower":"/conformance/paging/paging-three.txt"',
        '"path_lower":"/conformance/paging/paging-one.txt"'
      )
    ),
    message: 'expected list_folder/continue to repeat no entry from an earlier page'
  },
  {
    fixture: replaceResponse(
      dropboxPathLowerLookupFixture,
      1,
      replaceInBody('"id":"id:SyntheticMixedCaseFile01"', '"id":"id:SyntheticOtherFile000001"')
    ),
    message: 'expected the lower-cased lookup to return the same entry id'
  },
  {
    fixture: replaceResponse(
      dropboxSearchContinueFixture,
      1,
      withStatus(200, '{"matches":[],"has_more":false}')
    ),
    message: 'expected search/continue_v2 to return further matches'
  },
  {
    fixture: replaceResponse(dropboxNotFoundEnvelopeFixture, 0, withStatus(404, notFoundBody)),
    message: 'expected HTTP 409 for a missing path'
  },
  {
    fixture: replaceResponse(dropboxCreateFolderConflictFixture, 3, response => ({
      status: 200,
      headers: response.headers,
      body: textBody(dropboxCreateFolderConflictFixture.exchanges[1]?.response ?? response)
    })),
    message:
      'expected creating the folder name upper-cased to fail with dropbox_conflict (HTTP 409)'
  },
  {
    fixture: replaceResponse(
      dropboxDeleteThenNotFoundFixture,
      4,
      replaceInBody('{".tag":"deleted",', '{".tag":"folder","id":"id:SyntheticDeleteFolder01",')
    ),
    message: 'expected get_metadata with include_deleted to return deleted metadata'
  },
  {
    fixture: replaceResponse(
      dropboxCopyMoveMetadataFixture,
      4,
      replaceInBody('"id":"id:SyntheticCopiedFile0001"', '"id":"id:SyntheticOtherFile000002"')
    ),
    message: 'expected the moved file to keep its id'
  },
  {
    // The stale update succeeds: the case stops there (no second add, no file lookup) and restores.
    fixture: withoutExchanges(
      replaceResponse(dropboxUploadRevPreconditionFixture, 4, response => ({
        status: 200,
        headers: response.headers,
        body: textBody(dropboxUploadRevPreconditionFixture.exchanges[3]?.response ?? response)
      })),
      [5, 6]
    ),
    message: 'expected an update naming a stale rev to fail with conflict (HTTP 409)'
  }
]

describe('Dropbox conformance drills (one per case)', () => {
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
          dropboxConformanceFixtures.filter(fixture => fixture.caseId !== caseId)
        )

        expect(failures.map(failure => failure.id)).toEqual([caseId])
      })
    )
  }
})

const drill = (
  testCase: DropboxConformanceCase,
  fixture: WireFixture,
  seeds: DropboxConformanceSeeds = dropboxConformanceFixtureSeeds
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

describe('Dropbox conformance restore', () => {
  it.effect('still deletes the case folder when a claim fails mid-flow', () =>
    Effect.gen(function* () {
      const { entries, remaining } = yield* drill(
        dropboxCreateFolderConflictCase,
        tampers[4]?.fixture ?? expect.fail('missing tamper')
      )

      expect(exchangeIndices(entries)).toEqual([
        'files/get_metadata 0',
        'files/create_folder_v2 1',
        'files/create_folder_v2 2',
        'files/create_folder_v2 3',
        'files/delete_v2 4',
        'files/get_metadata 5'
      ])
      expect(remaining).toEqual([])
    })
  )

  it.effect('reports a failed restore instead of swallowing it', () =>
    Effect.gen(function* () {
      const undeleted = replaceResponse(
        dropboxCopyMoveMetadataFixture,
        5,
        withStatus(500, serverError)
      )

      const { failure } = yield* drill(dropboxCopyMoveMetadataCase, undeleted)

      expect(failure?.tag).toBe('DropboxConformanceRestoreFailed')
      expect(failure?.message).toBe(
        'dropbox.files.copy-move-metadata: restore failed; delete the case-created folder by hand if it still exists (its name starts with yolk-conformance, under workFolderPath). Restore error: dropbox.delete dropbox_delete_failed 500. Claim held first.'
      )
    })
  )

  it.effect('reports both a failed claim and a failed restore', () =>
    Effect.gen(function* () {
      // The stale-rev tamper (the claim fails), and its restore delete (5) answers 500.
      const both = replaceResponse(
        tampers[7]?.fixture ?? expect.fail('missing tamper'),
        5,
        withStatus(500, serverError)
      )

      const { failure } = yield* drill(dropboxUploadRevPreconditionCase, both)

      expect(failure?.tag).toBe('DropboxConformanceRestoreFailed')
      expect(failure?.message).toContain('Restore error: dropbox.delete dropbox_delete_failed 500.')
      expect(failure?.message).toContain('Claim failed first: expected an update naming a stale')
      expect(failure?.message.length).toBeLessThanOrEqual(300)
    })
  )

  it.effect('fails the restore when the folder is still found after deleting it', () =>
    Effect.gen(function* () {
      const stillThere = replaceResponse(dropboxCreateFolderConflictFixture, 5, response => ({
        status: 200,
        headers: response.headers,
        body: JSON.stringify({
          '.tag': 'folder',
          name: 'yolk-conformance-folder',
          path_lower: '/conformance/work/yolk-conformance-folder',
          path_display: '/Conformance/Work/yolk-conformance-folder',
          id: 'id:SyntheticConflictFolder1'
        })
      }))

      const { failure } = yield* drill(dropboxCreateFolderConflictCase, stillThere)

      expect(failure?.tag).toBe('DropboxConformanceRestoreFailed')
      expect(failure?.message).toContain(
        'Restore error: expected get_metadata of the case-created folder to answe...'
      )
      expect(failure?.message).toContain('Claim held first.')
    })
  )

  it.effect('deletes the path even when the create itself failed', () =>
    Effect.gen(function* () {
      const [absent, , , , deleted, gone] = dropboxCreateFolderConflictFixture.exchanges

      if (absent === undefined || deleted === undefined || gone === undefined) {
        return expect.fail('expected six exchanges')
      }

      const created = dropboxCreateFolderConflictFixture.exchanges[1]

      if (created === undefined) {
        return expect.fail('expected a create exchange')
      }

      const fixture: WireFixture = {
        ...dropboxCreateFolderConflictFixture,
        exchanges: [
          absent,
          { request: created.request, response: withStatus(500, serverError)(created.response) },
          { request: deleted.request, response: withStatus(409, notFoundBody)(deleted.response) },
          gone
        ]
      }

      const { failure, entries, remaining } = yield* drill(dropboxCreateFolderConflictCase, fixture)

      expect(failure).toEqual({
        kind: 'failure',
        tag: 'DropboxConformanceActionFailed',
        message: 'dropbox.create_folder failed: dropbox_create_folder_failed (HTTP 500)'
      })
      expect(exchangeIndices(entries)).toEqual([
        'files/get_metadata 0',
        'files/create_folder_v2 1',
        'files/delete_v2 2',
        'files/get_metadata 3'
      ])
      expect(remaining).toEqual([])
    })
  )

  it.effect('refuses to write when the case folder already exists', () =>
    Effect.gen(function* () {
      const exists = replaceResponse(
        dropboxCreateFolderConflictFixture,
        0,
        withStatus(
          200,
          '{".tag":"folder","name":"yolk-conformance-folder","id":"id:SyntheticLeftoverFolder"}'
        )
      )

      const { failure, entries } = yield* drill(
        dropboxCreateFolderConflictCase,
        withoutExchanges(exists, [1, 2, 3, 4, 5])
      )

      expect(failure).toEqual(
        mismatch(
          'precondition: a Dropbox entry already exists at the case folder yolk-conformance-folder under workFolderPath (left by an earlier run?); delete it by hand; nothing was written'
        )
      )
      expect(exchangeIndices(entries)).toEqual(['files/get_metadata 0'])
    })
  )

  it.effect('fails with a precondition before any request when a seed is missing', () =>
    Effect.gen(function* () {
      const { pagingFolderPath: _dropped, ...seeds } = dropboxConformanceFixtureSeeds

      const { failure, entries } = yield* drill(
        dropboxListFolderPagingCase,
        dropboxListFolderPagingFixture,
        seeds
      )

      expect(failure).toEqual(
        mismatch('precondition: DropboxConformanceConfig.pagingFolderPath is not configured')
      )
      expect(entries).toEqual([])
    })
  )

  it.effect('removes the case folder when the case is interrupted mid-flow', () =>
    Effect.gen(function* () {
      const copySent = yield* Deferred.make<void>()

      const { client, ledger } = yield* makeReplayHttpClient([dropboxCopyMoveMetadataFixture])

      // Hold the copy response until the case fiber is interrupted.
      const holdingCopy = HttpClient.transform(client, (response, request) =>
        request.url.endsWith('/files/copy_v2')
          ? response.pipe(
              Effect.tap(() => Deferred.succeed(copySent, undefined)),
              Effect.andThen(Effect.never)
            )
          : response
      )

      const fiber = yield* dropboxCopyMoveMetadataCase.run.pipe(
        Effect.provide(portsOver(Layer.succeed(HttpClient.HttpClient, holdingCopy))),
        Effect.forkChild
      )

      yield* Deferred.await(copySent)
      yield* Fiber.interrupt(fiber)

      const exit = yield* Fiber.await(fiber)

      expect(Exit.hasInterrupts(exit)).toBe(true)
      expect(exchangeIndices(yield* ledger.entries)).toEqual([
        'files/get_metadata 0',
        'files/get_metadata 1',
        'files/create_folder_v2 2',
        'files/copy_v2 3',
        'files/delete_v2 5',
        'files/get_metadata 6'
      ])
    })
  )

  it.effect('reports a transport failure without a status', () =>
    Effect.gen(function* () {
      const dropping = HttpClient.make(request =>
        Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request, description: 'connection reset' })
          })
        )
      )

      const report = yield* runConformance([dropboxListFolderPagingCase], {
        target: { kind: 'replay' },
        now,
        layer: () => portsOver(Layer.succeed(HttpClient.HttpClient, dropping))
      })

      expect(report.results[0]?.failure).toMatchObject({
        kind: 'failure',
        tag: 'ConnectorError'
      })
    })
  )
})
