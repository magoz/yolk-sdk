import { Effect, Layer } from 'effect'
import { HttpClient, HttpClientResponse, type HttpClientRequest } from 'effect/unstable/http'
import { describe, expect, it } from '@effect/vitest'
import { join } from 'node:path'
import { callMcpServerTool, listMcpServerTools } from '../src'
import type { McpServerConfig } from '../src'

const stdioFixturePath = process.cwd().endsWith(join('packages', 'mcp'))
  ? join(process.cwd(), 'test/fixtures/stdio-server.mjs')
  : join(process.cwd(), 'packages/mcp/test/fixtures/stdio-server.mjs')

type ResponseMode = 'json' | 'sse'

const requestMethod = (request: HttpClientRequest.HttpClientRequest) => {
  const body = request.body
  if (body._tag !== 'Uint8Array') {
    return 'notifications/initialized'
  }

  const text = new TextDecoder().decode(body.body)
  if (text.includes('"method":"initialize"')) {
    return 'initialize'
  }
  if (text.includes('"method":"tools/list"')) {
    return 'tools/list'
  }
  if (text.includes('"method":"tools/call"')) {
    return 'tools/call'
  }
  return 'notifications/initialized'
}

const makeRemoteMcpLayer = (mode: ResponseMode): Layer.Layer<HttpClient.HttpClient> => {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(request =>
      Effect.gen(function* () {
        const method = requestMethod(request)
        const result =
          method === 'initialize'
            ? {
                protocolVersion: '2024-11-05',
                capabilities: {},
                serverInfo: { name: 'remote', version: '0' }
              }
            : method === 'tools/list'
              ? {
                  tools: [
                    { name: 'search', description: 'Search', inputSchema: { type: 'object' } }
                  ]
                }
              : { content: [{ type: 'text', text: 'remote result' }] }

        if (method === 'notifications/initialized') {
          return HttpClientResponse.fromWeb(request, new Response(undefined, { status: 204 }))
        }

        const payload = JSON.stringify({
          jsonrpc: '2.0',
          id: method === 'initialize' ? 1 : method === 'tools/list' ? 2 : 3,
          result
        })

        const body = mode === 'sse' ? `event: message\ndata: ${payload}\n\n` : payload
        return HttpClientResponse.fromWeb(
          request,
          new Response(body, {
            status: 200,
            headers: { 'content-type': mode === 'sse' ? 'text/event-stream' : 'application/json' }
          })
        )
      })
    )
  )
}

describe('MCP client', () => {
  it.effect('lists and calls remote JSON-RPC tools', () =>
    Effect.gen(function* () {
      const config: McpServerConfig = {
        name: 'remote',
        type: 'remote',
        url: 'https://example.com/mcp'
      }
      const options = { securityPolicy: { allowLocalServers: false, allowDevHttpLocalhost: false } }

      const tools = yield* listMcpServerTools(config, options).pipe(
        Effect.provide(makeRemoteMcpLayer('json'))
      )
      expect(tools.map(tool => tool.def.name)).toEqual(['remote_search'])

      const result = yield* callMcpServerTool({
        config,
        mcpToolName: 'search',
        toolCallId: 'call_1',
        params: { query: 'effect' },
        options
      }).pipe(Effect.provide(makeRemoteMcpLayer('json')))

      expect(result.content).toBe('remote result')
    })
  )

  it.effect('parses remote SSE JSON-RPC responses', () =>
    Effect.gen(function* () {
      const tools = yield* listMcpServerTools(
        { name: 'remote', type: 'remote', url: 'https://example.com/mcp' },
        { securityPolicy: { allowLocalServers: false, allowDevHttpLocalhost: false } }
      ).pipe(Effect.provide(makeRemoteMcpLayer('sse')))

      expect(tools.map(tool => tool.def.name)).toEqual(['remote_search'])
    })
  )

  it.effect('lists and calls local stdio tools when enabled', () =>
    Effect.gen(function* () {
      const config: McpServerConfig = {
        name: 'local',
        type: 'local',
        command: [process.execPath, stdioFixturePath]
      }
      const options = { securityPolicy: { allowLocalServers: true, allowDevHttpLocalhost: false } }

      const tools = yield* listMcpServerTools(config, options).pipe(
        Effect.provide(makeRemoteMcpLayer('json'))
      )
      expect(tools.map(tool => tool.def.name)).toEqual(['local_echo'])

      const result = yield* callMcpServerTool({
        config,
        mcpToolName: 'echo',
        toolCallId: 'call_1',
        params: { text: 'hello' },
        options
      }).pipe(Effect.provide(makeRemoteMcpLayer('json')))
      expect(result.content).toBe('local result')
    })
  )
})
