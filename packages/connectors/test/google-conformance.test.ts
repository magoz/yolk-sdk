import { describe, expect, it } from '@effect/vitest'
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Predicate, Ref } from 'effect'
import * as Schema from 'effect/Schema'
import { TestClock } from 'effect/testing'
import { HttpClient, HttpClientError, type HttpClientRequest } from 'effect/http'
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
import { BearerTokenCredential } from '@yolk-sdk/connectors'
import {
  ConformanceCleanupReporter,
  connectorHttpClientsFromEffectHttpClientLayer,
  staticCredentialResolverLayer
} from '@yolk-sdk/connectors/conformance'
import { GoogleConnector } from '@yolk-sdk/connectors/google'
import {
  calendarDeletedGoneCase,
  calendarDeletedGoneFixture,
  calendarEventLifecycleCase,
  calendarEventLifecycleFixture,
  calendarListRangeFixture,
  driveFolderLifecycleCase,
  driveFolderLifecycleFixture,
  driveGetFileFieldsFixture,
  driveListPagingCase,
  driveListPagingFixture,
  findGoogleConformanceLeftovers,
  gmailAttachmentFixture,
  gmailDraftLifecycleCase,
  gmailDraftLifecycleFixture,
  gmailLabelLifecycleCase,
  gmailLabelLifecycleFixture,
  gmailListPagingCase,
  gmailListPagingFixture,
  gmailListThreadsPagingFixture,
  gmailMetadataHeadersFixture,
  gmailNotFoundEnvelopeFixture,
  gmailSendPracticeCase,
  gmailSendPracticeFixture,
  gmailTrashUntrashCase,
  gmailTrashUntrashFixture,
  GoogleConformanceConfig,
  googleConformanceCases,
  googleConformanceFixtures,
  googleConformanceFixtureSeeds,
  GoogleConformanceRunId,
  GoogleConformanceSeeds as GoogleConformanceSeedsSchema,
  GooglePracticeAddress,
  type GoogleConformanceCase,
  type GoogleConformanceSeeds
} from '@yolk-sdk/connectors/google/conformance'

const now = new Date('2026-09-30T12:00:00.000Z')

const atTestNow = TestClock.setTime(now.getTime())

const syntheticToken = 'ya29.synthetic-google-access-token-0001'

const credentialLayer = staticCredentialResolverLayer(
  BearerTokenCredential.make({ token: syntheticToken })
)

const portsOver = (
  httpLayer: Layer.Layer<HttpClient.HttpClient>,
  seeds: GoogleConformanceSeeds = googleConformanceFixtureSeeds
) =>
  Layer.mergeAll(
    connectorHttpClientsFromEffectHttpClientLayer.pipe(Layer.provide(httpLayer)),
    credentialLayer,
    Layer.succeed(GoogleConformanceConfig, seeds)
  )

const fixturesFor = (
  testCase: Pick<ConformanceCase<unknown, unknown>, 'fixtures'>,
  fixtures: ReadonlyArray<WireFixture> = googleConformanceFixtures
) => fixtures.filter(fixture => testCase.fixtures.includes(fixture.id))

const replayLayerOver =
  (fixtures: ReadonlyArray<WireFixture> = googleConformanceFixtures) =>
  (testCase: GoogleConformanceCase) =>
    portsOver(ReplayHttpClient.layer(fixturesFor(testCase, fixtures)))

/** Replay layer that also hands its ledger to the test, keyed by case id. */
const ledgerCaseLayer =
  (
    ledgers: Ref.Ref<Map<string, ReplayLedgerApi>>,
    fixtures: ReadonlyArray<WireFixture> = googleConformanceFixtures,
    seeds: GoogleConformanceSeeds = googleConformanceFixtureSeeds
  ) =>
  (testCase: GoogleConformanceCase) =>
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

const googleOrigins = [
  'https://gmail.googleapis.com/',
  'https://www.googleapis.com/calendar/v3/',
  'https://www.googleapis.com/drive/v3/'
]

/** `METHOD route exchangeIndex` per ledger entry (route after the API version, no query). */
const exchangeIndices = (entries: ReadonlyArray<ReplayLedgerEntry>) =>
  entries.map(entry =>
    entry.match.outcome === 'matched'
      ? `${entry.method} ${routeOf(entry.url)} ${entry.match.exchangeIndex}`
      : `unmatched ${entry.method} ${entry.url}`
  )

const routeOf = (url: string) =>
  (url.split('?', 1)[0] ?? '')
    .replace('https://gmail.googleapis.com/gmail/v1/users/me/', '')
    .replace(/^https:\/\/www\.googleapis\.com\/calendar\/v3\/calendars\/[^/]+\//, '')
    .replace('https://www.googleapis.com/drive/v3/', '')

const synthetic = (id: string) => `${id}.synthetic`

const caseIds = [
  ['google.gmail.list-page-token', 'read'],
  ['google.gmail.attachment-base64url', 'read'],
  ['google.gmail.not-found-envelope', 'read'],
  ['google.gmail.list-threads-page-token', 'read'],
  ['google.gmail.metadata-headers', 'read'],
  ['google.gmail.label-create-apply-delete', 'write-reversible'],
  ['google.gmail.draft-compose-update-delete', 'write-reversible'],
  ['google.gmail.trash-untrash', 'write-reversible'],
  ['google.gmail.send-practice-address', 'write-irreversible'],
  ['google.calendar.list-range-paging', 'read'],
  ['google.calendar.event-lifecycle', 'write-reversible'],
  ['google.calendar.deleted-event-gone', 'write-reversible'],
  ['google.drive.list-page-token', 'read'],
  ['google.drive.get-file-fields', 'read'],
  ['google.drive.folder-trash-delete', 'write-reversible']
] as const

const sendId = 'google.gmail.send-practice-address'

/** Replay may run every case, the write-irreversible one included. */
const everyCase: ConformanceTarget = { kind: 'replay' }

function textBody(response: WireResponse): string {
  if (isWireStreamResponse(response) || isWireBase64BodyResponse(response)) {
    return expect.fail('expected a text body')
  }

  return response.body
}

/** The multipart boundary the connector draws per send, normalized for comparison. */
const normalizedBoundary = (value: unknown) =>
  Predicate.isString(value)
    ? value.replaceAll(/yolk_gmail_send_[0-9a-f]{32}/g, 'yolk_gmail_send_<boundary>')
    : value

describe('Google conformance cases', () => {
  it('declare their safety, stay unverified, and are backed by one fixture each', () => {
    expect(googleConformanceCases.map(testCase => [testCase.id, testCase.safety])).toEqual(
      caseIds.map(([id, safety]) => [id, safety])
    )
    expect(googleConformanceFixtures.map(fixture => fixture.caseId)).toEqual(
      googleConformanceCases.map(testCase => testCase.id)
    )

    for (const testCase of googleConformanceCases) {
      expect(testCase.observed).toBeUndefined()
      expect(testCase.fixtures).toEqual([synthetic(testCase.id)])
    }
  })

  it('cite only real connector actions', () => {
    const actionIds = new Set(GoogleConnector.actions.map(action => action.id))

    for (const testCase of googleConformanceCases) {
      const cited = [
        ...`${testCase.docs} ${testCase.wire}`.matchAll(/`((?:gmail|calendar|drive)\.[a-z_]+)`/g)
      ].map(match => match[1])

      expect(cited.length).toBeGreaterThan(0)
      expect(cited.filter(id => id === undefined || !actionIds.has(id))).toEqual([])
    }
  })

  it('mark every guessed sub-claim unverified in wire', () => {
    expect(
      googleConformanceCases.flatMap(testCase =>
        [...testCase.wire.matchAll(/\bunverified: /g)].map(() => testCase.id)
      )
    ).toEqual([
      'google.gmail.not-found-envelope',
      'google.gmail.list-threads-page-token',
      'google.gmail.metadata-headers',
      'google.gmail.draft-compose-update-delete',
      'google.gmail.draft-compose-update-delete',
      'google.gmail.draft-compose-update-delete',
      'google.gmail.draft-compose-update-delete',
      'google.calendar.event-lifecycle',
      'google.calendar.deleted-event-gone',
      'google.calendar.deleted-event-gone'
    ])
  })

  it.effect('ship synthetic fixtures that decode and pass the secret scan', () =>
    Effect.gen(function* () {
      for (const fixture of googleConformanceFixtures) {
        expect(yield* decodeWireFixture(fixture)).toEqual(fixture)
        expect(scanFixtureForSecrets(fixture)).toEqual([])
        expect(fixture).toMatchObject({ evidence: 'unverified', account: 'synthetic' })

        for (const { request, response } of fixture.exchanges) {
          expect(Object.keys(request.headers ?? {})).not.toContain('authorization')
          expect(googleOrigins.some(origin => request.url.startsWith(origin))).toBe(true)
          expect(JSON.stringify(request)).not.toContain('ya29.')

          if (response.status >= 400) {
            // Google errors: the JSON envelope with a string `error.message`.
            expect(JSON.parse(textBody(response))).toMatchObject({
              error: { message: expect.any(String) }
            })
          }
        }
      }
    })
  )

  it.effect('all pass on replay with unverified warnings', () =>
    Effect.gen(function* () {
      yield* atTestNow

      const report = yield* runConformance(googleConformanceCases, {
        target: everyCase,
        now,
        fixtures: googleConformanceFixtures,
        layer: replayLayerOver()
      })

      expect(report.summary, formatConformanceReport(report)).toEqual({
        passed: 15,
        failed: 0,
        skipped: 0
      })
      expect(conformanceReportFailed(report)).toBe(false)

      for (const result of report.results) {
        expect(result.warnings).toEqual([
          { kind: 'unverified-case' },
          { kind: 'unverified-fixture', fixtureId: synthetic(result.id) }
        ])
      }
    })
  )

  it.effect('consume every recorded exchange in order and send the recorded requests', () =>
    Effect.gen(function* () {
      yield* atTestNow

      const ledgers = yield* Ref.make(new Map<string, ReplayLedgerApi>())

      const report = yield* runConformance(googleConformanceCases, {
        target: everyCase,
        now,
        layer: ledgerCaseLayer(ledgers)
      })

      expect(report.summary.passed).toBe(15)

      for (const testCase of googleConformanceCases) {
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
          expect(normalizedBoundary(entry.bodyJson ?? entry.bodyText)).toEqual(
            normalizedBoundary(exchange?.request.body)
          )
          expect(
            Object.fromEntries(
              Object.entries(entry.headers).map(([name, value]) => [
                name,
                normalizedBoundary(value)
              ])
            )
          ).toMatchObject(
            Object.fromEntries(
              Object.entries(exchange?.request.headers ?? {}).map(([name, value]) => [
                name,
                normalizedBoundary(value)
              ])
            )
          )
          // The token travels in the Authorization header only, and the ledger redacts it.
          expect(entry.headers.authorization).toBe('<redacted>')
          expect(JSON.stringify(entry)).not.toContain(syntheticToken)
        })
      }
    })
  )
})

describe('Google conformance safety on a live target', () => {
  // A replay layer under a `live` target proves the policy without any network.
  const statuses = (target: ConformanceTarget) =>
    atTestNow.pipe(
      Effect.andThen(
        runConformance(googleConformanceCases, { target, now, layer: replayLayerOver() })
      ),
      Effect.map(report =>
        report.results.map(result => [result.id, result.status, result.skipReason ?? null])
      )
    )

  it.effect('runs only the read cases by default', () =>
    Effect.gen(function* () {
      expect(yield* statuses({ kind: 'live', account: 'synthetic' })).toEqual(
        caseIds.map(([id, safety]) =>
          safety === 'read'
            ? [id, 'passed', null]
            : [
                id,
                'skipped',
                safety === 'write-irreversible' ? 'manual-only' : 'writes-not-allowed'
              ]
        )
      )
    })
  )

  it.effect('never sends mail under reversible writes', () =>
    Effect.gen(function* () {
      const results = yield* statuses({
        kind: 'live',
        account: 'synthetic',
        allowWrites: 'reversible'
      })

      expect(results.map(([id, status]) => [id, status])).toEqual(
        caseIds.map(([id]) => [id, id === sendId ? 'skipped' : 'passed'])
      )
    })
  )

  it.effect('sends only when the send case is named by its exact id', () =>
    Effect.gen(function* () {
      const results = yield* statuses({
        kind: 'live',
        account: 'synthetic',
        allowIrreversible: [sendId]
      })

      expect(results.find(([id]) => id === sendId)).toEqual([sendId, 'passed', null])
    })
  )
})

// Drills: replay a fixture that contradicts a claim, or drop it, and check that exactly that case
// fails (and, for write cases, still undoes what it created).

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

/** A copy of `fixture` (same id) with `exchanges` appended. */
const withAppended = (
  fixture: WireFixture,
  exchanges: ReadonlyArray<WireExchange>
): WireFixture => {
  const [first, ...rest] = fixture.exchanges

  return { ...fixture, exchanges: [first, ...rest, ...exchanges] }
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

const exchangeAt = (fixture: WireFixture, index: number): WireExchange =>
  fixture.exchanges[index] ?? expect.fail(`no exchange ${index} in ${fixture.id}`)

const jsonOf = (fixture: WireFixture, index: number) =>
  JSON.parse(textBody(exchangeAt(fixture, index).response))

const json = (status: number, body: unknown): WireResponse => ({
  status,
  headers: { 'content-type': 'application/json; charset=UTF-8' },
  body: JSON.stringify(body)
})

const serverError =
  '{"error":{"code":503,"message":"The service is currently unavailable.","status":"UNAVAILABLE"}}'

const mismatch = (message: string) => ({ kind: 'failure', tag: 'ConformanceMismatch', message })

/** Run the whole suite on replay with `fixtures`; return the failed case ids and failures. */
const suiteFailures = (fixtures: ReadonlyArray<WireFixture>) =>
  Effect.gen(function* () {
    yield* atTestNow

    const report = yield* runConformance(googleConformanceCases, {
      target: everyCase,
      now,
      layer: replayLayerOver(fixtures)
    })

    return report.results
      .filter(result => result.status === 'failed')
      .map(result => ({ id: result.id, failure: result.failure }))
  })

const withReplaced = (tampered: WireFixture) =>
  googleConformanceFixtures.map(fixture => (fixture.id === tampered.id ? tampered : fixture))

const gmailApi = 'https://gmail.googleapis.com/gmail/v1/users/me'

const workMessageUrl = `${gmailApi}/messages/18f00000000000b1?format=minimal`

const minimalMessage = (labelIds: ReadonlyArray<string>) =>
  json(200, { id: '18f00000000000b1', threadId: '18f00000000000b1', labelIds })

type ReportedFailure = { readonly kind: string; readonly tag: string; readonly message: string }

/** One tamper per case: the fixture edit and the failure the case reports. */
const tampers: ReadonlyArray<{
  readonly fixture: WireFixture
  readonly message?: string
  readonly failure?: ReportedFailure
}> = [
  {
    // The first page drops nextPageToken while three messages remain.
    fixture: replaceResponse(gmailListPagingFixture, 1, () =>
      json(200, { ...jsonOf(gmailListPagingFixture, 1), nextPageToken: undefined })
    ),
    message: 'expected the pages to list exactly the messages of the single listing'
  },
  {
    fixture: replaceResponse(gmailAttachmentFixture, 1, () =>
      json(200, { size: 7, data: '-_-_Pj_-' })
    ),
    message: 'expected the base64url data to decode to exactly size bytes'
  },
  {
    fixture: replaceResponse(
      gmailNotFoundEnvelopeFixture,
      0,
      withStatus(
        400,
        '{"error":{"code":400,"message":"Invalid id value","errors":[{"message":"Invalid id value","domain":"global","reason":"invalidArgument"}],"status":"INVALID_ARGUMENT"}}'
      )
    ),
    message: 'expected an unused message id to map to google_not_found'
  },
  {
    // The first thread page drops nextPageToken while three threads remain.
    fixture: replaceResponse(gmailListThreadsPagingFixture, 2, () =>
      json(200, { ...jsonOf(gmailListThreadsPagingFixture, 2), nextPageToken: undefined })
    ),
    message: 'expected the pages to list exactly the threads of the single listing'
  },
  {
    // The selected read answers every header, as if metadataHeaders were ignored.
    fixture: replaceResponse(
      gmailMetadataHeadersFixture,
      1,
      () => exchangeAt(gmailMetadataHeadersFixture, 0).response
    ),
    message:
      'expected get_message with metadataHeaders to answer exactly the selected headers of the unfiltered read'
  },
  {
    // The deleted label still shows on the message.
    fixture: replaceResponse(
      gmailLabelLifecycleFixture,
      5,
      () => exchangeAt(gmailLabelLifecycleFixture, 2).response
    ),
    message: 'expected get_message to drop the deleted label from the work message'
  },
  {
    // The draft message reads back after the repeated delete.
    fixture: replaceResponse(gmailDraftLifecycleFixture, 8, () =>
      json(200, { id: '18f00000000000d2', threadId: '18f00000000000d1', labelIds: ['DRAFT'] })
    ),
    message: 'expected the draft message to stay gone after the repeated delete'
  },
  {
    // Untrash answers the message still in Trash; the restore verifies it is out again.
    fixture: replaceResponse(gmailTrashUntrashFixture, 3, () =>
      minimalMessage(['INBOX', 'IMPORTANT', 'TRASH'])
    ),
    message: 'expected untrash to answer the message without the TRASH label'
  },
  {
    fixture: replaceResponse(
      gmailSendPracticeFixture,
      1,
      replaceInBody(
        '{"name":"To","value":"practice@example.test"}',
        '{"name":"To","value":"someone-else@example.test"}'
      )
    ),
    message:
      'expected get_message of the sent id to read back the practice address and the run subject'
  },
  {
    // The second page drops nextPageToken while one event remains.
    fixture: replaceResponse(calendarListRangeFixture, 2, () =>
      json(200, { ...jsonOf(calendarListRangeFixture, 2), nextPageToken: undefined })
    ),
    message: 'expected the pages to list exactly the events of the single listing'
  },
  {
    // The rename is ignored; the restore still deletes the event.
    fixture: withoutExchanges(
      replaceResponse(
        calendarEventLifecycleFixture,
        2,
        () => exchangeAt(calendarEventLifecycleFixture, 0).response
      ),
      [3]
    ),
    message: 'expected update_event to rename the event and keep its start'
  },
  {
    // The event reads live again after the repeated delete.
    fixture: replaceResponse(
      calendarDeletedGoneFixture,
      4,
      replaceInBody('"status":"cancelled"', '"status":"confirmed"')
    ),
    message: 'expected the deleted event to stay gone after the repeated delete'
  },
  {
    fixture: replaceResponse(driveListPagingFixture, 1, () =>
      json(200, { ...jsonOf(driveListPagingFixture, 1), nextPageToken: undefined })
    ),
    message: 'expected the pages to list exactly the files of the single listing'
  },
  {
    fixture: replaceResponse(
      driveGetFileFieldsFixture,
      0,
      replaceInBody('Synthetic practice notes.txt', 'Other notes.txt')
    ),
    message: 'expected get_file to answer the same metadata as the list entry'
  },
  {
    // The trashed folder is still listed; the restore still deletes it.
    fixture: replaceResponse(driveFolderLifecycleFixture, 3, () =>
      json(200, {
        ...jsonOf(driveFolderLifecycleFixture, 3),
        files: [
          ...jsonOf(driveFolderLifecycleFixture, 3).files,
          jsonOf(driveFolderLifecycleFixture, 0)
        ]
      })
    ),
    message: 'expected list_files to leave the trashed folder out'
  }
]

describe('Google conformance drills (one per case)', () => {
  it('cover every case with a tamper', () => {
    expect(tampers.map(tamper => tamper.fixture.caseId)).toEqual(caseIds.map(([id]) => id))
  })

  for (const { fixture, message, failure } of tampers) {
    it.effect(`a tampered fixture fails exactly ${fixture.caseId}`, () =>
      Effect.gen(function* () {
        expect(yield* suiteFailures(withReplaced(fixture))).toEqual([
          {
            id: fixture.caseId,
            failure: failure ?? mismatch(message ?? expect.fail('tamper without an outcome'))
          }
        ])
      })
    )
  }

  for (const [label, tampered, message] of [
    [
      'a repeated message id on a later page',
      replaceResponse(
        gmailListPagingFixture,
        2,
        replaceInBody('18f00000000000c3', '18f00000000000c1')
      ),
      'expected a later page to repeat no message from an earlier page'
    ],
    [
      'a repeated thread id on a later page',
      replaceResponse(
        gmailListThreadsPagingFixture,
        3,
        replaceInBody('18f00000000000c3', '18f00000000000c1')
      ),
      'expected a later page to repeat no thread from an earlier page'
    ],
    [
      'a thread listing naming a thread none of the label messages is in',
      replaceResponse(
        gmailListThreadsPagingFixture,
        0,
        replaceInBody('18f00000000000c5', '18f00000000000f5')
      ),
      'expected the thread listing to name exactly the threads of the label messages'
    ],
    [
      'a selected thread read without the From header',
      replaceResponse(
        gmailMetadataHeadersFixture,
        2,
        replaceInBody('{"name":"From","value":"practice@example.test"},', '')
      ),
      'expected get_thread with metadataHeaders to keep exactly the selected headers of the message'
    ],
    [
      'a message without a header the selection leaves out',
      replaceResponse(
        gmailMetadataHeadersFixture,
        0,
        replaceInBody(
          ',{"name":"Content-Type","value":"multipart/mixed; boundary=\\"synthetic\\""}',
          ''
        )
      ),
      'precondition: attachmentMessageId must carry a Subject header and a header other than Subject and From'
    ],
    [
      'a not-found body without error.message',
      replaceResponse(gmailNotFoundEnvelopeFixture, 0, withStatus(404, '{"error":{"code":404}}')),
      'expected the not-found body to be JSON with a non-empty error.message'
    ],
    [
      'a timed event outside the range',
      replaceResponse(
        calendarListRangeFixture,
        0,
        replaceInBody('2026-09-02T09:00:00Z', '2026-09-09T09:00:00Z')
      ),
      'expected every listed timed event to overlap the requested time range'
    ],
    [
      'a trashed file in the folder listing',
      replaceResponse(
        driveListPagingFixture,
        0,
        replaceInBody('"trashed":false', '"trashed":true')
      ),
      'expected every listed file to be an untrashed child of the folder'
    ]
  ] as const) {
    it.effect(`${label} fails exactly its case`, () =>
      Effect.gen(function* () {
        expect(yield* suiteFailures(withReplaced(tampered))).toEqual([
          { id: tampered.caseId, failure: mismatch(message) }
        ])
      })
    )
  }

  it.effect('a standard-base64 attachment answer fails the connector decoding', () =>
    Effect.gen(function* () {
      const standard = replaceResponse(gmailAttachmentFixture, 1, () =>
        json(200, { size: 6, data: '+/+/Pj/+' })
      )

      expect(yield* suiteFailures(withReplaced(standard))).toEqual([
        {
          id: 'google.gmail.attachment-base64url',
          failure: { kind: 'failure', tag: 'ConnectorError', message: 'Invalid response shape' }
        }
      ])
    })
  )

  it.effect('a draft body Gmail stored changed fails the draft case and still deletes it', () =>
    Effect.gen(function* () {
      const changed = replaceResponse(gmailDraftLifecycleFixture, 2, response =>
        json(200, {
          ...JSON.parse(textBody(response)),
          messages: [
            {
              ...JSON.parse(textBody(response)).messages[0],
              id: '18f00000000000d1',
              payload: {
                ...JSON.parse(textBody(response)).messages[0].payload,
                body: { size: 5, data: 'b3RoZXI' }
              }
            }
          ]
        })
      )

      const { failure, entries } = yield* drill(
        gmailDraftLifecycleCase,
        withAppended(changed, [
          {
            request: { method: 'GET', url: `${gmailApi}/messages/18f00000000000d1?format=minimal` },
            response: exchangeAt(gmailDraftLifecycleFixture, 6).response
          }
        ])
      )

      expect(failure).toEqual(
        mismatch('expected get_thread to read back the draft subject and UTF-8 body exactly')
      )
      expect(exchangeIndices(entries)).toEqual([
        'POST drafts 0',
        'GET messages/18f00000000000d1 1',
        'GET threads/18f00000000000d1 2',
        'DELETE drafts/r-8000000000000000001 5',
        'GET messages/18f00000000000d1 9'
      ])
    })
  )

  it.effect('a deleted event that still reads live fails the claim and the restore', () =>
    Effect.gen(function* () {
      const stillLive = (fixture: WireFixture) =>
        replaceResponse(fixture, 2, replaceInBody('"status":"cancelled"', '"status":"confirmed"'))

      const live = replaceResponse(
        stillLive(calendarDeletedGoneFixture),
        4,
        replaceInBody('"status":"cancelled"', '"status":"confirmed"')
      )

      const { failure, entries, remaining } = yield* drill(calendarDeletedGoneCase, live)

      expect(failure?.tag).toBe('GoogleConformanceRestoreFailed')
      expect(failure?.message).toBe(
        'google.calendar.deleted-event-gone: restore failed; delete event syntheticconformance0002 in calendar practice-calendar@example.test by hand if it still exists. Restore error: expected get_event to read the event gone after restoring. Claim failed first: expected get_event of the deleted event to...'
      )
      // The restore deleted again (410 counts as already deleted) and read the event again.
      expect(exchangeIndices(entries)).toEqual([
        'POST events 0',
        'DELETE events/syntheticconformance0002 1',
        'GET events/syntheticconformance0002 2',
        'DELETE events/syntheticconformance0002 3',
        'GET events/syntheticconformance0002 4'
      ])
      expect(remaining).toEqual([])
    })
  )

  for (const [caseId] of caseIds) {
    it.effect(`a dropped fixture fails exactly ${caseId}`, () =>
      Effect.gen(function* () {
        const failures = yield* suiteFailures(
          googleConformanceFixtures.filter(fixture => fixture.caseId !== caseId)
        )

        expect(failures.map(failure => failure.id)).toEqual([caseId])
      })
    )
  }
})

const drill = (
  testCase: GoogleConformanceCase,
  fixture: WireFixture,
  seeds: GoogleConformanceSeeds = googleConformanceFixtureSeeds
) =>
  Effect.gen(function* () {
    yield* atTestNow

    const ledgers = yield* Ref.make(new Map<string, ReplayLedgerApi>())

    const report = yield* runConformance([testCase], {
      target: everyCase,
      now,
      layer: ledgerCaseLayer(ledgers, [fixture], seeds)
    })

    return {
      passed: !conformanceReportFailed(report),
      failure: report.results[0]?.failure,
      ...(yield* ledgerOf(ledgers, testCase.id))
    }
  })

const writeCalls = (entries: ReadonlyArray<ReplayLedgerEntry>) =>
  entries.flatMap(entry =>
    entry.method === 'GET' ? [] : [`${entry.method} ${routeOf(entry.url)}`]
  )

/** The label case with its modify answer missing the label: a claim failure before the delete. */
const labelUnapplied = replaceResponse(gmailLabelLifecycleFixture, 1, () =>
  json(200, { id: '18f00000000000b1', threadId: '18f00000000000b1', labelIds: ['INBOX'] })
)

/** The label case's restore after a claim failure at the modify: delete (204), get (404). */
const labelRestored = withoutExchanges(labelUnapplied, [2, 5])

const labelRecovery =
  'delete the Gmail label Label_9101 ("yolk-conformance run-synthetic label") by hand if it still exists'

describe('Google conformance restore', () => {
  it.effect('still deletes the label, by id, when a claim fails mid-flow', () =>
    Effect.gen(function* () {
      const { failure, entries, remaining } = yield* drill(gmailLabelLifecycleCase, labelRestored)

      expect(failure).toEqual(
        mismatch('expected modify_labels to answer the work message with the new label')
      )
      expect(exchangeIndices(entries)).toEqual([
        'POST labels 0',
        'POST messages/18f00000000000b1/modify 1',
        'DELETE labels/Label_9101 2',
        'GET labels/Label_9101 3'
      ])
      expect(remaining).toEqual([])
    })
  )

  it.effect('reports a failed restore, naming the label, instead of swallowing it', () =>
    Effect.gen(function* () {
      const { failure } = yield* drill(
        gmailLabelLifecycleCase,
        replaceResponse(labelRestored, 2, withStatus(503, serverError))
      )

      expect(failure?.tag).toBe('GoogleConformanceRestoreFailed')
      expect(failure?.message).toBe(
        `google.gmail.label-create-apply-delete: restore failed; ${labelRecovery}. Restore error: gmail.delete_label gmail_delete_label_failed 503. Claim failed first: expected modify_labels to answer the work message wit...`
      )
    })
  )

  it.effect('accepts a not-found answer to the restore delete, then still verifies', () =>
    Effect.gen(function* () {
      const gone = replaceResponse(
        labelRestored,
        2,
        () => exchangeAt(gmailLabelLifecycleFixture, 4).response
      )

      const { failure, entries } = yield* drill(gmailLabelLifecycleCase, gone)

      expect(failure?.tag).toBe('ConformanceMismatch')
      expect(exchangeIndices(entries).slice(-2)).toEqual([
        'DELETE labels/Label_9101 2',
        'GET labels/Label_9101 3'
      ])
    })
  )

  it.effect('fails the restore when the label still reads after deleting it', () =>
    Effect.gen(function* () {
      const stillThere = replaceResponse(
        labelRestored,
        3,
        () => exchangeAt(gmailLabelLifecycleFixture, 0).response
      )

      const { failure } = yield* drill(gmailLabelLifecycleCase, stillThere)

      expect(failure?.tag).toBe('GoogleConformanceRestoreFailed')
      expect(failure?.message).toContain(
        `restore failed; ${labelRecovery}. Restore error: expected get_label to answer google_not_found after resto...`
      )
    })
  )

  it.effect('still deletes the draft by id and verifies its message when the update fails', () =>
    Effect.gen(function* () {
      const updateRejected = withAppended(
        withoutExchanges(
          replaceResponse(
            gmailDraftLifecycleFixture,
            3,
            withStatus(
              400,
              '{"error":{"code":400,"message":"Invalid draft","status":"INVALID_ARGUMENT"}}'
            )
          ),
          [4, 6, 7, 8]
        ),
        [
          {
            // The update failed, so the draft still holds its first message.
            request: { method: 'GET', url: `${gmailApi}/messages/18f00000000000d1?format=minimal` },
            response: exchangeAt(gmailDraftLifecycleFixture, 6).response
          }
        ]
      )

      const { failure, entries, remaining } = yield* drill(gmailDraftLifecycleCase, updateRejected)

      expect(failure).toEqual({
        kind: 'failure',
        tag: 'GoogleConformanceActionFailed',
        message: 'gmail.draft_update failed: gmail_draft_update_failed (HTTP 400)'
      })
      expect(exchangeIndices(entries)).toEqual([
        'POST drafts 0',
        'GET messages/18f00000000000d1 1',
        'GET threads/18f00000000000d1 2',
        'PUT drafts/r-8000000000000000001 3',
        'DELETE drafts/r-8000000000000000001 4',
        'GET messages/18f00000000000d1 5'
      ])
      expect(remaining).toEqual([])
    })
  )

  it.effect(
    're-adds the labels untrash lost, and the case still passes (not a connector claim)',
    () =>
      Effect.gen(function* () {
        // Untrash loses IMPORTANT: the claim (no TRASH) holds; the cleanup re-adds the label.
        const lost = withAppended(
          replaceResponse(
            replaceResponse(gmailTrashUntrashFixture, 4, () => minimalMessage(['INBOX'])),
            5,
            () => minimalMessage(['INBOX'])
          ),
          [
            {
              request: { method: 'POST', url: `${gmailApi}/messages/18f00000000000b1/modify` },
              response: minimalMessage(['INBOX', 'IMPORTANT'])
            }
          ]
        )

        const { passed, entries, remaining } = yield* drill(gmailTrashUntrashCase, lost)

        expect(passed).toBe(true)
        expect(writeCalls(entries)).toEqual([
          'POST messages/18f00000000000b1/trash',
          'POST messages/18f00000000000b1/untrash',
          'POST messages/18f00000000000b1/modify'
        ])
        expect(entries.find(entry => entry.url.endsWith('/modify'))?.bodyJson).toEqual({
          addLabelIds: ['IMPORTANT']
        })
        expect(remaining).toEqual([])
      })
  )

  it.effect('untrashes the message when a claim fails while it is in Trash', () =>
    Effect.gen(function* () {
      const notListed = replaceResponse(gmailTrashUntrashFixture, 2, () =>
        minimalMessage(['INBOX', 'IMPORTANT'])
      )

      // The read after the trash shows no TRASH: a claim failure. The restore reads the message
      // in Trash, untrashes it, and verifies its earlier labels.
      const { failure, entries } = yield* drill(
        gmailTrashUntrashCase,
        withAppended(withoutExchanges(notListed, [3, 4, 5, 6]), [
          {
            request: { method: 'GET', url: workMessageUrl },
            response: minimalMessage(['INBOX', 'IMPORTANT', 'TRASH'])
          },
          exchangeAt(gmailTrashUntrashFixture, 3),
          {
            request: { method: 'GET', url: workMessageUrl },
            response: minimalMessage(['INBOX', 'IMPORTANT'])
          },
          {
            request: { method: 'GET', url: workMessageUrl },
            response: minimalMessage(['INBOX', 'IMPORTANT'])
          }
        ])
      )

      expect(failure).toEqual(mismatch('expected get_message to list TRASH after the trash'))
      expect(writeCalls(entries)).toEqual([
        'POST messages/18f00000000000b1/trash',
        'POST messages/18f00000000000b1/untrash'
      ])
    })
  )

  it.effect('deletes the event when the rename is ignored, and verifies it gone', () =>
    Effect.gen(function* () {
      const eventTamper = tampers.find(
        tamper => tamper.fixture.caseId === 'google.calendar.event-lifecycle'
      )

      const { entries, remaining } = yield* drill(
        calendarEventLifecycleCase,
        eventTamper?.fixture ?? expect.fail('missing event tamper')
      )

      expect(exchangeIndices(entries)).toEqual([
        'POST events 0',
        'GET events/syntheticconformance0001 1',
        'PATCH events/syntheticconformance0001 2',
        'DELETE events/syntheticconformance0001 3',
        'GET events/syntheticconformance0001 4'
      ])
      expect(remaining).toEqual([])
    })
  )

  it.effect('deletes the folder permanently when a claim fails after the trash', () =>
    Effect.gen(function* () {
      const [folderTamper] = tampers.slice(-1)

      const { failure, entries, remaining } = yield* drill(
        driveFolderLifecycleCase,
        folderTamper?.fixture ?? expect.fail('missing folder tamper')
      )

      expect(failure).toEqual(mismatch('expected list_files to leave the trashed folder out'))
      expect(writeCalls(entries)).toEqual([
        'POST files',
        'PATCH files/synthetic-conformance-folder-0001',
        'DELETE files/synthetic-conformance-folder-0001'
      ])
      expect(remaining).toEqual([])
    })
  )

  it.effect('reports a failed folder delete, naming the folder', () =>
    Effect.gen(function* () {
      const [folderTamper] = tampers.slice(-1)

      const { failure } = yield* drill(
        driveFolderLifecycleCase,
        replaceResponse(
          folderTamper?.fixture ?? expect.fail('missing folder tamper'),
          4,
          withStatus(503, serverError)
        )
      )

      expect(failure?.tag).toBe('GoogleConformanceRestoreFailed')
      expect(failure?.message).toContain(
        'google.drive.folder-trash-delete: restore failed; delete the Drive folder synthetic-conformance-folder-0001 by hand if it still exists. Restore error: drive.delete_file drive_delete_file_failed 503.'
      )
    })
  )

  for (const [seed, testCase] of [
    ['pagingLabelId', gmailListPagingCase],
    ['workMessageId', gmailTrashUntrashCase],
    ['runId', gmailDraftLifecycleCase],
    ['practiceAddress', gmailSendPracticeCase],
    ['calendarId', calendarEventLifecycleCase],
    ['driveFolderId', driveListPagingCase]
  ] as const) {
    it.effect(`fails with a precondition before any request without ${seed}`, () =>
      Effect.gen(function* () {
        const { [seed]: _dropped, ...seeds } = googleConformanceFixtureSeeds

        const { failure, entries } = yield* drill(
          testCase,
          fixturesFor(testCase)[0] ?? expect.fail('no fixture'),
          seeds
        )

        expect(failure).toEqual(
          mismatch(`precondition: GoogleConformanceConfig.${seed} is not configured`)
        )
        expect(entries).toEqual([])
      })
    )
  }

  it.effect('refuses to trash a work message that is already in Trash', () =>
    Effect.gen(function* () {
      const alreadyTrashed = replaceResponse(
        gmailTrashUntrashFixture,
        0,
        () => exchangeAt(gmailTrashUntrashFixture, 2).response
      )

      const { failure, entries } = yield* drill(gmailTrashUntrashCase, alreadyTrashed)

      expect(failure).toEqual(
        mismatch(
          'precondition: workMessageId is in Trash (a leftover or a concurrent run); untrash it by hand first'
        )
      )
      expect(writeCalls(entries)).toEqual([])
    })
  )

  it.effect('reports a transport failure of a read without a status', () =>
    Effect.gen(function* () {
      const dropping = HttpClient.make(request => Effect.fail(connectionReset(request)))

      const report = yield* runConformance([gmailListPagingCase], {
        target: everyCase,
        now,
        layer: () => portsOver(Layer.succeed(HttpClient.HttpClient, dropping))
      })

      expect(report.results[0]?.failure).toMatchObject({ kind: 'failure', tag: 'ConnectorError' })
      expect(JSON.stringify(report)).not.toContain(syntheticToken)
    })
  )
})

const connectionReset = (request: HttpClientRequest.HttpClientRequest) =>
  new HttpClientError.HttpClientError({
    reason: new HttpClientError.TransportError({ request, description: 'connection reset' })
  })

// Ownership drills: definitive rejections undo nothing, ambiguous writes are reported with the
// exact item, and cleanup never leaves the run namespace.

const onlyCreate = (fixture: WireFixture, index = 0) =>
  withoutExchanges(
    fixture,
    fixture.exchanges.flatMap((_, position) => (position === index ? [] : [position]))
  )

const labelUnknown =
  'delete the Gmail label "yolk-conformance run-synthetic label" by hand if it exists'

const sendSubject =
  'yolk-conformance run-synthetic send: synthetic conformance message, safe to delete'

const sendUnknown = `look for a message with subject "${sendSubject}" in the Sent folder and at the practice address; never resend automatically`

describe('Google conformance write ownership', () => {
  it.effect('undoes nothing after a definitive label create rejection', () =>
    Effect.gen(function* () {
      const rejected = onlyCreate(
        replaceResponse(
          gmailLabelLifecycleFixture,
          0,
          withStatus(
            409,
            '{"error":{"code":409,"message":"Label name exists or conflicts","status":"ALREADY_EXISTS"}}'
          )
        )
      )

      const { failure, entries, remaining } = yield* drill(gmailLabelLifecycleCase, rejected)

      expect(failure).toEqual({
        kind: 'failure',
        tag: 'GoogleConformanceActionFailed',
        message: 'gmail.create_label failed: gmail_create_label_failed (HTTP 409)'
      })
      expect(writeCalls(entries)).toEqual(['POST labels'])
      expect(remaining).toEqual([])
    })
  )

  for (const status of [503, 408] as const) {
    it.effect(`reports an ambiguous ${status} label create with the exact name`, () =>
      Effect.gen(function* () {
        const ambiguous = onlyCreate(
          replaceResponse(gmailLabelLifecycleFixture, 0, withStatus(status, serverError))
        )

        const { failure, entries } = yield* drill(gmailLabelLifecycleCase, ambiguous)

        expect(failure).toEqual({
          kind: 'failure',
          tag: 'GoogleConformanceActionFailed',
          message: `gmail.create_label failed: gmail_create_label_failed (HTTP ${status}); write outcome unknown: ${labelUnknown}`
        })
        expect(writeCalls(entries)).toEqual(['POST labels'])
      })
    )
  }

  it.effect('reports an event create that fails in transport as ambiguous', () =>
    Effect.gen(function* () {
      const dropping = HttpClient.make(request => Effect.fail(connectionReset(request)))

      const report = yield* runConformance([calendarEventLifecycleCase], {
        target: everyCase,
        now,
        layer: () => portsOver(Layer.succeed(HttpClient.HttpClient, dropping))
      })

      expect(report.results[0]?.failure).toEqual({
        kind: 'failure',
        tag: 'GoogleConformanceActionFailed',
        message:
          'calendar.create_event failed: transport_failed; write outcome unknown: delete the event "yolk-conformance run-synthetic event: synthetic conformance event, safe to delete" on 2030-01-07 in calendar practice-calendar@example.test by hand if it exists'
      })
    })
  )

  it.effect('reports a draft answer it cannot decode as ambiguous, deleting nothing', () =>
    Effect.gen(function* () {
      const undecodable = onlyCreate(
        replaceResponse(gmailDraftLifecycleFixture, 0, () => json(200, { id: 'r-1' }))
      )

      const { failure, entries } = yield* drill(gmailDraftLifecycleCase, undecodable)

      expect(failure).toEqual({
        kind: 'failure',
        tag: 'GoogleConformanceActionFailed',
        message:
          'gmail.draft_compose failed: validation_failed; write outcome unknown: delete the Gmail draft with subject "yolk-conformance run-synthetic draft: synthetic conformance draft, safe to delete" by hand if it exists'
      })
      expect(writeCalls(entries)).toEqual(['POST drafts'])
    })
  )

  for (const [label, fixture, testCase, from, to, item] of [
    [
      'a label with another name',
      gmailLabelLifecycleFixture,
      gmailLabelLifecycleCase,
      '"name":"yolk-conformance run-synthetic label"',
      '"name":"Receipts"',
      'label Label_9101 named "Receipts"'
    ],
    [
      'an event with attendees',
      calendarEventLifecycleFixture,
      calendarEventLifecycleCase,
      '"eventType":"default"',
      '"eventType":"default","attendees":[{"email":"someone@example.test"}]',
      'event syntheticconformance0001 titled "yolk-conformance run-synthetic event: synthetic conformance event, safe to delete"'
    ],
    [
      'a folder under another parent',
      driveFolderLifecycleFixture,
      driveFolderLifecycleCase,
      '"parents":["synthetic-practice-folder-0001"]',
      '"parents":["someone-elses-folder-0001"]',
      'Drive item synthetic-conformance-folder-0001 named "yolk-conformance run-synthetic folder"'
    ],
    [
      'another message for the trash',
      gmailTrashUntrashFixture,
      gmailTrashUntrashCase,
      '"id":"18f00000000000b1"',
      '"id":"18f0000000000999"',
      'message 18f0000000000999'
    ]
  ] as const) {
    it.effect(`refuses to adopt ${label}`, () =>
      Effect.gen(function* () {
        const createIndex = testCase === gmailTrashUntrashCase ? 1 : 0

        const foreign = withoutExchanges(
          replaceResponse(fixture, createIndex, replaceInBody(from, to)),
          fixture.exchanges.flatMap((_, position) => (position <= createIndex ? [] : [position]))
        )

        const { failure, entries } = yield* drill(testCase, foreign)

        expect(failure).toEqual({
          kind: 'failure',
          tag: 'GoogleConformanceCleanupRefused',
          message: `${testCase.id}: cleanup refused; a write answered ${item}, outside the run namespace, so nothing was undone there; check it by hand.`
        })
        expect(writeCalls(entries)).toHaveLength(1)
      })
    )
  }
})

/**
 * Seeds a host built without the types (from JSON, a config file, or a cast): the branded schema
 * types never reached them, so only the cases' own decoding stands between them and a request.
 */
const untypedSeeds = (overrides: Readonly<Record<string, string>>): GoogleConformanceSeeds =>
  JSON.parse(JSON.stringify({ ...googleConformanceFixtureSeeds, ...overrides }))

const practiceAddressRule =
  'precondition: GoogleConformanceConfig.practiceAddress must be exactly one plain address local@domain: no display name, list, angle brackets, whitespace, or control characters'

describe('Google conformance send recipient safety (inside the case)', () => {
  it('types practiceAddress and runId as branded seeds, so a plain string is a type error', () => {
    const seeds: GoogleConformanceSeeds = {
      // @ts-expect-error a plain string is not a GooglePracticeAddress: hosts construct it.
      practiceAddress: 'practice@example.test',
      // @ts-expect-error a plain string is not a GoogleConformanceRunId: hosts construct it.
      runId: 'run-synthetic'
    }

    expect(Object.keys(seeds)).toEqual(['practiceAddress', 'runId'])
    expect(() => GooglePracticeAddress.make('a@example.test, b@example.test')).toThrow()
  })

  for (const [label, address] of [
    ['an address list', 'practice@example.test, other@example.test'],
    ['a semicolon list', 'practice@example.test;other@example.test'],
    ['a display name', 'Practice <practice@example.test>'],
    ['angle brackets', '<practice@example.test>'],
    ['a CRLF header injection', 'practice@example.test\r\nBcc: other@example.test'],
    ['a bare LF header injection', 'practice@example.test\nBcc: other@example.test'],
    ['a bare CR header injection', 'practice@example.test\rBcc: other@example.test'],
    ['a NUL control character', 'practice@example.test\u0000'],
    ['a tab', 'practice@example.test\t'],
    ['inner whitespace', 'practice @example.test'],
    ['a quoted local part', '"practice"@example.test'],
    ['a group', 'list: practice@example.test;'],
    ['an overlong local part', `${'a'.repeat(65)}@example.test`],
    ['an overlong address', `a@${'b'.repeat(250)}.test`],
    ['no domain dot', 'practice@localhost'],
    ['an empty string', '']
  ] as const) {
    it.effect(`refuses ${label} with a precondition and sends nothing`, () =>
      Effect.gen(function* () {
        const { failure, entries } = yield* drill(
          gmailSendPracticeCase,
          gmailSendPracticeFixture,
          untypedSeeds({ practiceAddress: address })
        )

        expect(failure).toEqual(mismatch(practiceAddressRule))
        expect(entries).toEqual([])
      })
    )
  }

  for (const runId of ['mine-0000beef', 'run-synthetic\r\nBcc: other@example.test', 'run-UPPER']) {
    it.effect(`refuses the run id ${JSON.stringify(runId)} before any request`, () =>
      Effect.gen(function* () {
        for (const testCase of [gmailSendPracticeCase, gmailDraftLifecycleCase]) {
          const { failure, entries } = yield* drill(
            testCase,
            fixturesFor(testCase)[0] ?? expect.fail('no fixture'),
            untypedSeeds({ runId })
          )

          expect(failure).toEqual(
            mismatch(
              'precondition: GoogleConformanceConfig.runId must be run- then lower-case letters, digits, and inner hyphens, at most 40 characters'
            )
          )
          expect(entries).toEqual([])
        }
      })
    )
  }
})

describe('Google conformance draft adoption and repeated deletes', () => {
  const metadataUrl = `${gmailApi}/messages/18f00000000000d1?format=metadata`

  const withMetadata = (response: (original: WireResponse) => WireResponse) =>
    withoutExchanges(
      replaceResponse(gmailDraftLifecycleFixture, 1, response),
      [2, 3, 4, 5, 6, 7, 8]
    )

  for (const [label, response, item] of [
    [
      'a valid unrelated draft (another subject)',
      replaceInBody(
        '"value":"yolk-conformance run-synthetic draft: synthetic conformance draft, safe to delete"',
        '"value":"Quarterly plan (a person\'s draft)"'
      ),
      "draft r-8000000000000000001, which is not this run's draft (another subject, a recipient, or no DRAFT label)"
    ],
    [
      'a draft with a recipient',
      replaceInBody(
        '{"name":"Content-Type"',
        '{"name":"To","value":"someone@example.test"},{"name":"Content-Type"'
      ),
      "draft r-8000000000000000001, which is not this run's draft (another subject, a recipient, or no DRAFT label)"
    ],
    [
      'an unverifiable draft (the metadata read fails)',
      withStatus(503, serverError),
      "draft r-8000000000000000001, whose message could not be read to prove it is this run's draft (gmail_get_message_failed 503)"
    ]
  ] as const) {
    it.effect(`never adopts, updates, or deletes ${label}`, () =>
      Effect.gen(function* () {
        const { failure, entries, remaining } = yield* drill(
          gmailDraftLifecycleCase,
          withMetadata(response)
        )

        expect(failure).toEqual({
          kind: 'failure',
          tag: 'GoogleConformanceCleanupRefused',
          message: `google.gmail.draft-compose-update-delete: cleanup refused; a write answered ${item}, outside the run namespace, so nothing was undone there; check it by hand.`
        })
        expect(exchangeIndices(entries)).toEqual(['POST drafts 0', `GET ${routeOf(metadataUrl)} 1`])
        expect(writeCalls(entries)).toEqual(['POST drafts'])
        expect(remaining).toEqual([])
      })
    )
  }

  it.effect('accepts a 2xx repeated draft delete when the message stays gone', () =>
    Effect.gen(function* () {
      const { passed } = yield* drill(
        gmailDraftLifecycleCase,
        replaceResponse(gmailDraftLifecycleFixture, 7, () => ({
          status: 204,
          headers: {},
          body: ''
        }))
      )

      expect(passed).toBe(true)
    })
  )

  it.effect('accepts a 2xx repeated event delete when the event stays gone', () =>
    Effect.gen(function* () {
      const { passed } = yield* drill(
        calendarDeletedGoneCase,
        replaceResponse(calendarDeletedGoneFixture, 3, () => ({
          status: 204,
          headers: {},
          body: ''
        }))
      )

      expect(passed).toBe(true)
    })
  )

  it.effect('fails a repeated event delete that answers another error', () =>
    Effect.gen(function* () {
      const { failure } = yield* drill(
        calendarDeletedGoneCase,
        replaceResponse(calendarDeletedGoneFixture, 3, withStatus(403, serverError))
      )

      expect(failure).toEqual(
        mismatch('expected deleting the deleted event again to answer 2xx, 404, or 410')
      )
    })
  )
})

describe('Google conformance send (write-irreversible)', () => {
  const sendOnly = (response: (original: WireResponse) => WireResponse) =>
    onlyCreate(replaceResponse(gmailSendPracticeFixture, 0, response))

  it.effect('sends exactly one upload whose only recipient is the practice address', () =>
    Effect.gen(function* () {
      const { passed, entries } = yield* drill(gmailSendPracticeCase, gmailSendPracticeFixture)

      expect(passed).toBe(true)
      expect(writeCalls(entries)).toEqual([
        'POST https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send'
      ])

      const body = entries[0]?.bodyText ?? ''

      expect(body.match(/^(?:To|Cc|Bcc):.*$/gim)).toEqual(['To: practice@example.test'])
    })
  )

  it.effect('sends to the seeded practice address only, whatever it is', () =>
    Effect.gen(function* () {
      const { entries } = yield* drill(
        gmailSendPracticeCase,
        onlyCreate(gmailSendPracticeFixture),
        {
          ...googleConformanceFixtureSeeds,
          practiceAddress: GooglePracticeAddress.make('other-practice@example.test')
        }
      )

      expect(entries[0]?.bodyText?.match(/^(?:To|Cc|Bcc):.*$/gim)).toEqual([
        'To: other-practice@example.test'
      ])
    })
  )

  it.effect('reports a definitive rejection without advice to look for the message', () =>
    Effect.gen(function* () {
      const { failure } = yield* drill(
        gmailSendPracticeCase,
        sendOnly(withStatus(400, '{"error":{"code":400,"message":"Invalid To header"}}'))
      )

      expect(failure).toEqual({
        kind: 'failure',
        tag: 'GoogleConformanceActionFailed',
        message: 'gmail.send_message failed: gmail_send_message_rejected (HTTP 400)'
      })
    })
  )

  for (const [status, code] of [
    [503, 'gmail_send_message_unknown'],
    [408, 'gmail_send_message_unknown'],
    [409, 'gmail_send_message_unknown']
  ] as const) {
    it.effect(`reports a ${status} send as an unknown outcome with the subject to look for`, () =>
      Effect.gen(function* () {
        const { failure } = yield* drill(
          gmailSendPracticeCase,
          sendOnly(withStatus(status, serverError))
        )

        expect(failure).toEqual({
          kind: 'failure',
          tag: 'GoogleConformanceActionFailed',
          message: `gmail.send_message failed: ${code} (HTTP ${status}); write outcome unknown: ${sendUnknown}`
        })
      })
    )
  }

  it.effect('reports a send that fails in transport as an unknown outcome', () =>
    Effect.gen(function* () {
      const dropping = HttpClient.make(request => Effect.fail(connectionReset(request)))

      const report = yield* runConformance([gmailSendPracticeCase], {
        target: everyCase,
        now,
        layer: () => portsOver(Layer.succeed(HttpClient.HttpClient, dropping))
      })

      expect(report.results[0]?.failure).toEqual({
        kind: 'failure',
        tag: 'GoogleConformanceActionFailed',
        message: `gmail.send_message failed: transport_failed; write outcome unknown: ${sendUnknown}`
      })
    })
  )
})

describe('Google conformance leftover detection (read-only)', () => {
  const listing = (url: string, body: unknown): WireExchange => ({
    request: { method: 'GET', url },
    response: json(200, body)
  })

  const driveLeftoversUrl = (() => {
    const params = new URLSearchParams()

    params.set('pageSize', '100')
    params.set('q', "'synthetic-practice-folder-0001' in parents")
    params.set('spaces', 'drive')
    params.set('supportsAllDrives', 'true')
    params.set('includeItemsFromAllDrives', 'true')
    params.set('corpora', 'user')
    params.set(
      'fields',
      new URL(exchangeAt(driveListPagingFixture, 0).request.url).searchParams.get('fields') ?? ''
    )

    return `https://www.googleapis.com/drive/v3/files?${params.toString()}`
  })()

  const leftoversFixture: WireFixture = {
    id: 'google.leftovers.synthetic',
    caseId: 'google.leftovers',
    evidence: 'unverified',
    recordedAt: '2026-09-30',
    account: 'synthetic',
    endpoint: 'https://www.googleapis.com',
    exchanges: [
      listing(`${gmailApi}/labels`, {
        labels: [
          { id: 'INBOX', name: 'INBOX', type: 'system' },
          { id: 'Label_9101', name: 'yolk-conformance run-0000beef label', type: 'user' },
          { id: 'Label_9001', name: 'synthetic-paging', type: 'user' }
        ]
      }),
      listing(`${gmailApi}/drafts?q=subject%3Ayolk-conformance&maxResults=100`, {
        drafts: [{ id: 'r-8000000000000000001', message: { id: '18f00000000000d1' } }]
      }),
      listing(workMessageUrl, {
        id: '18f00000000000b1',
        labelIds: ['INBOX', 'TRASH']
      }),
      listing(
        'https://www.googleapis.com/calendar/v3/calendars/practice-calendar%40example.test/events?q=yolk-conformance&maxResults=250',
        {
          items: [
            JSON.parse(textBody(exchangeAt(calendarEventLifecycleFixture, 0).response)),
            JSON.parse(textBody(exchangeAt(calendarEventLifecycleFixture, 5).response)),
            JSON.parse(textBody(exchangeAt(calendarListRangeFixture, 0).response)).items[0]
          ]
        }
      ),
      listing(driveLeftoversUrl, {
        files: [
          JSON.parse(textBody(exchangeAt(driveFolderLifecycleFixture, 1).response)),
          JSON.parse(textBody(exchangeAt(driveGetFileFieldsFixture, 0).response))
        ]
      })
    ]
  }

  it.effect(
    'lists run labels, run drafts, a trashed work message, run events, and run folders',
    () =>
      Effect.gen(function* () {
        const { client, ledger } = yield* makeReplayHttpClient([leftoversFixture])

        const found = yield* findGoogleConformanceLeftovers.pipe(
          Effect.provide(portsOver(Layer.succeed(HttpClient.HttpClient, client)))
        )

        expect(found).toEqual([
          'Gmail label Label_9101 "yolk-conformance run-0000beef label"',
          'Gmail draft r-8000000000000000001 (found by subject:yolk-conformance)',
          'work message 18f00000000000b1 in Gmail Trash',
          'event syntheticconformance0001 "yolk-conformance run-synthetic event: synthetic conformance event, safe to delete" in calendar practice-calendar@example.test',
          'Drive item synthetic-conformance-folder-0001 "yolk-conformance run-synthetic folder" (in Trash)'
        ])
        // Read-only: only GET requests were sent.
        expect((yield* ledger.entries).map(entry => entry.method)).toEqual([
          'GET',
          'GET',
          'GET',
          'GET',
          'GET'
        ])
        expect(yield* ledger.remaining).toEqual([])
      })
  )

  it.effect('looks only where the seeds point', () =>
    Effect.gen(function* () {
      const { client, ledger } = yield* makeReplayHttpClient([])

      const found = yield* findGoogleConformanceLeftovers.pipe(
        Effect.provide(
          portsOver(Layer.succeed(HttpClient.HttpClient, client), {
            runId: GoogleConformanceRunId.make('run-synthetic')
          })
        )
      )

      expect(found).toEqual([])
      expect(yield* ledger.entries).toEqual([])
    })
  )

  it('requires the run- prefix in every run id and valid seeds', () => {
    const decode = Schema.decodeUnknownOption(GoogleConformanceSeedsSchema)

    expect(Option.isSome(decode(googleConformanceFixtureSeeds))).toBe(true)
    expect(Option.isNone(decode({ runId: 'mine-0000beef' }))).toBe(true)
    expect(Option.isNone(decode({ practiceAddress: 'Someone <someone@example.test>' }))).toBe(true)
    expect(
      Option.isNone(decode({ practiceAddress: 'practice@example.test\r\nBcc: x@example.test' }))
    ).toBe(true)
    expect(Option.isNone(decode({ workMessageId: '../labels' }))).toBe(true)
    expect(Option.isNone(decode({ calendarId: '..' }))).toBe(true)
    expect(Option.isNone(decode({ eventRangeStart: '2026-09-01' }))).toBe(true)
    expect(Option.isNone(decode({ driveFolderId: 'short' }))).toBe(true)
  })
})

// Interruption drills: a cleanup problem raised while the case is being interrupted still reaches
// the owner through the ConformanceCleanupReporter, with the exact item to check.

const capturingReporter = Effect.gen(function* () {
  const warnings = yield* Ref.make<ReadonlyArray<string>>([])

  return {
    warnings,
    reporter: { warn: (message: string) => Ref.update(warnings, list => [...list, message]) }
  }
})

/** A client over `fixture` that holds the request with index `heldIndex` until released. */
const holding = (fixture: WireFixture, heldIndex: number) =>
  Effect.gen(function* () {
    const sent = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const { client, ledger } = yield* makeReplayHttpClient([fixture])
    const seen = yield* Ref.make(0)

    const client2 = HttpClient.transform(client, response =>
      Effect.gen(function* () {
        const index = yield* Ref.getAndUpdate(seen, count => count + 1)

        return yield* index === heldIndex
          ? response.pipe(
              Effect.tap(() => Deferred.succeed(sent, undefined)),
              Effect.tap(() => Deferred.await(release))
            )
          : response
      })
    )

    return { sent, release, client: client2, ledger }
  })

const interruptAfter = <A, E>(
  fiber: Fiber.Fiber<A, E>,
  sent: Deferred.Deferred<void>,
  release: Deferred.Deferred<void>
) =>
  Effect.gen(function* () {
    yield* Deferred.await(sent)

    const interrupting = yield* Effect.forkChild(Fiber.interrupt(fiber))

    yield* Effect.yieldNow
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(interrupting)

    return yield* Fiber.await(fiber)
  })

/** The label fixture whose restore delete answers 503 (after an interruption during the modify). */
const labelRestoreFailing = replaceResponse(
  withoutExchanges(gmailLabelLifecycleFixture, [2, 5]),
  2,
  withStatus(503, serverError)
)

describe('Google conformance interruption', () => {
  it.effect('finishes a masked in-flight label delete, then verifies absence on interruption', () =>
    Effect.gen(function* () {
      const { sent, release, client, ledger } = yield* holding(
        withAppended(gmailLabelLifecycleFixture, [
          exchangeAt(gmailLabelLifecycleFixture, 3),
          exchangeAt(gmailLabelLifecycleFixture, 4)
        ]),
        3
      )

      const fiber = yield* gmailLabelLifecycleCase.run.pipe(
        Effect.provide(portsOver(Layer.succeed(HttpClient.HttpClient, client))),
        Effect.forkChild
      )

      const exit = yield* interruptAfter(fiber, sent, release)

      expect(Exit.hasInterrupts(exit)).toBe(true)
      // The delete completed; no further claim ran; the restore deleted again and verified.
      expect(exchangeIndices(yield* ledger.entries)).toEqual([
        'POST labels 0',
        'POST messages/18f00000000000b1/modify 1',
        'GET messages/18f00000000000b1 2',
        'DELETE labels/Label_9101 3',
        'DELETE labels/Label_9101 6',
        'GET labels/Label_9101 4'
      ])
    })
  )

  it.effect('registers a folder create in flight when interrupted, then deletes it by id', () =>
    Effect.gen(function* () {
      const { sent, release, client, ledger } = yield* holding(
        withoutExchanges(driveFolderLifecycleFixture, [1, 2, 3]),
        0
      )

      const fiber = yield* driveFolderLifecycleCase.run.pipe(
        Effect.provide(portsOver(Layer.succeed(HttpClient.HttpClient, client))),
        Effect.forkChild
      )

      const exit = yield* interruptAfter(fiber, sent, release)

      expect(Exit.hasInterrupts(exit)).toBe(true)
      expect(exchangeIndices(yield* ledger.entries)).toEqual([
        'POST files 0',
        'DELETE files/synthetic-conformance-folder-0001 1',
        'GET files/synthetic-conformance-folder-0001 2'
      ])
    })
  )

  it.effect('reports a failed restore when interrupted during a claim', () =>
    Effect.gen(function* () {
      const { warnings, reporter } = yield* capturingReporter
      const { sent, release, client } = yield* holding(labelRestoreFailing, 1)

      const fiber = yield* gmailLabelLifecycleCase.run.pipe(
        Effect.provide(portsOver(Layer.succeed(HttpClient.HttpClient, client))),
        Effect.provideService(ConformanceCleanupReporter, reporter),
        Effect.forkChild
      )

      yield* interruptAfter(fiber, sent, release)

      const reported = yield* Ref.get(warnings)

      expect(reported).toHaveLength(1)
      expect(reported[0]).toContain(
        `google.gmail.label-create-apply-delete: restore failed; ${labelRecovery}.`
      )
    })
  )

  it.effect('reports an ambiguous label create answered while being interrupted', () =>
    Effect.gen(function* () {
      const { warnings, reporter } = yield* capturingReporter

      const { sent, release, client } = yield* holding(
        onlyCreate(replaceResponse(gmailLabelLifecycleFixture, 0, withStatus(503, serverError))),
        0
      )

      const fiber = yield* gmailLabelLifecycleCase.run.pipe(
        Effect.provide(portsOver(Layer.succeed(HttpClient.HttpClient, client))),
        Effect.provideService(ConformanceCleanupReporter, reporter),
        Effect.forkChild
      )

      yield* interruptAfter(fiber, sent, release)

      // The report names the case; the raised error stays the action failure.
      expect(yield* Ref.get(warnings)).toEqual([
        `google.gmail.label-create-apply-delete: gmail.create_label failed: gmail_create_label_failed (HTTP 503); write outcome unknown: ${labelUnknown}`
      ])
    })
  )

  it.effect('names the case when two cases share the create action', () =>
    Effect.gen(function* () {
      const reports: Array<string> = []

      for (const [testCase, fixture] of [
        [calendarEventLifecycleCase, calendarEventLifecycleFixture],
        [calendarDeletedGoneCase, calendarDeletedGoneFixture]
      ] as const) {
        const { warnings, reporter } = yield* capturingReporter

        const { sent, release, client } = yield* holding(
          onlyCreate(replaceResponse(fixture, 0, withStatus(503, serverError))),
          0
        )

        const fiber = yield* testCase.run.pipe(
          Effect.provide(portsOver(Layer.succeed(HttpClient.HttpClient, client))),
          Effect.provideService(ConformanceCleanupReporter, reporter),
          Effect.forkChild
        )

        yield* interruptAfter(fiber, sent, release)
        reports.push(...(yield* Ref.get(warnings)))
      }

      expect(reports.map(report => report.split(': calendar.create_event failed: ')[0])).toEqual([
        'google.calendar.event-lifecycle',
        'google.calendar.deleted-event-gone'
      ])
    })
  )

  it.effect('reports an unknown send answered while being interrupted', () =>
    Effect.gen(function* () {
      const { warnings, reporter } = yield* capturingReporter

      const { sent, release, client } = yield* holding(
        onlyCreate(replaceResponse(gmailSendPracticeFixture, 0, withStatus(503, serverError))),
        0
      )

      const fiber = yield* gmailSendPracticeCase.run.pipe(
        Effect.provide(portsOver(Layer.succeed(HttpClient.HttpClient, client))),
        Effect.provideService(ConformanceCleanupReporter, reporter),
        Effect.forkChild
      )

      yield* interruptAfter(fiber, sent, release)

      expect(yield* Ref.get(warnings)).toEqual([
        `${sendId}: gmail.send_message failed: gmail_send_message_unknown (HTTP 503); write outcome unknown: ${sendUnknown}`
      ])
    })
  )

  it.effect(
    'reports nothing extra when an uninterrupted restore fails (the report carries it)',
    () =>
      Effect.gen(function* () {
        const { warnings, reporter } = yield* capturingReporter

        const { client } = yield* makeReplayHttpClient([
          replaceResponse(labelRestored, 2, withStatus(503, serverError))
        ])

        const exit = yield* gmailLabelLifecycleCase.run.pipe(
          Effect.provide(portsOver(Layer.succeed(HttpClient.HttpClient, client))),
          Effect.provideService(ConformanceCleanupReporter, reporter),
          Effect.exit
        )

        expect(Exit.isFailure(exit)).toBe(true)
        expect(yield* Ref.get(warnings)).toEqual([])
      })
  )
})

// Run-level interruption drills: runConformance over [the label case, a sentinel]. Interrupting the
// label case must stop the run: the sentinel never starts, whether the restore fails or succeeds.

const sentinelCase = (ran: Ref.Ref<boolean>) =>
  defineConformanceCase({
    id: 'test.sentinel.after-interrupted-case',
    safety: 'read',
    docs: 'Synthetic sentinel: records whether it ran.',
    wire: 'Runs only if the run was not stopped.',
    fixtures: [],
    run: Ref.set(ran, true)
  })

describe('Google conformance run interruption', () => {
  it.effect('stops the whole run when interrupted with a failing restore', () =>
    Effect.gen(function* () {
      const sentinelRan = yield* Ref.make(false)
      const { warnings, reporter } = yield* capturingReporter
      const { sent, release, client } = yield* holding(labelRestoreFailing, 1)

      const fiber = yield* runConformance([gmailLabelLifecycleCase, sentinelCase(sentinelRan)], {
        target: everyCase,
        now,
        layer: () => portsOver(Layer.succeed(HttpClient.HttpClient, client))
      }).pipe(Effect.provideService(ConformanceCleanupReporter, reporter), Effect.forkChild)

      const exit = yield* interruptAfter(fiber, sent, release)

      expect(yield* Ref.get(sentinelRan)).toBe(false)

      // Same shape as the GitHub drill: the run ends with the case's own RestoreFailed and no
      // Interrupt in the cause, produces no report, and resumes no case.
      if (Exit.isSuccess(exit)) {
        return expect.fail('expected the interrupted run to fail')
      }

      expect(Cause.hasInterrupts(exit.cause)).toBe(false)
      expect(Cause.squash(exit.cause)).toMatchObject({ _tag: 'GoogleConformanceRestoreFailed' })

      const reported = yield* Ref.get(warnings)

      expect(reported).toHaveLength(1)
      expect(reported[0]).toContain(labelRecovery)
    })
  )

  it.effect(
    'ends interrupt-only, without a report or a later case, when the cleanup succeeds',
    () =>
      Effect.gen(function* () {
        const sentinelRan = yield* Ref.make(false)
        const { warnings, reporter } = yield* capturingReporter
        const { sent, release, client } = yield* holding(labelRestored, 1)

        const fiber = yield* runConformance([gmailLabelLifecycleCase, sentinelCase(sentinelRan)], {
          target: everyCase,
          now,
          layer: () => portsOver(Layer.succeed(HttpClient.HttpClient, client))
        }).pipe(Effect.provideService(ConformanceCleanupReporter, reporter), Effect.forkChild)

        const exit = yield* interruptAfter(fiber, sent, release)

        expect(yield* Ref.get(sentinelRan)).toBe(false)

        if (Exit.isSuccess(exit)) {
          return expect.fail('expected the interrupted run to be interrupted')
        }

        expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        expect(yield* Ref.get(warnings)).toEqual([])
      })
  )
})
