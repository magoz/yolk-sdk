/**
 * Cross-checks: the GitHub emulator must satisfy the same conformance cases the replayed fixtures
 * satisfy, through the REAL GitHub connector actions, both in-process and over a loopback socket,
 * each case alone and all of them in sequence on one emulator; the read-only leftover lookup must
 * fail closed against it (its open-issue listing has no fixture); and each drill knob must make
 * exactly its case fail. Tests may import SDK packages; the emulator source never does.
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
import { githubApiBaseUrl } from '@yolk-sdk/connectors/github'
import {
  GithubConformanceConfig,
  findGithubConformanceLeftovers,
  githubConformanceCases,
  githubConformanceFixtureSeeds
} from '@yolk-sdk/connectors/github/conformance'
import {
  makeGithubEmulator,
  type GithubEmulator,
  type GithubEmulatorDrills,
  type GithubEmulatorOptions,
  type GithubEmulatorState,
  type GithubLedgerEntry
} from '../src/github.ts'
import { serveFetchHandler } from '../src/node.ts'
import { EmulatedHttpClient, EmulatorRoute, InProcessHttpClient } from '../src/router.ts'

const origin = new URL(githubApiBaseUrl).origin

const now = new Date('2026-09-30T12:00:05.000Z')

const token = 'synthetic-github-conformance-token'

const credentialLayer = staticCredentialResolverLayer(BearerTokenCredential.make({ token }))

const portsOver = <E>(httpLayer: Layer.Layer<HttpClient.HttpClient, E>) =>
  Layer.mergeAll(
    connectorHttpClientsFromEffectHttpClientLayer.pipe(Layer.provide(httpLayer)),
    credentialLayer,
    Layer.succeed(GithubConformanceConfig, githubConformanceFixtureSeeds)
  )

const inProcessLayer = (emulator: GithubEmulator) =>
  InProcessHttpClient.layer([EmulatorRoute.handler(origin, emulator.fetch)])

/**
 * Real `FetchHttpClient` underneath; the origin rewritten to a server on 127.0.0.1:0 serving the
 * emulator's handler for the recorded origin (the rewrite loses the origin, and every route
 * answers only on the origin its fixtures record).
 */
const emulatedLayer = (emulator: GithubEmulator) =>
  Layer.unwrap(
    serveFetchHandler(emulator.fetchOn(origin)).pipe(
      Effect.map(server =>
        EmulatedHttpClient.layer([EmulatorRoute.url(origin, server.url)]).pipe(
          Layer.provide(FetchHttpClient.layer)
        )
      )
    )
  )

type Emulators = ReadonlyMap<string, GithubEmulator>

/** One fresh emulator per case (same seed), closed when the effect ends. */
const withEmulators = <A, E, R>(
  options: GithubEmulatorOptions,
  use: (emulators: Emulators) => Effect.Effect<A, E, R>
) =>
  Effect.acquireUseRelease(
    Effect.promise(async () => {
      const emulators = new Map<string, GithubEmulator>()

      for (const testCase of githubConformanceCases) {
        emulators.set(
          testCase.id,
          await makeGithubEmulator({ now: () => now.getTime(), ...options })
        )
      }

      return emulators
    }),
    use,
    emulators =>
      Effect.promise(() => Promise.all([...emulators.values()].map(emulator => emulator.close())))
  )

const withEmulator = <A, E, R>(
  options: GithubEmulatorOptions,
  use: (emulator: GithubEmulator) => Effect.Effect<A, E, R>
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => makeGithubEmulator({ now: () => now.getTime(), ...options })),
    use,
    emulator => Effect.promise(() => emulator.close())
  )

const emulatorFor = (emulators: Emulators, caseId: string): GithubEmulator => {
  const emulator = emulators.get(caseId)

  if (emulator === undefined) {
    throw new Error(`no emulator for ${caseId}`)
  }

  return emulator
}

const runAll = <E>(
  emulators: Emulators,
  target: ConformanceTarget,
  transport: (emulator: GithubEmulator) => Layer.Layer<HttpClient.HttpClient, E>
) =>
  runConformance(githubConformanceCases, {
    target,
    now,
    layer: testCase => portsOver(transport(emulatorFor(emulators, testCase.id)))
  })

const caseCount = githubConformanceCases.length

const expectAllPassed = (report: ConformanceReport) => {
  expect(report.summary, formatConformanceReport(report)).toEqual({
    passed: caseCount,
    failed: 0,
    skipped: 0
  })
}

const requests = (entries: ReadonlyArray<GithubLedgerEntry>) =>
  entries.map(entry => `${entry.method} ${entry.route ?? entry.path} ${entry.status}`)

const commentCaseId = 'github.comments.create-delete'

const lifecycleCaseId = 'github.issues.lifecycle-close'

const readCaseIds = githubConformanceCases
  .filter(testCase => testCase.safety === 'read')
  .map(testCase => testCase.id)

/**
 * What a write case may leave besides the seed, by design: the counters (which only advance), the
 * record of a comment deleted here (the comment fixture's second delete answers 404), and the
 * lifecycle case's closed issue (GitHub cannot delete issues; the fixture reads it back closed).
 */
const withoutCountersAndKeptItems = ({
  counters: _counters,
  deletedComments: _deleted,
  ...state
}: GithubEmulatorState) => ({
  ...state,
  issues: state.issues.filter(issue => !(issue.createdHere && issue.state === 'closed'))
})

/** The seed a case starts from, as kept before the run. */
const seedFrom = (seeds: ReadonlyMap<string, GithubEmulatorState>, id: string) => {
  const seed = seeds.get(id)

  if (seed === undefined) throw new Error(`no seed for ${id}`)

  return seed
}

/** Each case ends at its seed except the counters and the items the provider keeps. */
const expectEndsAtSeed = (
  emulators: Emulators,
  seeds: ReadonlyMap<string, GithubEmulatorState>
) => {
  for (const id of readCaseIds) {
    expect(emulatorFor(emulators, id).snapshot(), id).toEqual(seedFrom(seeds, id))
  }

  // The label case restores the work issue's labels exactly.
  expect(emulatorFor(emulators, 'github.labels.add-remove').snapshot()).toEqual(
    seedFrom(seeds, 'github.labels.add-remove')
  )

  const commented = emulatorFor(emulators, commentCaseId).snapshot()
  const commentSeed = seedFrom(seeds, commentCaseId)

  expect(withoutCountersAndKeptItems(commented)).toEqual(withoutCountersAndKeptItems(commentSeed))
  expect(commented.comments).toEqual([])
  expect(commented.deletedComments).toEqual([9000000001])
  expect(commented.counters).toEqual({
    ...commentSeed.counters,
    nextCommentId: commentSeed.counters.nextCommentId + 1
  })

  const closed = emulatorFor(emulators, lifecycleCaseId).snapshot()
  const lifecycleSeed = seedFrom(seeds, lifecycleCaseId)

  expect(withoutCountersAndKeptItems(closed)).toEqual(withoutCountersAndKeptItems(lifecycleSeed))
  expect(closed.counters).toEqual({
    ...lifecycleSeed.counters,
    nextIssueNumber: lifecycleSeed.counters.nextIssueNumber + 1
  })
  expect(closed.issues.at(-1)).toMatchObject({
    number: 42,
    state: 'closed',
    stateReason: 'completed',
    createdHere: true,
    title:
      'yolk-conformance run-synthetic lifecycle renamed: ' +
      'synthetic conformance issue, safe to ignore'
  })
}

describe('cross-check A: in-process emulator through the real connector', () => {
  it.effect(
    'passes every GitHub case; each ends at its seed except the counters and what GitHub keeps',
    () =>
      withEmulators({}, emulators =>
        Effect.gen(function* () {
          const seeds = new Map(
            [...emulators].map(([id, emulator]) => [id, emulator.snapshot()] as const)
          )

          const report = yield* runAll(emulators, { kind: 'in-process' }, inProcessLayer)

          expectAllPassed(report)
          expect(readCaseIds).toHaveLength(4)
          expectEndsAtSeed(emulators, seeds)

          const ledgerOf = (id: string) => emulatorFor(emulators, id).ledger.entries()

          // The error cases' refusals are the fixtures' 404 and 422, never not-emulated.
          for (const testCase of githubConformanceCases) {
            expect(
              ledgerOf(testCase.id).every(entry => entry.notEmulated === undefined),
              testCase.id
            ).toBe(true)
            expect(
              ledgerOf(testCase.id).every(
                entry =>
                  entry.headers['x-github-api-version'] === '2026-03-10' &&
                  entry.headers.accept === 'application/vnd.github+json'
              ),
              testCase.id
            ).toBe(true)
          }

          expect(requests(ledgerOf('github.labels.list-link-paging'))).toEqual([
            'GET /repos/{owner}/{repo}/labels 200',
            'GET /repos/{owner}/{repo}/labels 200',
            'GET /repos/{owner}/{repo}/labels 200',
            'GET /repos/{owner}/{repo}/labels 200'
          ])
          expect(requests(ledgerOf('github.errors.not-found-envelope'))).toEqual([
            'GET /repos/{owner}/{repo}/issues/{issueNumber} 404'
          ])
          expect(requests(ledgerOf('github.errors.validation-envelope'))).toEqual([
            'GET /search/issues 422'
          ])
          expect(requests(ledgerOf(commentCaseId))).toEqual([
            'POST /repos/{owner}/{repo}/issues/{issueNumber}/comments 201',
            'GET /repos/{owner}/{repo}/issues/{issueNumber}/comments 200',
            'DELETE /repos/{owner}/{repo}/issues/comments/{commentId} 204',
            'GET /repos/{owner}/{repo}/issues/{issueNumber}/comments 200',
            'DELETE /repos/{owner}/{repo}/issues/comments/{commentId} 404'
          ])
          expect(requests(ledgerOf('github.labels.add-remove'))).toEqual([
            'GET /repos/{owner}/{repo}/issues/{issueNumber} 200',
            'GET /repos/{owner}/{repo}/labels 200',
            'POST /repos/{owner}/{repo}/issues/{issueNumber}/labels 200',
            'GET /repos/{owner}/{repo}/issues/{issueNumber} 200',
            'DELETE /repos/{owner}/{repo}/issues/{issueNumber}/labels/{name} 200',
            'GET /repos/{owner}/{repo}/issues/{issueNumber} 200',
            'DELETE /repos/{owner}/{repo}/issues/{issueNumber}/labels/{name} 404'
          ])
          expect(requests(ledgerOf(lifecycleCaseId))).toEqual([
            'POST /repos/{owner}/{repo}/issues 201',
            'GET /repos/{owner}/{repo}/issues/{issueNumber} 200',
            'PATCH /repos/{owner}/{repo}/issues/{issueNumber} 200',
            'PATCH /repos/{owner}/{repo}/issues/{issueNumber} 200',
            'GET /repos/{owner}/{repo}/issues/{issueNumber} 200'
          ])

          for (const emulator of emulators.values()) {
            const recorded = JSON.stringify([emulator.ledger.entries(), emulator.snapshot()])

            expect(recorded).not.toContain(token)
            expect(recorded.toLowerCase()).not.toContain('bearer')
          }
        })
      ),
    60_000
  )

  it.effect(
    'passes every case twice in sequence on ONE emulator; the leftover lookup is not emulated',
    () =>
      withEmulator({}, emulator =>
        Effect.gen(function* () {
          const lookup = findGithubConformanceLeftovers.pipe(
            Effect.provide(portsOver(inProcessLayer(emulator)))
          )

          // No fixture records the open-issue listing, so the read-only lookup fails with its
          // action-failed error (the live runner prints its lookup-failed WARN) and writes nothing.
          const seed = emulator.snapshot()

          expect(yield* Effect.flip(lookup)).toMatchObject({
            _tag: 'GithubConformanceActionFailed',
            actionId: 'github.list_issues',
            code: 'github_validation',
            status: 400
          })
          expect(emulator.ledger.entries()).toEqual([
            {
              seq: 1,
              method: 'GET',
              path: '/<unrecognised>',
              query: {},
              headers: {},
              status: 400,
              evidence: 'unknown-route',
              notEmulated: 'no emulated GitHub route for this method and path'
            }
          ])
          expect(emulator.snapshot()).toEqual(seed)
          emulator.ledger.clear()

          const runOnce = runConformance(githubConformanceCases, {
            target: { kind: 'in-process' },
            now,
            layer: () => portsOver(inProcessLayer(emulator))
          })

          expectAllPassed(yield* runOnce)
          // The second pass mints issue 43 and comment 9000000002: counters only advance.
          expectAllPassed(yield* runOnce)
          expect(emulator.ledger.entries().every(entry => entry.notEmulated === undefined)).toBe(
            true
          )

          const after = emulator.snapshot()

          expect(withoutCountersAndKeptItems(after)).toEqual(withoutCountersAndKeptItems(seed))
          expect(after.counters).toEqual({ nextIssueNumber: 44, nextCommentId: 9000000003 })
          expect(after.deletedComments).toEqual([9000000001, 9000000002])
          expect(
            after.issues
              .filter(issue => issue.createdHere)
              .map(issue => [issue.number, issue.state])
          ).toEqual([
            [42, 'closed'],
            [43, 'closed']
          ])

          expect(yield* Effect.flip(lookup)).toMatchObject({
            _tag: 'GithubConformanceActionFailed',
            status: 400
          })
          expect(emulator.snapshot()).toEqual(after)
        })
      ),
    60_000
  )
})

describe('cross-check B: emulated over a loopback socket', () => {
  it.effect(
    'passes every GitHub case through FetchHttpClient and EmulatedHttpClient',
    () =>
      withEmulators({}, emulators =>
        Effect.gen(function* () {
          const seeds = new Map(
            [...emulators].map(([id, emulator]) => [id, emulator.snapshot()] as const)
          )

          const report = yield* runAll(emulators, { kind: 'emulated' }, emulatedLayer)

          expectAllPassed(report)
          expect(report.target).toEqual({ kind: 'emulated' })

          for (const testCase of githubConformanceCases) {
            const entries = emulatorFor(emulators, testCase.id).ledger.entries()

            expect(entries.length, testCase.id).toBeGreaterThan(0)
            expect(
              entries.every(
                entry => entry.evidence === 'unverified' && entry.notEmulated === undefined
              ),
              testCase.id
            ).toBe(true)
          }

          expectEndsAtSeed(emulators, seeds)
        })
      ),
    60_000
  )
})

const drill = (drills: GithubEmulatorDrills) =>
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
  const drills: ReadonlyArray<readonly [GithubEmulatorDrills, ExpectedFailure]> = [
    [
      { linkOmitsNext: true },
      {
        id: 'github.labels.list-link-paging',
        tag: 'ConformanceMismatch',
        message: 'expected page 2, after a page whose Link lists no rel="next", to answer no labels'
      }
    ],
    [
      { notFoundOmitsDocumentationUrl: true },
      {
        id: 'github.errors.not-found-envelope',
        tag: 'ConformanceMismatch',
        message: 'expected the not-found body to be JSON with a non-empty message'
      }
    ],
    [
      { validationWithoutErrors: true },
      {
        id: 'github.errors.validation-envelope',
        tag: 'ConformanceMismatch',
        message: 'expected the validation body to be JSON with a message and a non-empty errors'
      }
    ],
    [
      { contentUnfolded: true },
      {
        id: 'github.contents.base64-file',
        tag: 'ConformanceMismatch',
        message: 'expected the base64 content to be broken into lines'
      }
    ],
    [
      { sinceExcludesEqual: true },
      {
        id: 'github.comments.create-delete',
        tag: 'ConformanceMismatch',
        message: "expected list_issue_comments since the comment's created_at to list it"
      }
    ],
    [
      { addAnswerOmitsLabel: true },
      {
        id: 'github.labels.add-remove',
        tag: 'ConformanceMismatch',
        message: 'expected add_labels to answer the issue labels including the added label'
      }
    ],
    [
      { closeWithoutClosedAt: true },
      {
        id: 'github.issues.lifecycle-close',
        // The restore closes the issue as not_planned, which no fixture records (not emulated),
        // so the claim failure is reported inside the restore failure.
        tag: 'GithubConformanceRestoreFailed',
        message: 'Claim failed first: expected update_issue to answer the issue closed as compl'
      }
    ]
  ]

  // One drill per case: together they cover every case exactly once.
  it('has one drill per case', () => {
    expect(drills.map(([, failure]) => failure.id)).toEqual(
      githubConformanceCases.map(testCase => testCase.id)
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
