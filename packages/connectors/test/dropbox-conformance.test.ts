import { describe, expect, it } from '@effect/vitest'
import { Deferred, Effect, Exit, Fiber, Layer, Option, Predicate, Ref } from 'effect'
import * as Schema from 'effect/Schema'
import { TestClock } from 'effect/testing'
import {
  HttpClient,
  HttpClientError,
  HttpClientResponse,
  type HttpClientRequest
} from 'effect/unstable/http'
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
  ConformanceCleanupReporter,
  connectorHttpClientsFromEffectHttpClientLayer,
  staticCredentialResolverLayer
} from '@yolk-sdk/connectors/conformance'
import { DropboxConnector } from '@yolk-sdk/connectors/dropbox'
import {
  DropboxConformanceConfig,
  DropboxConformanceSeeds as DropboxConformanceSeedsSchema,
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
  findDropboxConformanceLeftovers,
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

/** A copy of `fixture` (same id) with `extra` inserted after exchange `index`. */
const insertAfter = (fixture: WireFixture, index: number, extra: WireExchange): WireFixture => {
  const [first, ...rest] = fixture.exchanges.flatMap((exchange, position) =>
    position === index ? [exchange, extra] : [exchange]
  )

  return first === undefined
    ? expect.fail('no exchanges')
    : { ...fixture, exchanges: [first, ...rest] }
}

const exchangeAt = (fixture: WireFixture, index: number): WireExchange =>
  fixture.exchanges[index] ?? expect.fail(`no exchange ${index} in ${fixture.id}`)

/** A `delete_v2` by the owned path (the fallback after a refused id delete). */
const deleteByPath = (path: string, response: WireResponse): WireExchange => ({
  request: {
    method: 'POST',
    url: 'https://api.dropboxapi.com/2/files/delete_v2',
    headers: { 'content-type': 'application/json' },
    body: { path }
  },
  response
})

const copyFolder = '/Conformance/Work/yolk-conformance-run-synthetic-copy'

const conflictFolder = '/Conformance/Work/yolk-conformance-run-synthetic-folder'

const malformedPathBody =
  '{"error_summary": "path_lookup/malformed_path/.", "error": {".tag": "path_lookup", "path_lookup": {".tag": "malformed_path"}}}'

const deleteBodies = (entries: ReadonlyArray<ReplayLedgerEntry>) =>
  entries.flatMap(entry => (entry.url.endsWith('/files/delete_v2') ? [entry.bodyJson] : []))

describe('Dropbox conformance restore', () => {
  it.effect('still deletes the case folder, by id, when a claim fails mid-flow', () =>
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
      expect(deleteBodies(entries)).toEqual([{ path: 'id:SyntheticConflictFolder1' }])
      expect(remaining).toEqual([])
    })
  )

  it.effect('falls back to the owned path when the id delete is refused', () =>
    Effect.gen(function* () {
      yield* atTestNow

      const fixture = insertAfter(
        replaceResponse(dropboxCopyMoveMetadataFixture, 5, withStatus(409, malformedPathBody)),
        5,
        deleteByPath(copyFolder, {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: textBody(exchangeAt(dropboxCopyMoveMetadataFixture, 5).response)
        })
      )

      const ledgers = yield* Ref.make(new Map<string, ReplayLedgerApi>())

      const report = yield* runConformance([dropboxCopyMoveMetadataCase], {
        target: { kind: 'replay' },
        now,
        layer: ledgerCaseLayer(ledgers, [fixture])
      })

      const { entries, remaining } = yield* ledgerOf(ledgers, dropboxCopyMoveMetadataCase.id)

      expect(report.summary.passed).toBe(1)
      expect(deleteBodies(entries)).toEqual([
        { path: 'id:SyntheticCopyFolder0001' },
        { path: copyFolder }
      ])
      expect(remaining).toEqual([])
    })
  )

  it.effect('reports a failed restore, naming the path, instead of swallowing it', () =>
    Effect.gen(function* () {
      const undeleted = insertAfter(
        replaceResponse(dropboxCopyMoveMetadataFixture, 5, withStatus(500, serverError)),
        5,
        deleteByPath(copyFolder, {
          status: 500,
          headers: { 'content-type': 'application/json' },
          body: serverError
        })
      )

      const { failure } = yield* drill(dropboxCopyMoveMetadataCase, undeleted)

      expect(failure?.tag).toBe('DropboxConformanceRestoreFailed')
      expect(failure?.message).toBe(
        `dropbox.files.copy-move-metadata: restore failed; delete ${copyFolder} by hand if it still exists. Restore error: dropbox.delete dropbox_delete_failed 500. Claim held first.`
      )
    })
  )

  it.effect('reports both a failed claim and a failed restore', () =>
    Effect.gen(function* () {
      // The stale-rev tamper (the claim fails); its restore id delete (5) and path delete answer 500.
      const both = insertAfter(
        replaceResponse(
          tampers[7]?.fixture ?? expect.fail('missing tamper'),
          5,
          withStatus(500, serverError)
        ),
        5,
        deleteByPath('/Conformance/Work/yolk-conformance-run-synthetic-upload', {
          status: 500,
          headers: { 'content-type': 'application/json' },
          body: serverError
        })
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
          name: 'yolk-conformance-run-synthetic-folder',
          path_lower: '/conformance/work/yolk-conformance-run-synthetic-folder',
          path_display: conflictFolder,
          id: 'id:SyntheticConflictFolder1'
        })
      }))

      const { failure } = yield* drill(dropboxCreateFolderConflictCase, stillThere)

      expect(failure?.tag).toBe('DropboxConformanceRestoreFailed')
      expect(failure?.message).toContain(`delete ${conflictFolder} by hand if it still exists`)
      expect(failure?.message).toContain(
        'Restore error: expected get_metadata of the case-created folder to answe...'
      )
      expect(failure?.message).toContain('Claim held first.')
    })
  )

  it.effect('refuses to write when the case folder already exists', () =>
    Effect.gen(function* () {
      const exists = replaceResponse(
        dropboxCreateFolderConflictFixture,
        0,
        withStatus(
          200,
          '{".tag":"folder","name":"yolk-conformance-run-synthetic-folder","id":"id:SyntheticLeftoverFolder"}'
        )
      )

      const { failure, entries } = yield* drill(
        dropboxCreateFolderConflictCase,
        withoutExchanges(exists, [1, 2, 3, 4, 5])
      )

      expect(failure).toEqual(
        mismatch(
          'precondition: a Dropbox entry already exists at the case folder yolk-conformance-run-synthetic-folder under workFolderPath; delete it by hand; nothing was written'
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

  it.effect('refuses every write case before any request without a run id', () =>
    Effect.gen(function* () {
      const { runId: _dropped, ...seeds } = dropboxConformanceFixtureSeeds

      const { failure, entries } = yield* drill(
        dropboxCreateFolderConflictCase,
        dropboxCreateFolderConflictFixture,
        seeds
      )

      expect(failure).toEqual(
        mismatch('precondition: DropboxConformanceConfig.runId is not configured')
      )
      expect(entries).toEqual([])
    })
  )

  it.effect('finishes a masked in-flight copy, then removes the case folder on interruption', () =>
    Effect.gen(function* () {
      const copySent = yield* Deferred.make<void>()
      const releaseCopy = yield* Deferred.make<void>()

      const { client, ledger } = yield* makeReplayHttpClient([dropboxCopyMoveMetadataFixture])

      // Hold the copy response until the case fiber has been asked to stop.
      const holdingCopy = HttpClient.transform(client, (response, request) =>
        request.url.endsWith('/files/copy_v2')
          ? response.pipe(
              Effect.tap(() => Deferred.succeed(copySent, undefined)),
              Effect.tap(() => Deferred.await(releaseCopy))
            )
          : response
      )

      const fiber = yield* dropboxCopyMoveMetadataCase.run.pipe(
        Effect.provide(portsOver(Layer.succeed(HttpClient.HttpClient, holdingCopy))),
        Effect.forkChild
      )

      yield* Deferred.await(copySent)

      // The copy is masked: the interruption waits for it, then no further claim (move) runs.
      const interrupting = yield* Effect.forkChild(Fiber.interrupt(fiber))

      yield* Effect.yieldNow
      yield* Deferred.succeed(releaseCopy, undefined)
      yield* Fiber.join(interrupting)

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

  it.effect('registers a create in flight when interrupted, then deletes it by id', () =>
    Effect.gen(function* () {
      const createSent = yield* Deferred.make<void>()
      const releaseCreate = yield* Deferred.make<void>()

      // The absence check (0), the create (1), then only the restore's delete (4) and lookup (5).
      const { client, ledger } = yield* makeReplayHttpClient([
        withoutExchanges(dropboxCreateFolderConflictFixture, [2, 3])
      ])

      // Dropbox has created the folder, but its response is held back until the test releases it.
      const holdingCreate = HttpClient.transform(client, (response, request) =>
        request.url.endsWith('/files/create_folder_v2')
          ? response.pipe(
              Effect.tap(() => Deferred.succeed(createSent, undefined)),
              Effect.tap(() => Deferred.await(releaseCreate))
            )
          : response
      )

      const fiber = yield* dropboxCreateFolderConflictCase.run.pipe(
        Effect.provide(portsOver(Layer.succeed(HttpClient.HttpClient, holdingCreate))),
        Effect.forkChild
      )

      yield* Deferred.await(createSent)

      const interrupting = yield* Effect.forkChild(Fiber.interrupt(fiber))

      yield* Effect.yieldNow
      yield* Deferred.succeed(releaseCreate, undefined)
      yield* Fiber.join(interrupting)

      const exit = yield* Fiber.await(fiber)
      const entries = yield* ledger.entries

      expect(Exit.hasInterrupts(exit)).toBe(true)
      expect(exchangeIndices(entries)).toEqual([
        'files/get_metadata 0',
        'files/create_folder_v2 1',
        'files/delete_v2 2',
        'files/get_metadata 3'
      ])
      expect(deleteBodies(entries)).toEqual([{ path: 'id:SyntheticConflictFolder1' }])
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

// Ownership drills: definitive rejections delete nothing, ambiguous creates are reported with the
// exact path, and cleanup never leaves the case folder.

const foreignFolder =
  '{"metadata":{"name":"elsewhere","path_lower":"/conformance/other/elsewhere","path_display":"/Conformance/Other/elsewhere","id":"id:SyntheticForeign0001"}}'

describe('Dropbox conformance write ownership', () => {
  it.effect('deletes nothing after a definitive create rejection', () =>
    Effect.gen(function* () {
      const rejected = withoutExchanges(
        replaceResponse(
          dropboxCreateFolderConflictFixture,
          1,
          withStatus(409, textBody(exchangeAt(dropboxCreateFolderConflictFixture, 2).response))
        ),
        [2, 3, 4, 5]
      )

      const { failure, entries, remaining } = yield* drill(
        dropboxCreateFolderConflictCase,
        rejected
      )

      expect(failure).toEqual({
        kind: 'failure',
        tag: 'DropboxConformanceActionFailed',
        message: 'dropbox.create_folder failed: dropbox_conflict (HTTP 409)'
      })
      expect(exchangeIndices(entries)).toEqual(['files/get_metadata 0', 'files/create_folder_v2 1'])
      expect(remaining).toEqual([])
    })
  )

  it.effect(
    'reports an ambiguous 5xx create with the exact path after one best-effort delete',
    () =>
      Effect.gen(function* () {
        const ambiguous: WireFixture = {
          ...dropboxCreateFolderConflictFixture,
          exchanges: [
            exchangeAt(dropboxCreateFolderConflictFixture, 0),
            {
              ...exchangeAt(dropboxCreateFolderConflictFixture, 1),
              response: withStatus(
                500,
                serverError
              )(exchangeAt(dropboxCreateFolderConflictFixture, 1).response)
            },
            deleteByPath(conflictFolder, {
              status: 409,
              headers: { 'content-type': 'application/json' },
              body: notFoundBody
            }),
            exchangeAt(dropboxCreateFolderConflictFixture, 5)
          ]
        }

        const { failure, entries } = yield* drill(dropboxCreateFolderConflictCase, ambiguous)

        expect(failure).toEqual({
          kind: 'failure',
          tag: 'DropboxConformanceActionFailed',
          message: `dropbox.create_folder failed: dropbox_create_folder_failed (HTTP 500); create outcome unknown: delete ${conflictFolder} by hand if it exists`
        })
        expect(deleteBodies(entries)).toEqual([{ path: conflictFolder }])
      })
  )

  it.effect('refuses to adopt a created path outside the case folder', () =>
    Effect.gen(function* () {
      const outside = withoutExchanges(
        replaceResponse(dropboxCreateFolderConflictFixture, 1, withStatus(200, foreignFolder)),
        [2, 3, 4, 5]
      )

      const { failure, entries } = yield* drill(dropboxCreateFolderConflictCase, outside)

      expect(failure).toEqual({
        kind: 'failure',
        tag: 'DropboxConformanceCleanupRefused',
        message:
          'dropbox.files.create-folder-conflict: cleanup refused; a create answered /conformance/other/elsewhere, outside the case folder, so nothing was deleted there; check it by hand.'
      })
      expect(deleteBodies(entries)).toEqual([])
    })
  )

  it.effect(
    'refuses an out-of-namespace path from a surprising duplicate create, cleaning only its own',
    () =>
      Effect.gen(function* () {
        const outside = replaceResponse(
          dropboxCreateFolderConflictFixture,
          3,
          withStatus(200, foreignFolder)
        )

        const { failure, entries, remaining } = yield* drill(
          dropboxCreateFolderConflictCase,
          outside
        )

        expect(failure?.tag).toBe('DropboxConformanceCleanupRefused')
        expect(deleteBodies(entries)).toEqual([{ path: 'id:SyntheticConflictFolder1' }])
        expect(remaining).toEqual([])
      })
  )

  it.effect('a concurrent create conflict: the losing run deletes nothing', () =>
    Effect.gen(function* () {
      yield* atTestNow

      const fake = yield* makeFakeDropbox
      const events = yield* Ref.make<ReadonlyArray<string>>([])
      const lookupsAnswered = yield* Ref.make(0)
      const createsSeen = yield* Ref.make(0)
      const bothLookedUp = yield* Deferred.make<void>()
      const loserConflicted = yield* Deferred.make<void>()

      const note = (event: string) => Ref.update(events, list => [...list, event])

      // Forced interleaving: both absence lookups are ANSWERED before either initial create is
      // released; then the winning create is held until the losing create has received its 409.
      const gated = HttpClient.make((request, url) =>
        Effect.gen(function* () {
          const route = url.pathname.slice(url.pathname.lastIndexOf('/') + 1)

          if (route === 'get_metadata' && (yield* Ref.get(lookupsAnswered)) < 2) {
            const response = yield* fake.handle(request, url)

            if ((yield* Ref.updateAndGet(lookupsAnswered, count => count + 1)) === 2) {
              yield* note('both absence lookups answered')
              yield* Deferred.succeed(bothLookedUp, undefined)
            }

            return response
          }

          if (
            route === 'create_folder_v2' &&
            (yield* Ref.updateAndGet(createsSeen, n => n + 1)) <= 2
          ) {
            yield* Deferred.await(bothLookedUp)

            const response = yield* fake.handle(request, url)

            if (response.status === 200) {
              yield* note('winner create answered 200')
              yield* Deferred.await(loserConflicted)
              yield* note('winner released')
            } else {
              yield* note(`loser create answered ${response.status}`)
              yield* Deferred.succeed(loserConflicted, undefined)
            }

            return response
          }

          return yield* fake.handle(request, url)
        })
      )

      // Same seeds, same namespace: a collision the unique run id normally prevents.
      const runOnce = dropboxCreateFolderConflictCase.run.pipe(
        Effect.provide(portsOver(Layer.succeed(HttpClient.HttpClient, gated))),
        Effect.exit
      )

      const exits = yield* Effect.all([runOnce, runOnce], { concurrency: 2 })
      const failures = exits.filter(Exit.isFailure)
      const order = yield* Ref.get(events)

      expect(order[0]).toBe('both absence lookups answered')
      expect([...order].sort()).toEqual([
        'both absence lookups answered',
        'loser create answered 409',
        'winner create answered 200',
        'winner released'
      ])
      expect(order.indexOf('loser create answered 409')).toBeLessThan(
        order.indexOf('winner released')
      )
      expect(exits.filter(Exit.isSuccess)).toHaveLength(1)
      expect(failures).toHaveLength(1)
      expect(String(failures[0]?.cause)).toContain(
        'dropbox.create_folder failed: dropbox_conflict (HTTP 409)'
      )

      const log = yield* Ref.get(fake.log)

      // Only the winner deleted anything, and only its own entry, by id.
      const deletes = log.filter(line => line.startsWith('delete_v2'))

      expect(deletes).toHaveLength(1)
      expect(deletes[0]).toMatch(/^delete_v2 id:SyntheticFake\d{4}$/)
      expect((yield* Ref.get(fake.entries)).size).toBe(0)
    })
  )

  it.effect('a create that lands after the cleanup lookup is still reported as ambiguous', () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeDropbox
      const deferred = yield* Ref.make<ReadonlyArray<string>>([])

      // The connection drops while Dropbox is still creating the folder; it lands only later.
      const dropping = HttpClient.make((request, url) =>
        url.pathname.endsWith('/files/create_folder_v2')
          ? Ref.update(deferred, paths => [...paths, requestPath(request)]).pipe(
              Effect.andThen(Effect.fail(connectionReset(request)))
            )
          : fake.handle(request, url)
      )

      const exit = yield* dropboxCreateFolderConflictCase.run.pipe(
        Effect.provide(portsOver(Layer.succeed(HttpClient.HttpClient, dropping))),
        Effect.exit
      )

      // The best-effort cleanup looked the path up and found nothing; then the create lands.
      expect(yield* Ref.get(fake.log)).toEqual([
        `get_metadata ${conflictFolder}`,
        `delete_v2 ${conflictFolder}`,
        `get_metadata ${conflictFolder}`
      ])

      for (const path of yield* Ref.get(deferred)) {
        yield* fake.create(path)
      }

      expect((yield* Ref.get(fake.entries)).size).toBe(1)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(String(Exit.isFailure(exit) ? exit.cause : '')).toContain(
        `dropbox.create_folder failed: transport_failed; create outcome unknown: delete ${conflictFolder} by hand if it exists`
      )
    })
  )

  const upperConflictFolder = '/Conformance/Work/YOLK-CONFORMANCE-RUN-SYNTHETIC-FOLDER'

  for (const [attempt, attemptedPath] of [
    [2, conflictFolder],
    [3, upperConflictFolder]
  ] as const) {
    it.effect(
      `a duplicate create (attempt ${attempt}) that lands after the verified cleanup is reported as ambiguous`,
      () =>
        Effect.gen(function* () {
          const fake = yield* makeFakeDropbox
          const creates = yield* Ref.make(0)
          const deferred = yield* Ref.make<ReadonlyArray<string>>([])

          // Only this create attempt drops its connection; Dropbox completes it later.
          const dropping = HttpClient.make((request, url) =>
            Effect.gen(function* () {
              if (
                url.pathname.endsWith('/files/create_folder_v2') &&
                (yield* Ref.updateAndGet(creates, n => n + 1)) === attempt
              ) {
                yield* Ref.update(deferred, paths => [...paths, requestPath(request)])

                return yield* Effect.fail(connectionReset(request))
              }

              return yield* fake.handle(request, url)
            })
          )

          const exit = yield* dropboxCreateFolderConflictCase.run.pipe(
            Effect.provide(portsOver(Layer.succeed(HttpClient.HttpClient, dropping))),
            Effect.exit
          )

          // The known original was cleaned up by id and verified absent...
          const log = yield* Ref.get(fake.log)

          expect(log.slice(-2)).toEqual([
            'delete_v2 id:SyntheticFake0001',
            `get_metadata ${conflictFolder}`
          ])
          expect((yield* Ref.get(fake.entries)).size).toBe(0)

          // ...and then the dropped duplicate lands, which the report already warned about.
          for (const path of yield* Ref.get(deferred)) {
            yield* fake.create(path)
          }

          expect((yield* Ref.get(fake.entries)).size).toBe(1)
          expect(Exit.isFailure(exit)).toBe(true)
          expect(String(Exit.isFailure(exit) ? exit.cause : '')).toContain(
            `dropbox.create_folder failed: transport_failed; create outcome unknown: delete ${attemptedPath} by hand if it exists`
          )
        })
    )
  }

  it.effect('skips the path fallback when the id delete answers not-found', () =>
    Effect.gen(function* () {
      yield* atTestNow

      const gone = replaceResponse(
        dropboxCreateFolderConflictFixture,
        4,
        withStatus(
          409,
          '{"error_summary": "path_lookup/not_found/.", "error": {".tag": "path_lookup", "path_lookup": {".tag": "not_found"}}}'
        )
      )

      const ledgers = yield* Ref.make(new Map<string, ReplayLedgerApi>())

      const report = yield* runConformance([dropboxCreateFolderConflictCase], {
        target: { kind: 'replay' },
        now,
        layer: ledgerCaseLayer(ledgers, [gone])
      })

      const { entries, remaining } = yield* ledgerOf(ledgers, dropboxCreateFolderConflictCase.id)

      expect(report.summary.passed).toBe(1)
      expect(deleteBodies(entries)).toEqual([{ path: 'id:SyntheticConflictFolder1' }])
      expect(remaining).toEqual([])
    })
  )

  it.effect('falls back to the owned path when the id delete fails in transport', () =>
    Effect.gen(function* () {
      yield* atTestNow

      const { client, ledger } = yield* makeReplayHttpClient([dropboxCreateFolderConflictFixture])
      const deletes = yield* Ref.make(0)

      // The first delete (by id) never reaches Dropbox; the path fallback takes its exchange.
      const dropsFirstDelete = HttpClient.transform(client, (response, request) =>
        request.url.endsWith('/files/delete_v2')
          ? Ref.updateAndGet(deletes, n => n + 1).pipe(
              Effect.flatMap(n => (n === 1 ? Effect.fail(connectionReset(request)) : response))
            )
          : response
      )

      const exit = yield* dropboxCreateFolderConflictCase.run.pipe(
        Effect.provide(portsOver(Layer.succeed(HttpClient.HttpClient, dropsFirstDelete))),
        Effect.exit
      )

      expect(Exit.isSuccess(exit)).toBe(true)
      expect(deleteBodies(yield* ledger.entries)).toEqual([{ path: conflictFolder }])
    })
  )
})

const connectionReset = (request: HttpClientRequest.HttpClientRequest) =>
  new HttpClientError.HttpClientError({
    reason: new HttpClientError.TransportError({ request, description: 'connection reset' })
  })

// A minimal in-memory Dropbox (folders only) for the ownership drills.

type FakeFolder = {
  readonly id: string
  readonly name: string
  readonly path_lower: string
  readonly path_display: string
}

const requestPath = (request: HttpClientRequest.HttpClientRequest): string => {
  const text = Predicate.isTagged(request.body, 'Uint8Array')
    ? new TextDecoder().decode(request.body.body)
    : '{}'

  const path: unknown = JSON.parse(text).path

  return Predicate.isString(path) ? path : ''
}

const jsonResponse = (
  request: HttpClientRequest.HttpClientRequest,
  status: number,
  body: unknown
) =>
  HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  )

const makeFakeDropbox = Effect.gen(function* () {
  const entries = yield* Ref.make(new Map<string, FakeFolder>())
  const log = yield* Ref.make<ReadonlyArray<string>>([])
  const counter = yield* Ref.make(0)

  const notFound = JSON.parse(notFoundBody)

  const conflict = {
    error_summary: 'path/conflict/folder/..',
    error: { '.tag': 'path', path: { '.tag': 'conflict', conflict: { '.tag': 'folder' } } }
  }

  const find = (path: string) =>
    Ref.get(entries).pipe(
      Effect.map(map =>
        path.startsWith('id:')
          ? [...map.values()].find(folder => folder.id === path)
          : map.get(path.toLowerCase())
      )
    )

  const create = (path: string) =>
    Effect.gen(function* () {
      const id = `id:SyntheticFake${String(yield* Ref.updateAndGet(counter, n => n + 1)).padStart(4, '0')}`

      return yield* Ref.modify(
        entries,
        (map): [FakeFolder | undefined, Map<string, FakeFolder>] => {
          if (map.has(path.toLowerCase())) return [undefined, map]

          const folder: FakeFolder = {
            id,
            name: path.slice(path.lastIndexOf('/') + 1),
            path_lower: path.toLowerCase(),
            path_display: path
          }

          return [folder, new Map(map).set(folder.path_lower, folder)]
        }
      )
    })

  const handle = (request: HttpClientRequest.HttpClientRequest, url: URL) =>
    Effect.gen(function* () {
      const route = url.pathname.slice(url.pathname.lastIndexOf('/') + 1)
      const path = requestPath(request)

      yield* Ref.update(log, lines => [...lines, `${route} ${path}`])

      switch (route) {
        case 'get_metadata': {
          const folder = yield* find(path)

          return folder === undefined
            ? jsonResponse(request, 409, notFound)
            : jsonResponse(request, 200, { '.tag': 'folder', ...folder })
        }

        case 'create_folder_v2': {
          const folder = yield* create(path)

          return folder === undefined
            ? jsonResponse(request, 409, conflict)
            : jsonResponse(request, 200, { metadata: folder })
        }

        case 'delete_v2': {
          const folder = yield* find(path)

          if (folder === undefined) return jsonResponse(request, 409, notFound)

          yield* Ref.update(entries, map => {
            const next = new Map(map)

            next.delete(folder.path_lower)

            return next
          })

          return jsonResponse(request, 200, { metadata: { '.tag': 'folder', ...folder } })
        }

        default:
          return jsonResponse(request, 400, { error_summary: 'unsupported/.' })
      }
    })

  return { entries, log, create, handle }
})

describe('Dropbox conformance leftover detection (read-only)', () => {
  const listing = (body: string, cursor?: string): WireExchange => ({
    request: {
      method: 'POST',
      url:
        cursor === undefined
          ? 'https://api.dropboxapi.com/2/files/list_folder'
          : 'https://api.dropboxapi.com/2/files/list_folder/continue',
      headers: { 'content-type': 'application/json' },
      body: cursor === undefined ? { path: '/Conformance/Work', limit: 2000 } : { cursor }
    },
    response: { status: 200, headers: { 'content-type': 'application/json' }, body }
  })

  const folder = (name: string) =>
    `{".tag":"folder","name":"${name}","path_lower":"/conformance/work/${name.toLowerCase()}","path_display":"/Conformance/Work/${name}","id":"id:Synthetic${name.length}"}`

  const leftoversFixture: WireFixture = {
    id: 'dropbox.leftovers.synthetic',
    caseId: 'dropbox.leftovers',
    evidence: 'unverified',
    recordedAt: '2026-09-30',
    account: 'synthetic',
    endpoint: 'https://api.dropboxapi.com/2',
    exchanges: [
      listing(
        `{"entries":[${folder('yolk-conformance-run-0000beef-copy')},${folder('Keep Me')},{".tag":"deleted","name":"yolk-conformance-run-0000dead-folder"}],"cursor":"AAHsyntheticLeftoverCursor","has_more":true}`
      ),
      listing(
        `{"entries":[${folder('yolk-conformance-run-0000cafe-upload')},${folder('yolk-conformance-absent')}],"cursor":"AAHsyntheticLeftoverCursor2","has_more":false}`,
        'AAHsyntheticLeftoverCursor'
      )
    ]
  }

  it.effect(
    'lists run-scoped folders earlier runs left under the work folder, and nothing else',
    () =>
      Effect.gen(function* () {
        const { client, ledger } = yield* makeReplayHttpClient([leftoversFixture])

        const found = yield* findDropboxConformanceLeftovers.pipe(
          Effect.provide(portsOver(Layer.succeed(HttpClient.HttpClient, client)))
        )

        expect(found).toEqual([
          '/Conformance/Work/yolk-conformance-run-0000beef-copy',
          '/Conformance/Work/yolk-conformance-run-0000cafe-upload'
        ])
        // Read-only: only listing requests were sent.
        expect((yield* ledger.entries).map(entry => entry.url)).toEqual([
          'https://api.dropboxapi.com/2/files/list_folder',
          'https://api.dropboxapi.com/2/files/list_folder/continue'
        ])
      })
  )

  it.effect('treats a work folder that does not exist yet as holding no leftovers', () =>
    Effect.gen(function* () {
      const missing: WireFixture = {
        ...leftoversFixture,
        exchanges: [
          {
            request: leftoversFixture.exchanges[0].request,
            response: {
              status: 409,
              headers: { 'content-type': 'application/json' },
              body: notFoundBody
            }
          }
        ]
      }

      const { client } = yield* makeReplayHttpClient([missing])

      const found = yield* findDropboxConformanceLeftovers.pipe(
        Effect.provide(portsOver(Layer.succeed(HttpClient.HttpClient, client)))
      )

      expect(found).toEqual([])
    })
  )

  it('requires the run- prefix in every run id, so the leftover lookup sees every run', () => {
    const decode = Schema.decodeUnknownOption(DropboxConformanceSeedsSchema)

    expect(Option.isSome(decode({ runId: 'run-0000beef' }))).toBe(true)
    expect(Option.isNone(decode({ runId: 'mine-0000beef' }))).toBe(true)
    expect(Option.isNone(decode({ runId: 'run-' }))).toBe(true)
  })
})

// Interruption drills: a cleanup problem raised while the case is being interrupted still reaches
// the owner through the ConformanceCleanupReporter, with the exact path to check.

const capturingReporter = Effect.gen(function* () {
  const warnings = yield* Ref.make<ReadonlyArray<string>>([])

  return {
    warnings,
    reporter: { warn: (message: string) => Ref.update(warnings, list => [...list, message]) }
  }
})

describe('Dropbox conformance interruption reporting', () => {
  for (const moment of ['during the copy claim', 'during the restore delete'] as const) {
    it.effect(`reports a failed delete when interrupted ${moment}`, () =>
      Effect.gen(function* () {
        const sent = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const deletes = yield* Ref.make(0)
        const { warnings, reporter } = yield* capturingReporter

        // Both restore deletes (by id, then by path) answer 500.
        const failing = insertAfter(
          replaceResponse(dropboxCopyMoveMetadataFixture, 5, withStatus(500, serverError)),
          5,
          deleteByPath(copyFolder, {
            status: 500,
            headers: { 'content-type': 'application/json' },
            body: serverError
          })
        )

        const { client } = yield* makeReplayHttpClient([failing])

        const hold = <A, E, R>(response: Effect.Effect<A, E, R>) =>
          response.pipe(
            Effect.tap(() => Deferred.succeed(sent, undefined)),
            Effect.tap(() => Deferred.await(release))
          )

        const holding = HttpClient.transform(client, (response, request) => {
          if (moment === 'during the copy claim' && request.url.endsWith('/files/copy_v2')) {
            return hold(response)
          }

          if (moment === 'during the restore delete' && request.url.endsWith('/files/delete_v2')) {
            return Ref.updateAndGet(deletes, n => n + 1).pipe(
              Effect.flatMap(n => (n === 1 ? hold(response) : response))
            )
          }

          return response
        })

        const fiber = yield* dropboxCopyMoveMetadataCase.run.pipe(
          Effect.provide(portsOver(Layer.succeed(HttpClient.HttpClient, holding))),
          Effect.provideService(ConformanceCleanupReporter, reporter),
          Effect.forkChild
        )

        yield* Deferred.await(sent)

        const interrupting = yield* Effect.forkChild(Fiber.interrupt(fiber))

        yield* Effect.yieldNow
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(interrupting)
        yield* Fiber.await(fiber)

        const reported = yield* Ref.get(warnings)

        // Whatever the fiber's exit, the owner sees the restore failure and the path to check.
        expect(reported).toHaveLength(1)
        expect(reported[0]).toContain(
          `dropbox.files.copy-move-metadata: restore failed; delete ${copyFolder} by hand if it still exists.`
        )
      })
    )
  }

  it.effect('reports an ambiguous create answered while the case is being interrupted', () =>
    Effect.gen(function* () {
      const createSent = yield* Deferred.make<void>()
      const releaseCreate = yield* Deferred.make<void>()
      const { warnings, reporter } = yield* capturingReporter

      const { client } = yield* makeReplayHttpClient([
        {
          ...dropboxCreateFolderConflictFixture,
          exchanges: [
            exchangeAt(dropboxCreateFolderConflictFixture, 0),
            {
              ...exchangeAt(dropboxCreateFolderConflictFixture, 1),
              response: withStatus(
                500,
                serverError
              )(exchangeAt(dropboxCreateFolderConflictFixture, 1).response)
            },
            deleteByPath(conflictFolder, {
              status: 409,
              headers: { 'content-type': 'application/json' },
              body: notFoundBody
            }),
            exchangeAt(dropboxCreateFolderConflictFixture, 5)
          ]
        }
      ])

      const holdingCreate = HttpClient.transform(client, (response, request) =>
        request.url.endsWith('/files/create_folder_v2')
          ? response.pipe(
              Effect.tap(() => Deferred.succeed(createSent, undefined)),
              Effect.tap(() => Deferred.await(releaseCreate))
            )
          : response
      )

      const fiber = yield* dropboxCreateFolderConflictCase.run.pipe(
        Effect.provide(portsOver(Layer.succeed(HttpClient.HttpClient, holdingCreate))),
        Effect.provideService(ConformanceCleanupReporter, reporter),
        Effect.forkChild
      )

      yield* Deferred.await(createSent)

      const interrupting = yield* Effect.forkChild(Fiber.interrupt(fiber))

      yield* Effect.yieldNow
      yield* Deferred.succeed(releaseCreate, undefined)
      yield* Fiber.join(interrupting)
      yield* Fiber.await(fiber)

      expect(yield* Ref.get(warnings)).toEqual([
        `dropbox.create_folder failed: dropbox_create_folder_failed (HTTP 500); create outcome unknown: delete ${conflictFolder} by hand if it exists`
      ])
    })
  )

  it.effect(
    'reports nothing extra when an uninterrupted restore fails (the report carries it)',
    () =>
      Effect.gen(function* () {
        const { warnings, reporter } = yield* capturingReporter

        const undeleted = insertAfter(
          replaceResponse(dropboxCopyMoveMetadataFixture, 5, withStatus(500, serverError)),
          5,
          deleteByPath(copyFolder, {
            status: 500,
            headers: { 'content-type': 'application/json' },
            body: serverError
          })
        )

        const { client } = yield* makeReplayHttpClient([undeleted])

        const exit = yield* dropboxCopyMoveMetadataCase.run.pipe(
          Effect.provide(portsOver(Layer.succeed(HttpClient.HttpClient, client))),
          Effect.provideService(ConformanceCleanupReporter, reporter),
          Effect.exit
        )

        expect(Exit.isFailure(exit)).toBe(true)
        expect(yield* Ref.get(warnings)).toEqual([])
      })
  )
})
