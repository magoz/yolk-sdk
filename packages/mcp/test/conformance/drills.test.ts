/**
 * Disagreement drills (each case fails for its intended reason) and passing variants that pin the
 * pinned SDK's real behaviour, all through the real `@yolk-sdk/mcp/client` over replay.
 */
import { Effect, Layer, Predicate, Ref } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/unstable/http'
import { describe, expect, it } from '@effect/vitest'
import {
  isWireStreamResponse,
  type WireExchange,
  type WireFixture,
  type WireResponse
} from '@yolk-sdk/conformance/fixture'
import type { ReplayLedgerApi } from '@yolk-sdk/conformance/replay'
import { formatConformanceReport, runConformance } from '@yolk-sdk/conformance/runner'
import { McpError } from '../../src/client/index.ts'
import {
  legacyListingExchanges,
  legacySseAnswer,
  mcpAuthRejectedCase,
  mcpAuthRejectedModernFixture,
  mcpCallReadCase,
  mcpCallReadModernFixture,
  mcpCallToolErrorCase,
  mcpCallToolErrorLegacyFixture,
  mcpConformanceCases,
  mcpConformanceDiscoverRequestId,
  mcpConformanceModernDiscoverResult,
  mcpConformanceSyntheticCursor,
  mcpConformanceSyntheticReadTool,
  mcpConformanceSyntheticTarget,
  mcpConformanceSyntheticTools,
  mcpConformanceSyntheticWriteTool,
  mcpConformanceUnauthorizedAnswer,
  mcpLegacySessionCase,
  mcpLegacySessionFixture,
  mcpModernStatelessCase,
  mcpModernStatelessFixture,
  mcpNegotiationEraCase,
  mcpNegotiationEraModernFixture,
  mcpResponseEncodingCase,
  mcpResponseEncodingLegacyFixture,
  mcpToolsListCase,
  mcpToolsListModernFixture,
  mcpUnknownToolCase,
  mcpUnknownToolLegacyFixture,
  mcpUnknownToolModernFixture,
  modernCallExchanges,
  modernListingExchanges,
  selectMcpConformanceCases,
  type McpConformanceCase,
  type McpConformanceEra
} from '../../src/conformance/index.ts'
import { encodeMcpParamValue } from '../../src/conformance/param-value.ts'
import {
  caseServices,
  drillFixture,
  eraOf,
  fixturesFor,
  lastIndexOf,
  ledgerMethods,
  replayLayer,
  withExchange,
  withResponse,
  withStreams
} from './helpers.ts'

const now = new Date('2026-10-01T12:00:00.000Z')

const jsonAnswer = (status: number, message: object): WireResponse => ({
  status,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(message)
})

const jsonResult = (id: string | number, result: object) =>
  jsonAnswer(200, { jsonrpc: '2.0', id, result })

const toolsPage = (tools: ReadonlyArray<object>, nextCursor?: string) => {
  const page = { tools, resultType: 'complete', ttlMs: 0, cacheScope: 'private' }

  return nextCursor === undefined ? page : { ...page, nextCursor }
}

const unsupportedVersion = (data?: object) => {
  const error = { code: -32_022, message: 'Unsupported protocol version' }

  return jsonAnswer(400, {
    jsonrpc: '2.0',
    id: mcpConformanceDiscoverRequestId,
    error: data === undefined ? error : { ...error, data }
  })
}

/** The default absent tool, listed plainly. */
const plainAbsentTool = { name: 'yolk_conformance_absent', inputSchema: { type: 'object' } }

/** The default absent tool with an invalid `x-mcp-header`: the modern SDK filters it out. */
const filteredAbsentTool = {
  name: 'yolk_conformance_absent',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string', 'x-mcp-header': 'not a token' } }
  }
}

/** The precondition mismatch of a call the observer's gate refused, for `reason`. */
const refusedMessage = (reason: string) =>
  `precondition: the call operation's own wire evidence does not prove the call safe (${reason}); the observer did not forward tools/call`

/** The case's failure against `fixture` (fails the test when the case passes). */
const failureAgainst = (
  testCase: McpConformanceCase,
  fixture: WireFixture,
  options: Parameters<typeof replayLayer>[2] = {}
) => testCase.run.pipe(Effect.provide(replayLayer([fixture], eraOf(fixture), options)), Effect.flip)

/** Run the case against `fixture`; fails the test when the case fails. */
const passAgainst = (
  testCase: McpConformanceCase,
  fixture: WireFixture,
  era: McpConformanceEra = eraOf(fixture),
  options: Parameters<typeof replayLayer>[2] = {}
) => testCase.run.pipe(Effect.provide(replayLayer([fixture], era, options)))

/** Legacy exchanges whose era probe answers `response` instead of the 400 JSON-RPC error. */
const legacyAfterProbe = (response: WireResponse): ReadonlyArray<WireExchange> =>
  legacyListingExchanges().map((exchange, index) =>
    index === 0 ? { ...exchange, response } : exchange
  )

describe('mcp.negotiation.era (the SDK auto negotiation)', () => {
  it.effect('fails a modern target whose discover result does not list 2026-07-28', () =>
    Effect.gen(function* () {
      const drill = withResponse(
        mcpNegotiationEraModernFixture,
        0,
        jsonResult(mcpConformanceDiscoverRequestId, {
          ...mcpConformanceModernDiscoverResult,
          supportedVersions: ['2099-01-01']
        })
      )

      const error = yield* failureAgainst(mcpNegotiationEraCase, drill)

      expect(error.message).toBe('expected the era probe answer to select the modern era')
    })
  )

  it.effect('fails on a 5xx probe answer', () =>
    Effect.gen(function* () {
      const error = yield* failureAgainst(
        mcpNegotiationEraCase,
        withResponse(mcpNegotiationEraModernFixture, 0, { status: 503, headers: {}, body: '' })
      )

      expect(error.message).toBe('expected the era probe never to be answered 5xx')
    })
  )

  it.effect('fails on -32022 listing only modern versions the client does not speak', () =>
    Effect.gen(function* () {
      const error = yield* failureAgainst(
        mcpNegotiationEraCase,
        withResponse(
          mcpNegotiationEraModernFixture,
          0,
          unsupportedVersion({ supported: ['2099-01-01'] })
        )
      )

      expect(error.message).toBe(
        'expected the era probe not to answer UnsupportedProtocolVersion (-32022) listing only modern versions this client does not speak'
      )
    })
  )

  it.effect('passes a legacy fallback from a discover result without a mutual version', () =>
    passAgainst(
      mcpNegotiationEraCase,
      drillFixture(
        'mcp.negotiation.era',
        'legacy',
        legacyAfterProbe(
          jsonResult(mcpConformanceDiscoverRequestId, {
            ...mcpConformanceModernDiscoverResult,
            supportedVersions: ['2099-01-01']
          })
        )
      )
    )
  )

  it.effect('passes a legacy fallback from a discover result invalid for the 2026 schema', () =>
    passAgainst(
      mcpNegotiationEraCase,
      drillFixture(
        'mcp.negotiation.era',
        'legacy',
        legacyAfterProbe(
          jsonResult(mcpConformanceDiscoverRequestId, { supportedVersions: ['2026-07-28'] })
        )
      )
    )
  )

  it.effect('passes a legacy fallback from -32022 listing only legacy versions, or no data', () =>
    Effect.gen(function* () {
      for (const answer of [
        unsupportedVersion({ supported: ['2025-11-25', '2025-06-18'] }),
        unsupportedVersion()
      ]) {
        yield* passAgainst(
          mcpNegotiationEraCase,
          drillFixture('mcp.negotiation.era', 'legacy', legacyAfterProbe(answer))
        )
      }
    })
  )

  it.effect('passes one corrective retry: -32022 listing 2026-07-28, then a modern probe', () =>
    Effect.gen(function* () {
      const [discover, ...rest] = modernListingExchanges()

      if (discover === undefined) {
        return expect.fail('no discover exchange')
      }

      const retryId = 'server-discover-probe-2'

      const ledger = yield* Ref.make<ReplayLedgerApi | undefined>(undefined)

      yield* passAgainst(
        mcpNegotiationEraCase,
        drillFixture('mcp.negotiation.era', 'modern', [
          { ...discover, response: unsupportedVersion({ supported: ['2026-07-28'] }) },
          {
            ...discover,
            response: jsonResult(retryId, mcpConformanceModernDiscoverResult)
          },
          ...rest
        ]),
        'modern',
        { ledger }
      )

      expect(yield* ledgerMethods(ledger)).toEqual([
        'server/discover',
        'server/discover',
        'tools/list'
      ])
    })
  )
})

describe('mcp.modern.stateless', () => {
  it.effect('fails when an answer carries a session id', () =>
    Effect.gen(function* () {
      const index = lastIndexOf(mcpModernStatelessFixture, 'tools/list')

      const drill = withExchange(mcpModernStatelessFixture, index, exchange => ({
        ...exchange,
        response: {
          ...exchange.response,
          headers: { ...exchange.response.headers, 'mcp-session-id': 'yolk-synthetic-session-0002' }
        }
      }))

      const error = yield* failureAgainst(mcpModernStatelessCase, drill)

      expect(error.message).toBe('expected no mcp-session-id on the answer to POST tools/list')
    })
  )

  it.effect('refuses, with zero tools/call, when absentToolName is listed', () =>
    Effect.gen(function* () {
      const ledger = yield* Ref.make<ReplayLedgerApi | undefined>(undefined)

      const error = yield* failureAgainst(mcpModernStatelessCase, mcpModernStatelessFixture, {
        ledger,
        seeds: { absentToolName: 'create_synthetic_note' }
      })

      expect(error.message).toBe('precondition: the listing contains absentToolName')
      expect(yield* ledgerMethods(ledger)).toEqual(['server/discover', 'tools/list'])
    })
  )

  it.effect(
    'refuses, with zero tools/call, an absent name listed with an invalid x-mcp-header',
    () =>
      Effect.gen(function* () {
        const ledger = yield* Ref.make<ReplayLedgerApi | undefined>(undefined)

        const error = yield* failureAgainst(
          mcpModernStatelessCase,
          withResponse(
            mcpModernStatelessFixture,
            1,
            jsonResult(0, toolsPage([...mcpConformanceSyntheticTools, filteredAbsentTool]))
          ),
          { ledger }
        )

        expect(error.message).toBe('precondition: the listing contains absentToolName')
        expect(yield* ledgerMethods(ledger)).toEqual(['server/discover', 'tools/list'])
      })
  )

  it.effect("refuses at the wire when only the call operation's own listing names the tool", () =>
    Effect.gen(function* () {
      for (const absent of [plainAbsentTool, filteredAbsentTool]) {
        const ledger = yield* Ref.make<ReplayLedgerApi | undefined>(undefined)

        const error = yield* failureAgainst(
          mcpModernStatelessCase,
          withResponse(
            mcpModernStatelessFixture,
            lastIndexOf(mcpModernStatelessFixture, 'tools/list'),
            jsonResult(0, toolsPage([...mcpConformanceSyntheticTools, absent]))
          ),
          { ledger }
        )

        expect(error.message).toBe(refusedMessage('tool-listed'))
        expect(yield* ledgerMethods(ledger)).toEqual([
          'server/discover',
          'tools/list',
          'server/discover',
          'tools/list'
        ])
      }
    })
  )

  it.effect('fails when the call answers result: null', () =>
    Effect.gen(function* () {
      const drill = withResponse(
        mcpModernStatelessFixture,
        lastIndexOf(mcpModernStatelessFixture, 'tools/call'),
        jsonAnswer(200, { jsonrpc: '2.0', id: 1, result: null })
      )

      const error = yield* failureAgainst(mcpModernStatelessCase, drill)

      expect(error.message).toBe('expected the result of POST tools/call to be an object')
    })
  )

  it.effect('passes a non-ASCII absent name, sent as an encoded mcp-name', () =>
    Effect.gen(function* () {
      const name = 'yolk_conformance_ausente_é'
      const ledger = yield* Ref.make<ReplayLedgerApi | undefined>(undefined)

      yield* passAgainst(
        mcpModernStatelessCase,
        drillFixture('mcp.modern.stateless', 'modern', [
          ...modernListingExchanges(),
          ...modernCallExchanges(
            { name, arguments: {} },
            { kind: 'error', status: 400, code: -32_602, message: 'Unknown tool' }
          )
        ]),
        'modern',
        { ledger, seeds: { absentToolName: name } }
      )

      const entries = yield* (yield* Ref.get(ledger))?.entries ?? Effect.succeed([])
      const call = entries.find(entry => entry.headers['mcp-method'] === 'tools/call')

      expect(call?.headers['mcp-name']).toBe(encodeMcpParamValue(name))
      expect(call?.headers['mcp-name']).toBe(
        `=?base64?${Buffer.from(name, 'utf8').toString('base64')}?=`
      )
    })
  )
})

describe('mcp.legacy.session', () => {
  it.effect('fails when initialized is not answered 202', () =>
    Effect.gen(function* () {
      const drill = withResponse(
        mcpLegacySessionFixture,
        lastIndexOf(mcpLegacySessionFixture, 'notifications/initialized'),
        { status: 200, headers: {}, body: '' }
      )

      const error = yield* failureAgainst(mcpLegacySessionCase, drill)

      expect(error.message).toBe(
        'expected notifications/initialized to get 202 with an empty body ([status, body length])'
      )
    })
  )
})

/** The priming event the official server's `writePrimingEvent` sends first (empty data). */
const primingEvent = 'id: evt-0\ndata: \n\n'

describe('mcp.transport.response-encoding (the SDK SSE event selection)', () => {
  it.effect('fails when a message event the client reads is not JSON', () =>
    Effect.gen(function* () {
      const drill = withStreams(mcpResponseEncodingLegacyFixture, (chunks, index) =>
        index === lastIndexOf(mcpResponseEncodingLegacyFixture, 'tools/list')
          ? ['event: message\ndata: not json\n\n', ...chunks]
          : chunks
      )

      const error = yield* failureAgainst(mcpResponseEncodingCase, drill)

      expect(error.message).toBe(
        'expected every message event of the answer to POST tools/list to be JSON'
      )
    })
  )

  it.effect('passes a priming first event (empty data), as the official server sends', () =>
    passAgainst(
      mcpResponseEncodingCase,
      withStreams(mcpResponseEncodingLegacyFixture, chunks => [primingEvent, ...chunks])
    )
  )

  it.effect('passes events of another type (not read by the client) and trailing notices', () =>
    passAgainst(
      mcpResponseEncodingCase,
      withStreams(mcpResponseEncodingLegacyFixture, chunks => [
        'event: heartbeat\ndata: keepalive\n\n',
        ...chunks,
        'event: message\nid: evt-3\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"late"}}\n\n'
      ])
    )
  )

  it.effect('passes an unterminated final block, which the client never dispatches', () =>
    passAgainst(
      mcpResponseEncodingCase,
      withStreams(mcpResponseEncodingLegacyFixture, chunks => [...chunks, 'data: not json'])
    )
  )

  it.effect('every legacy case passes with a priming event before every SSE answer', () =>
    Effect.gen(function* () {
      const { applicable } = selectMcpConformanceCases(mcpConformanceCases, 'legacy')

      const report = yield* runConformance(applicable, {
        target: { kind: 'replay' },
        now,
        layer: testCase =>
          replayLayer(
            fixturesFor(testCase, 'legacy').map(fixture =>
              withStreams(fixture, chunks => [primingEvent, ...chunks])
            ),
            'legacy'
          )
      })

      expect(report.summary, formatConformanceReport(report)).toEqual({
        passed: applicable.length,
        failed: 0,
        skipped: 0
      })
    })
  )
})

describe('mcp.tools.list', () => {
  it('replays a two-page modern listing', () => {
    expect(
      mcpToolsListModernFixture.exchanges.filter(
        exchange =>
          Predicate.hasProperty(exchange.request.body, 'method') &&
          exchange.request.body.method === 'tools/list'
      )
    ).toHaveLength(2)
  })

  it.effect('fails on a repeated cursor (the SDK stops paging silently)', () =>
    Effect.gen(function* () {
      const drill = withResponse(
        mcpToolsListModernFixture,
        2,
        jsonResult(1, toolsPage([mcpConformanceSyntheticWriteTool], mcpConformanceSyntheticCursor))
      )

      const error = yield* failureAgainst(mcpToolsListCase, drill)

      expect(error.message).toBe(
        'expected no repeated cursor (page 2 repeats an earlier nextCursor)'
      )
    })
  )

  const invalidHeaderTool = {
    ...mcpConformanceSyntheticWriteTool,
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', 'x-mcp-header': 'not a token' } }
    }
  }

  it.effect('fails when the SDK silently drops a tool with an invalid x-mcp-header', () =>
    Effect.gen(function* () {
      const drill = withResponse(
        mcpToolsListModernFixture,
        2,
        jsonResult(1, toolsPage([invalidHeaderTool]))
      )

      const error = yield* failureAgainst(mcpToolsListCase, drill)

      expect(error.message).toBe(
        'expected listed tools and McpResolvedTools to correspond one to one (listed 2, resolved 1; silently dropped: page 2 tool 1)'
      )
    })
  )

  it.effect('fails a duplicate whose filtered copy would otherwise match the survivor', () =>
    Effect.gen(function* () {
      const drill = withResponse(
        mcpToolsListModernFixture,
        2,
        jsonResult(1, toolsPage([mcpConformanceSyntheticWriteTool, invalidHeaderTool]))
      )

      const error = yield* failureAgainst(mcpToolsListCase, drill)

      expect(error.message).toBe(
        'expected listed tools and McpResolvedTools to correspond one to one (listed 3, resolved 2; silently dropped: page 2 tool 2)'
      )
    })
  )

  it.effect('fails when the server does not advertise capabilities.tools', () =>
    Effect.gen(function* () {
      const { capabilities: _capabilities, ...withoutTools } = mcpConformanceModernDiscoverResult

      const drill = withResponse(
        mcpToolsListModernFixture,
        0,
        jsonResult(mcpConformanceDiscoverRequestId, { ...withoutTools, capabilities: {} })
      )

      const error = yield* failureAgainst(mcpToolsListCase, drill)

      expect(error.message).toBe(
        'expected the discover result to advertise capabilities.tools (without it the client lists nothing)'
      )
    })
  )

  it.effect('reports the client failure first when the handshake is refused', () =>
    Effect.gen(function* () {
      const error = yield* failureAgainst(
        mcpToolsListCase,
        withResponse(mcpToolsListModernFixture, 0, mcpConformanceUnauthorizedAnswer)
      )

      expect(error).toBeInstanceOf(McpError)
      expect(error).toMatchObject({ cause: 'transport' })
    })
  )

  it.effect('passes an annotation key the SDK does not model (it strips it)', () =>
    passAgainst(
      mcpToolsListCase,
      withResponse(
        mcpToolsListModernFixture,
        1,
        jsonResult(
          0,
          toolsPage(
            [
              {
                ...mcpConformanceSyntheticReadTool,
                annotations: { readOnlyHint: true, 'x-example': 1 }
              }
            ],
            mcpConformanceSyntheticCursor
          )
        )
      )
    )
  )
})

describe('mcp.tools.call-read and mcp.tools.call-tool-error', () => {
  it.effect('call-read fails when structuredContent breaks the output schema', () =>
    Effect.gen(function* () {
      const drill = withResponse(
        mcpCallReadModernFixture,
        lastIndexOf(mcpCallReadModernFixture, 'tools/call'),
        jsonResult(1, {
          content: [{ type: 'text', text: 'Synthetic note note-0001.' }],
          structuredContent: { noteId: 1 },
          resultType: 'complete'
        })
      )

      const error = yield* failureAgainst(mcpCallReadCase, drill)

      expect(error).toBeInstanceOf(McpError)
      expect(error.message).toMatch(/Structured content does not match the tool's output schema/)
    })
  )

  it.effect('call-read refuses, with zero tools/call, a tool not marked read-only', () =>
    Effect.gen(function* () {
      const notReadOnly = {
        ...mcpConformanceSyntheticReadTool,
        annotations: { readOnlyHint: false }
      }

      const ledger = yield* Ref.make<ReplayLedgerApi | undefined>(undefined)

      const error = yield* failureAgainst(
        mcpCallReadCase,
        withResponse(
          mcpCallReadModernFixture,
          1,
          jsonResult(0, toolsPage([notReadOnly, mcpConformanceSyntheticWriteTool]))
        ),
        { ledger }
      )

      expect(error.message).toBe(
        'precondition: the listing does not mark readTool readOnlyHint: true'
      )
      expect(yield* ledgerMethods(ledger)).not.toContain('tools/call')
    })
  )

  it.effect('call-tool-error fails when invalid arguments answer a JSON-RPC error', () =>
    Effect.gen(function* () {
      const drill = withResponse(
        mcpCallToolErrorLegacyFixture,
        lastIndexOf(mcpCallToolErrorLegacyFixture, 'tools/call'),
        legacySseAnswer({
          jsonrpc: '2.0',
          id: 2,
          error: { code: -32_602, message: 'Invalid params' }
        })
      )

      const error = yield* failureAgainst(mcpCallToolErrorCase, drill)

      expect(error.message).toBe(
        'expected invalid arguments to answer a tool result with isError: true, not a JSON-RPC error'
      )
    })
  )
})

describe('mcp.errors.unknown-tool', () => {
  it.effect('fails when the absent tool answers a result', () =>
    Effect.gen(function* () {
      const drill = withResponse(
        mcpUnknownToolModernFixture,
        lastIndexOf(mcpUnknownToolModernFixture, 'tools/call'),
        jsonResult(1, {
          content: [{ type: 'text', text: 'No such tool.' }],
          isError: true,
          resultType: 'complete'
        })
      )

      const error = yield* failureAgainst(mcpUnknownToolCase, drill)

      expect(error.message).toBe('expected tools/call of an absent tool not to answer a result')
    })
  )

  it.effect('refuses, with zero tools/call, when absentToolName is listed', () =>
    Effect.gen(function* () {
      const ledger = yield* Ref.make<ReplayLedgerApi | undefined>(undefined)

      const error = yield* failureAgainst(mcpUnknownToolCase, mcpUnknownToolModernFixture, {
        ledger,
        seeds: { absentToolName: 'create_synthetic_note' }
      })

      expect(error.message).toBe('precondition: the listing contains absentToolName')
      expect(yield* ledgerMethods(ledger)).toEqual(['server/discover', 'tools/list'])
    })
  )
})

describe('mcp.errors.unknown-tool at the wire', () => {
  it.effect(
    'refuses, with zero tools/call, an absent name listed with an invalid x-mcp-header',
    () =>
      Effect.gen(function* () {
        const ledger = yield* Ref.make<ReplayLedgerApi | undefined>(undefined)

        const error = yield* failureAgainst(
          mcpUnknownToolCase,
          withResponse(
            mcpUnknownToolModernFixture,
            1,
            jsonResult(0, toolsPage([...mcpConformanceSyntheticTools, filteredAbsentTool]))
          ),
          { ledger }
        )

        expect(error.message).toBe('precondition: the listing contains absentToolName')
        expect(yield* ledgerMethods(ledger)).toEqual(['server/discover', 'tools/list'])
      })
  )

  it.effect("refuses at the wire when only the call operation's own listing names the tool", () =>
    Effect.gen(function* () {
      for (const absent of [plainAbsentTool, filteredAbsentTool]) {
        const ledger = yield* Ref.make<ReplayLedgerApi | undefined>(undefined)

        const error = yield* failureAgainst(
          mcpUnknownToolCase,
          withResponse(
            mcpUnknownToolModernFixture,
            lastIndexOf(mcpUnknownToolModernFixture, 'tools/list'),
            jsonResult(0, toolsPage([...mcpConformanceSyntheticTools, absent]))
          ),
          { ledger }
        )

        expect(error.message).toBe(refusedMessage('tool-listed'))
        expect(yield* ledgerMethods(ledger)).not.toContain('tools/call')
      }
    })
  )

  it.effect('refuses at the wire over a legacy SSE listing too', () =>
    Effect.gen(function* () {
      const ledger = yield* Ref.make<ReplayLedgerApi | undefined>(undefined)

      const error = yield* failureAgainst(
        mcpUnknownToolCase,
        withResponse(
          mcpUnknownToolLegacyFixture,
          lastIndexOf(mcpUnknownToolLegacyFixture, 'tools/list'),
          legacySseAnswer({
            jsonrpc: '2.0',
            id: 1,
            result: { tools: [...mcpConformanceSyntheticTools, plainAbsentTool] }
          })
        ),
        { ledger }
      )

      expect(error.message).toBe(refusedMessage('tool-listed'))
      expect(yield* ledgerMethods(ledger)).not.toContain('tools/call')
    })
  )
})

describe('header values never corrupt the evidence', () => {
  for (const era of ['modern', 'legacy'] satisfies ReadonlyArray<McpConformanceEra>) {
    it.effect(`every ${era} case passes with target headers that collide with wire values`, () =>
      Effect.gen(function* () {
        const { applicable } = selectMcpConformanceCases(mcpConformanceCases, era)

        const report = yield* runConformance(applicable, {
          target: { kind: 'replay' },
          now,
          layer: testCase =>
            replayLayer(fixturesFor(testCase, era), era, {
              target: {
                headers: {
                  'x-client-tag': '2026-07-28',
                  'x-team-id': '12345678',
                  'x-note-id': '42',
                  'x-workspace': 'analytics',
                  'x-tool-hint': 'get_synthetic_note',
                  'x-origin-hint': 'https://mcp.example.test'
                }
              }
            })
        })

        expect(report.summary, formatConformanceReport(report)).toEqual({
          passed: applicable.length,
          failed: 0,
          skipped: 0
        })
      })
    )
  }
})

describe('mcp.auth.rejected', () => {
  it.effect('fails when the 401 carries no Bearer challenge', () =>
    Effect.gen(function* () {
      const drill = withResponse(mcpAuthRejectedModernFixture, 0, {
        status: 401,
        headers: { 'content-type': 'application/json' },
        body: '{"error":"invalid_token"}'
      })

      const error = yield* failureAgainst(mcpAuthRejectedCase, drill)

      expect(error.message).toBe('expected the 401 to carry a WWW-Authenticate: Bearer challenge')
    })
  )

  it.effect('fails when the invalid credential is answered 403', () =>
    Effect.gen(function* () {
      const drill = withResponse(mcpAuthRejectedModernFixture, 0, {
        status: 403,
        headers: { 'content-type': 'application/json' },
        body: '{"error":"forbidden"}'
      })

      const error = yield* failureAgainst(mcpAuthRejectedCase, drill)

      expect(error.message).toBe(
        'expected the first request with the invalid credential to get 401'
      )
    })
  )

  it.effect('passes a Bearer challenge in any position and letter case', () =>
    passAgainst(
      mcpAuthRejectedCase,
      withResponse(mcpAuthRejectedModernFixture, 0, {
        ...mcpConformanceUnauthorizedAnswer,
        headers: {
          'content-type': 'application/json',
          'www-authenticate': 'Basic realm="synthetic", bEaReR error="invalid_token"'
        }
      })
    )
  )

  it.effect('merges the invalid credential over the non-credential target headers', () =>
    Effect.gen(function* () {
      const sent = yield* Ref.make<ReadonlyArray<Readonly<Record<string, string>>>>([])

      const http = HttpClient.make(request =>
        Ref.update(sent, all => [...all, request.headers]).pipe(
          Effect.as(
            HttpClientResponse.fromWeb(
              request,
              new Response('{"error":"invalid_token"}', {
                status: 401,
                headers: { 'www-authenticate': 'Bearer error="invalid_token"' }
              })
            )
          )
        )
      )

      yield* mcpAuthRejectedCase.run.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(HttpClient.HttpClient, http),
            caseServices({
              ...mcpConformanceSyntheticTarget('modern'),
              headers: {
                Authorization: 'Bearer yolk-synthetic-target-credential-0001',
                'x-api-key': 'yolk-synthetic-target-key-0001',
                'x-client-tag': 'synthetic-run'
              }
            })
          )
        )
      )

      const [first] = yield* Ref.get(sent)

      expect(first?.['authorization']).toBe('Bearer yolk-conformance-invalid-credential-0000')
      expect(first?.['x-client-tag']).toBe('synthetic-run')
      expect(first).not.toHaveProperty('x-api-key')
    })
  )
})

describe('the stream helpers', () => {
  it('only change streamed answers', () => {
    const changed = withStreams(mcpLegacySessionFixture, chunks => [primingEvent, ...chunks])

    expect(
      changed.exchanges.map(exchange =>
        isWireStreamResponse(exchange.response) ? exchange.response.chunks[0] : null
      )
    ).toEqual(
      mcpLegacySessionFixture.exchanges.map(exchange =>
        isWireStreamResponse(exchange.response) ? primingEvent : null
      )
    )
  })
})
