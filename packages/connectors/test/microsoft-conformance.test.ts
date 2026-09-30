import { describe, expect, it } from '@effect/vitest'
import { Effect, Layer, Ref } from 'effect'
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
import { OAuthCredential } from '@yolk-sdk/connectors'
import {
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

const graphServerError =
  '{"error":{"code":"ErrorInternalServerError","message":"Synthetic placeholder: server error.","innerError":{"date":"2026-09-29T10:00:09","request-id":"00000000-0000-4000-8000-000000000009","client-request-id":"00000000-0000-4000-8000-000000000009"}}}'

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
    'fails the create case when the create response carries no id, writing nothing more',
    () =>
      Effect.gen(function* () {
        const noId = replaceResponse(
          microsoftCalendarCreateEventFixture,
          0,
          replaceInBody('"id":"AAMkAGI2-synthetic-event-0101=",', '')
        )

        const { failure, entries } = yield* drill(microsoftCalendarCreateEventCase, noId)

        expect(failure).toEqual(
          mismatch(
            'expected the create response to carry an event id; an event titled "yolk-conformance event: safe to delete" may exist: delete it by hand'
          )
        )
        // Without an id there is nothing to address: only the create was sent.
        expect(exchangeIndices(entries)).toEqual(['POST 0'])
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

  it.effect('fails the immutable-id case when the move returns a new id, and still deletes', () =>
    Effect.gen(function* () {
      const changed = replaceResponse(
        microsoftOutlookImmutableIdFixture,
        1,
        replaceInBody(
          '"id":"AAkALgAAAAAAHYQDEapmEc2byACqAC-EWg0A-synthetic-immutable-0001="',
          '"id":"AAMkAGI2-synthetic-moved-0001="'
        )
      )

      const { failure, entries, remaining } = yield* drill(
        microsoftOutlookImmutableIdCase,
        pickExchanges(changed, [0, 1, 3])
      )

      expect(failure).toEqual(mismatch('expected the moved message to keep its immutable id'))
      expect(exchangeIndices(entries)).toEqual(['POST 0', 'POST 1', 'POST 2'])
      expect(remaining).toEqual([])
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
        'microsoft.onedrive.create-folder-roundtrip: restore failed; remove the case-created item by hand if it still exists (subjects and names start with yolk-conformance). Restore error: MicrosoftConformanceActionFailed: onedrive.delete_item fa... Claim failed first: expected the parent listing to incl...'
      )
      expect(failure?.message.length).toBeLessThanOrEqual(300)
      expect(exchangeIndices(entries)).toEqual(['POST 0', 'GET 1', 'DELETE 2'])
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
