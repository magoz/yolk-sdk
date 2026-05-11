import { Effect, Layer } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/unstable/http'
import { describe, expect, it } from '@effect/vitest'
import {
  callMcpServerTool,
  defaultMcpSecurityPolicy,
  mcpToolToToolDef,
  sanitizeMcpName,
  toolCallResultToToolResult
} from '../src'

// Public MCP client helpers accept remote/local union configs, so tests that stop at
// local policy validation still provide an inert HttpClient requirement.
const unusedRemoteMcpLayer = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make(request =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response(undefined, { status: 204 })))
  )
)

describe('MCP protocol helpers', () => {
  it('sanitizes server and tool names for protocol tool defs', () => {
    const def = mcpToolToToolDef({
      serverName: 'docs.server',
      tool: {
        name: 'search docs',
        description: 'Search docs',
        inputSchema: { type: 'object', properties: {} }
      }
    })

    expect(def.name).toBe('docs_server_search_docs')
    expect(def.description).toBe('Search docs')
    expect(sanitizeMcpName('***')).toBe('___')
  })

  it('converts text content blocks to tool result content', () => {
    const result = toolCallResultToToolResult({
      toolCallId: 'call_1',
      result: {
        content: [
          { type: 'text', text: 'hello' },
          { type: 'text', text: 'world' }
        ]
      }
    })

    expect(result.toolCallId).toBe('call_1')
    expect(result.content).toBe('hello\nworld')
  })

  it.effect('rejects local MCP when disabled by policy', () =>
    Effect.gen(function* () {
      const result = yield* callMcpServerTool({
        config: {
          name: 'local',
          type: 'local',
          command: ['node', 'server.js']
        },
        mcpToolName: 'search',
        toolCallId: 'call_1',
        params: {},
        options: { securityPolicy: defaultMcpSecurityPolicy }
      }).pipe(Effect.result, Effect.provide(unusedRemoteMcpLayer))

      expect(result._tag).toBe('Failure')
      if (result._tag === 'Failure') {
        expect(result.failure.cause).toBe('security')
      }
    })
  )
})
