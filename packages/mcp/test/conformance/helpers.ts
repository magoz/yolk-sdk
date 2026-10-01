import { Effect, Layer, Predicate, Ref } from 'effect'
import { HttpClient } from 'effect/unstable/http'
import type { ConformanceCase } from '@yolk-sdk/conformance/case'
import {
  isWireStreamResponse,
  type WireChunk,
  type WireExchange,
  type WireFixture,
  type WireResponse
} from '@yolk-sdk/conformance/fixture'
import {
  makeReplayHttpClient,
  type ReplayHttpClientOptions,
  type ReplayLedgerApi
} from '@yolk-sdk/conformance/replay'
import {
  McpConformanceConfig,
  McpConformanceTarget,
  mcpConformanceFixtureSeeds,
  mcpConformanceFixtures,
  mcpConformanceSyntheticTarget,
  mcpSyntheticFixture,
  type McpConformanceEra,
  type McpConformanceSeeds,
  type McpConformanceTargetSettings
} from '../../src/conformance/index.ts'

export const eraOf = (fixture: WireFixture): McpConformanceEra =>
  fixture.id.endsWith('.modern.synthetic') ? 'modern' : 'legacy'

export const fixturesFor = (
  testCase: Pick<ConformanceCase<unknown, unknown>, 'fixtures'>,
  era?: McpConformanceEra
) =>
  mcpConformanceFixtures.filter(
    fixture =>
      testCase.fixtures.includes(fixture.id) && (era === undefined || eraOf(fixture) === era)
  )

export const caseServices = (
  target: McpConformanceTargetSettings,
  seeds: McpConformanceSeeds = mcpConformanceFixtureSeeds
) =>
  Layer.mergeAll(
    Layer.succeed(McpConformanceTarget, target),
    Layer.succeed(McpConformanceConfig, seeds)
  )

/**
 * A replay layer over `fixtures` plus the synthetic target of `era` (with `target` overrides) and
 * the fixture seeds (or `seeds`); when `ledger` is given, the replay ledger is stored in it.
 */
export const replayLayer = (
  fixtures: ReadonlyArray<WireFixture>,
  era: McpConformanceEra,
  options: {
    readonly replay?: ReplayHttpClientOptions
    readonly target?: Partial<McpConformanceTargetSettings>
    readonly seeds?: McpConformanceSeeds
    readonly ledger?: Ref.Ref<ReplayLedgerApi | undefined>
  } = {}
) =>
  Layer.mergeAll(
    Layer.unwrap(
      makeReplayHttpClient(fixtures, options.replay).pipe(
        Effect.tap(({ ledger }) =>
          options.ledger === undefined ? Effect.void : Ref.set(options.ledger, ledger)
        ),
        Effect.map(({ client }) => Layer.succeed(HttpClient.HttpClient, client))
      )
    ),
    caseServices({ ...mcpConformanceSyntheticTarget(era), ...options.target }, options.seeds)
  )

/** A copy of `fixture` with exchange `index` changed by `f` (a drill). */
export const withExchange = (
  fixture: WireFixture,
  index: number,
  f: (exchange: WireExchange) => WireExchange
): WireFixture => {
  const [first, ...rest] = fixture.exchanges.map((exchange, at) =>
    at === index ? f(exchange) : exchange
  )

  if (first === undefined) {
    throw new Error('empty fixture')
  }

  return { ...fixture, exchanges: [first, ...rest] }
}

/** A copy of `fixture` whose exchange `index` answers `response`. */
export const withResponse = (fixture: WireFixture, index: number, response: WireResponse) =>
  withExchange(fixture, index, exchange => ({ ...exchange, response }))

/** Index of the last exchange whose JSON-RPC method is `method`. */
export const lastIndexOf = (fixture: WireFixture, method: string): number =>
  fixture.exchanges.findLastIndex(exchange => {
    const body = exchange.request.body

    return Predicate.hasProperty(body, 'method') && body.method === method
  })

/** A copy of `fixture` with every streamed answer's chunks changed by `f`. */
export const withStreams = (
  fixture: WireFixture,
  f: (chunks: ReadonlyArray<WireChunk>, index: number) => ReadonlyArray<WireChunk>
): WireFixture => {
  const [first, ...rest] = fixture.exchanges.map((exchange, index) =>
    isWireStreamResponse(exchange.response)
      ? {
          ...exchange,
          response: { ...exchange.response, chunks: [...f(exchange.response.chunks, index)] }
        }
      : exchange
  )

  if (first === undefined) {
    throw new Error('empty fixture')
  }

  return { ...fixture, exchanges: [first, ...rest] }
}

/** A test-only fixture (not committed) from exchanges, for drills and passing variants. */
export const drillFixture = (
  caseId: string,
  era: McpConformanceEra,
  exchanges: ReadonlyArray<WireExchange>
): WireFixture => mcpSyntheticFixture({ caseId, era, note: 'Test variant.', exchanges })

/** The JSON-RPC methods of the requests a replay ledger saw, in arrival order. */
export const ledgerMethods = (ledger: Ref.Ref<ReplayLedgerApi | undefined>) =>
  Effect.gen(function* () {
    const api = yield* Ref.get(ledger)

    if (api === undefined) {
      return []
    }

    return (yield* api.entries).map(entry =>
      Predicate.hasProperty(entry.bodyJson, 'method') ? String(entry.bodyJson.method) : entry.method
    )
  })
