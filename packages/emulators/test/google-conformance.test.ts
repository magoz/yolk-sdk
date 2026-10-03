/**
 * Cross-checks: the Google emulator must satisfy the same conformance cases the replayed fixtures
 * satisfy, through the REAL Google connector actions (Gmail, Calendar, Drive), both in-process (A)
 * and over loopback sockets (B, one per recorded origin); the read-only leftover lookup must fail
 * closed against it (no fixture records its reads); and each drill knob must make exactly its case
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
import { BearerTokenCredential } from '@yolk-sdk/connectors'
import {
  connectorHttpClientsFromEffectHttpClientLayer,
  staticCredentialResolverLayer
} from '@yolk-sdk/connectors/conformance'
import {
  findGoogleConformanceLeftovers,
  GoogleConformanceConfig,
  googleConformanceCases,
  googleConformanceFixtureSeeds,
  GoogleConformanceRunId,
  type GoogleConformanceSeeds
} from '@yolk-sdk/connectors/google/conformance'
import {
  googleEmulatorApisOrigin,
  googleEmulatorGmailOrigin,
  makeGoogleEmulator,
  type GoogleEmulator,
  type GoogleEmulatorDrills,
  type GoogleEmulatorOptions,
  type GoogleEmulatorState,
  type GoogleLedgerEntry
} from '../src/google.ts'
import { serveFetchHandler } from '../src/node.ts'
import { EmulatedHttpClient, EmulatorRoute, InProcessHttpClient } from '../src/router.ts'

const now = new Date('2026-09-30T12:00:00.000Z')

/** A synthetic token: any well-formed bearer is accepted, and none is ever kept. */
const accessToken = 'ya29.synthetic-google-emulator-token-0001'

const credentialLayer = staticCredentialResolverLayer(
  BearerTokenCredential.make({ token: accessToken })
)

const portsOver = <E>(
  httpLayer: Layer.Layer<HttpClient.HttpClient, E>,
  seeds: GoogleConformanceSeeds = googleConformanceFixtureSeeds
) =>
  Layer.mergeAll(
    connectorHttpClientsFromEffectHttpClientLayer.pipe(Layer.provide(httpLayer)),
    credentialLayer,
    Layer.succeed(GoogleConformanceConfig, seeds)
  )

const inProcessLayer = (emulator: GoogleEmulator) =>
  InProcessHttpClient.layer([
    EmulatorRoute.handler(googleEmulatorGmailOrigin, emulator.fetch),
    EmulatorRoute.handler(googleEmulatorApisOrigin, emulator.fetch)
  ])

/**
 * Real `FetchHttpClient` underneath; each recorded origin rewritten to its own server on
 * 127.0.0.1:0 serving the emulator's handler for that origin (the rewrite loses the origin, and
 * every route answers only on the origin its fixtures record).
 */
const emulatedLayer = (emulator: GoogleEmulator) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const gmail = yield* serveFetchHandler(emulator.fetchOn(googleEmulatorGmailOrigin))
      const apis = yield* serveFetchHandler(emulator.fetchOn(googleEmulatorApisOrigin))

      return EmulatedHttpClient.layer([
        EmulatorRoute.url(googleEmulatorGmailOrigin, gmail.url),
        EmulatorRoute.url(googleEmulatorApisOrigin, apis.url)
      ]).pipe(Layer.provide(FetchHttpClient.layer))
    })
  )

type Emulators = ReadonlyMap<string, GoogleEmulator>

/** One fresh emulator per case (same seed), closed when the effect ends. */
const withEmulators = <A, E, R>(
  options: GoogleEmulatorOptions,
  use: (emulators: Emulators) => Effect.Effect<A, E, R>
) =>
  Effect.acquireUseRelease(
    Effect.promise(async () => {
      const emulators = new Map<string, GoogleEmulator>()

      for (const testCase of googleConformanceCases) {
        emulators.set(
          testCase.id,
          await makeGoogleEmulator({ now: () => now.getTime(), ...options })
        )
      }

      return emulators
    }),
    use,
    emulators =>
      Effect.promise(() => Promise.all([...emulators.values()].map(emulator => emulator.close())))
  )

const withEmulator = <A, E, R>(
  options: GoogleEmulatorOptions,
  use: (emulator: GoogleEmulator) => Effect.Effect<A, E, R>
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => makeGoogleEmulator({ now: () => now.getTime(), ...options })),
    use,
    emulator => Effect.promise(() => emulator.close())
  )

const emulatorFor = (emulators: Emulators, caseId: string): GoogleEmulator => {
  const emulator = emulators.get(caseId)

  if (emulator === undefined) {
    throw new Error(`no emulator for ${caseId}`)
  }

  return emulator
}

const runAll = <E>(
  emulators: Emulators,
  target: ConformanceTarget,
  transport: (emulator: GoogleEmulator) => Layer.Layer<HttpClient.HttpClient, E>
) =>
  runConformance(googleConformanceCases, {
    target,
    now,
    layer: testCase => portsOver(transport(emulatorFor(emulators, testCase.id)))
  })

const caseCount = googleConformanceCases.length

const expectAllPassed = (report: ConformanceReport) => {
  expect(report.summary, formatConformanceReport(report)).toEqual({
    passed: caseCount,
    failed: 0,
    skipped: 0
  })
}

const requests = (entries: ReadonlyArray<GoogleLedgerEntry>) =>
  entries.map(entry => `${entry.method} ${entry.route ?? entry.path} ${entry.status}`)

const sendCaseId = 'google.gmail.send-practice-address'

const eventCaseIds: ReadonlyArray<string> = [
  'google.calendar.event-lifecycle',
  'google.calendar.deleted-event-gone'
]

const readCaseIds = googleConformanceCases
  .filter(testCase => testCase.safety === 'read')
  .map(testCase => testCase.id)

/**
 * The state without what the cases leave by design: the counters (which only advance), the sent
 * message (Gmail cannot unsend; recorded in the state, never delivered), and the cancelled events
 * the event cases created (Calendar keeps a deleted event readable as `cancelled`, as the fixtures
 * read it back).
 */
const withoutResidue = ({ counters: _counters, ...state }: GoogleEmulatorState) => ({
  ...state,
  messages: state.messages.filter(message => !message.labelIds.includes('SENT')),
  events: state.events.filter(
    event => !(event.status === 'cancelled' && event.summary.startsWith('yolk-conformance run-'))
  )
})

/** Nothing the emulator keeps or reports carries the access token, in any form. */
const expectNoToken = (emulator: GoogleEmulator) => {
  const recorded = JSON.stringify([
    emulator.ledger.entries(),
    emulator.snapshot(),
    emulator.coverage(),
    emulator.faults.list()
  ])

  expect(recorded).not.toContain(accessToken)
  expect(recorded).not.toContain(encodeURIComponent(accessToken))
  expect(recorded.toLowerCase()).not.toContain('bearer')
}

describe('cross-check A: in-process emulator through the real connector', () => {
  // What "ends at the seed" means: every read case leaves the exact seed; every reversible write
  // case ends at the seed except the counters and, for the event cases, its own cancelled event;
  // the irreversible send adds exactly its sent message.
  it.effect(
    'passes every Google case (the irreversible send included); writes leave only the documented residue',
    () =>
      withEmulators({}, emulators =>
        Effect.gen(function* () {
          const seeds = new Map(
            [...emulators].map(([id, emulator]) => [id, emulator.snapshot()] as const)
          )

          const report = yield* runAll(emulators, { kind: 'in-process' }, inProcessLayer)

          expectAllPassed(report)
          expect(readCaseIds).toHaveLength(6)
          expect(report.results.find(result => result.id === sendCaseId)?.safety, sendCaseId).toBe(
            'write-irreversible'
          )

          const seedOf = (id: string): GoogleEmulatorState => {
            const seed = seeds.get(id)

            if (seed === undefined) throw new Error(`no seed for ${id}`)

            return seed
          }

          const stateOf = (id: string) => emulatorFor(emulators, id).snapshot()
          const ledgerOf = (id: string) => emulatorFor(emulators, id).ledger.entries()

          for (const id of readCaseIds) {
            expect(stateOf(id), id).toEqual(seedOf(id))
          }

          for (const testCase of googleConformanceCases) {
            const state = stateOf(testCase.id)

            expect(withoutResidue(state), testCase.id).toEqual(withoutResidue(seedOf(testCase.id)))
            expect(
              ledgerOf(testCase.id).every(
                entry => entry.notEmulated === undefined && entry.evidence === 'unverified'
              ),
              testCase.id
            ).toBe(true)
            expectNoToken(emulatorFor(emulators, testCase.id))
          }

          for (const id of eventCaseIds) {
            expect(
              stateOf(id).events.filter(event => event.status === 'cancelled'),
              id
            ).toHaveLength(1)
          }

          const sent = stateOf(sendCaseId).messages.filter(message =>
            message.labelIds.includes('SENT')
          )

          expect(sent).toHaveLength(1)
          expect(sent[0]?.metadataPayload?.headers).toContainEqual({
            name: 'To',
            value: googleConformanceFixtureSeeds.practiceAddress
          })

          expect(requests(ledgerOf(sendCaseId))).toEqual([
            'POST /upload/gmail/v1/users/me/messages/send 200',
            'GET /gmail/v1/users/me/messages/{messageId} 200'
          ])

          expect(requests(ledgerOf('google.gmail.draft-compose-update-delete'))).toEqual([
            'POST /gmail/v1/users/me/drafts 200',
            'GET /gmail/v1/users/me/messages/{messageId} 200',
            'GET /gmail/v1/users/me/threads/{threadId} 200',
            'PUT /gmail/v1/users/me/drafts/{draftId} 200',
            'GET /gmail/v1/users/me/threads/{threadId} 200',
            'DELETE /gmail/v1/users/me/drafts/{draftId} 204',
            'GET /gmail/v1/users/me/messages/{messageId} 404',
            'DELETE /gmail/v1/users/me/drafts/{draftId} 404',
            'GET /gmail/v1/users/me/messages/{messageId} 404'
          ])

          expect(requests(ledgerOf('google.calendar.deleted-event-gone'))).toEqual([
            'POST /calendar/v3/calendars/{calendarId}/events 200',
            'DELETE /calendar/v3/calendars/{calendarId}/events/{eventId} 204',
            'GET /calendar/v3/calendars/{calendarId}/events/{eventId} 200',
            'DELETE /calendar/v3/calendars/{calendarId}/events/{eventId} 410',
            'GET /calendar/v3/calendars/{calendarId}/events/{eventId} 200'
          ])

          expect(requests(ledgerOf('google.drive.folder-trash-delete'))).toEqual([
            'POST /drive/v3/files 200',
            'PATCH /drive/v3/files/{fileId} 200',
            'GET /drive/v3/files/{fileId} 200',
            'GET /drive/v3/files 200',
            'DELETE /drive/v3/files/{fileId} 204',
            'GET /drive/v3/files/{fileId} 404'
          ])
        })
      ),
    60_000
  )

  it.effect(
    'passes every case sequentially on ONE emulator; the leftover lookup fails closed before and after',
    () =>
      withEmulator({}, emulator =>
        Effect.gen(function* () {
          const lookup = findGoogleConformanceLeftovers.pipe(
            Effect.provide(portsOver(inProcessLayer(emulator)))
          )

          // No fixture records the lookup's label listing (nor its draft search or free-text event
          // query), so the read-only lookup fails with its action-failed error (the live runner
          // prints its lookup-failed WARN) and writes nothing.
          const seeded = emulator.snapshot()

          expect(yield* Effect.flip(lookup)).toMatchObject({
            _tag: 'GoogleConformanceActionFailed',
            actionId: 'gmail.list_labels',
            code: 'gmail_list_labels_failed',
            status: 400
          })
          expect(emulator.ledger.entries()).toEqual([
            expect.objectContaining({
              method: 'GET',
              path: '/<unrecognised>',
              query: {},
              status: 400,
              evidence: 'unknown-route',
              notEmulated: 'no emulated Google route for this method and path'
            })
          ])
          expect(emulator.snapshot()).toEqual(seeded)
          emulator.ledger.clear()

          const report = yield* runConformance(googleConformanceCases, {
            target: { kind: 'in-process' },
            now,
            layer: () => portsOver(inProcessLayer(emulator))
          })

          expectAllPassed(report)
          expect(emulator.ledger.entries().every(entry => entry.notEmulated === undefined)).toBe(
            true
          )

          const after = emulator.snapshot()

          // Ends at the seed except the counters, the one sent message, and the two cancelled
          // case events.
          expect(withoutResidue(after)).toEqual(withoutResidue(seeded))
          expect(after.messages.filter(message => message.labelIds.includes('SENT'))).toHaveLength(
            1
          )
          expect(after.events.filter(event => event.status === 'cancelled')).toHaveLength(2)
          expect(after.counters).toEqual({
            ...seeded.counters,
            nextLabelNumber: seeded.counters.nextLabelNumber + 1,
            nextDraftNumber: seeded.counters.nextDraftNumber + 1,
            nextDraftMessageNumber: seeded.counters.nextDraftMessageNumber + 2,
            nextSentNumber: seeded.counters.nextSentNumber + 1,
            nextEventNumber: seeded.counters.nextEventNumber + 2,
            nextFolderNumber: seeded.counters.nextFolderNumber + 1
          })

          expect(yield* Effect.flip(lookup)).toMatchObject({
            _tag: 'GoogleConformanceActionFailed',
            code: 'gmail_list_labels_failed',
            status: 400
          })
          expect(emulator.snapshot()).toEqual(after)
          expectNoToken(emulator)
        })
      ),
    60_000
  )

  // Any run id of the fixtures' length (13 characters): the draft and sent messages carry the
  // recorded sizeEstimate, which covers the subject, so those answers need exactly that length.
  it.effect('passes every case with another 13-character run id', () =>
    withEmulator({}, emulator =>
      Effect.gen(function* () {
        const runId = GoogleConformanceRunId.make('run-3f9a2c7d1')

        expect(runId).toHaveLength(13)

        const report = yield* runConformance(googleConformanceCases, {
          target: { kind: 'in-process' },
          now,
          layer: () =>
            portsOver(inProcessLayer(emulator), { ...googleConformanceFixtureSeeds, runId })
        })

        expectAllPassed(report)

        const sent = emulator.snapshot().messages.find(message => message.labelIds.includes('SENT'))

        expect(sent?.metadataPayload?.headers).toContainEqual({
          name: 'Subject',
          value: `yolk-conformance ${runId} send: synthetic conformance message, safe to delete`
        })
      })
    )
  )
})

describe('cross-check B: emulated over loopback sockets', () => {
  it.effect(
    'passes every Google case through FetchHttpClient and EmulatedHttpClient',
    () =>
      withEmulators({}, emulators =>
        Effect.gen(function* () {
          const seeds = new Map(
            [...emulators].map(([id, emulator]) => [id, emulator.snapshot()] as const)
          )

          const report = yield* runAll(emulators, { kind: 'emulated' }, emulatedLayer)

          expectAllPassed(report)
          expect(report.target).toEqual({ kind: 'emulated' })

          for (const testCase of googleConformanceCases) {
            const emulator = emulatorFor(emulators, testCase.id)
            const entries = emulator.ledger.entries()
            const seed = seeds.get(testCase.id)

            if (seed === undefined) throw new Error(`no seed for ${testCase.id}`)

            expect(entries.length, testCase.id).toBeGreaterThan(0)
            expect(
              entries.every(
                entry => entry.evidence === 'unverified' && entry.notEmulated === undefined
              ),
              testCase.id
            ).toBe(true)
            expect(withoutResidue(emulator.snapshot()), testCase.id).toEqual(withoutResidue(seed))
            expectNoToken(emulator)
          }

          for (const id of readCaseIds) {
            expect(emulatorFor(emulators, id).snapshot(), id).toEqual(seeds.get(id))
          }
        })
      ),
    60_000
  )
})

const drill = (drills: GoogleEmulatorDrills) =>
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
  const drills: ReadonlyArray<readonly [GoogleEmulatorDrills, ExpectedFailure]> = [
    [
      { gmailPageRepeats: true },
      {
        id: 'google.gmail.list-page-token',
        tag: 'ConformanceMismatch',
        message: 'expected a later page to repeat no message from an earlier page'
      }
    ],
    [
      { attachmentStandardBase64: true },
      {
        id: 'google.gmail.attachment-base64url',
        tag: 'ConnectorError',
        // The connector refuses standard-base64 data when decoding the answer.
        message: 'Invalid response shape'
      }
    ],
    [
      { notFoundWithoutMessage: true },
      {
        id: 'google.gmail.not-found-envelope',
        tag: 'ConformanceMismatch',
        message: 'expected the not-found body to be JSON with a non-empty error.message'
      }
    ],
    [
      { labelDeleteKeepsOnMessages: true },
      {
        id: 'google.gmail.label-create-apply-delete',
        tag: 'ConformanceMismatch',
        message: 'expected get_message to drop the deleted label from the work message'
      }
    ],
    [
      { draftUpdateKeepsContent: true },
      {
        id: 'google.gmail.draft-compose-update-delete',
        tag: 'ConformanceMismatch',
        message: 'expected get_thread to read back the updated subject and body exactly'
      }
    ],
    [
      { trashAnswerOmitsTrash: true },
      {
        id: 'google.gmail.trash-untrash',
        tag: 'ConformanceMismatch',
        message: 'expected trash to answer the message with the TRASH label'
      }
    ],
    [
      { sentMessageWithoutTo: true },
      {
        id: sendCaseId,
        tag: 'ConformanceMismatch',
        message: 'expected get_message of the sent id to read back the practice address'
      }
    ],
    [
      { calendarPageRepeats: true },
      {
        id: 'google.calendar.list-range-paging',
        tag: 'ConformanceMismatch',
        message: 'expected no event repeated within or across pages'
      }
    ],
    [
      { eventPatchKeepsSummary: true },
      {
        id: 'google.calendar.event-lifecycle',
        tag: 'ConformanceMismatch',
        message: 'expected update_event to rename the event and keep its start'
      }
    ],
    [
      { repeatedEventDeleteConflict: true },
      {
        id: 'google.calendar.deleted-event-gone',
        tag: 'ConformanceMismatch',
        message: 'expected deleting the deleted event again to answer 2xx, 404, or 410'
      }
    ],
    [
      { drivePageRepeats: true },
      {
        id: 'google.drive.list-page-token',
        tag: 'ConformanceMismatch',
        message: 'expected no file repeated within or across pages'
      }
    ],
    [
      { getFileWithoutParents: true },
      {
        id: 'google.drive.get-file-fields',
        tag: 'ConformanceMismatch',
        message:
          'expected get_file to answer the seeded id with the seeded folder among its parents'
      }
    ],
    [
      { listIncludesTrashed: true },
      {
        id: 'google.drive.folder-trash-delete',
        tag: 'ConformanceMismatch',
        message: 'expected list_files to leave the trashed folder out'
      }
    ]
  ]

  // One drill per case: together they cover every case exactly once.
  it('has one drill per case', () => {
    expect(drills.map(([, failure]) => failure.id)).toEqual(
      googleConformanceCases.map(testCase => testCase.id)
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
