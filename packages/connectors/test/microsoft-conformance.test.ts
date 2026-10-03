import { describe, expect, it } from '@effect/vitest'
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Ref } from 'effect'
import { TestClock } from 'effect/testing'
import { HttpClient, HttpClientError } from 'effect/http'
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
  type ReplayLedgerApi,
  type ReplayLedgerEntry
} from '@yolk-sdk/conformance/replay'
import {
  conformanceReportFailed,
  formatConformanceReport,
  runConformance,
  type ConformanceTarget
} from '@yolk-sdk/conformance/runner'
import { OAuthCredential } from '@yolk-sdk/connectors'
import {
  ConformanceCleanupReporter,
  connectorHttpClientsFromEffectHttpClientLayer,
  staticCredentialResolverLayer
} from '@yolk-sdk/connectors/conformance'
import {
  MicrosoftConformanceConfig,
  microsoftCalendarCancelCase,
  microsoftCalendarCancelFixture,
  microsoftCalendarCreateEventCase,
  microsoftCalendarCreateEventFixture,
  microsoftCalendarListRangeCase,
  microsoftCalendarListRangeFixture,
  microsoftCalendarTimestampPrecisionCase,
  microsoftCalendarTimestampPrecisionFixture,
  microsoftConformanceCases,
  microsoftConformanceFixtureSeeds,
  microsoftConformanceFixtures,
  microsoftOneDriveCreateFolderCase,
  microsoftOneDriveCreateFolderFixture,
  microsoftOutlookAttachmentsListingCase,
  microsoftOutlookAttachmentsListingFixture,
  microsoftOutlookConcurrentWritesCase,
  microsoftOutlookConcurrentWritesFixture,
  microsoftOutlookImmutableIdCase,
  microsoftOutlookImmutableIdFixture,
  microsoftOutlookPagingNextLinkCase,
  microsoftOutlookPagingNextLinkFixture,
  type MicrosoftConformanceCase,
  type MicrosoftConformanceSeeds
} from '@yolk-sdk/connectors/microsoft/conformance'

const now = new Date('2026-09-30T12:00:00.000Z')

const atTestNow = TestClock.setTime(now.getTime())

const mailbox = 'ada@example.test'

/** Static delegated OAuth credential whose account is the seeded mailbox (ordinary Mail.* slots). */
const credentialLayer = staticCredentialResolverLayer(
  OAuthCredential.make({
    provider: 'microsoft',
    accessToken: 'synthetic-microsoft-access-token',
    expiresAt: 4_000_000_000_000,
    accountId: mailbox
  })
)

const portsOver = (
  httpLayer: Layer.Layer<HttpClient.HttpClient>,
  seeds: MicrosoftConformanceSeeds = microsoftConformanceFixtureSeeds
) =>
  Layer.mergeAll(
    connectorHttpClientsFromEffectHttpClientLayer.pipe(Layer.provide(httpLayer)),
    credentialLayer,
    Layer.succeed(MicrosoftConformanceConfig, seeds)
  )

const fixturesFor = (
  testCase: Pick<ConformanceCase<unknown, unknown>, 'fixtures'>,
  fixtures: ReadonlyArray<WireFixture> = microsoftConformanceFixtures
) => fixtures.filter(fixture => testCase.fixtures.includes(fixture.id))

const replayCaseLayer = (testCase: MicrosoftConformanceCase) =>
  portsOver(ReplayHttpClient.layer(fixturesFor(testCase)))

/** Replay layer that also hands its ledger to the test, keyed by case id. */
const ledgerCaseLayer =
  (
    ledgers: Ref.Ref<Map<string, ReplayLedgerApi>>,
    fixtures: ReadonlyArray<WireFixture> = microsoftConformanceFixtures,
    seeds: MicrosoftConformanceSeeds = microsoftConformanceFixtureSeeds
  ) =>
  (testCase: MicrosoftConformanceCase) =>
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

/** `METHOD exchangeIndex` per ledger entry: which recorded exchange answered each request. */
const exchangeIndices = (entries: ReadonlyArray<ReplayLedgerEntry>) =>
  entries.map(entry =>
    entry.match.outcome === 'matched' ? `${entry.method} ${entry.match.exchangeIndex}` : 'unmatched'
  )

const synthetic = (id: string) => `${id}.synthetic`

const graphOrigin = 'https://graph.microsoft.com/v1.0/'

const monitorOrigin = 'https://synthetic-my.sharepoint.com/'

const isOutlookRequest = (url: string) =>
  url.startsWith(`${graphOrigin}users/ada%40example.test/messages`) ||
  url.startsWith(`${graphOrigin}users/ada%40example.test/mailFolders`)

describe('Microsoft conformance cases', () => {
  it('declare their safety, stay unverified, and are backed by one fixture each', () => {
    expect(microsoftConformanceCases.map(testCase => [testCase.id, testCase.safety])).toEqual([
      ['microsoft.calendar.list-range-returns-events', 'read'],
      ['microsoft.calendar.timestamp-precision', 'read'],
      ['microsoft.calendar.create-returns-event-id', 'write-reversible'],
      ['microsoft.calendar.cancel-semantics', 'write-reversible'],
      ['microsoft.outlook.attachments-listing', 'read'],
      ['microsoft.outlook.attachment-content-id', 'read'],
      ['microsoft.outlook.paging-next-link', 'read'],
      ['microsoft.outlook.immutable-id-survives-move', 'write-reversible'],
      ['microsoft.outlook.concurrent-writes-same-message', 'write-reversible'],
      ['microsoft.onedrive.create-folder-roundtrip', 'write-reversible'],
      ['microsoft.onedrive.copy-accepted-monitor', 'write-reversible']
    ])
    expect(microsoftConformanceFixtures.map(fixture => fixture.caseId)).toEqual(
      microsoftConformanceCases.map(testCase => testCase.id)
    )

    for (const testCase of microsoftConformanceCases) {
      expect(testCase.observed).toBeUndefined()
      expect(testCase.fixtures).toEqual([synthetic(testCase.id)])
    }
  })

  it('say plainly that the calendar cases send raw Graph requests', () => {
    for (const testCase of microsoftConformanceCases.filter(({ id }) =>
      id.startsWith('microsoft.calendar.')
    )) {
      expect(testCase.docs).toContain('The connector has no calendar actions yet')
    }
  })

  it.effect('ship synthetic fixtures that decode and pass the secret scan', () =>
    Effect.gen(function* () {
      for (const fixture of microsoftConformanceFixtures) {
        expect(yield* decodeWireFixture(fixture)).toEqual(fixture)
        expect(scanFixtureForSecrets(fixture)).toEqual([])
        expect(fixture).toMatchObject({ evidence: 'unverified', account: 'synthetic' })

        for (const { request, response } of fixture.exchanges) {
          expect(Object.keys(request.headers ?? {})).not.toContain('authorization')
          expect(request.url.startsWith(graphOrigin) || request.url.startsWith(monitorOrigin)).toBe(
            true
          )

          // The connector sends the immutable-id preference on every Outlook request.
          if (isOutlookRequest(request.url)) {
            expect(request.headers?.prefer).toBe('IdType="ImmutableId"')
          }

          if (response.status >= 400) {
            const body = isWireStreamResponse(response) || isWireBase64BodyResponse(response)

            expect(body).toBe(false)
            // Graph error envelope: { error: { code, message, innerError } }.
            expect(JSON.parse('body' in response ? (response.body ?? '') : '')).toMatchObject({
              error: {
                code: expect.any(String),
                message: expect.any(String),
                innerError: expect.any(Object)
              }
            })
          }
        }
      }

      const [page] = microsoftOutlookPagingNextLinkFixture.exchanges

      expect(JSON.parse('body' in page.response ? (page.response.body ?? '') : '')).toMatchObject({
        '@odata.context': expect.stringContaining('$metadata#'),
        '@odata.nextLink': expect.stringContaining('%24skip=2'),
        value: expect.any(Array)
      })
    })
  )

  it.effect('all pass on replay with unverified warnings', () =>
    Effect.gen(function* () {
      yield* atTestNow

      const report = yield* runConformance(microsoftConformanceCases, {
        target: { kind: 'replay' },
        now,
        fixtures: microsoftConformanceFixtures,
        layer: replayCaseLayer
      })

      expect(report.summary).toEqual({ passed: 11, failed: 0, skipped: 0 })
      expect(conformanceReportFailed(report)).toBe(false)

      for (const result of report.results) {
        expect(result.status).toBe('passed')
        expect(result.warnings).toEqual([
          { kind: 'unverified-case' },
          { kind: 'unverified-fixture', fixtureId: synthetic(result.id) }
        ])
      }

      expect(formatConformanceReport(report).split('\n').at(-1)).toBe(
        '11 passed, 0 failed, 0 skipped; target replay; started 2026-09-30T12:00:00.000Z'
      )
    })
  )

  it.effect('consume every recorded exchange in order and send the recorded requests', () =>
    Effect.gen(function* () {
      yield* atTestNow

      const ledgers = yield* Ref.make(new Map<string, ReplayLedgerApi>())

      const report = yield* runConformance(microsoftConformanceCases, {
        target: { kind: 'replay' },
        now,
        layer: ledgerCaseLayer(ledgers)
      })

      expect(report.summary.passed).toBe(11)

      for (const testCase of microsoftConformanceCases) {
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
          // The synthetic fixtures record exactly what the cases send, headers included.
          expect(entry.bodyJson).toEqual(exchange?.request.body)
          expect(entry.headers).toMatchObject(exchange?.request.headers ?? {})
          // Graph requests carry the (redacted) bearer token; the monitor URL gets none.
          expect(entry.headers.authorization).toBe(
            entry.url.startsWith(graphOrigin) ? '<redacted>' : undefined
          )
        })
      }
    })
  )
})

describe('Microsoft conformance safety on a live target', () => {
  // A replay layer under a `live` target proves the policy without any network.
  const statuses = (target: ConformanceTarget) =>
    atTestNow.pipe(
      Effect.andThen(
        runConformance(microsoftConformanceCases, { target, now, layer: replayCaseLayer })
      ),
      Effect.map(report =>
        report.results.map(result => [result.id, result.status, result.skipReason ?? null])
      )
    )

  it.effect('runs only the read cases by default and skips every write', () =>
    Effect.gen(function* () {
      expect(yield* statuses({ kind: 'live', account: 'synthetic' })).toEqual([
        ['microsoft.calendar.list-range-returns-events', 'passed', null],
        ['microsoft.calendar.timestamp-precision', 'passed', null],
        ['microsoft.calendar.create-returns-event-id', 'skipped', 'writes-not-allowed'],
        ['microsoft.calendar.cancel-semantics', 'skipped', 'writes-not-allowed'],
        ['microsoft.outlook.attachments-listing', 'passed', null],
        ['microsoft.outlook.attachment-content-id', 'passed', null],
        ['microsoft.outlook.paging-next-link', 'passed', null],
        ['microsoft.outlook.immutable-id-survives-move', 'skipped', 'writes-not-allowed'],
        ['microsoft.outlook.concurrent-writes-same-message', 'skipped', 'writes-not-allowed'],
        ['microsoft.onedrive.create-folder-roundtrip', 'skipped', 'writes-not-allowed'],
        ['microsoft.onedrive.copy-accepted-monitor', 'skipped', 'writes-not-allowed']
      ])
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
      expect(results).toHaveLength(11)
    })
  )
})

// Disagreement drills: replay a fixture that contradicts a claim and check the case fails with a
// ConformanceMismatch (and, for write cases, still removes what it created).

const textBody = (response: WireResponse): string => {
  if (isWireStreamResponse(response) || isWireBase64BodyResponse(response)) {
    return expect.fail('expected a text body')
  }

  return response.body
}

/** A copy of `fixture` (same id) with only the exchanges at `indices`, in that order. */
const pickExchanges = (
  fixture: WireFixture,
  indices: readonly [number, ...Array<number>]
): WireFixture => {
  const at = (index: number): WireExchange =>
    fixture.exchanges[index] ?? expect.fail(`no exchange ${index} in ${fixture.id}`)

  const [first, ...rest] = indices

  return { ...fixture, exchanges: [at(first), ...rest.map(at)] }
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

/** Append exchanges (for restore requests a failing path makes in addition). */
const withExtra = (fixture: WireFixture, extra: ReadonlyArray<WireExchange>): WireFixture => {
  const [first, ...rest] = fixture.exchanges

  return { ...fixture, exchanges: [first, ...rest, ...extra] }
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

const drill = (
  testCase: MicrosoftConformanceCase,
  fixture: WireFixture,
  seeds: MicrosoftConformanceSeeds = microsoftConformanceFixtureSeeds
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

const mismatch = (message: string) => ({ kind: 'failure', tag: 'ConformanceMismatch', message })

/** The event create (0) answering without an id: nothing can be removed automatically. */
const idLessCreateFixture = pickExchanges(
  replaceResponse(
    microsoftCalendarCreateEventFixture,
    0,
    replaceInBody('"id":"AAMkAGI2-synthetic-event-0101=",', '')
  ),
  [0]
)

/** A `ConformanceCleanupReporter` that captures every reported message. */
const capturingReporter = Effect.gen(function* () {
  const warnings = yield* Ref.make<ReadonlyArray<string>>([])

  return {
    warnings,
    reporter: { warn: (message: string) => Ref.update(warnings, list => [...list, message]) }
  }
})

const graphNotFoundError =
  '{"error":{"code":"ErrorItemNotFound","message":"Synthetic placeholder: not found.","innerError":{"date":"2026-09-29T10:00:08","request-id":"00000000-0000-4000-8000-000000000008","client-request-id":"00000000-0000-4000-8000-000000000008"}}}'

const graphServerError =
  '{"error":{"code":"ErrorInternalServerError","message":"Synthetic placeholder: server error.","innerError":{"date":"2026-09-29T10:00:09","request-id":"00000000-0000-4000-8000-000000000009","client-request-id":"00000000-0000-4000-8000-000000000009"}}}'

const immutableOriginalId = 'AAkALgAAAAAAHYQDEapmEc2byACqAC-EWg0A-synthetic-immutable-0001='

const immutableMovedId = 'AAMkAGI2-synthetic-moved-0001='

/**
 * The immutable-id create (0), a move (1) that answers a NEW id, and the cleanup batch (3) in which
 * the original id no longer exists (404) and the new id deletes (204).
 */
const movedIdFixture = pickExchanges(
  replaceResponse(
    replaceResponse(
      microsoftOutlookImmutableIdFixture,
      1,
      replaceInBody(`"id":"${immutableOriginalId}"`, `"id":"${immutableMovedId}"`)
    ),
    3,
    response => ({
      status: 200,
      headers: response.headers,
      body: JSON.stringify({
        responses: [
          { id: 'req-1', status: 404, headers: {}, body: JSON.parse(graphNotFoundError) },
          { id: 'req-2', status: 204, headers: {} }
        ]
      })
    })
  ),
  [0, 1, 3]
)

/** The cleanup batch permanently deletes the NEW id (and tries the original one). */
const expectBatchDeletesBothIds = (entries: ReadonlyArray<ReplayLedgerEntry>) => {
  const batch = entries.at(-1)

  expect(batch?.url).toBe('https://graph.microsoft.com/v1.0/$batch')
  expect(batch?.bodyJson).toMatchObject({
    requests: [
      {
        method: 'POST',
        url: `/users/ada%40example.test/messages/${encodeURIComponent(immutableOriginalId)}/permanentDelete`
      },
      {
        method: 'POST',
        url: `/users/ada%40example.test/messages/${encodeURIComponent(immutableMovedId)}/permanentDelete`
      }
    ]
  })
}

describe('Microsoft conformance disagreement drills', () => {
  it.effect('fails the range case when a populated range returns an empty success', () =>
    Effect.gen(function* () {
      const empty = replaceResponse(microsoftCalendarListRangeFixture, 0, response => {
        const body = JSON.parse(textBody(response))

        return {
          status: 200,
          headers: response.headers,
          body: JSON.stringify({ ...body, value: [] })
        }
      })

      const { failure, remaining } = yield* drill(microsoftCalendarListRangeCase, empty)

      expect(failure).toEqual(
        mismatch(
          'expected the seeded calendar range to return events; Graph answered an empty success for a populated range'
        )
      )
      expect(remaining).toEqual([])
    })
  )

  it.effect(
    'reports a create without an id as a restore failure needing removal by hand, writing nothing more',
    () =>
      Effect.gen(function* () {
        const { warnings, reporter } = yield* capturingReporter

        const { failure, entries } = yield* drill(
          microsoftCalendarCreateEventCase,
          idLessCreateFixture
        ).pipe(Effect.provideService(ConformanceCleanupReporter, reporter))

        expect(failure?.tag).toBe('MicrosoftConformanceRestoreFailed')
        expect(failure?.message).toBe(
          'microsoft.calendar.create-returns-event-id: restore failed; remove the case-created item by hand if it still exists (subjects and names start with yolk-conformance). Restore error: the create response carried no id, so nothing was removed. Claim failed first.'
        )
        // Without an id there is nothing to address: only the create was sent.
        expect(exchangeIndices(entries)).toEqual(['POST 0'])
        // Uninterrupted, the report carries it: nothing goes to the reporter.
        expect(yield* Ref.get(warnings)).toEqual([])
      })
  )

  it.effect('fails the timestamp case when the listed instant differs from the seed', () =>
    Effect.gen(function* () {
      const shifted = replaceResponse(
        microsoftCalendarTimestampPrecisionFixture,
        0,
        replaceInBody('"2026-09-23T12:00:00.0000000"', '"2026-09-23T12:00:00.0000001"')
      )

      const { failure } = yield* drill(
        microsoftCalendarTimestampPrecisionCase,
        pickExchanges(shifted, [0])
      )

      expect(failure).toEqual(
        mismatch('expected the calendar view start to name the seeded calendarEventStart instant')
      )
    })
  )

  it.effect('fails the timestamp case when Graph drops the seven-digit fraction', () =>
    Effect.gen(function* () {
      const iso = replaceResponse(
        microsoftCalendarTimestampPrecisionFixture,
        0,
        replaceInBody('"2026-09-23T12:00:00.0000000"', '"2026-09-23T12:00:00Z"')
      )

      const { failure } = yield* drill(
        microsoftCalendarTimestampPrecisionCase,
        pickExchanges(iso, [0])
      )

      expect(failure).toEqual(
        mismatch('expected the calendar view start as a seven-digit fractional dateTime in UTC')
      )
    })
  )

  it.effect('fails the timestamp case when GET and the calendar view disagree', () =>
    Effect.gen(function* () {
      const disagreeing = replaceResponse(
        microsoftCalendarTimestampPrecisionFixture,
        1,
        replaceInBody('"2026-09-23T13:00:00.0000000"', '"2026-09-23T13:30:00.0000000"')
      )

      const { failure } = yield* drill(microsoftCalendarTimestampPrecisionCase, disagreeing)

      expect(failure).toEqual(
        mismatch(
          'expected GET of the event and the calendar view to name the same start and end instants'
        )
      )
    })
  )

  it.effect('fails the paging case when a larger folder returns no nextLink', () =>
    Effect.gen(function* () {
      const noNextLink = replaceResponse(microsoftOutlookPagingNextLinkFixture, 0, response => {
        const { '@odata.nextLink': _dropped, ...body } = JSON.parse(textBody(response))

        return { status: 200, headers: response.headers, body: JSON.stringify(body) }
      })

      const { failure, entries } = yield* drill(
        microsoftOutlookPagingNextLinkCase,
        pickExchanges(noNextLink, [0])
      )

      expect(failure).toEqual(
        mismatch('expected @odata.nextLink for a page of 2 from a folder seeded with more messages')
      )
      expect(exchangeIndices(entries)).toEqual(['GET 0'])
    })
  )

  it.effect('fails the attachments case when the listing leaves out the inline attachment', () =>
    Effect.gen(function* () {
      const withoutInline = replaceResponse(
        microsoftOutlookAttachmentsListingFixture,
        0,
        response => {
          const body = JSON.parse(textBody(response))

          return {
            status: 200,
            headers: response.headers,
            body: JSON.stringify({ ...body, value: body.value.slice(1) })
          }
        }
      )

      const { failure } = yield* drill(
        microsoftOutlookAttachmentsListingCase,
        pickExchanges(withoutInline, [0])
      )

      expect(failure).toEqual(
        mismatch('expected the listing to include the inline file attachment (isInline true)')
      )
    })
  )

  it.effect('still deletes the created event when an assertion fails mid-flow', () =>
    Effect.gen(function* () {
      // PATCH (2) answers the old subject: the claim fails, then the restore sends DELETE (3) and
      // verifies GET (4) answers 404.
      const stale = replaceResponse(
        microsoftCalendarCreateEventFixture,
        2,
        replaceInBody(
          '"yolk-conformance event (updated): safe to delete"',
          '"yolk-conformance event: safe to delete"'
        )
      )

      const { failure, entries, remaining } = yield* drill(microsoftCalendarCreateEventCase, stale)

      expect(failure).toEqual(
        mismatch('expected PATCH with the created id to return the updated subject')
      )
      expect(exchangeIndices(entries)).toEqual(['POST 0', 'GET 1', 'PATCH 2', 'DELETE 3', 'GET 4'])
      expect(remaining).toEqual([])
    })
  )

  it.effect('fails the cancel case when cancel leaves the event readable, and removes it', () =>
    Effect.gen(function* () {
      const [created, cancelled, afterCancel, deleteAfter] =
        microsoftCalendarCancelFixture.exchanges.length === 4
          ? microsoftCalendarCancelFixture.exchanges
          : expect.fail('expected four cancel exchanges')

      const stillThere: WireExchange = {
        request: afterCancel.request,
        response: { ...created.response, status: 200 }
      }

      const fixture = withExtra(
        { ...microsoftCalendarCancelFixture, exchanges: [created, cancelled, stillThere] },
        [{ ...deleteAfter, response: { status: 204, headers: {}, body: '' } }, afterCancel]
      )

      const { failure, entries, remaining } = yield* drill(microsoftCalendarCancelCase, fixture)

      expect(failure).toEqual(
        mismatch('expected GET to answer 404 after cancel (cancel removes the event)')
      )
      expect(exchangeIndices(entries)).toEqual(['POST 0', 'POST 1', 'GET 2', 'DELETE 3', 'GET 4'])
      expect(remaining).toEqual([])
    })
  )

  it.effect('fails the concurrent case on a 5xx loser and still deletes the draft', () =>
    Effect.gen(function* () {
      const serverError = replaceResponse(
        microsoftOutlookConcurrentWritesFixture,
        2,
        withStatus(500, graphServerError)
      )

      const { failure, entries, remaining } = yield* drill(
        microsoftOutlookConcurrentWritesCase,
        serverError
      )

      expect(failure).toEqual(
        mismatch('expected a losing concurrent write to fail with HTTP 409 or 404')
      )
      expect(entries.map(entry => entry.method)).toEqual(['POST', 'PATCH', 'PATCH', 'POST'])
      expect(entries.at(-1)?.url).toBe('https://graph.microsoft.com/v1.0/$batch')
      expect(remaining).toEqual([])
    })
  )

  it.effect('fails the immutable-id case when the move returns a new id, and deletes that id', () =>
    Effect.gen(function* () {
      const { failure, entries, remaining } = yield* drill(
        microsoftOutlookImmutableIdCase,
        movedIdFixture
      )

      // The restore succeeded: the case reports the claim, not a restore failure.
      expect(failure).toEqual(mismatch('expected the moved message to keep its immutable id'))
      expect(exchangeIndices(entries)).toEqual(['POST 0', 'POST 1', 'POST 2'])
      expect(remaining).toEqual([])
      expectBatchDeletesBothIds(entries)
    })
  )

  it.effect('reports a failed restore when the draft under its new id is not deleted', () =>
    Effect.gen(function* () {
      const changed = replaceResponse(
        microsoftOutlookImmutableIdFixture,
        1,
        replaceInBody(
          '"id":"AAkALgAAAAAAHYQDEapmEc2byACqAC-EWg0A-synthetic-immutable-0001="',
          '"id":"AAMkAGI2-synthetic-moved-0001="'
        )
      )

      // Only the original id answers in the batch: the new id's outcome is unknown.
      const { failure } = yield* drill(
        microsoftOutlookImmutableIdCase,
        pickExchanges(changed, [0, 1, 3])
      )

      expect(failure?.tag).toBe('MicrosoftConformanceRestoreFailed')
      expect(failure?.message).toContain(
        'Restore error: expected the case-created draft to be permanently deleted. Claim failed first: expected the moved message to keep ...'
      )
    })
  )

  it.effect('reports a failed restore instead of swallowing it', () =>
    Effect.gen(function* () {
      const undeleted = replaceResponse(
        microsoftOutlookImmutableIdFixture,
        3,
        replaceInBody('"status":204', '"status":500')
      )

      const { failure } = yield* drill(microsoftOutlookImmutableIdCase, undeleted)

      expect(failure?.tag).toBe('MicrosoftConformanceRestoreFailed')
      expect(failure?.message).toBe(
        'microsoft.outlook.immutable-id-survives-move: restore failed; remove the case-created item by hand if it still exists (subjects and names start with yolk-conformance). Restore error: expected the case-created draft to be permanently deleted. Claim held first.'
      )
    })
  )

  it.effect('reports both a failed claim and a failed restore on the folder case', () =>
    Effect.gen(function* () {
      // The listing (1) omits the folder, and the restore DELETE (2) fails with a 500.
      const missing = replaceResponse(
        replaceResponse(microsoftOneDriveCreateFolderFixture, 1, response => {
          const body = JSON.parse(textBody(response))

          return {
            status: 200,
            headers: response.headers,
            body: JSON.stringify({ ...body, value: body.value.slice(0, 1) })
          }
        }),
        2,
        withStatus(500, graphServerError)
      )

      const { failure, entries } = yield* drill(
        microsoftOneDriveCreateFolderCase,
        pickExchanges(missing, [0, 1, 2])
      )

      expect(failure?.tag).toBe('MicrosoftConformanceRestoreFailed')
      // Both summaries are capped so the whole message fits the 300-character report cap.
      expect(failure?.message).toBe(
        'microsoft.onedrive.create-folder-roundtrip: restore failed; remove the case-created item by hand if it still exists (subjects and names start with yolk-conformance). Restore error: onedrive.delete_item onedrive_delete_item_failed 500. Claim failed first: expected the parent listing to include the...'
      )
      expect(failure?.message.length).toBeLessThanOrEqual(300)
      expect(exchangeIndices(entries)).toEqual(['POST 0', 'GET 1', 'DELETE 2'])
    })
  )

  it.effect('keeps the event for the restore when DELETE succeeds but GET still finds it', () =>
    Effect.gen(function* () {
      const [, fetched] = microsoftCalendarCreateEventFixture.exchanges
      const deleted = microsoftCalendarCreateEventFixture.exchanges[3]
      const gone = microsoftCalendarCreateEventFixture.exchanges[4]

      if (fetched === undefined || deleted === undefined || gone === undefined) {
        return expect.fail('expected five create-event exchanges')
      }

      // DELETE (3) answers 204 but GET (4) still returns the event; the restore then deletes it
      // again (5) and GET (6) still finds it, so the restore fails and is reported.
      const stillThere: WireExchange = { request: gone.request, response: fetched.response }

      const fixture = withExtra(pickExchanges(microsoftCalendarCreateEventFixture, [0, 1, 2, 3]), [
        stillThere,
        deleted,
        stillThere
      ])

      const { failure, entries, remaining } = yield* drill(
        microsoftCalendarCreateEventCase,
        fixture
      )

      expect(exchangeIndices(entries)).toEqual([
        'POST 0',
        'GET 1',
        'PATCH 2',
        'DELETE 3',
        'GET 4',
        'DELETE 5',
        'GET 6'
      ])
      expect(remaining).toEqual([])
      expect(failure?.tag).toBe('MicrosoftConformanceRestoreFailed')
      expect(failure?.message).toBe(
        'microsoft.calendar.create-returns-event-id: restore failed; remove the case-created item by hand if it still exists (subjects and names start with yolk-conformance). Restore error: expected GET of the case-created event to answer 404 afte... Claim failed first: expected GET with the created id to...'
      )
    })
  )

  it.effect('keeps the folder for the restore when DELETE succeeds but GET still finds it', () =>
    Effect.gen(function* () {
      const [created, , deleted, gone] =
        microsoftOneDriveCreateFolderFixture.exchanges.length === 4
          ? microsoftOneDriveCreateFolderFixture.exchanges
          : expect.fail('expected four create-folder exchanges')

      const stillThere: WireExchange = {
        request: gone.request,
        response: { ...created.response, status: 200 }
      }

      const fixture = withExtra(pickExchanges(microsoftOneDriveCreateFolderFixture, [0, 1, 2]), [
        stillThere,
        deleted,
        stillThere
      ])

      const { failure, entries, remaining } = yield* drill(
        microsoftOneDriveCreateFolderCase,
        fixture
      )

      expect(exchangeIndices(entries)).toEqual([
        'POST 0',
        'GET 1',
        'DELETE 2',
        'GET 3',
        'DELETE 4',
        'GET 5'
      ])
      expect(remaining).toEqual([])
      expect(failure?.tag).toBe('MicrosoftConformanceRestoreFailed')
      expect(failure?.message).toBe(
        'microsoft.onedrive.create-folder-roundtrip: restore failed; remove the case-created item by hand if it still exists (subjects and names start with yolk-conformance). Restore error: expected GET of the case-created folder to answer 404 aft... Claim failed first: expected GET of the deleted folder ...'
      )
    })
  )

  it.effect('fails with a precondition before any request when a seed is missing', () =>
    Effect.gen(function* () {
      const { calendarEventId: _dropped, ...seeds } = microsoftConformanceFixtureSeeds

      const { failure, entries } = yield* drill(
        microsoftCalendarListRangeCase,
        microsoftCalendarListRangeFixture,
        seeds
      )

      expect(failure).toEqual(
        mismatch('precondition: MicrosoftConformanceConfig.calendarEventId is not configured')
      )
      expect(entries).toEqual([])
    })
  )
})

describe('Microsoft conformance interruption', () => {
  it.effect('removes an event whose create was in flight when the case was interrupted', () =>
    Effect.gen(function* () {
      const createSent = yield* Deferred.make<void>()
      const releaseCreate = yield* Deferred.make<void>()

      // The create (0), then only the restore's DELETE (3) and GET (4).
      const { client, ledger } = yield* makeReplayHttpClient([
        pickExchanges(microsoftCalendarCreateEventFixture, [0, 3, 4])
      ])

      // Graph has created the event, but its response is held back until the test releases it.
      const holdingCreate = HttpClient.transform(client, (response, request) =>
        request.method === 'POST'
          ? response.pipe(
              Effect.tap(() => Deferred.succeed(createSent, undefined)),
              Effect.tap(() => Deferred.await(releaseCreate))
            )
          : response
      )

      const fiber = yield* microsoftCalendarCreateEventCase.run.pipe(
        Effect.provide(portsOver(Layer.succeed(HttpClient.HttpClient, holdingCreate))),
        Effect.forkChild
      )

      yield* Deferred.await(createSent)

      // Interrupt between the remote create and the id registration, then let the response in.
      const interrupting = yield* Effect.forkChild(Fiber.interrupt(fiber))

      yield* Effect.yieldNow
      yield* Deferred.succeed(releaseCreate, undefined)
      yield* Fiber.join(interrupting)

      const exit = yield* Fiber.await(fiber)

      expect(Exit.hasInterrupts(exit)).toBe(true)
      expect(exchangeIndices(yield* ledger.entries)).toEqual(['POST 0', 'DELETE 1', 'GET 2'])
      expect(yield* ledger.remaining).toEqual([])
    })
  )

  it.effect(
    'deletes the new id of a draft whose move was in flight when the case was interrupted',
    () =>
      Effect.gen(function* () {
        const moveSent = yield* Deferred.make<void>()
        const releaseMove = yield* Deferred.make<void>()

        // The create (0), a move answering a NEW id (1), then only the cleanup batch (2).
        const { client, ledger } = yield* makeReplayHttpClient([movedIdFixture])

        // Graph has moved the draft, but the move response is held back until the test releases it.
        const holdingMove = HttpClient.transform(client, (response, request) =>
          request.url.endsWith('/move')
            ? response.pipe(
                Effect.tap(() => Deferred.succeed(moveSent, undefined)),
                Effect.tap(() => Deferred.await(releaseMove))
              )
            : response
        )

        const fiber = yield* microsoftOutlookImmutableIdCase.run.pipe(
          Effect.provide(portsOver(Layer.succeed(HttpClient.HttpClient, holdingMove))),
          Effect.forkChild
        )

        yield* Deferred.await(moveSent)

        // Interrupt between the remote move and the new id's registration, then let the response in.
        const interrupting = yield* Effect.forkChild(Fiber.interrupt(fiber))

        yield* Effect.yieldNow
        yield* Deferred.succeed(releaseMove, undefined)
        yield* Fiber.join(interrupting)

        const exit = yield* Fiber.await(fiber)
        const entries = yield* ledger.entries

        // Interrupted before the claims: no set_read PATCH, straight to the cleanup batch.
        expect(Exit.hasInterrupts(exit)).toBe(true)
        expect(exchangeIndices(entries)).toEqual(['POST 0', 'POST 1', 'POST 2'])
        expect(yield* ledger.remaining).toEqual([])
        expectBatchDeletesBothIds(entries)
      })
  )
})

const ambiguousCreateAdvice =
  'the item may exist anyway: remove the case-created item by hand if it still exists (subjects and names start with yolk-conformance).'

/** The raised message of a 502 event create; the report puts the case id in front of it. */
const badGatewayCreateMessage = `microsoft.conformance.create_event failed: microsoft_create_event_failed (HTTP 502); ${ambiguousCreateAdvice}`

/** A client whose every request fails in transport, as if the connection dropped mid-response. */
const droppingHttpClient = HttpClient.make(request =>
  Effect.fail(
    new HttpClientError.HttpClientError({
      reason: new HttpClientError.TransportError({ request, description: 'connection reset' })
    })
  )
)

describe('Microsoft conformance ambiguous creates', () => {
  const runOver = (testCase: MicrosoftConformanceCase, client: HttpClient.HttpClient) =>
    Effect.gen(function* () {
      yield* atTestNow

      const report = yield* runConformance([testCase], {
        target: { kind: 'replay' },
        now,
        layer: () => portsOver(Layer.succeed(HttpClient.HttpClient, client))
      })

      return report.results[0]?.failure
    })

  it.effect('reports a transport failure of the create with manual-recovery advice', () =>
    Effect.gen(function* () {
      expect(yield* runOver(microsoftCalendarCreateEventCase, droppingHttpClient)).toEqual({
        kind: 'failure',
        tag: 'MicrosoftConformanceActionFailed',
        message: `microsoft.conformance.create_event failed: transport_failed; ${ambiguousCreateAdvice}`
      })
    })
  )

  it.effect(
    'reports a create that answers an undecodable success with manual-recovery advice',
    () =>
      Effect.gen(function* () {
        const garbled = replaceResponse(microsoftCalendarCreateEventFixture, 0, response => ({
          status: 201,
          headers: response.headers,
          body: 'not json'
        }))

        const { failure, entries } = yield* drill(
          microsoftCalendarCreateEventCase,
          pickExchanges(garbled, [0])
        )

        expect(failure).toEqual({
          kind: 'failure',
          tag: 'MicrosoftConformanceActionFailed',
          message: `microsoft.conformance.create_event failed: validation_failed; ${ambiguousCreateAdvice}`
        })
        expect(exchangeIndices(entries)).toEqual(['POST 0'])
      })
  )

  it.effect('reports a 5xx create with its code, status, and manual-recovery advice', () =>
    Effect.gen(function* () {
      const serverError = replaceResponse(
        microsoftOutlookImmutableIdFixture,
        0,
        withStatus(500, graphServerError)
      )

      const { failure, entries } = yield* drill(
        microsoftOutlookImmutableIdCase,
        pickExchanges(serverError, [0])
      )

      expect(failure).toEqual({
        kind: 'failure',
        tag: 'MicrosoftConformanceActionFailed',
        message: `outlook.create_draft failed: outlook_create_draft_failed (HTTP 500); ${ambiguousCreateAdvice}`
      })
      expect(failure?.message.length).toBeLessThanOrEqual(300)
      expect(exchangeIndices(entries)).toEqual(['POST 0'])
    })
  )

  it.effect('reports a 408 create as ambiguous: a timed-out create may still have written', () =>
    Effect.gen(function* () {
      const timedOut = replaceResponse(
        microsoftOutlookImmutableIdFixture,
        0,
        withStatus(408, graphServerError)
      )

      const { failure, entries } = yield* drill(
        microsoftOutlookImmutableIdCase,
        pickExchanges(timedOut, [0])
      )

      expect(failure?.tag).toBe('MicrosoftConformanceActionFailed')
      expect(failure?.message).toMatch(/^outlook\.create_draft failed: \S+ \(HTTP 408\); /)
      expect(failure?.message).toContain(ambiguousCreateAdvice)
      expect(exchangeIndices(entries)).toEqual(['POST 0'])
    })
  )

  it.effect('reports a 4xx create without the advice: nothing was created', () =>
    Effect.gen(function* () {
      const rejected = replaceResponse(
        microsoftOneDriveCreateFolderFixture,
        0,
        withStatus(403, graphServerError)
      )

      const { failure } = yield* drill(
        microsoftOneDriveCreateFolderCase,
        pickExchanges(rejected, [0])
      )

      expect(failure).toEqual({
        kind: 'failure',
        tag: 'MicrosoftConformanceActionFailed',
        message: 'onedrive.create_folder failed: microsoft_unauthorized (HTTP 403)'
      })
    })
  )

  it.effect(
    'reports a 409 folder create as the leftover-folder precondition, deleting nothing',
    () =>
      Effect.gen(function* () {
        const conflict = replaceResponse(
          microsoftOneDriveCreateFolderFixture,
          0,
          withStatus(409, graphServerError)
        )

        const { failure, entries } = yield* drill(
          microsoftOneDriveCreateFolderCase,
          pickExchanges(conflict, [0])
        )

        expect(failure?.tag).toBe('ConformanceMismatch')
        expect(failure?.message).toMatch(
          /^precondition: a folder named "[^"]+" already exists under driveParentItemId \(left by an earlier run\?\); delete it by hand/
        )
        expect(exchangeIndices(entries)).toEqual(['POST 0'])
      })
  )
})

// Interruption reporting: a cleanup problem (a failed removal, an ambiguous create, an id-less
// create) raised while the case is being interrupted still reaches the owner through the
// ConformanceCleanupReporter, with the full message naming the case or create.

const restoreFailedAdvice =
  'microsoft.calendar.create-returns-event-id: restore failed; remove the case-created item by hand if it still exists (subjects and names start with yolk-conformance).'

const idLessCreateMessage = `${restoreFailedAdvice} Restore error: the create response carried no id, so nothing was removed. Claim failed first.`

const failedEventDelete = withStatus(500, graphServerError)

const removalMoments = [
  {
    moment: 'during the claim',
    // The claim's GET (1) is held; the restore's DELETE (3) then answers 500.
    fixture: replaceResponse(
      pickExchanges(microsoftCalendarCreateEventFixture, [0, 1, 3]),
      2,
      failedEventDelete
    ),
    held: (request: { readonly method: string }) => request.method === 'GET',
    message: `${restoreFailedAdvice} Restore error: microsoft.conformance.delete_event microsoft_delete_e... 500. Claim failed first: interrupted`
  },
  {
    moment: 'during the restore',
    // The claim's PATCH (2) answers the old subject, so the claim fails before its own DELETE;
    // the restore's DELETE (3) is held and then answers 500.
    fixture: replaceResponse(
      replaceResponse(
        pickExchanges(microsoftCalendarCreateEventFixture, [0, 1, 2, 3]),
        2,
        replaceInBody(
          '"yolk-conformance event (updated): safe to delete"',
          '"yolk-conformance event: safe to delete"'
        )
      ),
      3,
      failedEventDelete
    ),
    held: (request: { readonly method: string }) => request.method === 'DELETE',
    message: `${restoreFailedAdvice} Restore error: microsoft.conformance.delete_event microsoft_delete_e... 500. Claim failed first: expected PATCH with the created id to return the updated...`
  }
] as const

/** `client`, with the first response `held` selects held until `release` (and `sent` signalled). */
const holdingFirst = (
  client: HttpClient.HttpClient,
  held: (request: { readonly method: string }) => boolean,
  sent: Deferred.Deferred<void>,
  release: Deferred.Deferred<void>
) =>
  Effect.gen(function* () {
    const seen = yield* Ref.make(0)

    return HttpClient.transform(client, (response, request) =>
      held(request)
        ? Ref.updateAndGet(seen, n => n + 1).pipe(
            Effect.flatMap(n =>
              n === 1
                ? response.pipe(
                    Effect.tap(() => Deferred.succeed(sent, undefined)),
                    Effect.tap(() => Deferred.await(release))
                  )
                : response
            )
          )
        : response
    )
  })

/** Run the create-event case over `fixture`, interrupting it while the `held` response is held. */
const interruptCreateEventCase = (
  fixture: WireFixture,
  held: (request: { readonly method: string }) => boolean
) =>
  Effect.gen(function* () {
    const sent = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const { warnings, reporter } = yield* capturingReporter

    const { client } = yield* makeReplayHttpClient([fixture])
    const holding = yield* holdingFirst(client, held, sent, release)

    const fiber = yield* microsoftCalendarCreateEventCase.run.pipe(
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

    return yield* Ref.get(warnings)
  })

const isCreate = (request: { readonly method: string }) => request.method === 'POST'

describe('Microsoft conformance interruption reporting', () => {
  for (const { moment, fixture, held, message } of removalMoments) {
    it.effect(`reports a failed removal when interrupted ${moment}`, () =>
      Effect.gen(function* () {
        // Whatever the fiber's exit, the owner sees the failed removal and what to do by hand.
        expect(yield* interruptCreateEventCase(fixture, held)).toEqual([message])
      })
    )
  }

  it.effect('reports an ambiguous create answered while the case is being interrupted', () =>
    Effect.gen(function* () {
      // Graph receives the create; its answer (a 502) is held until the case is being stopped.
      const badGateway = pickExchanges(
        replaceResponse(microsoftCalendarCreateEventFixture, 0, withStatus(502, graphServerError)),
        [0]
      )

      expect(yield* interruptCreateEventCase(badGateway, isCreate)).toEqual([
        `microsoft.calendar.create-returns-event-id: ${badGatewayCreateMessage}`
      ])
    })
  )

  it.effect('reports a create without an id answered while the case is being interrupted', () =>
    Effect.gen(function* () {
      expect(yield* interruptCreateEventCase(idLessCreateFixture, isCreate)).toEqual([
        idLessCreateMessage
      ])
    })
  )

  it.effect('reports nothing for a definitive create rejection while interrupted', () =>
    Effect.gen(function* () {
      const rejected = pickExchanges(
        replaceResponse(microsoftCalendarCreateEventFixture, 0, withStatus(403, graphServerError)),
        [0]
      )

      expect(yield* interruptCreateEventCase(rejected, isCreate)).toEqual([])
    })
  )

  it.effect(
    'reports nothing extra when an uninterrupted removal fails (the report carries it)',
    () =>
      Effect.gen(function* () {
        const { warnings, reporter } = yield* capturingReporter

        const undeleted = replaceResponse(
          microsoftOutlookImmutableIdFixture,
          3,
          replaceInBody('"status":204', '"status":500')
        )

        const { client } = yield* makeReplayHttpClient([undeleted])

        const exit = yield* microsoftOutlookImmutableIdCase.run.pipe(
          Effect.provide(portsOver(Layer.succeed(HttpClient.HttpClient, client))),
          Effect.provideService(ConformanceCleanupReporter, reporter),
          Effect.exit
        )

        if (Exit.isSuccess(exit)) {
          return expect.fail('expected the failed removal to fail the case')
        }

        expect(Cause.squash(exit.cause)).toMatchObject({
          _tag: 'MicrosoftConformanceRestoreFailed'
        })
        expect(yield* Ref.get(warnings)).toEqual([])
      })
  )

  it.effect('reports nothing extra for an uninterrupted ambiguous create', () =>
    Effect.gen(function* () {
      const { warnings, reporter } = yield* capturingReporter

      const exit = yield* microsoftCalendarCreateEventCase.run.pipe(
        Effect.provide(portsOver(Layer.succeed(HttpClient.HttpClient, droppingHttpClient))),
        Effect.provideService(ConformanceCleanupReporter, reporter),
        Effect.exit
      )

      if (Exit.isSuccess(exit)) {
        return expect.fail('expected the ambiguous create to fail the case')
      }

      expect(Cause.squash(exit.cause)).toMatchObject({
        _tag: 'MicrosoftConformanceActionFailed',
        createOutcome: 'unknown'
      })
      expect(yield* Ref.get(warnings)).toEqual([])
    })
  )
})

// Run-level interruption drill: runConformance over [a write case whose removal fails, a
// sentinel]. Interrupting the case must stop the run: the sentinel never starts.

const sentinelCase = (ran: Ref.Ref<boolean>) =>
  defineConformanceCase({
    id: 'test.sentinel.after-interrupted-case',
    safety: 'read',
    docs: 'Synthetic sentinel: records whether it ran.',
    wire: 'Runs only if the run was not stopped.',
    fixtures: [],
    run: Ref.set(ran, true)
  })

/** runConformance over [the create-event case, a sentinel], interrupted while `held` is held. */
const interruptCreateEventRun = (
  fixture: WireFixture,
  held: (request: { readonly method: string }) => boolean
) =>
  Effect.gen(function* () {
    const sent = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const sentinelRan = yield* Ref.make(false)
    const { warnings, reporter } = yield* capturingReporter

    const { client, ledger } = yield* makeReplayHttpClient([fixture])
    const holding = yield* holdingFirst(client, held, sent, release)

    const fiber = yield* runConformance(
      [microsoftCalendarCreateEventCase, sentinelCase(sentinelRan)],
      {
        target: { kind: 'replay' },
        now,
        layer: () => portsOver(Layer.succeed(HttpClient.HttpClient, holding))
      }
    ).pipe(Effect.provideService(ConformanceCleanupReporter, reporter), Effect.forkChild)

    yield* Deferred.await(sent)

    const interrupting = yield* Effect.forkChild(Fiber.interrupt(fiber))

    yield* Effect.yieldNow
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(interrupting)

    return {
      exit: yield* Fiber.await(fiber),
      sentinelRan: yield* Ref.get(sentinelRan),
      warnings: yield* Ref.get(warnings),
      remaining: yield* ledger.remaining
    }
  })

describe('Microsoft conformance run interruption', () => {
  for (const { moment, fixture, held, message } of removalMoments) {
    it.effect(`stops the whole run when interrupted ${moment} with a failing removal`, () =>
      Effect.gen(function* () {
        const { exit, sentinelRan, warnings } = yield* interruptCreateEventRun(fixture, held)

        expect(sentinelRan).toBe(false)

        // As for Dropbox: the run ends with the case's own RestoreFailed, and no Interrupt in the
        // cause, so it produces no report and resumes no case.
        if (Exit.isSuccess(exit)) {
          return expect.fail('expected the interrupted run to fail')
        }

        expect(Cause.hasInterrupts(exit.cause)).toBe(false)
        expect(Cause.squash(exit.cause)).toMatchObject({
          _tag: 'MicrosoftConformanceRestoreFailed'
        })
        expect(warnings).toEqual([message])
      })
    )
  }

  it.effect('stops the whole run when an ambiguous create answers while interrupted', () =>
    Effect.gen(function* () {
      const badGateway = pickExchanges(
        replaceResponse(microsoftCalendarCreateEventFixture, 0, withStatus(502, graphServerError)),
        [0]
      )

      const { exit, sentinelRan, warnings } = yield* interruptCreateEventRun(badGateway, isCreate)

      expect(sentinelRan).toBe(false)

      if (Exit.isSuccess(exit)) {
        return expect.fail('expected the interrupted run to fail')
      }

      expect(Cause.hasInterrupts(exit.cause)).toBe(false)

      const raised = Cause.squash(exit.cause)

      expect(raised).toMatchObject({
        _tag: 'MicrosoftConformanceActionFailed',
        createOutcome: 'unknown'
      })
      // The raised error is unchanged; only the report names the case.
      expect(raised instanceof Error ? raised.message : undefined).toBe(badGatewayCreateMessage)
      expect(warnings).toEqual([
        `microsoft.calendar.create-returns-event-id: ${badGatewayCreateMessage}`
      ])
    })
  )

  it.effect('stops the whole run when a create without an id answers while interrupted', () =>
    Effect.gen(function* () {
      const { exit, sentinelRan, warnings } = yield* interruptCreateEventRun(
        idLessCreateFixture,
        isCreate
      )

      expect(sentinelRan).toBe(false)

      if (Exit.isSuccess(exit)) {
        return expect.fail('expected the interrupted run to fail')
      }

      expect(Cause.hasInterrupts(exit.cause)).toBe(false)
      expect(Cause.squash(exit.cause)).toMatchObject({
        _tag: 'MicrosoftConformanceRestoreFailed'
      })
      expect(warnings).toEqual([idLessCreateMessage])
    })
  )

  it.effect(
    'ends interrupt-only, without a report or a later case, when the removal succeeds',
    () =>
      Effect.gen(function* () {
        // The claim's GET (1) is held; the restore's DELETE (3) and GET (4) then succeed.
        const { exit, sentinelRan, warnings, remaining } = yield* interruptCreateEventRun(
          pickExchanges(microsoftCalendarCreateEventFixture, [0, 1, 3, 4]),
          request => request.method === 'GET'
        )

        expect(sentinelRan).toBe(false)

        if (Exit.isSuccess(exit)) {
          return expect.fail('expected the interrupted run to be interrupted')
        }

        expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        expect(warnings).toEqual([])
        expect(remaining).toEqual([])
      })
  )
})
