import { Effect, Predicate, Ref } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import {
  decodeWireFixture,
  isWireStreamResponse,
  scanFixtureForSecrets
} from '@yolk-sdk/conformance/fixture'
import { WireFault, type ReplayLedgerApi } from '@yolk-sdk/conformance/replay'
import {
  conformanceReportFailed,
  formatConformanceReport,
  runConformance
} from '@yolk-sdk/conformance/runner'
import { McpError } from '../../src/client/index.ts'
import {
  mcpConformanceCaseEra,
  mcpConformanceCases,
  mcpConformanceFixtures,
  mcpConformanceSyntheticLegacyUrl,
  mcpObservedRequestHeaders,
  mcpToolsListCase,
  mcpToolsListLegacyFixture,
  selectMcpConformanceCases,
  type McpConformanceEra
} from '../../src/conformance/index.ts'
import { eraOf, fixturesFor, replayLayer } from './helpers.ts'

const now = new Date('2026-10-01T12:00:00.000Z')

const eras: ReadonlyArray<McpConformanceEra> = ['modern', 'legacy']

const caseCount = mcpConformanceCases.length

/** Request headers a fixture records: the observed MCP headers plus the session header. */
const fixtureRequestHeaders = [...mcpObservedRequestHeaders, 'mcp-session-id']

describe('MCP conformance cases', () => {
  it('are nine read-only, unverified cases backed by synthetic fixtures', () => {
    expect(mcpConformanceCases.map(testCase => testCase.id)).toEqual([
      'mcp.negotiation.era',
      'mcp.modern.stateless',
      'mcp.legacy.session',
      'mcp.transport.response-encoding',
      'mcp.tools.list',
      'mcp.tools.call-read',
      'mcp.tools.call-tool-error',
      'mcp.errors.unknown-tool',
      'mcp.auth.rejected'
    ])
    expect(mcpConformanceFixtures).toHaveLength(16)
    expect(new Set(mcpConformanceFixtures.map(fixture => fixture.id)).size).toBe(16)

    for (const testCase of mcpConformanceCases) {
      expect(testCase.safety).toBe('read')
      expect(testCase.observed).toBeUndefined()

      const era = mcpConformanceCaseEra(testCase.id)
      const fixtures = fixturesFor(testCase)

      expect(fixtures.map(fixture => fixture.id)).toEqual(testCase.fixtures)
      expect(fixtures.map(fixture => fixture.caseId)).toEqual(fixtures.map(() => testCase.id))
      expect(fixtures.map(eraOf)).toEqual(era === undefined ? ['modern', 'legacy'] : [era])
    }

    expect(mcpConformanceFixtures.flatMap(fixture => [fixture.id])).toEqual(
      mcpConformanceCases.flatMap(testCase => testCase.fixtures)
    )
  })

  it.effect('fixtures decode, pass the shared secret scan, and stay synthetic', () =>
    Effect.gen(function* () {
      for (const fixture of mcpConformanceFixtures) {
        expect((yield* decodeWireFixture(fixture)).id).toBe(fixture.id)
        expect(scanFixtureForSecrets(fixture), fixture.id).toEqual([])
        expect(fixture).toMatchObject({ evidence: 'unverified', account: 'synthetic' })
        expect(fixture.endpoint).toBe(`https://mcp.example.test/${eraOf(fixture)}/mcp`)

        for (const { request, response } of fixture.exchanges) {
          expect(request.url).toBe(fixture.endpoint)
          expect(
            Object.keys(request.headers ?? {}).every(name => fixtureRequestHeaders.includes(name))
          ).toBe(true)

          for (const sessionId of [
            request.headers?.['mcp-session-id'],
            response.headers['mcp-session-id']
          ]) {
            if (sessionId !== undefined) {
              expect(sessionId).toMatch(/^yolk-synthetic-session-\d{4}$/)
            }
          }

          // Modern answers JSON, legacy answers to requests SSE.
          if (eraOf(fixture) === 'modern') {
            expect(isWireStreamResponse(response)).toBe(false)
          }
        }
      }

      const serialized = JSON.stringify(mcpConformanceFixtures)

      expect(serialized).not.toMatch(/"authorization"/i)
      expect(serialized).not.toContain('yolk-conformance-invalid-credential')
    })
  )

  it('filter by era: one era-specific case is not applicable per era', () => {
    expect(selectMcpConformanceCases(mcpConformanceCases, 'modern').notApplicable).toEqual([
      { id: 'mcp.legacy.session', reason: 'needs a legacy target; this target is modern' }
    ])
    expect(selectMcpConformanceCases(mcpConformanceCases, 'legacy').notApplicable).toEqual([
      { id: 'mcp.modern.stateless', reason: 'needs a modern target; this target is legacy' }
    ])
    expect(selectMcpConformanceCases(mcpConformanceCases, 'legacy').applicable).toHaveLength(
      caseCount - 1
    )
  })

  for (const era of eras) {
    it.effect(`all pass on the synthetic ${era} server with unverified warnings`, () =>
      Effect.gen(function* () {
        const { applicable } = selectMcpConformanceCases(mcpConformanceCases, era)

        const report = yield* runConformance(applicable, {
          target: { kind: 'replay' },
          now,
          fixtures: mcpConformanceFixtures,
          layer: testCase => replayLayer(fixturesFor(testCase, era), era)
        })

        expect(report.summary, formatConformanceReport(report)).toEqual({
          passed: caseCount - 1,
          failed: 0,
          skipped: 0
        })
        expect(conformanceReportFailed(report)).toBe(false)
        expect(report.results.map(result => result.warnings)).toEqual(
          applicable.map(testCase => [
            { kind: 'unverified-case' },
            ...testCase.fixtures.map(fixtureId => ({ kind: 'unverified-fixture', fixtureId }))
          ])
        )
      })
    )

    it.effect(`send exactly the ${era} fixture requests, in the SDK's order`, () =>
      Effect.gen(function* () {
        for (const testCase of selectMcpConformanceCases(mcpConformanceCases, era).applicable) {
          const [fixture] = fixturesFor(testCase, era)
          const ledger = yield* Ref.make<ReplayLedgerApi | undefined>(undefined)

          if (fixture === undefined) {
            return expect.fail(`no ${era} fixture for ${testCase.id}`)
          }

          yield* testCase.run.pipe(Effect.provide(replayLayer([fixture], era, { ledger })))

          const api = yield* Ref.get(ledger)

          if (api === undefined) {
            return expect.fail('no ledger')
          }

          expect(yield* api.remaining, testCase.id).toEqual([])

          const entries = yield* api.entries

          expect(entries).toHaveLength(fixture.exchanges.length)

          for (const entry of entries) {
            if (entry.match.outcome !== 'matched') {
              return expect.fail(`${testCase.id}: unmatched ${entry.method} ${entry.url}`)
            }

            const recorded = fixture.exchanges[entry.match.exchangeIndex]?.request
            const label = `${testCase.id} #${entry.match.exchangeIndex}`

            expect(entry.bodyJson, label).toEqual(recorded?.body)

            for (const name of fixtureRequestHeaders) {
              expect(entry.headers[name], `${label} ${name}`).toBe(recorded?.headers?.[name])
            }

            // The credential header is redacted in the ledger and never recorded.
            expect(entry.headers['authorization'] ?? '<redacted>').toBe('<redacted>')
          }

          // Requests on one key arrive in fixture order.
          const postIndexes = entries
            .filter(entry => entry.method === 'POST')
            .map(entry => (entry.match.outcome === 'matched' ? entry.match.exchangeIndex : -1))

          expect(postIndexes, testCase.id).toEqual([...postIndexes].sort((a, b) => a - b))
        }
      })
    )
  }
})

describe('MCP conformance faults', () => {
  it.live('an SSE answer truncated before its response fails at the timeout, not a hang', () =>
    Effect.gen(function* () {
      const ledger = yield* Ref.make<ReplayLedgerApi | undefined>(undefined)
      const started = Date.now()

      const error = yield* mcpToolsListCase.run.pipe(
        Effect.provide(
          replayLayer([mcpToolsListLegacyFixture], 'legacy', {
            ledger,
            target: { timeoutMs: 300 },
            replay: {
              faults: [
                // POST attempts: discover, initialize, initialized, then tools/list (4).
                WireFault.TruncateAfterChunks({
                  match: { method: 'POST', url: mcpConformanceSyntheticLegacyUrl },
                  attempt: 4,
                  chunks: 1
                })
              ]
            }
          })
        ),
        Effect.flip
      )

      expect(error).toBeInstanceOf(McpError)
      expect(error).toMatchObject({ cause: 'timeout' })
      expect(Date.now() - started).toBeLessThan(3_000)

      const entries = (yield* Ref.get(ledger))?.entries

      if (entries === undefined) {
        return expect.fail('no ledger')
      }

      expect((yield* entries).map(entry => entry.fault).filter(Predicate.isNotUndefined)).toEqual([
        'TruncateAfterChunks'
      ])
    })
  )
})
