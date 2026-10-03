/**
 * The MCP conformance cases in-process against yolk's own `makeMcpToolServer().handleHttpRequest`
 * (target kind `in-process`), through the real `@yolk-sdk/mcp/client`.
 *
 * The client always negotiates the modern era with this server (`createMcpHandler` answers
 * `server/discover`), so the target is modern. Four cases do not apply:
 *
 * - `mcp.legacy.session`: the era filter leaves it out; the client never runs the legacy handshake
 *   against a server that answers the era probe.
 * - `mcp.tools.call-read` and `mcp.tools.call-tool-error`: the server publishes no tool
 *   annotations, so no tool is marked `readOnlyHint: true` and the shared precondition refuses
 *   to call anything.
 * - `mcp.auth.rejected`: the server has no authentication; it answers the invalid credential with
 *   a listing, not 401 (authorization is host-owned).
 */
import { Effect, Layer, Predicate } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/http'
import { describe, expect, it } from '@effect/vitest'
import { formatConformanceReport, runConformance } from '@yolk-sdk/conformance/runner'
import { ToolDef, ToolResult } from '@yolk-sdk/agent/protocol'
import {
  mcpAuthRejectedCase,
  mcpCallReadCase,
  mcpCallToolErrorCase,
  mcpConformanceCases,
  mcpConformanceSyntheticReadCall,
  selectMcpConformanceCases,
  type McpConformanceSeeds,
  type McpConformanceTargetSettings
} from '../../src/conformance/index.ts'
import { makeMcpToolServer } from '../../src/server/index.ts'
import { caseServices } from './helpers.ts'

const now = new Date('2026-10-01T12:00:00.000Z')

const server = makeMcpToolServer({
  name: 'yolk-in-process',
  version: '0.0.0',
  tools: [
    {
      def: ToolDef.make({
        name: 'get_synthetic_note',
        description: 'Read one synthetic note by id.',
        parameters: {
          type: 'object',
          properties: { noteId: { type: 'string' } },
          required: ['noteId'],
          additionalProperties: false
        }
      }),
      execute: call =>
        Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'Synthetic note.' }))
    }
  ]
})

/** An `HttpClient` that hands every request to the server in-process (no network). */
const inProcessHttpClient = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make(request =>
    Effect.gen(function* () {
      const body = Predicate.isTagged(request.body, 'Uint8Array')
        ? new TextDecoder().decode(request.body.body)
        : undefined

      const response = yield* server.handleHttpRequest(
        new Request(request.url, { method: request.method, headers: request.headers, body })
      )

      return HttpClientResponse.fromWeb(request, response)
    })
  )
)

const target: McpConformanceTargetSettings = {
  name: 'in_process',
  url: 'https://mcp.example.test/mcp',
  headers: {},
  era: 'modern',
  protocolVersion: '2026-07-28',
  timeoutMs: 5_000
}

const seeds: McpConformanceSeeds = {
  readTool: mcpConformanceSyntheticReadCall,
  invalidArguments: { noteId: 42 },
  expectedTools: ['get_synthetic_note'],
  notReadOnly: []
}

const layer = Layer.mergeAll(inProcessHttpClient, caseServices(target, seeds))

const notApplicable = new Set([
  'mcp.legacy.session',
  'mcp.tools.call-read',
  'mcp.tools.call-tool-error',
  'mcp.auth.rejected'
])

describe('MCP conformance cases in-process against makeMcpToolServer', () => {
  it.effect('pass where the server supports them', () =>
    Effect.gen(function* () {
      const { applicable, notApplicable: filtered } = selectMcpConformanceCases(
        mcpConformanceCases,
        'modern'
      )

      expect(filtered.map(entry => entry.id)).toEqual(['mcp.legacy.session'])

      const supported = applicable.filter(testCase => !notApplicable.has(testCase.id))

      expect(supported.map(testCase => testCase.id)).toEqual([
        'mcp.negotiation.era',
        'mcp.modern.stateless',
        'mcp.transport.response-encoding',
        'mcp.tools.list',
        'mcp.errors.unknown-tool'
      ])

      const report = yield* runConformance(supported, {
        target: { kind: 'in-process' },
        now,
        layer: () => layer
      })

      expect(report.summary, formatConformanceReport(report)).toEqual({
        passed: supported.length,
        failed: 0,
        skipped: 0
      })
    })
  )

  it.effect('do not apply to the call cases: the server publishes no readOnlyHint', () =>
    Effect.gen(function* () {
      for (const testCase of [mcpCallReadCase, mcpCallToolErrorCase]) {
        const error = yield* testCase.run.pipe(Effect.provide(layer), Effect.flip)

        expect(error.message, testCase.id).toBe(
          'precondition: the listing does not mark readTool readOnlyHint: true'
        )
      }
    })
  )

  it.effect('do not apply to auth.rejected: the server has no authentication', () =>
    Effect.gen(function* () {
      const error = yield* mcpAuthRejectedCase.run.pipe(Effect.provide(layer), Effect.flip)

      expect(error.message).toBe(
        'expected the first request with the invalid credential to get 401'
      )
    })
  )
})
