/**
 * Cross-checks: the Microsoft Graph emulator must satisfy the same conformance cases the replayed
 * fixtures satisfy, through the REAL Microsoft connector actions (and the raw calendar requests
 * the cases send through the same ports), both in-process and over a loopback socket; and each
 * drill knob must make its case fail. Tests may import SDK packages; the emulator source never
 * does.
 *
 * With the default `copyInProgressPolls: 0` the copy case's first monitor poll completes (as the
 * fixture records), so no case sleeps and these run on the test clock.
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
import { OAuthCredential } from '@yolk-sdk/connectors'
import {
  connectorHttpClientsFromEffectHttpClientLayer,
  staticCredentialResolverLayer
} from '@yolk-sdk/connectors/conformance'
import { microsoftGraphApiBaseUrl } from '@yolk-sdk/connectors/microsoft'
import {
  MicrosoftConformanceConfig,
  microsoftConformanceCases,
  microsoftConformanceFixtureSeeds
} from '@yolk-sdk/connectors/microsoft/conformance'
import {
  makeMicrosoftEmulator,
  type MicrosoftEmulator,
  type MicrosoftEmulatorDrills,
  type MicrosoftEmulatorOptions,
  type MicrosoftEmulatorState,
  type MicrosoftLedgerEntry
} from '../src/microsoft.ts'
import { serveFetchHandler } from '../src/node.ts'
import { EmulatedHttpClient, EmulatorRoute, InProcessHttpClient } from '../src/router.ts'

const graphOrigin = new URL(microsoftGraphApiBaseUrl).origin

const now = new Date('2026-09-29T10:00:00.000Z')

const accessToken = 'synthetic-microsoft-access-token'

/** Delegated OAuth credential whose account is the seeded mailbox (ordinary Mail.* slots). */
const credentialLayer = staticCredentialResolverLayer(
  OAuthCredential.make({
    provider: 'microsoft',
    accessToken,
    expiresAt: 4_000_000_000_000,
    accountId: microsoftConformanceFixtureSeeds.mailbox
  })
)

const portsOver = <E>(httpLayer: Layer.Layer<HttpClient.HttpClient, E>) =>
  Layer.mergeAll(
    connectorHttpClientsFromEffectHttpClientLayer.pipe(Layer.provide(httpLayer)),
    credentialLayer,
    Layer.succeed(MicrosoftConformanceConfig, microsoftConformanceFixtureSeeds)
  )

/** Both origins (Graph and the SharePoint monitor host) go to the same emulator. */
const inProcessLayer = (emulator: MicrosoftEmulator) =>
  InProcessHttpClient.layer([
    EmulatorRoute.handler(graphOrigin, emulator.fetch),
    EmulatorRoute.handler(emulator.sharePointOrigin, emulator.fetch)
  ])

/** Real `FetchHttpClient` underneath; both origins rewritten to one server on 127.0.0.1:0. */
const emulatedLayer = (emulator: MicrosoftEmulator) =>
  Layer.unwrap(
    serveFetchHandler(emulator.fetch).pipe(
      Effect.map(server =>
        EmulatedHttpClient.layer([
          EmulatorRoute.url(graphOrigin, server.url),
          EmulatorRoute.url(emulator.sharePointOrigin, server.url)
        ]).pipe(Layer.provide(FetchHttpClient.layer))
      )
    )
  )

type Emulators = ReadonlyMap<string, MicrosoftEmulator>

/** One fresh emulator per case (same seed), closed when the effect ends. */
const withEmulators = <A, E, R>(
  options: MicrosoftEmulatorOptions,
  use: (emulators: Emulators) => Effect.Effect<A, E, R>
) =>
  Effect.acquireUseRelease(
    Effect.promise(async () => {
      const emulators = new Map<string, MicrosoftEmulator>()

      for (const testCase of microsoftConformanceCases) {
        emulators.set(
          testCase.id,
          await makeMicrosoftEmulator({ now: () => now.getTime(), ...options })
        )
      }

      return emulators
    }),
    use,
    emulators =>
      Effect.promise(() => Promise.all([...emulators.values()].map(emulator => emulator.close())))
  )

const emulatorFor = (emulators: Emulators, caseId: string): MicrosoftEmulator => {
  const emulator = emulators.get(caseId)

  if (emulator === undefined) {
    throw new Error(`no emulator for ${caseId}`)
  }

  return emulator
}

const runAll = <E>(
  emulators: Emulators,
  target: ConformanceTarget,
  transport: (emulator: MicrosoftEmulator) => Layer.Layer<HttpClient.HttpClient, E>
) =>
  runConformance(microsoftConformanceCases, {
    target,
    now,
    layer: testCase => portsOver(transport(emulatorFor(emulators, testCase.id)))
  })

const caseCount = microsoftConformanceCases.length

const expectAllPassed = (report: ConformanceReport) => {
  expect(report.summary, formatConformanceReport(report)).toEqual({
    passed: caseCount,
    failed: 0,
    skipped: 0
  })

  for (const result of report.results) {
    expect(result.status, result.id).toBe('passed')
  }
}

const requests = (entries: ReadonlyArray<MicrosoftLedgerEntry>) =>
  entries.map(entry => `${entry.method} ${entry.route ?? entry.path} ${entry.status}`)

/** The state without its id counters, which creates advance by design (never rewound). */
const withoutCounters = ({ counters: _counters, ...state }: MicrosoftEmulatorState) => state

const readCaseIds = microsoftConformanceCases
  .filter(testCase => testCase.safety === 'read')
  .map(testCase => testCase.id)

const writeCaseIds = microsoftConformanceCases
  .filter(testCase => testCase.safety === 'write-reversible')
  .map(testCase => testCase.id)

describe('cross-check A: in-process emulator through the real connector', () => {
  // What "ends at the seed" means: every read case leaves the exact seed; every write-reversible
  // case removes what it created and ends at the seed except the id counters (event, message,
  // change-key, and drive-item numbers), which only ever advance so a later create never reuses
  // a removed id. The test proves each write case moved at least one counter.
  it.effect(
    'passes every Microsoft case; read cases leave the exact seed, write cases differ only in advanced id counters',
    () =>
      withEmulators({}, emulators =>
        Effect.gen(function* () {
          const seeds = new Map(
            [...emulators].map(([id, emulator]) => [id, emulator.snapshot()] as const)
          )

          const report = yield* runAll(emulators, { kind: 'in-process' }, inProcessLayer)

          expectAllPassed(report)
          expect(report.target).toEqual({ kind: 'in-process' })
          expect(readCaseIds).toHaveLength(5)
          expect(writeCaseIds).toHaveLength(6)

          const seedOf = (id: string): MicrosoftEmulatorState => {
            const seed = seeds.get(id)

            if (seed === undefined) throw new Error(`no seed for ${id}`)

            return seed
          }

          const stateOf = (id: string) => emulatorFor(emulators, id).snapshot()
          const ledgerOf = (id: string) => emulatorFor(emulators, id).ledger.entries()

          for (const id of readCaseIds) {
            expect(stateOf(id), id).toEqual(seedOf(id))
            expect(
              ledgerOf(id).every(entry => entry.method === 'GET' && entry.status === 200),
              id
            ).toBe(true)
          }

          for (const id of writeCaseIds) {
            const state = stateOf(id)
            const seed = seedOf(id)

            expect(withoutCounters(state), id).toEqual(withoutCounters(seed))
            expect(state.counters, id).not.toEqual(seed.counters)

            for (const [key, value] of Object.entries(state.counters)) {
              const before = Object.entries(seed.counters).find(([name]) => name === key)?.[1]

              expect(value, `${id} ${key}`).toBeGreaterThanOrEqual(before ?? 0)
            }
          }

          // Create, GET, PATCH, DELETE (204), GET (404).
          expect(requests(ledgerOf('microsoft.calendar.create-returns-event-id'))).toEqual([
            'POST /v1.0/users/{userId}/calendars/{calendarId}/events 201',
            'GET /v1.0/users/{userId}/events/{eventId} 200',
            'PATCH /v1.0/users/{userId}/events/{eventId} 200',
            'DELETE /v1.0/users/{userId}/events/{eventId} 204',
            'GET /v1.0/users/{userId}/events/{eventId} 404'
          ])

          // Create, cancel (202), GET (404), DELETE (404), exactly as the cancel fixture.
          expect(requests(ledgerOf('microsoft.calendar.cancel-semantics'))).toEqual([
            'POST /v1.0/users/{userId}/calendars/{calendarId}/events 201',
            'POST /v1.0/users/{userId}/events/{eventId}/cancel 202',
            'GET /v1.0/users/{userId}/events/{eventId} 404',
            'DELETE /v1.0/users/{userId}/events/{eventId} 404'
          ])

          // Draft, move (same immutable id), PATCH by the original id, permanent-delete batch;
          // every Outlook request carried the immutable-id preference.
          const immutableLedger = ledgerOf('microsoft.outlook.immutable-id-survives-move')

          expect(requests(immutableLedger)).toEqual([
            'POST /v1.0/users/{userId}/messages 201',
            'POST /v1.0/users/{userId}/messages/{messageId}/move 201',
            'PATCH /v1.0/users/{userId}/messages/{messageId} 200',
            'POST /v1.0/$batch 200'
          ])
          expect(
            immutableLedger
              .filter(entry => entry.route !== '/v1.0/$batch')
              .every(entry => entry.prefer === 'IdType="ImmutableId"')
          ).toBe(true)
          expect(immutableLedger[1]?.path).toBe(immutableLedger[2]?.path.concat('/move'))

          // Two overlapping PATCHes: exactly one wins (200), the other loses with 409.
          const concurrentStatuses = ledgerOf('microsoft.outlook.concurrent-writes-same-message')
            .filter(entry => entry.method === 'PATCH')
            .map(entry => entry.status)
            .sort()

          expect(concurrentStatuses).toEqual([200, 409])

          // Paging: two pages, the second through the opaque nextLink.
          expect(ledgerOf('microsoft.outlook.paging-next-link').map(entry => entry.query)).toEqual([
            {
              $select:
                'id,subject,bodyPreview,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,hasAttachments,isRead,flag,isDraft,importance,conversationId,internetMessageId,webLink',
              $top: '2'
            },
            {
              $select:
                'id,subject,bodyPreview,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,hasAttachments,isRead,flag,isDraft,importance,conversationId,internetMessageId,webLink',
              $top: '2',
              $skip: '2'
            }
          ])

          // Copy: accepted (202), the monitor's first poll completed (200, no credential), as
          // the fixture records, with the copy listed; the folder removal takes the copy with it.
          const copyLedger = ledgerOf('microsoft.onedrive.copy-accepted-monitor')

          expect(requests(copyLedger)).toEqual([
            'GET /v1.0/drives/{driveId}/items/{itemId} 200',
            'POST /v1.0/drives/{driveId}/items/{itemId}/children 201',
            'POST /v1.0/drives/{driveId}/items/{itemId}/copy 202',
            'GET /personal/{site}/_api/v2.0/monitor/{monitorId} 200',
            'GET /v1.0/drives/{driveId}/items/{itemId}/children 200',
            'DELETE /v1.0/drives/{driveId}/items/{itemId} 204',
            'GET /v1.0/drives/{driveId}/items/{itemId} 404'
          ])
          expect(
            emulatorFor(emulators, 'microsoft.onedrive.copy-accepted-monitor').monitors()
          ).toEqual([
            expect.objectContaining({ status: 'completed', resourceId: expect.any(String) })
          ])

          // No credential ever reaches a ledger or a state.
          for (const emulator of emulators.values()) {
            const recorded = JSON.stringify([emulator.ledger.entries(), emulator.snapshot()])

            expect(recorded).not.toContain(accessToken)
            expect(recorded.toLowerCase()).not.toContain('bearer')
          }
        })
      ),
    60_000
  )
})

describe('cross-check B: emulated over a loopback socket', () => {
  // Over a real socket the two concurrent PATCHes arrive on separate connections: a wide
  // conflict window keeps the second one overlapping the first even on a loaded machine.
  it.effect(
    'passes every Microsoft case through FetchHttpClient and EmulatedHttpClient',
    () =>
      withEmulators({ conflictWindowMs: 500 }, emulators =>
        Effect.gen(function* () {
          const report = yield* runAll(emulators, { kind: 'emulated' }, emulatedLayer)

          expectAllPassed(report)
          expect(report.target).toEqual({ kind: 'emulated' })

          for (const testCase of microsoftConformanceCases) {
            const entries = emulatorFor(emulators, testCase.id).ledger.entries()

            expect(entries.length, testCase.id).toBeGreaterThan(0)
            expect(
              entries.every(entry => entry.evidence === 'unverified'),
              testCase.id
            ).toBe(true)
          }

          expect(
            emulatorFor(emulators, 'microsoft.outlook.concurrent-writes-same-message')
              .ledger.entries()
              .filter(entry => entry.method === 'PATCH')
              .map(entry => entry.status)
              .sort()
          ).toEqual([200, 409])
        })
      ),
    60_000
  )
})

const drill = (drills: MicrosoftEmulatorDrills) =>
  withEmulators({ drills }, emulators => runAll(emulators, { kind: 'in-process' }, inProcessLayer))

type ExpectedFailure = {
  readonly id: string
  readonly tag: string
  readonly message: string
}

const expectFailures = (report: ConformanceReport, failures: ReadonlyArray<ExpectedFailure>) => {
  expect(report.summary, formatConformanceReport(report)).toEqual({
    passed: caseCount - failures.length,
    failed: failures.length,
    skipped: 0
  })

  const failed = report.results.filter(result => result.status === 'failed')

  expect(failed.map(result => result.id)).toEqual(failures.map(failure => failure.id))

  for (const [index, failure] of failures.entries()) {
    expect(failed[index]?.failure?.tag, failure.id).toBe(failure.tag)
    expect(failed[index]?.failure?.message, failure.id).toContain(failure.message)
  }
}

describe('disagreement drills (tests-only knobs)', () => {
  // The timestamp-precision case reads the seeded event from the same calendar view, so an empty
  // view also fails it, as a precondition: it cannot check a precision it never sees.
  it.effect(
    'calendarRangeEmpty fails the list-range claim (and the precision case precondition)',
    () =>
      Effect.gen(function* () {
        expectFailures(yield* drill({ calendarRangeEmpty: true }), [
          {
            id: 'microsoft.calendar.list-range-returns-events',
            tag: 'ConformanceMismatch',
            message: 'expected the seeded calendar range to return events'
          },
          {
            id: 'microsoft.calendar.timestamp-precision',
            tag: 'ConformanceMismatch',
            message: 'precondition: the seeded calendarEventId is not among'
          }
        ])
      }),
    60_000
  )

  // The cancel case creates its event through the same route, so it cannot remove it either.
  it.effect(
    'createOmitsId fails the create-returns-id claim (and the cancel case, which creates the same way)',
    () =>
      Effect.gen(function* () {
        expectFailures(yield* drill({ createOmitsId: true }), [
          {
            id: 'microsoft.calendar.create-returns-event-id',
            tag: 'MicrosoftConformanceRestoreFailed',
            message: 'the create response carried no id'
          },
          {
            id: 'microsoft.calendar.cancel-semantics',
            tag: 'MicrosoftConformanceRestoreFailed',
            message: 'the create response carried no id'
          }
        ])
      }),
    60_000
  )

  it.effect(
    'timestampPrecisionDigits: 3 fails only the timestamp-precision case',
    () =>
      Effect.gen(function* () {
        expectFailures(yield* drill({ timestampPrecisionDigits: 3 }), [
          {
            id: 'microsoft.calendar.timestamp-precision',
            tag: 'ConformanceMismatch',
            message: 'seven-digit fractional dateTime'
          }
        ])
      }),
    60_000
  )

  it.effect(
    'omitNextLink fails only the paging case',
    () =>
      Effect.gen(function* () {
        expectFailures(yield* drill({ omitNextLink: true }), [
          {
            id: 'microsoft.outlook.paging-next-link',
            tag: 'ConformanceMismatch',
            message: 'expected @odata.nextLink'
          }
        ])
      }),
    60_000
  )
})
