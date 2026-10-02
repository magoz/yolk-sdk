/**
 * Cross-checks: the MCP emulator must satisfy the same `@yolk-sdk/mcp/conformance` cases the
 * replayed synthetic fixtures (and the derived Afloat fixtures) satisfy, through the REAL
 * `@yolk-sdk/mcp/client` (the cases run its operations behind their observing client and
 * fail-closed call gate; the Afloat target comes from the real `afloat.mcp_auth`), per profile,
 * both in-process and over a loopback socket, each case alone and all of them in sequence on one
 * emulator; every case is a read, so each emulator ends at its seed except the legacy sessions the
 * handshakes minted; each drill knob makes exactly its case fail; and an SSE answer truncated
 * before its response fails the operation as an `McpError` at the client's timeout, never a hang.
 * Tests may import SDK packages; the emulator source never does.
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
import { McpError } from '@yolk-sdk/mcp/client'
import {
  McpConformanceConfig,
  McpConformanceTarget,
  mcpConformanceCases,
  mcpConformanceFixtureSeeds,
  mcpConformanceInvalidCredential,
  mcpConformanceSyntheticOrigin,
  mcpConformanceSyntheticTarget,
  mcpToolsListCase,
  selectMcpConformanceCases,
  type McpConformanceCase,
  type McpConformanceEra,
  type McpConformanceTargetSettings
} from '@yolk-sdk/mcp/conformance'
import { ApiKeyCredential } from '@yolk-sdk/connectors'
import {
  afloatMcpConformanceFixtureSeeds,
  afloatMcpConformanceFixtures,
  afloatMcpConformanceInvalidCredential,
  makeAfloatMcpConformanceTarget
} from '@yolk-sdk/connectors/afloat/conformance'
import { staticCredentialResolverLayer } from '@yolk-sdk/connectors/conformance'
import {
  makeMcpEmulator,
  mcpEmulatorAfloatOrigin,
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
            expect(emulator.snapshot()).toEqual({ modernListing: 'one-page', sessions: [] })
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
