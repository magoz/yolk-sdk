/**
 * Cross-checks: the Dropbox emulator must satisfy the same conformance cases the replayed fixtures
 * satisfy, through the REAL Dropbox connector actions and upload helpers, both in-process and over
 * a loopback socket; the read-only leftover lookup must work against it; and each drill knob must
 * make exactly its case fail. Tests may import SDK packages; the emulator source never does.
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
import { BearerTokenCredential } from '@yolk-sdk/connectors'
import {
  connectorHttpClientsFromEffectHttpClientLayer,
  staticCredentialResolverLayer
} from '@yolk-sdk/connectors/conformance'
import {
  DropboxConformanceConfig,
  dropboxConformanceCases,
  dropboxConformanceFixtureSeeds,
  findDropboxConformanceLeftovers
} from '@yolk-sdk/connectors/dropbox/conformance'
import { dropboxApiBaseUrl, dropboxContentApiBaseUrl } from '@yolk-sdk/connectors/dropbox'
import {
  makeDropboxEmulator,
  type DropboxEmulator,
  type DropboxEmulatorDrills,
  type DropboxEmulatorOptions,
  type DropboxEmulatorState,
  type DropboxLedgerEntry
} from '../src/dropbox.ts'
import { serveFetchHandler } from '../src/node.ts'
import { EmulatedHttpClient, EmulatorRoute, InProcessHttpClient } from '../src/router.ts'

const apiOrigin = new URL(dropboxApiBaseUrl).origin

const contentOrigin = new URL(dropboxContentApiBaseUrl).origin

const now = new Date('2026-09-29T14:00:00.000Z')

const accessToken = 'synthetic-dropbox-access-token'

const credentialLayer = staticCredentialResolverLayer(
  BearerTokenCredential.make({ token: accessToken })
)

const portsOver = <E>(httpLayer: Layer.Layer<HttpClient.HttpClient, E>) =>
  Layer.mergeAll(
    connectorHttpClientsFromEffectHttpClientLayer.pipe(Layer.provide(httpLayer)),
    credentialLayer,
    Layer.succeed(DropboxConformanceConfig, dropboxConformanceFixtureSeeds)
  )

/** Both origins (RPC and content) go to the same emulator. */
const inProcessLayer = (emulator: DropboxEmulator) =>
  InProcessHttpClient.layer([
    EmulatorRoute.handler(apiOrigin, emulator.fetch),
    EmulatorRoute.handler(contentOrigin, emulator.fetch)
  ])

/**
 * Real `FetchHttpClient` underneath; each origin rewritten to its own server on 127.0.0.1:0,
 * serving the emulator's handler for that origin (the rewrite loses the origin, and each route
 * answers only on the origin its fixtures record).
 */
const emulatedLayer = (emulator: DropboxEmulator) =>
  Layer.unwrap(
    Effect.all([
      serveFetchHandler(emulator.fetchOn(apiOrigin)),
      serveFetchHandler(emulator.fetchOn(contentOrigin))
    ]).pipe(
      Effect.map(([api, content]) =>
        EmulatedHttpClient.layer([
          EmulatorRoute.url(apiOrigin, api.url),
          EmulatorRoute.url(contentOrigin, content.url)
        ]).pipe(Layer.provide(FetchHttpClient.layer))
      )
    )
  )

type Emulators = ReadonlyMap<string, DropboxEmulator>

/** One fresh emulator per case (same seed), closed when the effect ends. */
const withEmulators = <A, E, R>(
  options: DropboxEmulatorOptions,
  use: (emulators: Emulators) => Effect.Effect<A, E, R>
) =>
  Effect.acquireUseRelease(
    Effect.promise(async () => {
      const emulators = new Map<string, DropboxEmulator>()

      for (const testCase of dropboxConformanceCases) {
        emulators.set(
          testCase.id,
          await makeDropboxEmulator({ now: () => now.getTime(), ...options })
        )
      }

      return emulators
    }),
    use,
    emulators =>
      Effect.promise(() => Promise.all([...emulators.values()].map(emulator => emulator.close())))
  )

const withEmulator = <A, E, R>(
  options: DropboxEmulatorOptions,
  use: (emulator: DropboxEmulator) => Effect.Effect<A, E, R>
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => makeDropboxEmulator({ now: () => now.getTime(), ...options })),
    use,
    emulator => Effect.promise(() => emulator.close())
  )

const emulatorFor = (emulators: Emulators, caseId: string): DropboxEmulator => {
  const emulator = emulators.get(caseId)

  if (emulator === undefined) {
    throw new Error(`no emulator for ${caseId}`)
  }

  return emulator
}

const runAll = <E>(
  emulators: Emulators,
  target: ConformanceTarget,
  transport: (emulator: DropboxEmulator) => Layer.Layer<HttpClient.HttpClient, E>
) =>
  runConformance(dropboxConformanceCases, {
    target,
    now,
    layer: testCase => portsOver(transport(emulatorFor(emulators, testCase.id)))
  })

const caseCount = dropboxConformanceCases.length

const expectAllPassed = (report: ConformanceReport) => {
  expect(report.summary, formatConformanceReport(report)).toEqual({
    passed: caseCount,
    failed: 0,
    skipped: 0
  })
}

const requests = (entries: ReadonlyArray<DropboxLedgerEntry>) =>
  entries.map(entry => `${entry.route ?? entry.path} ${entry.status}`)

/**
 * The state without what a write case leaves by design: the id and rev counters (which only
 * advance, so a later create never reuses an id) and the deleted-entry record of an empty case
 * folder it deleted (the delete fixture's `include_deleted` answer reads it).
 */
const withoutCountersAndDeleted = ({
  counters: _counters,
  deleted: _deleted,
  ...state
}: DropboxEmulatorState) => state

/** Every case folder lives under the work folder with the fixtures' synthetic run id. */
const caseNamespace = '/conformance/work/yolk-conformance-run-synthetic-'

const readCaseIds = dropboxConformanceCases
  .filter(testCase => testCase.safety === 'read')
  .map(testCase => testCase.id)

const writeCaseIds = dropboxConformanceCases
  .filter(testCase => testCase.safety === 'write-reversible')
  .map(testCase => testCase.id)

describe('cross-check A: in-process emulator through the real connector', () => {
  // What "ends at the seed" means: every read case leaves the exact seed; every write-reversible
  // case removes what it created and ends at the seed except the advanced counters and the
  // deleted-entry record of its own empty case folder, if it deleted one.
  it.effect(
    'passes every Dropbox case; read cases leave the exact seed, write cases differ only in counters and their own deleted records',
    () =>
      withEmulators({}, emulators =>
        Effect.gen(function* () {
          const seeds = new Map(
            [...emulators].map(([id, emulator]) => [id, emulator.snapshot()] as const)
          )

          const report = yield* runAll(emulators, { kind: 'in-process' }, inProcessLayer)

          expectAllPassed(report)
          expect(readCaseIds).toHaveLength(4)
          expect(writeCaseIds).toHaveLength(4)

          const seedOf = (id: string): DropboxEmulatorState => {
            const seed = seeds.get(id)

            if (seed === undefined) throw new Error(`no seed for ${id}`)

            return seed
          }

          const stateOf = (id: string) => emulatorFor(emulators, id).snapshot()
          const ledgerOf = (id: string) => emulatorFor(emulators, id).ledger.entries()

          for (const id of readCaseIds) {
            expect(stateOf(id), id).toEqual(seedOf(id))
            expect(
              ledgerOf(id).every(entry => entry.notEmulated === undefined),
              id
            ).toBe(true)
          }

          for (const id of writeCaseIds) {
            const state = stateOf(id)
            const seed = seedOf(id)

            expect(withoutCountersAndDeleted(state), id).toEqual(withoutCountersAndDeleted(seed))
            expect(state.counters.nextIdNumber, id).toBeGreaterThan(seed.counters.nextIdNumber)
            expect(state.counters.nextRevNumber, id).toBeGreaterThanOrEqual(
              seed.counters.nextRevNumber
            )
            expect(seed.deleted, id).toEqual([])
            expect(
              state.deleted.every(record => record.pathLower.startsWith(caseNamespace)),
              id
            ).toBe(true)
            expect(
              ledgerOf(id).every(entry => entry.notEmulated === undefined),
              id
            ).toBe(true)
          }

          expect(requests(ledgerOf('dropbox.files.create-folder-conflict'))).toEqual([
            '/2/files/get_metadata 409',
            '/2/files/create_folder_v2 200',
            '/2/files/create_folder_v2 409',
            '/2/files/create_folder_v2 409',
            '/2/files/delete_v2 200',
            '/2/files/get_metadata 409'
          ])

          expect(requests(ledgerOf('dropbox.files.upload-rev-precondition'))).toEqual([
            '/2/files/get_metadata 409',
            '/2/files/create_folder_v2 200',
            '/2/files/upload 200',
            '/2/files/upload 200',
            '/2/files/upload 409',
            '/2/files/upload 409',
            '/2/files/get_metadata 200',
            '/2/files/delete_v2 200',
            '/2/files/get_metadata 409'
          ])

          // The upload ledger records the Dropbox-API-Arg and the body length, never the bytes.
          const uploads = ledgerOf('dropbox.files.upload-rev-precondition').filter(
            entry => entry.route === '/2/files/upload'
          )

          expect(uploads.map(entry => entry.bodyBytes)).toEqual([37, 37, 37, 37])
          expect(uploads.every(entry => entry.headers['dropbox-api-arg'] !== undefined)).toBe(true)

          // Only the deletes of empty case folders keep a record (the conflict and delete cases);
          // the copy and upload cases delete folders with content, whose records no fixture shows.
          expect(writeCaseIds.map(id => stateOf(id).deleted.length)).toEqual([1, 1, 0, 0])
          expect(stateOf('dropbox.files.delete-then-not-found').deleted).toEqual([
            {
              name: 'yolk-conformance-run-synthetic-delete',
              pathLower: '/conformance/work/yolk-conformance-run-synthetic-delete',
              pathDisplay: '/Conformance/Work/yolk-conformance-run-synthetic-delete'
            }
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

  it.effect(
    'passes every case on one shared emulator; the leftover lookup of the empty work folder is not emulated before or after',
    () =>
      withEmulator({}, emulator =>
        Effect.gen(function* () {
          const seeded = emulator.snapshot()

          // No fixture records a listing of an empty folder, so the read-only lookup fails with
          // its action-failed error (the live runner prints its lookup-failed WARN) and writes
          // nothing.
          const lookup = findDropboxConformanceLeftovers.pipe(
            Effect.provide(portsOver(inProcessLayer(emulator)))
          )

          const expectLookupNotEmulated = (failed: unknown) => {
            expect(failed).toMatchObject({
              _tag: 'DropboxConformanceActionFailed',
              actionId: 'dropbox.list_folder',
              code: 'dropbox_list_folder_failed',
              status: 400
            })
            expect(emulator.ledger.entries().at(-1)).toMatchObject({
              route: '/2/files/list_folder',
              status: 400,
              notEmulated: expect.stringContaining('empty folder')
            })
          }

          expectLookupNotEmulated(yield* Effect.flip(lookup))
          expect(emulator.snapshot()).toEqual(seeded)
          emulator.ledger.clear()

          const report = yield* runConformance(dropboxConformanceCases, {
            target: { kind: 'in-process' },
            now,
            layer: () => portsOver(inProcessLayer(emulator))
          })

          expectAllPassed(report)
          expect(withoutCountersAndDeleted(emulator.snapshot())).toEqual(
            withoutCountersAndDeleted(seeded)
          )

          expect(emulator.ledger.entries().every(entry => entry.notEmulated === undefined)).toBe(
            true
          )

          const afterRun = emulator.snapshot()

          expectLookupNotEmulated(yield* Effect.flip(lookup))
          expect(emulator.snapshot()).toEqual(afterRun)
        })
      ),
    60_000
  )

  it.effect('the leftover lookup lists a run folder an earlier run left behind', () =>
    withEmulator(
      {
        seed: {
          entries: [
            { path: '/Conformance', id: 'id:SyntheticConformanceFolder', kind: 'folder' },
            { path: '/Conformance/Work', id: 'id:SyntheticWorkFolder00000', kind: 'folder' },
            {
              path: '/Conformance/Work/yolk-conformance-run-synthetic-copy',
              id: 'id:SyntheticLeftover0001',
              kind: 'folder'
            },
            {
              path: '/Conformance/Work/unrelated-folder',
              id: 'id:SyntheticUnrelated001',
              kind: 'folder'
            }
          ]
        }
      },
      emulator =>
        Effect.gen(function* () {
          const leftovers = yield* findDropboxConformanceLeftovers.pipe(
            Effect.provide(portsOver(inProcessLayer(emulator)))
          )

          expect(leftovers).toEqual(['/Conformance/Work/yolk-conformance-run-synthetic-copy'])
          // The lookup is read-only.
          expect(emulator.ledger.entries().map(entry => entry.route)).toEqual([
            '/2/files/list_folder'
          ])
        })
    )
  )
})

describe('cross-check B: emulated over a loopback socket', () => {
  it.effect(
    'passes every Dropbox case through FetchHttpClient and EmulatedHttpClient',
    () =>
      withEmulators({}, emulators =>
        Effect.gen(function* () {
          const seeds = new Map(
            [...emulators].map(([id, emulator]) => [id, emulator.snapshot()] as const)
          )

          const report = yield* runAll(emulators, { kind: 'emulated' }, emulatedLayer)

          expectAllPassed(report)
          expect(report.target).toEqual({ kind: 'emulated' })

          for (const testCase of dropboxConformanceCases) {
            const emulator = emulatorFor(emulators, testCase.id)
            const entries = emulator.ledger.entries()

            expect(entries.length, testCase.id).toBeGreaterThan(0)
            expect(
              entries.every(
                entry => entry.evidence === 'unverified' && entry.notEmulated === undefined
              ),
              testCase.id
            ).toBe(true)
            expect(withoutCountersAndDeleted(emulator.snapshot()), testCase.id).toEqual(
              withoutCountersAndDeleted(seeds.get(testCase.id) ?? emulator.snapshot())
            )
          }
        })
      ),
    60_000
  )
})

const drill = (drills: DropboxEmulatorDrills) =>
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
  const drills: ReadonlyArray<readonly [DropboxEmulatorDrills, ExpectedFailure]> = [
    [
      { listFolderSinglePage: true },
      {
        id: 'dropbox.files.list-folder-cursor-paging',
        tag: 'ConformanceMismatch',
        message: 'expected has_more for a listing larger than the limit'
      }
    ],
    [
      { getMetadataCaseSensitive: true },
      {
        id: 'dropbox.files.path-lower-lookup',
        tag: 'DropboxConformanceActionFailed',
        message: 'dropbox_not_found'
      }
    ],
    [
      { searchRepeatsMatches: true },
      {
        id: 'dropbox.files.search-continue',
        tag: 'ConformanceMismatch',
        message: 'expected search/continue_v2 to repeat no match from the first page'
      }
    ],
    [
      { notFoundAsPathLookup: true },
      {
        id: 'dropbox.errors.not-found-409-envelope',
        tag: 'ConformanceMismatch',
        message: 'expected an error_summary starting path/not_found/'
      }
    ],
    [
      { folderConflictAsFile: true },
      {
        id: 'dropbox.files.create-folder-conflict',
        tag: 'ConformanceMismatch',
        message: 'expected the conflict error envelope tagged path/conflict/folder'
      }
    ],
    [
      { deleteLeavesNoTombstone: true },
      {
        id: 'dropbox.files.delete-then-not-found',
        tag: 'DropboxConformanceActionFailed',
        message: 'dropbox.get_metadata failed: dropbox_get_metadata_failed (HTTP 400)'
      }
    ],
    [
      { moveMintsNewId: true },
      {
        id: 'dropbox.files.copy-move-metadata',
        tag: 'ConformanceMismatch',
        message: 'expected the moved file to keep its id'
      }
    ],
    [
      { uploadIgnoresRev: true },
      {
        id: 'dropbox.files.upload-rev-precondition',
        tag: 'ConformanceMismatch',
        message: 'expected an update naming a stale rev to fail with conflict (HTTP 409)'
      }
    ]
  ]

  // One drill per case: together they cover every case exactly once.
  it('has one drill per case', () => {
    expect(drills.map(([, failure]) => failure.id)).toEqual(
      dropboxConformanceCases.map(testCase => testCase.id)
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
