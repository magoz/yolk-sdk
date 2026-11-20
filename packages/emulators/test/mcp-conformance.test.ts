/**
 * Cross-checks: the MCP emulator must satisfy the same `@yolk-sdk/mcp/conformance` cases the
 * replayed synthetic fixtures (and the derived Afloat and synthetic Figma fixtures) satisfy,
 * through the REAL `@yolk-sdk/mcp/client` (the cases run its operations behind their observing
 * client and fail-closed call gate; the Afloat and Figma targets come from the real
 * `afloat.mcp_auth` and `figma.mcp_auth`), per profile,
 * both in-process and over a loopback socket, each case alone and all of them in sequence on one
 * emulator; every case is a read, so each emulator ends at its seed except the legacy sessions the
 * handshakes minted; each drill knob makes exactly its case fail; an SSE answer truncated before
 * its response fails the operation as an `McpError` at the client's timeout, never a hang; and the
 * opt-in `mcp.legacy.server-ping` passes on the synthetic legacy profile under its seed, both
 * in-process and over loopback, with its own drill.
 * Tests may import SDK packages; the emulator source never does.
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
import { McpError } from '@yolk-sdk/mcp/client'
import {
  McpConformanceConfig,
  McpConformanceTarget,
  mcpConformanceCases,
  mcpConformanceFixtureSeeds,
  mcpConformanceInvalidCredential,
  mcpConformanceSyntheticOrigin,
  mcpConformanceSyntheticTarget,
  mcpServerPingCase,
  mcpToolsListCase,
  selectMcpConformanceCases,
  type McpConformanceCase,
  type McpConformanceEra,
  type McpConformanceTargetSettings
} from '@yolk-sdk/mcp/conformance'
import { ApiKeyCredential, OAuthCredential } from '@yolk-sdk/connectors'
import {
  afloatMcpConformanceFixtureSeeds,
  afloatMcpConformanceFixtures,
  afloatMcpConformanceInvalidCredential,
  makeAfloatMcpConformanceTarget
} from '@yolk-sdk/connectors/afloat/conformance'
import { staticCredentialResolverLayer } from '@yolk-sdk/connectors/conformance'
import {
  figmaMcpConformanceFixtureSeeds,
  figmaMcpConformanceFixtures,
  makeFigmaMcpConformanceTarget
} from '@yolk-sdk/connectors/figma/conformance'
import {
  makeMcpEmulator,
  mcpEmulatorAfloatOrigin,
  mcpEmulatorFigmaOrigin,
  mcpEmulatorOrigin,
  type McpEmulator,
  type McpEmulatorDrills,
  type McpEmulatorOptions,
  type McpLedgerEntry
} from '../src/mcp.ts'
import { serveFetchHandler } from '../src/node.ts'
import { EmulatedHttpClient, EmulatorRoute, InProcessHttpClient } from '../src/router.ts'

const now = new Date('2026-10-01T12:00:00.000Z')

/** A synthetic bearer the emulator accepts (never compared with anything but the reserved one). */
const token = 'synthetic-mcp-emulator-token-0001'

const eras: ReadonlyArray<McpConformanceEra> = ['modern', 'legacy']

const targetFor = (
  era: McpConformanceEra,
  overrides: Partial<McpConformanceTargetSettings> = {}
): McpConformanceTargetSettings => ({
  ...mcpConformanceSyntheticTarget(era),
  headers: { authorization: `Bearer ${token}` },
  ...overrides
})

const services = (target: McpConformanceTargetSettings) =>
  Layer.mergeAll(
    Layer.succeed(McpConformanceTarget, target),
    Layer.succeed(McpConformanceConfig, mcpConformanceFixtureSeeds)
  )

const inProcessLayer = (emulator: McpEmulator) =>
  InProcessHttpClient.layer([EmulatorRoute.handler(mcpEmulatorOrigin, emulator.fetch)])

/**
 * Real `FetchHttpClient` underneath; the recorded origin rewritten to a server on 127.0.0.1:0
 * serving the emulator's handler for that origin (the rewrite loses the origin, and every route
 * answers only on the origin its fixtures record).
 */
const emulatedLayer = (emulator: McpEmulator) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const server = yield* serveFetchHandler(emulator.fetchOn(mcpEmulatorOrigin))

      return EmulatedHttpClient.layer([EmulatorRoute.url(mcpEmulatorOrigin, server.url)]).pipe(
        Layer.provide(FetchHttpClient.layer)
      )
    })
  )

type Transport = (emulator: McpEmulator) => Layer.Layer<HttpClient.HttpClient, unknown>

const transports: ReadonlyArray<readonly [ConformanceTarget, Transport]> = [
  [{ kind: 'in-process' }, inProcessLayer],
  [{ kind: 'emulated' }, emulatedLayer]
]

const applicable = (era: McpConformanceEra) =>
  selectMcpConformanceCases(mcpConformanceCases, era).applicable

const withEmulator = <A, E, R>(
  options: McpEmulatorOptions,
  use: (emulator: McpEmulator) => Effect.Effect<A, E, R>
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => makeMcpEmulator(options)),
    use,
    emulator => Effect.promise(() => emulator.close())
  )

/** Run `cases` with one fresh emulator per case (same options); answers the report. */
const runEach = (
  era: McpConformanceEra,
  cases: ReadonlyArray<McpConformanceCase>,
  options: McpEmulatorOptions,
  target: ConformanceTarget,
  transport: Transport,
  check: (id: string, emulator: McpEmulator) => void = () => undefined
) =>
  Effect.gen(function* () {
    const emulators = new Map<string, McpEmulator>()

    const report = yield* runConformance(cases, {
      target,
      now,
      layer: testCase =>
        Layer.unwrap(
          Effect.promise(async () => {
            const emulator = await makeMcpEmulator(options)

            emulators.set(testCase.id, emulator)

            return Layer.mergeAll(transport(emulator), services(targetFor(era)))
          })
        )
    })

    for (const [id, emulator] of emulators) {
      check(id, emulator)
      yield* Effect.promise(() => emulator.close())
    }

    return report
  })

const expectAllPassed = (report: ConformanceReport, count: number) => {
  expect(report.summary, formatConformanceReport(report)).toEqual({
    passed: count,
    failed: 0,
    skipped: 0
  })
}

/** The ledger as `METHOD route status`, never request text. */
const requests = (entries: ReadonlyArray<McpLedgerEntry>) =>
  entries.map(entry => `${entry.method} ${entry.route ?? entry.path} ${entry.status}`)

/** The requests each case sends on a fresh emulator, per era (the standing GET may race). */
const expectedRequests = (era: McpConformanceEra, id: string): ReadonlyArray<string> => {
  const row = (method: string) => `${mcpEmulatorOrigin}/${era}/mcp#${method}`

  const listing =
    era === 'modern'
      ? [`POST ${row('server/discover')} 200`, `POST ${row('tools/list')} 200`]
      : [
          `POST ${row('server/discover')} 400`,
          `POST ${row('initialize')} 200`,
          `POST ${row('notifications/initialized')} 202`,
          `GET ${mcpEmulatorOrigin}/legacy/mcp 405`,
          `POST ${row('tools/list')} 200`
        ]

  const call = (status: number) => [...listing, `POST ${row('tools/call')} ${status}`]
  const absentStatus = era === 'modern' ? 400 : 200

  switch (id) {
    case 'mcp.modern.stateless':
    case 'mcp.errors.unknown-tool':
      return [...listing, ...call(absentStatus)]
    case 'mcp.tools.call-read':
    case 'mcp.tools.call-tool-error':
      return [...listing, ...call(200)]
    case 'mcp.auth.rejected':
      return [`POST ${row('server/discover')} 401`]
    default:
      return listing
  }
}

/** Entries in a canonical order: the standing GET is fire-and-forget, so it may arrive late. */
const sorted = (lines: ReadonlyArray<string>) => [...lines].sort()

/** No bearer, accepted or reserved, ever reaches the ledger, the state, or a control-plane read. */
const expectNoCredential = async (emulator: McpEmulator) => {
  const reads = await Promise.all(
    ['ledger', 'state', 'coverage', 'faults'].map(route =>
      emulator
        .fetch(new Request(`${mcpEmulatorOrigin}/_emulate/${route}`))
        .then(response => response.text())
    )
  )

  const recorded = [
    JSON.stringify(emulator.ledger.entries()),
    JSON.stringify(emulator.snapshot()),
    ...reads
  ].join('\n')

  expect(recorded).not.toContain(token)
  expect(recorded).not.toContain(mcpConformanceInvalidCredential)
  expect(recorded.toLowerCase()).not.toContain('bearer')
}

/** Every case is a read: the state ends at its seed except the sessions the handshakes minted. */
const expectAtSeed = (era: McpConformanceEra, emulator: McpEmulator) => {
  const state = emulator.snapshot()

  expect(state.modernListing).toBe('one-page')

  if (era === 'modern') {
    expect(state.sessions).toEqual([])
  } else {
    expect(state.sessions.every(session => session.phase === 'ready')).toBe(true)
  }
}

describe('the synthetic targets are the emulated profiles', () => {
  it('one origin, the two recorded endpoints', () => {
    expect(mcpConformanceSyntheticOrigin).toBe(mcpEmulatorOrigin)
    expect(mcpConformanceSyntheticTarget('modern').url).toBe(`${mcpEmulatorOrigin}/modern/mcp`)
    expect(mcpConformanceSyntheticTarget('legacy').url).toBe(`${mcpEmulatorOrigin}/legacy/mcp`)
  })
})

for (const era of eras) {
  const cases = applicable(era)

  for (const [target, transport] of transports) {
    describe(`${era} profile, ${target.kind}`, () => {
      it.effect(
        'passes every applicable case, each on a fresh emulator ending at its seed',
        () =>
          Effect.gen(function* () {
            const report = yield* runEach(era, cases, {}, target, transport, (id, emulator) => {
              const entries = emulator.ledger.entries()

              expect(sorted(requests(entries)), id).toEqual(sorted(expectedRequests(era, id)))
              expect(
                entries.every(
                  entry => entry.notEmulated === undefined && entry.evidence === 'unverified'
                ),
                id
              ).toBe(true)
              expectAtSeed(era, emulator)
            })

            expectAllPassed(report, cases.length)
            expect(report.target).toEqual(target)
          }),
        60_000
      )

      it.effect(
        'passes every applicable case twice in sequence on ONE emulator',
        () =>
          withEmulator({}, emulator =>
            Effect.gen(function* () {
              const runOnce = runConformance(cases, {
                target,
                now,
                layer: () => Layer.mergeAll(transport(emulator), services(targetFor(era)))
              })

              expectAllPassed(yield* runOnce, cases.length)
              expectAllPassed(yield* runOnce, cases.length)

              const once = cases.flatMap(testCase => expectedRequests(era, testCase.id))

              expect(sorted(requests(emulator.ledger.entries()))).toEqual(
                sorted([...once, ...once])
              )
              expect(
                emulator.ledger.entries().every(entry => entry.notEmulated === undefined)
              ).toBe(true)
              expectAtSeed(era, emulator)

              // Sessions are minted from one counter: each legacy handshake got its own.
              const sessions = emulator.snapshot().sessions.map(session => session.id)

              expect(new Set(sessions).size).toBe(sessions.length)

              yield* Effect.promise(() => expectNoCredential(emulator))
            })
          ),
        60_000
      )
    })
  }
}

describe('the paged modern listing (seed two-pages)', () => {
  for (const [target, transport] of transports) {
    it.effect(
      `mcp.tools.list follows the recorded cursor (${target.kind}), in every generation`,
      () =>
        withEmulator({ seed: { modernListing: 'two-pages' } }, emulator =>
          Effect.gen(function* () {
            const run = runConformance(applicable('modern'), {
              target,
              now,
              layer: () => Layer.mergeAll(transport(emulator), services(targetFor('modern')))
            })

            expectAllPassed(yield* run, applicable('modern').length)

            const pages = () =>
              emulator.ledger
                .entries()
                .filter(entry => entry.route === `${mcpEmulatorOrigin}/modern/mcp#tools/list`)

            expect(pages().length).toBeGreaterThan(0)
            expect(pages().every(entry => entry.status === 200)).toBe(true)

            // A reset starts a new generation: the cursor is minted, and the client follows it.
            yield* Effect.promise(() => emulator.reset())

            const again = yield* runConformance([mcpToolsListCase], {
              target,
              now,
              layer: () => Layer.mergeAll(transport(emulator), services(targetFor('modern')))
            })

            expectAllPassed(again, 1)
            expect(pages().map(entry => JSON.stringify(entry.body ?? null))).toEqual([
              expect.not.stringContaining('cursor'),
              expect.stringContaining('"cursor":"synthetic-cursor-0001.g2"')
            ])
          })
        ),
      60_000
    )
  }
})

type Drill = {
  readonly knobs: McpEmulatorDrills
  /** Every era whose answers the knob changes. */
  readonly eras: ReadonlyArray<McpConformanceEra>
  readonly id: string
  readonly message: string
}

const drills: ReadonlyArray<Drill> = [
  {
    knobs: { discoverCarriesErrorResponse: true },
    eras: ['modern'],
    id: 'mcp.negotiation.era',
    message: 'expected the era probe answer to select the modern era'
  },
  {
    knobs: { discoverWithoutResultType: true },
    eras: ['modern'],
    id: 'mcp.modern.stateless',
    message: 'expected resultType: "complete" on the result of POST server/discover'
  },
  {
    knobs: { sessionIdNotVisibleAscii: true },
    eras: ['legacy'],
    id: 'mcp.legacy.session',
    message: 'expected the issued mcp-session-id to be visible ASCII'
  },
  {
    knobs: { discoverAnsweredTwice: true },
    eras: ['modern'],
    id: 'mcp.transport.response-encoding',
    message: 'expected the event stream answering POST server/discover to hold its response once'
  },
  {
    knobs: { writeToolMarkedReadOnly: true },
    eras: ['modern', 'legacy'],
    id: 'mcp.tools.list',
    message: 'expected no notReadOnly tool to be marked readOnlyHint: true'
  },
  {
    knobs: { readCallAnswersToolError: true },
    eras: ['modern', 'legacy'],
    id: 'mcp.tools.call-read',
    message: 'expected the read call result to have isError absent or false'
  },
  {
    knobs: { invalidCallAnswersRpcError: true },
    eras: ['modern', 'legacy'],
    id: 'mcp.tools.call-tool-error',
    message:
      'expected invalid arguments to answer a tool result with isError: true, not a JSON-RPC error'
  },
  {
    knobs: { absentCallAnswersResult: true },
    eras: ['modern', 'legacy'],
    id: 'mcp.errors.unknown-tool',
    message: 'expected tools/call of an absent tool not to answer a result'
  },
  {
    knobs: { unauthorizedWithoutChallenge: true },
    eras: ['modern', 'legacy'],
    id: 'mcp.auth.rejected',
    // The runner's message sanitizer redacts the word after `Bearer`.
    message: 'expected the 401 to carry a WWW-Authenticate: Bearer <redacted>'
  }
]

describe('disagreement drills (tests-only knobs): each fails exactly its case', () => {
  it('has one drill per case', () => {
    expect(drills.map(drill => drill.id)).toEqual(mcpConformanceCases.map(testCase => testCase.id))
  })

  for (const drill of drills) {
    for (const era of drill.eras) {
      it.effect(
        `${Object.keys(drill.knobs).join(', ')} fails only ${drill.id} (${era})`,
        () =>
          Effect.gen(function* () {
            const cases = applicable(era)

            const report = yield* runEach(
              era,
              cases,
              { drills: drill.knobs },
              { kind: 'in-process' },
              inProcessLayer
            )

            expect(report.summary, formatConformanceReport(report)).toEqual({
              passed: cases.length - 1,
              failed: 1,
              skipped: 0
            })

            const failed = report.results.filter(result => result.status === 'failed')

            expect(failed.map(result => result.id)).toEqual([drill.id])
            expect(failed[0]?.failure?.tag).toBe('ConformanceMismatch')
            expect(failed[0]?.failure?.message).toContain(drill.message)
          }),
        60_000
      )
    }
  }
})

// The opt-in server ping: the synthetic legacy profile under `legacyInitialize: 'server-ping'`.

const pingOptions: McpEmulatorOptions = { seed: { legacyInitialize: 'server-ping' } }

const pingRow = `${mcpEmulatorOrigin}/legacy/mcp#response:ping`

const sendsCall = (testCase: McpConformanceCase) =>
  expectedRequests('legacy', testCase.id).some(line => line.includes('#tools/call'))

/** The legacy cases that call a tool refuse a pinging server (see below); the others pass. */
const legacyCallingCases = applicable('legacy').filter(sendsCall)

const legacyOtherCases = applicable('legacy').filter(testCase => !sendsCall(testCase))

describe('the opt-in server ping (seed legacyInitialize: server-ping)', () => {
  for (const [target, transport] of transports) {
    it.effect(
      `passes on a fresh emulator: the ping answered once with the recorded 202 (${target.kind})`,
      () =>
        Effect.gen(function* () {
          const report = yield* runEach(
            'legacy',
            [mcpServerPingCase],
            pingOptions,
            target,
            transport,
            (id, emulator) => {
              const entries = emulator.ledger.entries()

              expect(sorted(requests(entries)), id).toEqual(
                sorted([...expectedRequests('legacy', id), `POST ${pingRow} 202`])
              )
              expect(entries.every(entry => entry.notEmulated === undefined)).toBe(true)
              expect(emulator.snapshot().sessions).toEqual([
                { id: 'yolk-emu-session-1', phase: 'ready' }
              ])
            }
          )

          expectAllPassed(report, 1)
        }),
      60_000
    )

    it.effect(
      `the non-calling cases pass beside it, twice on ONE emulator; no credential kept (${target.kind})`,
      () =>
        withEmulator(pingOptions, emulator =>
          Effect.gen(function* () {
            const cases = [mcpServerPingCase, ...legacyOtherCases]

            const runOnce = runConformance(cases, {
              target,
              now,
              layer: () => Layer.mergeAll(transport(emulator), services(targetFor('legacy')))
            })

            expectAllPassed(yield* runOnce, cases.length)
            expectAllPassed(yield* runOnce, cases.length)

            const answers = emulator.ledger.entries().filter(entry => entry.route === pingRow)

            // One ping per handshake (every case but the auth case shakes hands), answered once.
            expect(answers.map(entry => entry.status)).toEqual(
              Array<number>((cases.length - 1) * 2).fill(202)
            )
            expect(
              emulator
                .snapshot()
                .sessions.every(
                  session => session.phase === 'ready' && session.awaitingPingAnswer === undefined
                )
            ).toBe(true)

            yield* Effect.promise(() => expectNoCredential(emulator))
          })
        ),
      60_000
    )
  }

  it.effect(
    'the call gate treats the ping as uncertainty: calling cases refuse with zero forwarded calls',
    () =>
      Effect.gen(function* () {
        const calling = legacyCallingCases

        expect(calling.map(testCase => testCase.id)).toEqual([
          'mcp.tools.call-read',
          'mcp.tools.call-tool-error',
          'mcp.errors.unknown-tool'
        ])

        const report = yield* runEach(
          'legacy',
          calling,
          pingOptions,
          { kind: 'in-process' },
          inProcessLayer,
          (id, emulator) => {
            expect(
              emulator.ledger.entries().some(entry => entry.route?.endsWith('#tools/call')),
              id
            ).toBe(false)
          }
        )

        expect(report.summary.failed, formatConformanceReport(report)).toBe(calling.length)

        for (const result of report.results) {
          expect(result.failure?.message).toContain('uncertain-exchange')
        }
      }),
    60_000
  )

  it.effect(
    'pingAnswerRejected fails only the server ping case',
    () =>
      Effect.gen(function* () {
        const knobs: McpEmulatorDrills = { pingAnswerRejected: true }

        const report = yield* runEach(
          'legacy',
          [mcpServerPingCase, ...legacyOtherCases],
          { ...pingOptions, drills: knobs },
          { kind: 'in-process' },
          inProcessLayer
        )

        const failed = report.results.filter(result => result.status === 'failed')

        expect(failed.map(result => result.id)).toEqual([mcpServerPingCase.id])
        expect(failed[0]?.failure?.tag).toBe('ConformanceMismatch')
        expect(failed[0]?.failure?.message).toContain(
          'expected the server to accept the answer to ping 1 with 202 and an empty body'
        )

        // Without the seed nothing pings, so the knob changes no default legacy case.
        const plain = yield* runEach(
          'legacy',
          applicable('legacy'),
          { drills: knobs },
          { kind: 'in-process' },
          inProcessLayer
        )

        expectAllPassed(plain, applicable('legacy').length)
      }),
    60_000
  )
})

describe('an SSE answer truncated before its response', () => {
  for (const [target, transport] of transports) {
    it.effect(
      `fails the listing as McpError at the timeout, not a hang (${target.kind})`,
      () =>
        withEmulator({}, emulator =>
          Effect.gen(function* () {
            emulator.faults.add({
              kind: 'truncate-after-chunks',
              chunks: 1,
              match: { route: `${mcpEmulatorOrigin}/legacy/mcp#tools/list` },
              count: 1
            })

            const started = Date.now()

            const error = yield* mcpToolsListCase.run.pipe(
              Effect.provide(
                Layer.mergeAll(
                  transport(emulator),
                  services(targetFor('legacy', { timeoutMs: 300 }))
                )
              ),
              Effect.flip
            )

            expect(error).toBeInstanceOf(McpError)
            expect(error).toMatchObject({ cause: 'timeout' })
            expect(Date.now() - started).toBeLessThan(5_000)

            const truncated = emulator.ledger
              .entries()
              .filter(entry => entry.fault === 'truncate-after-chunks')

            expect(truncated.map(entry => [entry.route, entry.status])).toEqual([
              [`${mcpEmulatorOrigin}/legacy/mcp#tools/list`, 200]
            ])
            expect(emulator.faults.list().map(fault => fault.applied)).toEqual([1])
          })
        ),
      30_000
    )
  }
})

// The Afloat profile: the derived Afloat fixtures on `https://useafloat.com/mcp`, the target built
// by running the real `afloat.mcp_auth` action, and the Afloat seeds.

/** A synthetic Afloat key the emulator accepts (`afloat_` and a recognisable remainder). */
const afloatToken = 'afloat_synthetic-mcp-emulator-key-0001'

const afloatServices = Layer.mergeAll(
  Layer.effect(
    McpConformanceTarget,
    makeAfloatMcpConformanceTarget().pipe(
      Effect.provide(staticCredentialResolverLayer(ApiKeyCredential.make({ key: afloatToken })))
    )
  ),
  Layer.succeed(McpConformanceConfig, afloatMcpConformanceFixtureSeeds)
)

const afloatInProcessLayer = (emulator: McpEmulator) =>
  InProcessHttpClient.layer([EmulatorRoute.handler(mcpEmulatorAfloatOrigin, emulator.fetch)])

const afloatEmulatedLayer = (emulator: McpEmulator) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const server = yield* serveFetchHandler(emulator.fetchOn(mcpEmulatorAfloatOrigin))

      return EmulatedHttpClient.layer([
        EmulatorRoute.url(mcpEmulatorAfloatOrigin, server.url)
      ]).pipe(Layer.provide(FetchHttpClient.layer))
    })
  )

const afloatTransports: ReadonlyArray<readonly [ConformanceTarget, Transport]> = [
  [{ kind: 'in-process' }, afloatInProcessLayer],
  [{ kind: 'emulated' }, afloatEmulatedLayer]
]

/** The requests each case sends to the Afloat profile on a fresh emulator. */
const afloatExpectedRequests = (id: string): ReadonlyArray<string> => {
  const row = (method: string) => `${mcpEmulatorAfloatOrigin}/mcp#${method}`
  const listing = [`POST ${row('server/discover')} 200`, `POST ${row('tools/list')} 200`]
  const call = [...listing, `POST ${row('tools/call')} 200`]

  switch (id) {
    case 'mcp.modern.stateless':
    case 'mcp.errors.unknown-tool':
    case 'mcp.tools.call-read':
    case 'mcp.tools.call-tool-error':
      return [...listing, ...call]
    case 'mcp.auth.rejected':
      return [`POST ${row('server/discover')} 401`]
    default:
      return listing
  }
}

const afloatCases = applicable('modern')

const runAfloat = (
  cases: ReadonlyArray<McpConformanceCase>,
  options: McpEmulatorOptions,
  target: ConformanceTarget,
  transport: Transport,
  check: (id: string, emulator: McpEmulator) => void = () => undefined
) =>
  Effect.gen(function* () {
    const emulators = new Map<string, McpEmulator>()

    const report = yield* runConformance(cases, {
      target,
      now,
      layer: testCase =>
        Layer.unwrap(
          Effect.promise(async () => {
            const emulator = await makeMcpEmulator(options)

            emulators.set(testCase.id, emulator)

            return Layer.mergeAll(transport(emulator), afloatServices)
          })
        )
    })

    for (const [id, emulator] of emulators) {
      check(id, emulator)
      yield* Effect.promise(() => emulator.close())
    }

    return report
  })

describe('the Afloat profile is the provider endpoint', () => {
  it('the derived fixtures cover every case of the modern era', () => {
    expect(afloatMcpConformanceFixtures.map(fixture => fixture.caseId)).toEqual(
      afloatCases.map(testCase => testCase.id)
    )
    expect(new Set(afloatMcpConformanceFixtures.map(fixture => fixture.endpoint))).toEqual(
      new Set([`${mcpEmulatorAfloatOrigin}/mcp`])
    )
  })
})

for (const [target, transport] of afloatTransports) {
  describe(`Afloat profile, ${target.kind}`, () => {
    it.effect(
      'passes every applicable case, each on a fresh emulator, statelessly',
      () =>
        Effect.gen(function* () {
          const report = yield* runAfloat(afloatCases, {}, target, transport, (id, emulator) => {
            const entries = emulator.ledger.entries()

            expect(requests(entries), id).toEqual(afloatExpectedRequests(id))
            expect(
              entries.every(
                entry => entry.notEmulated === undefined && entry.evidence === 'unverified'
              ),
              id
            ).toBe(true)
            expect(emulator.snapshot()).toEqual({
              modernListing: 'one-page',
              legacyInitialize: 'plain',
              sessions: []
            })
          })

          expectAllPassed(report, afloatCases.length)
        }),
      60_000
    )

    it.effect(
      'passes every applicable case twice in sequence on ONE emulator; no key is kept',
      () =>
        withEmulator({}, emulator =>
          Effect.gen(function* () {
            const runOnce = runConformance(afloatCases, {
              target,
              now,
              layer: () => Layer.mergeAll(transport(emulator), afloatServices)
            })

            expectAllPassed(yield* runOnce, afloatCases.length)
            expectAllPassed(yield* runOnce, afloatCases.length)

            const once = afloatCases.flatMap(testCase => afloatExpectedRequests(testCase.id))

            expect(requests(emulator.ledger.entries())).toEqual([...once, ...once])

            const reads = yield* Effect.promise(() =>
              Promise.all(
                ['ledger', 'state', 'coverage', 'faults'].map(route =>
                  emulator
                    .fetch(new Request(`${mcpEmulatorAfloatOrigin}/_emulate/${route}`))
                    .then(response => response.text())
                )
              )
            )

            const recorded = [
              JSON.stringify(emulator.ledger.entries()),
              JSON.stringify(emulator.snapshot()),
              ...reads
            ].join('\n')

            expect(recorded).not.toContain(afloatToken.slice('afloat_'.length))
            expect(recorded).not.toContain(afloatMcpConformanceInvalidCredential.slice(7))
            expect(recorded.toLowerCase()).not.toContain('bearer')
          })
        ),
      60_000
    )
  })
}

const afloatDrills = drills.filter(drill => drill.eras.includes('modern'))

describe('Afloat profile disagreement drills: each fails exactly its case', () => {
  it('has one drill per applicable case', () => {
    expect(afloatDrills.map(drill => drill.id)).toEqual(afloatCases.map(testCase => testCase.id))
  })

  for (const drill of afloatDrills) {
    it.effect(
      `${Object.keys(drill.knobs).join(', ')} fails only ${drill.id} (afloat)`,
      () =>
        Effect.gen(function* () {
          const report = yield* runAfloat(
            afloatCases,
            { drills: drill.knobs },
            { kind: 'in-process' },
            afloatInProcessLayer
          )

          expect(report.summary, formatConformanceReport(report)).toEqual({
            passed: afloatCases.length - 1,
            failed: 1,
            skipped: 0
          })

          const failed = report.results.filter(result => result.status === 'failed')

          expect(failed.map(result => result.id)).toEqual([drill.id])
          expect(failed[0]?.failure?.tag).toBe('ConformanceMismatch')
          expect(failed[0]?.failure?.message).toContain(drill.message)
        }),
      60_000
    )
  }
})

// The Figma profile: the synthetic Figma fixtures on `https://mcp.figma.com/mcp` (the legacy era),
// the target built by running the real `figma.mcp_auth` action, and the Figma seeds.

/** A synthetic Figma access token the emulator accepts (the plain recognisable-bearer rule). */
const figmaToken = 'synthetic-figma-emulator-token-0001'

const figmaServices = Layer.mergeAll(
  Layer.effect(
    McpConformanceTarget,
    makeFigmaMcpConformanceTarget().pipe(
      Effect.provide(
        staticCredentialResolverLayer(
          OAuthCredential.make({
            provider: 'figma',
            accessToken: figmaToken,
            expiresAt: 1_900_000_000_000
          })
        )
      )
    )
  ),
  Layer.succeed(McpConformanceConfig, figmaMcpConformanceFixtureSeeds)
)

const figmaInProcessLayer = (emulator: McpEmulator) =>
  InProcessHttpClient.layer([EmulatorRoute.handler(mcpEmulatorFigmaOrigin, emulator.fetch)])

const figmaEmulatedLayer = (emulator: McpEmulator) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const server = yield* serveFetchHandler(emulator.fetchOn(mcpEmulatorFigmaOrigin))

      return EmulatedHttpClient.layer([EmulatorRoute.url(mcpEmulatorFigmaOrigin, server.url)]).pipe(
        Layer.provide(FetchHttpClient.layer)
      )
    })
  )

const figmaTransports: ReadonlyArray<readonly [ConformanceTarget, Transport]> = [
  [{ kind: 'in-process' }, figmaInProcessLayer],
  [{ kind: 'emulated' }, figmaEmulatedLayer]
]

/** The requests each case sends to the Figma profile on a fresh emulator (the GET may race). */
const figmaExpectedRequests = (id: string): ReadonlyArray<string> => {
  const row = (method: string) => `${mcpEmulatorFigmaOrigin}/mcp#${method}`

  const listing = [
    `POST ${row('server/discover')} 400`,
    `POST ${row('initialize')} 200`,
    `POST ${row('notifications/initialized')} 202`,
    `GET ${mcpEmulatorFigmaOrigin}/mcp 405`,
    `POST ${row('tools/list')} 200`
  ]

  const call = [...listing, `POST ${row('tools/call')} 200`]

  switch (id) {
    case 'mcp.errors.unknown-tool':
    case 'mcp.tools.call-read':
    case 'mcp.tools.call-tool-error':
      return [...listing, ...call]
    case 'mcp.auth.rejected':
      return [`POST ${row('server/discover')} 401`]
    default:
      return listing
  }
}

const figmaCases = applicable('legacy')

const runFigma = (
  cases: ReadonlyArray<McpConformanceCase>,
  options: McpEmulatorOptions,
  target: ConformanceTarget,
  transport: Transport,
  check: (id: string, emulator: McpEmulator) => void = () => undefined
) =>
  Effect.gen(function* () {
    const emulators = new Map<string, McpEmulator>()

    const report = yield* runConformance(cases, {
      target,
      now,
      layer: testCase =>
        Layer.unwrap(
          Effect.promise(async () => {
            const emulator = await makeMcpEmulator(options)

            emulators.set(testCase.id, emulator)

            return Layer.mergeAll(transport(emulator), figmaServices)
          })
        )
    })

    for (const [id, emulator] of emulators) {
      check(id, emulator)
      yield* Effect.promise(() => emulator.close())
    }

    return report
  })

/** No bearer, accepted or reserved, ever reaches a Figma emulator's records. */
const expectNoFigmaCredential = async (emulator: McpEmulator) => {
  const reads = await Promise.all(
    ['ledger', 'state', 'coverage', 'faults'].map(route =>
      emulator
        .fetch(new Request(`${mcpEmulatorFigmaOrigin}/_emulate/${route}`))
        .then(response => response.text())
    )
  )

  const recorded = [
    JSON.stringify(emulator.ledger.entries()),
    JSON.stringify(emulator.snapshot()),
    ...reads
  ].join('\n')

  expect(recorded).not.toContain(figmaToken)
  expect(recorded).not.toContain(mcpConformanceInvalidCredential)
  expect(recorded.toLowerCase()).not.toContain('bearer')
}

describe('the Figma profile is the provider endpoint', () => {
  it('the synthetic fixtures cover every case of the legacy era', () => {
    expect(figmaMcpConformanceFixtures.map(fixture => fixture.caseId)).toEqual(
      figmaCases.map(testCase => testCase.id)
    )
    expect(new Set(figmaMcpConformanceFixtures.map(fixture => fixture.endpoint))).toEqual(
      new Set([`${mcpEmulatorFigmaOrigin}/mcp`])
    )
  })
})

for (const [target, transport] of figmaTransports) {
  describe(`Figma profile, ${target.kind}`, () => {
    it.effect(
      'passes every applicable case, each on a fresh emulator; only Figma sessions are minted',
      () =>
        Effect.gen(function* () {
          const report = yield* runFigma(figmaCases, {}, target, transport, (id, emulator) => {
            const entries = emulator.ledger.entries()

            expect(sorted(requests(entries)), id).toEqual(sorted(figmaExpectedRequests(id)))
            expect(
              entries.every(
                entry => entry.notEmulated === undefined && entry.evidence === 'unverified'
              ),
              id
            ).toBe(true)

            const state = emulator.snapshot()

            expect(state.modernListing).toBe('one-page')
            expect(
              state.sessions.every(
                session => session.phase === 'ready' && session.profile === 'figma'
              ),
              id
            ).toBe(true)
          })

          expectAllPassed(report, figmaCases.length)
        }),
      60_000
    )

    it.effect(
      'passes every applicable case twice in sequence on ONE emulator; no token is kept',
      () =>
        withEmulator({}, emulator =>
          Effect.gen(function* () {
            const runOnce = runConformance(figmaCases, {
              target,
              now,
              layer: () => Layer.mergeAll(transport(emulator), figmaServices)
            })

            expectAllPassed(yield* runOnce, figmaCases.length)
            expectAllPassed(yield* runOnce, figmaCases.length)

            const once = figmaCases.flatMap(testCase => figmaExpectedRequests(testCase.id))

            expect(sorted(requests(emulator.ledger.entries()))).toEqual(sorted([...once, ...once]))

            yield* Effect.promise(() => expectNoFigmaCredential(emulator))
          })
        ),
      60_000
    )
  })
}

const figmaDrills = drills.filter(drill => drill.eras.includes('legacy'))

describe('Figma profile disagreement drills: each fails exactly its case', () => {
  it('has a drill for every legacy case the emulator can drill alone', () => {
    // Every case starts with the era probe and a listing, so no knob can break only
    // mcp.negotiation.era or mcp.transport.response-encoding on a legacy profile (as on the
    // synthetic legacy profile); the replayed fixtures drill those two in the connectors tests.
    expect(figmaDrills.map(drill => drill.id)).toEqual(
      figmaCases
        .map(testCase => testCase.id)
        .filter(id => id !== 'mcp.negotiation.era' && id !== 'mcp.transport.response-encoding')
    )
  })

  for (const drill of figmaDrills) {
    it.effect(
      `${Object.keys(drill.knobs).join(', ')} fails only ${drill.id} (figma)`,
      () =>
        Effect.gen(function* () {
          const report = yield* runFigma(
            figmaCases,
            { drills: drill.knobs },
            { kind: 'in-process' },
            figmaInProcessLayer
          )

          expect(report.summary, formatConformanceReport(report)).toEqual({
            passed: figmaCases.length - 1,
            failed: 1,
            skipped: 0
          })

          const failed = report.results.filter(result => result.status === 'failed')

          expect(failed.map(result => result.id)).toEqual([drill.id])
          expect(failed[0]?.failure?.tag).toBe('ConformanceMismatch')
          expect(failed[0]?.failure?.message).toContain(drill.message)
        }),
      60_000
    )
  }
})
