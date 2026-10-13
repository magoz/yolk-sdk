/**
 * The opt-in `mcp.elicitation.declaration` case: replay on both synthetic servers (exact
 * requests), disagreement drills, and the case against yolk's own tool server in-process.
 */
import { Effect, Layer, Predicate, Ref } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/http'
import { describe, expect, it } from '@effect/vitest'
import { ToolDef, ToolResult } from '@yolk-sdk/agent/protocol'
import { decodeWireFixture, scanFixtureForSecrets } from '@yolk-sdk/conformance/fixture'
import type { ReplayLedgerApi } from '@yolk-sdk/conformance/replay'
import { formatConformanceReport, runConformance } from '@yolk-sdk/conformance/runner'
import {
  mcpConformanceCases,
  mcpConformanceElicitationFixtures,
  mcpConformanceFixtures,
  mcpElicitationDeclarationCase,
  mcpElicitationDeclarationLegacyFixture,
  mcpElicitationDeclarationModernFixture,
  modernListingExchanges,
  type McpConformanceEra,
  type McpConformanceRequirements
} from '../../src/conformance/index.ts'
import { makeMcpToolServer } from '../../src/server/index.ts'
import {
  caseServices,
  drillFixture,
  eraOf,
  lastIndexOf,
  replayLayer,
  withResponse
} from './helpers.ts'

const now = new Date('2026-10-01T12:00:00.000Z')

const caseId = mcpElicitationDeclarationCase.id

const fixtureOf = (era: McpConformanceEra) =>
  era === 'modern' ? mcpElicitationDeclarationModernFixture : mcpElicitationDeclarationLegacyFixture

const runCase = (layer: Layer.Layer<McpConformanceRequirements>) =>
  runConformance([mcpElicitationDeclarationCase], {
    target: { kind: 'replay' },
    now,
    fixtures: mcpConformanceElicitationFixtures,
    layer: () => layer
  })

describe('mcp.elicitation.declaration (opt-in)', () => {
  it.effect('is a read case outside the default suite, with synthetic fixtures', () =>
    Effect.gen(function* () {
      expect(mcpElicitationDeclarationCase.safety).toBe('read')
      expect(mcpElicitationDeclarationCase.observed).toBeUndefined()
      expect(mcpConformanceCases).not.toContain(mcpElicitationDeclarationCase)
      expect(mcpElicitationDeclarationCase.fixtures).toEqual(
        mcpConformanceElicitationFixtures.map(fixture => fixture.id)
      )

      for (const fixture of mcpConformanceElicitationFixtures) {
        expect(mcpConformanceFixtures).not.toContain(fixture)
        expect((yield* decodeWireFixture(fixture)).caseId).toBe(caseId)
        expect(scanFixtureForSecrets(fixture), fixture.id).toEqual([])
        expect(fixture).toMatchObject({ evidence: 'unverified', account: 'synthetic' })
      }

      expect(mcpConformanceElicitationFixtures.map(eraOf)).toEqual(['modern', 'legacy'])
    })
  )

  for (const era of ['modern', 'legacy'] as const) {
    it.effect(`passes on the synthetic ${era} server, sending exactly the fixture requests`, () =>
      Effect.gen(function* () {
        const fixture = fixtureOf(era)
        const report = yield* runCase(replayLayer([fixture], era))

        expect(report.summary, formatConformanceReport(report)).toEqual({
          passed: 1,
          failed: 0,
          skipped: 0
        })

        const ledger = yield* Ref.make<ReplayLedgerApi | undefined>(undefined)

        yield* mcpElicitationDeclarationCase.run.pipe(
          Effect.provide(replayLayer([fixture], era, { ledger }))
        )

        const api = yield* Ref.get(ledger)

        if (api === undefined) return expect.fail('no ledger')

        expect(yield* api.remaining).toEqual([])

        for (const entry of yield* api.entries) {
          if (entry.match.outcome !== 'matched') {
            return expect.fail(`unmatched ${entry.method} ${entry.url}`)
          }

          expect(entry.bodyJson).toEqual(fixture.exchanges[entry.match.exchangeIndex]?.request.body)
        }
      })
    )
  }

  it.effect('the modern fixture pins the declaration: a plain listing differs from it', () =>
    Effect.gen(function* () {
      const plain = drillFixture(caseId, 'modern', modernListingExchanges())
      const ledger = yield* Ref.make<ReplayLedgerApi | undefined>(undefined)

      yield* mcpElicitationDeclarationCase.run.pipe(
        Effect.provide(replayLayer([plain], 'modern', { ledger }))
      )

      const api = yield* Ref.get(ledger)

      if (api === undefined) return expect.fail('no ledger')

      const listed = (yield* api.entries).at(-1)
      const index = lastIndexOf(plain, 'tools/list')

      expect(listed?.bodyJson).not.toEqual(plain.exchanges[index]?.request.body)
      expect(listed?.bodyJson).toEqual(
        mcpElicitationDeclarationModernFixture.exchanges[index]?.request.body
      )
    })
  )

  it.effect('fails when the server rejects the declared listing', () =>
    Effect.gen(function* () {
      const fixture = mcpElicitationDeclarationModernFixture
      const index = lastIndexOf(fixture, 'tools/list')

      const rejected = withResponse(fixture, index, {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 0,
          error: { code: -32_602, message: 'Invalid client capabilities' }
        })
      })

      const report = yield* runCase(replayLayer([rejected], 'modern'))

      expect(report.summary.failed, formatConformanceReport(report)).toBe(1)
    })
  )

  it.effect('passes in-process against makeMcpToolServer (modern)', () =>
    Effect.gen(function* () {
      const server = makeMcpToolServer({
        name: 'yolk-in-process',
        version: '0.0.0',
        tools: [
          {
            def: ToolDef.make({
              name: 'get_synthetic_note',
              description: 'Read one synthetic note by id.',
              parameters: { type: 'object', properties: { noteId: { type: 'string' } } }
            }),
            execute: call =>
              Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'Synthetic note.' }))
          }
        ]
      })

      const requests: Array<unknown> = []

      const http = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(request =>
          Effect.gen(function* () {
            const body = Predicate.isTagged(request.body, 'Uint8Array')
              ? new TextDecoder().decode(request.body.body)
              : undefined

            requests.push(body)

            const response = yield* server.handleHttpRequest(
              new Request(request.url, { method: request.method, headers: request.headers, body })
            )

            return HttpClientResponse.fromWeb(request, response)
          })
        )
      )

      const report = yield* runCase(
        Layer.mergeAll(
          http,
          caseServices({
            name: 'in_process',
            url: 'https://mcp.example.test/mcp',
            headers: {},
            era: 'modern',
            protocolVersion: '2026-07-28',
            timeoutMs: 5_000
          })
        )
      )

      expect(report.summary, formatConformanceReport(report)).toEqual({
        passed: 1,
        failed: 0,
        skipped: 0
      })
      expect(requests.length).toBeGreaterThan(1)
    })
  )
})
