/**
 * The opt-in `mcp.legacy.server-ping` case: replay on the synthetic legacy server (exact
 * requests), disagreement drills, passing variants of real SDK behaviour, and the default listing
 * cases against a pinging server. It does not run in-process against `makeMcpToolServer`: the
 * client negotiates the modern era with that server (no `ping` in `2026-07-28`), and the server
 * never pings. The emulator's cross-checks (`@yolk-sdk/emulators`, `test/mcp-conformance.test.ts`)
 * run it in-process and over loopback against the synthetic legacy profile.
 */
import { Effect, Predicate, Ref, type Layer } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import {
  decodeWireFixture,
  isWireStreamResponse,
  scanFixtureForSecrets,
  type WireExchange,
  type WireFixture
} from '@yolk-sdk/conformance/fixture'
import type { ReplayLedgerApi } from '@yolk-sdk/conformance/replay'
import { formatConformanceReport, runConformance } from '@yolk-sdk/conformance/runner'
import {
  legacyListingExchanges,
  legacyServerPingListingExchanges,
  mcpConformanceCases,
  mcpConformanceFixtures,
  mcpConformanceServerPingFixtures,
  mcpConformanceServerPingRequestId,
  mcpLegacySessionCase,
  mcpNegotiationEraCase,
  mcpResponseEncodingCase,
  mcpServerPingCase,
  mcpServerPingLegacyFixture,
  mcpToolsListCase,
  type McpConformanceCase,
  type McpConformanceRequirements
} from '../../src/conformance/index.ts'
import { drillFixture, replayLayer, withResponse } from './helpers.ts'

const now = new Date('2026-10-01T12:00:00.000Z')

const caseId = mcpServerPingCase.id

/** Index of the client's answer to the server ping (a POST body without `method`). */
const pingAnswerIndex = mcpServerPingLegacyFixture.exchanges.findIndex(
  exchange =>
    Predicate.hasProperty(exchange.request.body, 'result') &&
    !Predicate.hasProperty(exchange.request.body, 'method')
)

const run = (
  cases: ReadonlyArray<McpConformanceCase>,
  fixtures: ReadonlyArray<WireFixture>,
  layer: Layer.Layer<McpConformanceRequirements>
) =>
  runConformance(cases, {
    target: { kind: 'replay' },
    now,
    fixtures,
    layer: () => layer
  })

const runCase = (fixture: WireFixture, era: 'modern' | 'legacy' = 'legacy') =>
  run([mcpServerPingCase], [fixture], replayLayer([fixture], era))

/** The ping fixture with the server's ping (and so the client's answer) under another id. */
const withPingId = (id: string | number): WireFixture => {
  const exchanges: ReadonlyArray<WireExchange> = legacyServerPingListingExchanges().map(
    (exchange, index) => {
      if (index === pingAnswerIndex) {
        return {
          ...exchange,
          request: { ...exchange.request, body: { result: {}, jsonrpc: '2.0', id } }
        }
      }

      const response = exchange.response
      const recordedId = JSON.stringify(mcpConformanceServerPingRequestId)

      return isWireStreamResponse(response)
        ? {
            ...exchange,
            response: {
              ...response,
              chunks: response.chunks.map(chunk =>
                Predicate.isString(chunk) ? chunk.replace(recordedId, JSON.stringify(id)) : chunk
              )
            }
          }
        : exchange
    }
  )

  return drillFixture(caseId, 'legacy', exchanges)
}

describe('mcp.legacy.server-ping (opt-in)', () => {
  it.effect('is a read case outside the default suite, with one synthetic legacy fixture', () =>
    Effect.gen(function* () {
      expect(mcpServerPingCase.safety).toBe('read')
      expect(mcpServerPingCase.observed).toBeUndefined()
      expect(mcpConformanceCases).not.toContain(mcpServerPingCase)
      expect(mcpServerPingCase.fixtures).toEqual(
        mcpConformanceServerPingFixtures.map(fixture => fixture.id)
      )
      expect(mcpConformanceServerPingFixtures).toEqual([mcpServerPingLegacyFixture])
      expect(mcpConformanceFixtures).not.toContain(mcpServerPingLegacyFixture)
      expect((yield* decodeWireFixture(mcpServerPingLegacyFixture)).caseId).toBe(caseId)
      expect(scanFixtureForSecrets(mcpServerPingLegacyFixture)).toEqual([])
      expect(mcpServerPingLegacyFixture).toMatchObject({
        id: 'mcp.legacy.server-ping.legacy.synthetic',
        evidence: 'unverified',
        account: 'synthetic',
        endpoint: 'https://mcp.example.test/legacy/mcp'
      })
      expect(mcpServerPingLegacyFixture.note).toContain('MCP 2025-11-25')
      expect(pingAnswerIndex).toBe(2)
    })
  )

  it.effect('passes on the synthetic legacy server, sending exactly the fixture requests', () =>
    Effect.gen(function* () {
      const fixture = mcpServerPingLegacyFixture
      const report = yield* runCase(fixture)

      expect(report.summary, formatConformanceReport(report)).toEqual({
        passed: 1,
        failed: 0,
        skipped: 0
      })

      const ledger = yield* Ref.make<ReplayLedgerApi | undefined>(undefined)

      yield* mcpServerPingCase.run.pipe(
        Effect.provide(replayLayer([fixture], 'legacy', { ledger }))
      )

      const api = yield* Ref.get(ledger)

      if (api === undefined) return expect.fail('no ledger')

      expect(yield* api.remaining).toEqual([])

      const entries = yield* api.entries

      for (const [index, entry] of entries.entries()) {
        if (entry.match.outcome !== 'matched') {
          return expect.fail(`unmatched ${entry.method} ${entry.url}`)
        }

        // The fixture order is the order the client sends: the ping answer before initialized.
        expect(entry.match.exchangeIndex).toBe(index)

        const exchange = fixture.exchanges[entry.match.exchangeIndex]

        expect(entry.bodyJson).toEqual(exchange?.request.body)
        // The headers the fixture records are the MCP ones the client sends, exactly.
        expect(
          Object.fromEntries(
            Object.entries(entry.headers).filter(
              ([name]) => name === 'accept' || name === 'content-type' || name.startsWith('mcp-')
            )
          )
        ).toEqual(exchange?.request.headers)
      }
    })
  )

  it.effect('fails when the server rejects the answer to its ping', () =>
    Effect.gen(function* () {
      const rejected = withResponse(mcpServerPingLegacyFixture, pingAnswerIndex, {
        status: 400,
        headers: {},
        body: ''
      })

      const report = yield* runCase(rejected)

      expect(report.summary.failed, formatConformanceReport(report)).toBe(1)
      expect(formatConformanceReport(report)).toContain('202')
    })
  )

  it.effect('fails when the server answers the ping answer 202 with a body', () =>
    Effect.gen(function* () {
      const withBody = withResponse(mcpServerPingLegacyFixture, pingAnswerIndex, {
        status: 202,
        headers: { 'content-type': 'application/json' },
        body: '{}'
      })

      const report = yield* runCase(withBody)

      expect(report.summary.failed, formatConformanceReport(report)).toBe(1)
    })
  )

  it.effect('fails its precondition on a server that never pings', () =>
    Effect.gen(function* () {
      const plain = drillFixture(caseId, 'legacy', legacyListingExchanges())
      const report = yield* runCase(plain)

      expect(report.summary.failed, formatConformanceReport(report)).toBe(1)
      expect(formatConformanceReport(report)).toContain('precondition: no answer')
    })
  )

  it.effect('fails its precondition on a modern target before any request', () =>
    Effect.gen(function* () {
      const report = yield* runCase(mcpServerPingLegacyFixture, 'modern')

      expect(report.summary.failed, formatConformanceReport(report)).toBe(1)
      expect(formatConformanceReport(report)).toContain('needs a legacy target')
    })
  )

  for (const id of [7, 'ping 0001'] as const) {
    it.effect(`passes when the server pings with id ${JSON.stringify(id)} (echoed as sent)`, () =>
      Effect.gen(function* () {
        const report = yield* runCase(withPingId(id))

        expect(report.summary, formatConformanceReport(report)).toEqual({
          passed: 1,
          failed: 0,
          skipped: 0
        })
      })
    )
  }

  it.effect('the client answers the ping on a POST without mcp-protocol-version', () =>
    Effect.gen(function* () {
      const answer = mcpServerPingLegacyFixture.exchanges[pingAnswerIndex]

      expect(answer?.request.headers).toEqual({
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-session-id': 'yolk-synthetic-session-0001'
      })
      expect(answer?.request.body).toEqual({
        result: {},
        jsonrpc: '2.0',
        id: mcpConformanceServerPingRequestId
      })
    })
  )

  it.effect('the default listing cases pass against the pinging server', () =>
    Effect.gen(function* () {
      const cases = [
        mcpNegotiationEraCase,
        mcpLegacySessionCase,
        mcpResponseEncodingCase,
        mcpToolsListCase
      ]

      // Without skipping client-sent responses, `mcp.transport.response-encoding` read the 202 to
      // the ping answer as an answer to a request and failed.
      for (const testCase of cases) {
        const fixture = drillFixture(testCase.id, 'legacy', legacyServerPingListingExchanges())
        const report = yield* run([testCase], [fixture], replayLayer([fixture], 'legacy'))

        expect(report.summary, `${testCase.id}\n${formatConformanceReport(report)}`).toEqual({
          passed: 1,
          failed: 0,
          skipped: 0
        })
      }
    })
  )
})
