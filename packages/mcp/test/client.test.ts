import { Effect, Layer, type Result } from 'effect'
import { HttpClient, HttpClientResponse, type HttpClientRequest } from 'effect/unstable/http'
import { describe, expect, it } from '@effect/vitest'
import { join } from 'node:path'
import {
  callLocalMcpServerTool,
  callMcpServerTool,
  listLocalMcpServerTools,
  listMcpServerTools
} from '../src'
import type { McpError, McpServerConfig } from '../src'

const stdioFixturePath = process.cwd().endsWith(join('packages', 'mcp'))
  ? join(process.cwd(), '../mcp-server/test/fixtures/fake-stdio-mcp-server.ts')
  : join(process.cwd(), 'packages/mcp-server/test/fixtures/fake-stdio-mcp-server.ts')
const tsxCliPath = process.cwd().endsWith(join('packages', 'mcp'))
  ? join(process.cwd(), '../../node_modules/tsx/dist/cli.mjs')
  : join(process.cwd(), 'node_modules/tsx/dist/cli.mjs')

type ResponseMode = 'json' | 'sse' | 'invalid-json' | 'json-rpc-error' | 'status-error'

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

const makeFakeRemoteMcpLayer = (mode: ResponseMode): Layer.Layer<HttpClient.HttpClient> => {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(request =>
      Effect.gen(function* () {
        const method = requestMethod(request)

        if (mode === 'status-error') {
          return HttpClientResponse.fromWeb(request, new Response('nope', { status: 500 }))
        }

        if (mode === 'invalid-json') {
          return HttpClientResponse.fromWeb(request, new Response('not json', { status: 200 }))
        }

        if (mode === 'json-rpc-error') {
          return HttpClientResponse.fromWeb(
            request,
            new Response(
              JSON.stringify({
                jsonrpc: '2.0',
                id: method === 'initialize' ? 1 : method === 'tools/list' ? 2 : 3,
                error: { code: -32_000, message: 'fixture failure' }
              }),
              { status: 200 }
            )
          )
        }

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

const expectMcpFailureCause = (
  result: Result.Result<unknown, McpError>,
  cause: McpError['cause']
) => {
  expect(result._tag).toBe('Failure')
  if (result._tag === 'Failure') {
    expect(result.failure.cause).toBe(cause)
  }
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
        Effect.provide(makeFakeRemoteMcpLayer('json'))
      )
      expect(tools.map(tool => tool.def.name)).toEqual(['remote_search'])

      const result = yield* callMcpServerTool({
        config,
        mcpToolName: 'search',
        toolCallId: 'call_1',
        params: { query: 'effect' },
        options
      }).pipe(Effect.provide(makeFakeRemoteMcpLayer('json')))

      expect(result.content).toBe('remote result')
    })
  )

  it.effect('parses remote SSE JSON-RPC responses', () =>
    Effect.gen(function* () {
      const tools = yield* listMcpServerTools(
        { name: 'remote', type: 'remote', url: 'https://example.com/mcp' },
        { securityPolicy: { allowLocalServers: false, allowDevHttpLocalhost: false } }
      ).pipe(Effect.provide(makeFakeRemoteMcpLayer('sse')))

      expect(tools.map(tool => tool.def.name)).toEqual(['remote_search'])
    })
  )

  it.effect('maps malformed remote JSON-RPC responses to protocol errors', () =>
    Effect.gen(function* () {
      const result = yield* listMcpServerTools(
        { name: 'remote', type: 'remote', url: 'https://example.com/mcp' },
        { securityPolicy: { allowLocalServers: false, allowDevHttpLocalhost: false } }
      ).pipe(Effect.provide(makeFakeRemoteMcpLayer('invalid-json')), Effect.result)

      expectMcpFailureCause(result, 'protocol')
    })
  )

  it.effect('maps remote JSON-RPC error responses to protocol errors', () =>
    Effect.gen(function* () {
      const result = yield* listMcpServerTools(
        { name: 'remote', type: 'remote', url: 'https://example.com/mcp' },
        { securityPolicy: { allowLocalServers: false, allowDevHttpLocalhost: false } }
      ).pipe(Effect.provide(makeFakeRemoteMcpLayer('json-rpc-error')), Effect.result)

      expectMcpFailureCause(result, 'protocol')
    })
  )

  it.effect('maps remote non-2xx responses to transport errors', () =>
    Effect.gen(function* () {
      const result = yield* listMcpServerTools(
        { name: 'remote', type: 'remote', url: 'https://example.com/mcp' },
        { securityPolicy: { allowLocalServers: false, allowDevHttpLocalhost: false } }
      ).pipe(Effect.provide(makeFakeRemoteMcpLayer('status-error')), Effect.result)

      expectMcpFailureCause(result, 'transport')
    })
  )

  it.effect('lists and calls local stdio tools when enabled', () =>
    Effect.gen(function* () {
      const config: McpServerConfig = {
        name: 'local',
        type: 'local',
        command: [process.execPath, tsxCliPath, stdioFixturePath]
      }
      const options = { securityPolicy: { allowLocalServers: true, allowDevHttpLocalhost: false } }

      const tools = yield* listLocalMcpServerTools(config, options)
      expect(tools.map(tool => tool.def.name)).toEqual(['local_echo'])

      const result = yield* callLocalMcpServerTool({
        config,
        mcpToolName: 'echo',
        toolCallId: 'call_1',
        params: { text: 'hello' },
        options
      })
      expect(result.content).toBe('local result')
    })
  )

  it.effect('maps local stdio early exit to protocol errors', () =>
    Effect.gen(function* () {
      const result = yield* listLocalMcpServerTools(
        { name: 'local', type: 'local', command: [process.execPath, '-e', ''] },
        { securityPolicy: { allowLocalServers: true, allowDevHttpLocalhost: false } }
      ).pipe(Effect.result)

      expectMcpFailureCause(result, 'protocol')
    })
  )
})
