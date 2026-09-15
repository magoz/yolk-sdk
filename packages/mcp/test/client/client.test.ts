import {
  Duration,
  Effect,
  Fiber,
  Layer,
  Option,
  Predicate,
  Sink,
  Stream,
  type Result
} from 'effect'
import * as Schema from 'effect/Schema'
import { TestClock } from 'effect/testing'
import { HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/unstable/http'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'
import { describe, expect, it } from '@effect/vitest'
import { join } from 'node:path'
import { AudioPart, ImagePart, TextPart, inlineBase64Source } from '@yolk-sdk/agent/protocol'
import {
  JsonRpcMessage,
  listLocalMcpServerTools,
  callRemoteMcpServerTool,
  listRemoteMcpServerTools,
  McpError,
  ProtocolError,
  SdkError,
  SdkErrorCode
} from '../../src/client'
import {
  callLocalMcpServerToolNode,
  listLocalMcpServerToolsNode,
  listMcpToolsNode
} from '../../src/client/node.ts'
import type { McpClientOptions, McpServerConfig } from '../../src/client'

const stdioFixturePath = process.cwd().endsWith(join('packages', 'mcp'))
  ? join(process.cwd(), 'test/server/fixtures/fake-stdio-mcp-server.ts')
  : join(process.cwd(), 'packages/mcp/test/server/fixtures/fake-stdio-mcp-server.ts')

const tsxCliPath = process.cwd().endsWith(join('packages', 'mcp'))
  ? join(process.cwd(), '../../node_modules/tsx/dist/cli.mjs')
  : join(process.cwd(), 'node_modules/tsx/dist/cli.mjs')

const outOfOrderStdioScript = `
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }] } }) + '\\n');
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'local', version: '0' } } }) + '\\n');
});
`

const initializeErrorStdioScript = `
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }] } }) + '\\n');
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'init failed' } }) + '\\n');
});
`

type ResponseMode =
  | 'json'
  | 'sse'
  | 'invalid-json'
  | 'json-rpc-error'
  | 'status-error'
  | 'timeout'
  | 'duplicate-tools'
  | 'metadata'
  | 'tool-error'
  | 'rich-result'
  | 'legacy'

const makeFakeLocalMcpLayer = (lines: ReadonlyArray<string>) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(command =>
      Effect.sync(() => {
        if (!ChildProcess.isStandardCommand(command)) {
          throw new Error('Expected standard command')
        }

        expect(command.options.extendEnv).toBe(false)
        expect(command.options.env).toEqual({ MCP_TOKEN: 'token' })

        const stdout = Stream.fromIterable(lines.map(line => `${line}\n`)).pipe(Stream.encodeText)

        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout,
          stderr: Stream.empty,
          all: stdout,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void)
        })
      })
    )
  )

const decodeJsonRpcPacket = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))

const decodeJsonRpcMessage = Schema.decodeUnknownOption(JsonRpcMessage)

const requestMessage = (request: HttpClientRequest.HttpClientRequest) =>
  Effect.gen(function* () {
    const body = request.body

    if (!Predicate.isTagged(body, 'Uint8Array')) {
      return { id: null, method: 'notifications/initialized' }
    }

    const parsed = yield* decodeJsonRpcPacket(new TextDecoder().decode(body.body)).pipe(
      Effect.orDie
    )

    const message = decodeJsonRpcMessage(parsed)

    if (Option.isNone(message)) {
      return { id: null, method: 'unknown' }
    }

    if ('id' in message.value) {
      return { id: message.value.id, method: message.value.method }
    }

    return { id: null, method: message.value.method }
  })

const makeFakeRemoteMcpLayer = (mode: ResponseMode): Layer.Layer<HttpClient.HttpClient> => {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(request =>
      Effect.gen(function* () {
        if (mode === 'timeout') {
          yield* Effect.sleep(Duration.millis(100))
        }

        const searchTool =
          mode === 'metadata'
            ? {
                name: 'search',
                description: 'Search',
                inputSchema: { type: 'object' },
                title: 'Search records',
                outputSchema: {
                  type: 'object',
                  properties: { records: { type: 'array' } }
                },
                annotations: {
                  readOnlyHint: true,
                  destructiveHint: false
                }
              }
            : {
                name: 'search',
                description: 'Search',
                inputSchema: { type: 'object' }
              }

        const message = yield* requestMessage(request)
        const method = message.method

        if (
          method !== 'initialize' &&
          method !== 'notifications/initialized' &&
          request.headers['mcp-protocol-version'] === '2026-07-28'
        ) {
          expect(request.headers['accept']).toBe('application/json, text/event-stream')
          expect(request.headers['mcp-method']).toBe(method)
          expect(request.headers['mcp-protocol-version']).toBe('2026-07-28')
        }

        if (mode === 'legacy' && method === 'server/discover') {
          return HttpClientResponse.fromWeb(
            request,
            new Response(
              JSON.stringify({
                jsonrpc: '2.0',
                id: message.id,
                error: { code: -32_601, message: 'Method not found' }
              }),
              { status: 400, headers: { 'content-type': 'application/json' } }
            )
          )
        }

        if (mode === 'status-error') {
          return HttpClientResponse.fromWeb(request, new Response('nope', { status: 500 }))
        }

        if (mode === 'invalid-json') {
          return HttpClientResponse.fromWeb(
            request,
            new Response('not json', {
              status: 200,
              headers: { 'content-type': 'application/json' }
            })
          )
        }

        if (mode === 'json-rpc-error') {
          return HttpClientResponse.fromWeb(
            request,
            new Response(
              JSON.stringify({
                jsonrpc: '2.0',
                id: message.id,
                error: { code: -32_000, message: 'fixture failure' }
              }),
              { status: 200, headers: { 'content-type': 'application/json' } }
            )
          )
        }

        const result =
          method === 'server/discover'
            ? {
                resultType: 'complete',
                supportedVersions: ['2026-07-28'],
                capabilities: { tools: {} },
                ttlMs: 60_000,
                cacheScope: 'public',
                _meta: {
                  'io.modelcontextprotocol/serverInfo': { name: 'remote', version: '0' }
                }
              }
            : method === 'initialize'
              ? {
                  protocolVersion: '2024-11-05',
                  capabilities: { tools: {} },
                  serverInfo: { name: 'remote', version: '0' }
                }
              : method === 'tools/list'
                ? {
                    resultType: 'complete',
                    ttlMs: 60_000,
                    cacheScope: 'public',
                    tools:
                      mode === 'duplicate-tools'
                        ? [
                            {
                              name: 'search.one',
                              description: 'Search one',
                              inputSchema: { type: 'object' }
                            },
                            {
                              name: 'search/one',
                              description: 'Search duplicate',
                              inputSchema: { type: 'object' }
                            }
                          ]
                        : [searchTool]
                  }
                : mode === 'tool-error'
                  ? {
                      resultType: 'complete',
                      content: [{ type: 'text', text: 'bad params' }],
                      isError: true
                    }
                  : mode === 'rich-result'
                    ? {
                        resultType: 'complete',
                        content: [
                          { type: 'text', text: 'remote result' },
                          { type: 'image', data: 'abc', mimeType: 'image/png' },
                          { type: 'audio', data: 'def', mimeType: 'audio/opus' },
                          {
                            type: 'resource',
                            resource: { uri: 'file:///tmp/out.txt', text: 'resource text' }
                          },
                          {
                            type: 'resource_link',
                            uri: 'file:///tmp/linked.txt',
                            name: 'linked.txt'
                          }
                        ],
                        structuredContent: { answer: 42 },
                        isError: true
                      }
                    : {
                        resultType: 'complete',
                        content: [{ type: 'text', text: 'remote result' }]
                      }

        if (method === 'notifications/initialized') {
          return HttpClientResponse.fromWeb(request, new Response(undefined, { status: 204 }))
        }

        const payload = JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
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

  if (Predicate.isTagged(result, 'Failure')) {
    expect(result.failure.cause).toBe(cause)
  }
}

const mcpErrorBrands = Symbol.for('mcp.sdk.errorBrands')

const listRemoteConfigureClientFailure = (
  configureClient: NonNullable<McpClientOptions['configureClient']>
) =>
  listRemoteMcpServerTools(
    { name: 'remote', type: 'remote', url: 'https://example.com/mcp' },
    {
      securityPolicy: { allowLocalServers: false, allowDevHttpLocalhost: false },
      configureClient
    }
  ).pipe(Effect.provide(makeFakeRemoteMcpLayer('json')), Effect.result)

describe('MCP client', () => {
  it.effect('lists and calls remote JSON-RPC tools', () =>
    Effect.gen(function* () {
      const config: McpServerConfig = {
        name: 'remote',
        type: 'remote',
        url: 'https://example.com/mcp'
      }

      const options = { securityPolicy: { allowLocalServers: false, allowDevHttpLocalhost: false } }

      const tools = yield* listRemoteMcpServerTools(config, options).pipe(
        Effect.provide(makeFakeRemoteMcpLayer('metadata'))
      )

      expect(tools).toMatchObject([
        {
          mcpToolName: 'search',
          title: 'Search records',
          outputSchema: { type: 'object', properties: { records: { type: 'array' } } },
          annotations: {
            readOnlyHint: true,
            destructiveHint: false
          },
          def: { name: 'remote_search' }
        }
      ])

      const result = yield* callRemoteMcpServerTool({
        config,
        mcpToolName: 'search',
        toolCallId: 'call_1',
        params: { query: 'effect' },
        options
      }).pipe(Effect.provide(makeFakeRemoteMcpLayer('json')))

      expect(result.content).toBe('remote result')
    })
  )

  it.effect('falls back to initialize-based remote servers', () =>
    Effect.gen(function* () {
      const tools = yield* listRemoteMcpServerTools(
        { name: 'remote', type: 'remote', url: 'https://example.com/mcp' },
        { securityPolicy: { allowLocalServers: false, allowDevHttpLocalhost: false } }
      ).pipe(Effect.provide(makeFakeRemoteMcpLayer('legacy')))

      expect(tools.map(tool => tool.def.name)).toEqual(['remote_search'])
    })
  )

  it.effect('parses remote SSE JSON-RPC responses', () =>
    Effect.gen(function* () {
      const tools = yield* listRemoteMcpServerTools(
        { name: 'remote', type: 'remote', url: 'https://example.com/mcp' },
        { securityPolicy: { allowLocalServers: false, allowDevHttpLocalhost: false } }
      ).pipe(Effect.provide(makeFakeRemoteMcpLayer('sse')))

      expect(tools.map(tool => tool.def.name)).toEqual(['remote_search'])
    })
  )

  it.effect('maps malformed remote JSON-RPC responses to protocol errors', () =>
    Effect.gen(function* () {
      const result = yield* listRemoteMcpServerTools(
        { name: 'remote', type: 'remote', url: 'https://example.com/mcp' },
        { securityPolicy: { allowLocalServers: false, allowDevHttpLocalhost: false } }
      ).pipe(Effect.provide(makeFakeRemoteMcpLayer('invalid-json')), Effect.result)

      expectMcpFailureCause(result, 'protocol')
    })
  )

  it.effect('maps remote JSON-RPC error responses to protocol errors', () =>
    Effect.gen(function* () {
      const result = yield* listRemoteMcpServerTools(
        { name: 'remote', type: 'remote', url: 'https://example.com/mcp' },
        { securityPolicy: { allowLocalServers: false, allowDevHttpLocalhost: false } }
      ).pipe(Effect.provide(makeFakeRemoteMcpLayer('json-rpc-error')), Effect.result)

      expectMcpFailureCause(result, 'protocol')
    })
  )

  it.effect('preserves MCP tool error content as tool results', () =>
    Effect.gen(function* () {
      const result = yield* callRemoteMcpServerTool({
        config: { name: 'remote', type: 'remote', url: 'https://example.com/mcp' },
        mcpToolName: 'search',
        toolCallId: 'call_1',
        params: {},
        options: { securityPolicy: { allowLocalServers: false, allowDevHttpLocalhost: false } }
      }).pipe(Effect.provide(makeFakeRemoteMcpLayer('tool-error')))

      expect(result.content).toBe('bad params')
      expect(result.isError).toBe(true)
    })
  )

  it.effect('preserves rich remote MCP tool result fidelity', () =>
    Effect.gen(function* () {
      const result = yield* callRemoteMcpServerTool({
        config: { name: 'remote', type: 'remote', url: 'https://example.com/mcp' },
        mcpToolName: 'search',
        toolCallId: 'call_1',
        params: {},
        options: { securityPolicy: { allowLocalServers: false, allowDevHttpLocalhost: false } }
      }).pipe(Effect.provide(makeFakeRemoteMcpLayer('rich-result')))

      expect(result).toMatchObject({
        toolCallId: 'call_1',
        isError: true,
        structuredContent: { answer: 42 },
        content: [
          TextPart.make({ text: 'remote result' }),
          ImagePart.make({ source: inlineBase64Source('abc'), mimeType: 'image/png' }),
          AudioPart.make({ source: inlineBase64Source('def'), mimeType: 'audio/opus' }),
          TextPart.make({ text: 'resource text' }),
          TextPart.make({
            text: 'MCP resource link: linked.txt (file:///tmp/linked.txt)'
          })
        ]
      })
    })
  )

  it.effect('maps remote non-2xx responses to transport errors', () =>
    Effect.gen(function* () {
      const result = yield* listRemoteMcpServerTools(
        { name: 'remote', type: 'remote', url: 'https://example.com/mcp' },
        { securityPolicy: { allowLocalServers: false, allowDevHttpLocalhost: false } }
      ).pipe(Effect.provide(makeFakeRemoteMcpLayer('status-error')), Effect.result)

      expectMcpFailureCause(result, 'transport')
    })
  )

  it.effect('maps remote timeouts to timeout errors', () =>
    Effect.gen(function* () {
      const fiber = yield* listRemoteMcpServerTools(
        { name: 'remote', type: 'remote', url: 'https://example.com/mcp' },
        {
          securityPolicy: { allowLocalServers: false, allowDevHttpLocalhost: false },
          timeoutMs: 10
        }
      ).pipe(Effect.provide(makeFakeRemoteMcpLayer('timeout')), Effect.result, Effect.forkChild)

      yield* TestClock.adjust(Duration.millis(100))
      const result = yield* Fiber.join(fiber)

      expectMcpFailureCause(result, 'timeout')
    })
  )

  it.effect('rejects duplicate generated tool names', () =>
    Effect.gen(function* () {
      const result = yield* listMcpToolsNode(
        [{ name: 'remote', type: 'remote', url: 'https://example.com/mcp' }],
        { securityPolicy: { allowLocalServers: false, allowDevHttpLocalhost: false } }
      ).pipe(Effect.provide(makeFakeRemoteMcpLayer('duplicate-tools')), Effect.result)

      expectMcpFailureCause(result, 'validation')
    })
  )

  it.effect(
    'lists and calls local stdio tools when enabled',
    () =>
      Effect.gen(function* () {
        const config: McpServerConfig = {
          name: 'local',
          type: 'local',
          command: [process.execPath, tsxCliPath, stdioFixturePath]
        }

        const options = {
          securityPolicy: { allowLocalServers: true, allowDevHttpLocalhost: false }
        }

        const tools = yield* listLocalMcpServerToolsNode(config, options)
        expect(tools.map(tool => tool.def.name)).toEqual(['local_echo'])

        const result = yield* callLocalMcpServerToolNode({
          config,
          mcpToolName: 'echo',
          toolCallId: 'call_1',
          params: { text: 'hello' },
          options
        })

        expect(result.content).toBe('local result')
      }),
    30_000
  )

  it.effect('supports injected local process spawners without Node services', () =>
    Effect.gen(function* () {
      const initializeResponse = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          serverInfo: { name: 'local', version: '0' }
        }
      })

      const toolsResponse = JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        result: {
          tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }]
        }
      })

      const tools = yield* listLocalMcpServerTools(
        {
          name: 'local',
          type: 'local',
          command: ['fake-mcp'],
          environment: { MCP_TOKEN: 'token' }
        },
        { securityPolicy: { allowLocalServers: true, allowDevHttpLocalhost: false } }
      ).pipe(Effect.provide(makeFakeLocalMcpLayer([initializeResponse, toolsResponse])))

      expect(tools.map(tool => tool.def.name)).toEqual(['local_echo'])
    })
  )

  it.effect('maps non-object and nonfinite inputSchema wire data to typed validation errors', () =>
    Effect.gen(function* () {
      const initializeResponse =
        '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","capabilities":{},"serverInfo":{"name":"local","version":"0"}}}'

      const toolsResponses = [
        '{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"echo","inputSchema":false}]}}',
        '{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"echo","inputSchema":true}]}}',
        '{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"echo","inputSchema":{"n":1e999,"private_marker":"do-not-echo"}}]}}'
      ]

      for (const toolsResponse of toolsResponses) {
        const result = yield* listLocalMcpServerTools(
          {
            name: 'local',
            type: 'local',
            command: ['fake-mcp'],
            environment: { MCP_TOKEN: 'token' }
          },
          { securityPolicy: { allowLocalServers: true, allowDevHttpLocalhost: false } }
        ).pipe(
          Effect.provide(makeFakeLocalMcpLayer([initializeResponse, toolsResponse])),
          Effect.result
        )

        expectMcpFailureCause(result, 'validation')

        if (Predicate.isTagged(result, 'Failure')) {
          expect(Schema.is(McpError)(result.failure)).toBe(true)
          expect(result.failure.message).toContain('Invalid tools/list result:')
          expect(result.failure.message).toContain('JSON Schema')
          expect(result.failure.message).not.toContain('do-not-echo')
        }
      }
    })
  )

  it.effect('maps local stdio early exit to protocol errors', () =>
    Effect.gen(function* () {
      const result = yield* listLocalMcpServerToolsNode(
        { name: 'local', type: 'local', command: [process.execPath, '-e', ''] },
        { securityPolicy: { allowLocalServers: true, allowDevHttpLocalhost: false } }
      ).pipe(Effect.result)

      expectMcpFailureCause(result, 'protocol')
    })
  )

  it.effect('routes local stdio responses by request id', () =>
    Effect.gen(function* () {
      const tools = yield* listLocalMcpServerToolsNode(
        { name: 'local', type: 'local', command: [process.execPath, '-e', outOfOrderStdioScript] },
        { securityPolicy: { allowLocalServers: true, allowDevHttpLocalhost: false } }
      )

      expect(tools.map(tool => tool.def.name)).toEqual(['local_echo'])
    })
  )

  it.effect('rejects local stdio initialize errors before target responses', () =>
    Effect.gen(function* () {
      const result = yield* listLocalMcpServerToolsNode(
        {
          name: 'local',
          type: 'local',
          command: [process.execPath, '-e', initializeErrorStdioScript]
        },
        { securityPolicy: { allowLocalServers: true, allowDevHttpLocalhost: false } }
      ).pipe(Effect.result)

      expectMcpFailureCause(result, 'protocol')
    })
  )

  it.effect('fails the fake transport on malformed outbound JSON-RPC packets', () =>
    Effect.gen(function* () {
      const request = HttpClientRequest.bodyUint8Array(
        HttpClientRequest.post('https://example.com/mcp'),
        new TextEncoder().encode('{'),
        'application/json'
      )

      const exit = yield* Effect.exit(requestMessage(request))

      expect(exit._tag).toBe('Failure')
    })
  )

  it.effect('decodes valid outbound requests and notifications at the fake transport', () =>
    Effect.gen(function* () {
      const request = HttpClientRequest.bodyUint8Array(
        HttpClientRequest.post('https://example.com/mcp'),
        new TextEncoder().encode('{"jsonrpc":"2.0","id":7,"method":"tools/list"}'),
        'application/json'
      )

      const notification = HttpClientRequest.bodyUint8Array(
        HttpClientRequest.post('https://example.com/mcp'),
        new TextEncoder().encode('{"jsonrpc":"2.0","method":"notifications/initialized"}'),
        'application/json'
      )

      const nonJsonRpcObject = HttpClientRequest.bodyUint8Array(
        HttpClientRequest.post('https://example.com/mcp'),
        new TextEncoder().encode('{"foo":1}'),
        'application/json'
      )

      expect(yield* requestMessage(request)).toEqual({ id: 7, method: 'tools/list' })
      expect(yield* requestMessage(notification)).toEqual({
        id: null,
        method: 'notifications/initialized'
      })
      expect(yield* requestMessage(nonJsonRpcObject)).toEqual({ id: null, method: 'unknown' })
    })
  )

  it.effect('rejects invalid remote MCP URLs as validation errors', () =>
    Effect.gen(function* () {
      const result = yield* listRemoteMcpServerTools(
        { name: 'remote', type: 'remote', url: 'not-a-url' },
        { securityPolicy: { allowLocalServers: false, allowDevHttpLocalhost: false } }
      ).pipe(Effect.provide(makeFakeRemoteMcpLayer('json')), Effect.result)

      expectMcpFailureCause(result, 'validation')
    })
  )

  it.effect('rejects non-https remote MCP URLs as security errors', () =>
    Effect.gen(function* () {
      const result = yield* listRemoteMcpServerTools(
        { name: 'remote', type: 'remote', url: 'http://example.com/mcp' },
        { securityPolicy: { allowLocalServers: false, allowDevHttpLocalhost: false } }
      ).pipe(Effect.provide(makeFakeRemoteMcpLayer('json')), Effect.result)

      expectMcpFailureCause(result, 'security')
    })
  )

  it.effect('rejects localhost http unless the dev policy is enabled', () =>
    Effect.gen(function* () {
      const result = yield* listRemoteMcpServerTools(
        { name: 'remote', type: 'remote', url: 'http://localhost/mcp' },
        { securityPolicy: { allowLocalServers: false, allowDevHttpLocalhost: false } }
      ).pipe(Effect.provide(makeFakeRemoteMcpLayer('json')), Effect.result)

      expectMcpFailureCause(result, 'security')
    })
  )

  it.effect('maps malformed local JSON-RPC lines to parse errors', () =>
    Effect.gen(function* () {
      const result = yield* listLocalMcpServerTools(
        {
          name: 'local',
          type: 'local',
          command: ['fake-mcp'],
          environment: { MCP_TOKEN: 'token' }
        },
        { securityPolicy: { allowLocalServers: true, allowDevHttpLocalhost: false } }
      ).pipe(Effect.provide(makeFakeLocalMcpLayer(['not json'])), Effect.result)

      expectMcpFailureCause(result, 'parse')
    })
  )

  it.effect('maps invalid local JSON-RPC objects to validation errors', () =>
    Effect.gen(function* () {
      const result = yield* listLocalMcpServerTools(
        {
          name: 'local',
          type: 'local',
          command: ['fake-mcp'],
          environment: { MCP_TOKEN: 'token' }
        },
        { securityPolicy: { allowLocalServers: true, allowDevHttpLocalhost: false } }
      ).pipe(
        Effect.provide(makeFakeLocalMcpLayer([JSON.stringify({ jsonrpc: '2.0', id: 1 })])),
        Effect.result
      )

      expectMcpFailureCause(result, 'validation')
    })
  )

  it.effect('keeps thrown McpError identity from configureClient', () =>
    Effect.gen(function* () {
      const existing = new McpError({
        server: 'remote',
        message: 'keep-me',
        cause: 'tool_error'
      })

      const result = yield* listRemoteConfigureClientFailure(() => {
        throw existing
      })

      expect(result._tag).toBe('Failure')

      if (Predicate.isTagged(result, 'Failure')) {
        expect(result.failure).toBe(existing)
        expect(result.failure.message).toBe('keep-me')
        expect(result.failure.cause).toBe('tool_error')
      }
    })
  )

  it.effect('stringifies opaque host throws before any SDK cause probe', () =>
    Effect.gen(function* () {
      const reads: Array<string> = []

      const opaque = {
        get code() {
          reads.push('code')

          return SdkErrorCode.RequestTimeout
        },
        get message() {
          reads.push('message')
          throw new Error('message getter must not run')
        },
        toString() {
          reads.push('toString')

          return 'opaque-host'
        }
      }

      const result = yield* listRemoteConfigureClientFailure(() => {
        throw opaque
      })

      expect(reads).toEqual(['toString'])
      expect(result._tag).toBe('Failure')

      if (Predicate.isTagged(result, 'Failure')) {
        expect(result.failure.message).toBe('Could not configure MCP client: opaque-host')
        expect(result.failure.cause).toBe('transport')
        expect(result.failure.server).toBe('remote')
      }
    })
  )

  it.effect('maps non-Error primitive configure throws to transport', () =>
    Effect.gen(function* () {
      const result = yield* listRemoteConfigureClientFailure(() => {
        throw 0
      })

      expect(result._tag).toBe('Failure')

      if (Predicate.isTagged(result, 'Failure')) {
        expect(result.failure.message).toBe('Could not configure MCP client: 0')
        expect(result.failure.cause).toBe('transport')
      }
    })
  )

  it.effect('maps real SdkError timeout after Error.message projection', () =>
    Effect.gen(function* () {
      const result = yield* listRemoteConfigureClientFailure(() => {
        throw new SdkError(SdkErrorCode.RequestTimeout, 'json parse timed out')
      })

      expect(result._tag).toBe('Failure')

      if (Predicate.isTagged(result, 'Failure')) {
        expect(result.failure.message).toBe('Could not configure MCP client: json parse timed out')
        expect(result.failure.cause).toBe('timeout')
      }
    })
  )

  it.effect('maps real SdkError parse messages to protocol after projection', () =>
    Effect.gen(function* () {
      const result = yield* listRemoteConfigureClientFailure(() => {
        throw new SdkError(SdkErrorCode.SendFailed, 'Unable to parse JSON body')
      })

      expect(result._tag).toBe('Failure')

      if (Predicate.isTagged(result, 'Failure')) {
        expect(result.failure.message).toBe(
          'Could not configure MCP client: Unable to parse JSON body'
        )
        expect(result.failure.cause).toBe('protocol')
      }
    })
  )

  it.effect('maps real ProtocolError to protocol after Error.message projection', () =>
    Effect.gen(function* () {
      const result = yield* listRemoteConfigureClientFailure(() => {
        throw new ProtocolError(-32_600, 'invalid request')
      })

      expect(result._tag).toBe('Failure')

      if (Predicate.isTagged(result, 'Failure')) {
        expect(result.failure.message).toBe('Could not configure MCP client: invalid request')
        expect(result.failure.cause).toBe('protocol')
      }
    })
  )

  it.effect('uses String() for branded non-Error SdkError before code/message probes', () =>
    Effect.gen(function* () {
      const reads: Array<string> = []

      const forged = {
        get code() {
          reads.push('code')

          return SdkErrorCode.RequestTimeout
        },
        get message() {
          reads.push('message')

          return 'JSON parse failed'
        },
        toString() {
          reads.push('toString')

          return 'branded-string'
        }
      }

      Object.defineProperty(forged, mcpErrorBrands, {
        value: new Set(['mcp.SdkError']),
        enumerable: false,
        configurable: true
      })

      expect(forged instanceof SdkError).toBe(true)
      expect(forged instanceof Error).toBe(false)
      expect(forged instanceof ProtocolError).toBe(false)

      const result = yield* listRemoteConfigureClientFailure(() => {
        throw forged
      })

      expect(reads).toEqual(['toString', 'code'])
      expect(result._tag).toBe('Failure')

      if (Predicate.isTagged(result, 'Failure')) {
        expect(result.failure.message).toBe('Could not configure MCP client: branded-string')
        expect(result.failure.cause).toBe('timeout')
      }
    })
  )

  it.effect('reads branded SdkError message getter only after code when not timeout', () =>
    Effect.gen(function* () {
      const reads: Array<string> = []

      const forged = {
        get code() {
          reads.push('code')

          return SdkErrorCode.SendFailed
        },
        get message() {
          reads.push('message')

          return 'JSON parse failed'
        },
        toString() {
          reads.push('toString')

          return 'branded-parse'
        }
      }

      Object.defineProperty(forged, mcpErrorBrands, {
        value: new Set(['mcp.SdkError']),
        enumerable: false,
        configurable: true
      })

      const result = yield* listRemoteConfigureClientFailure(() => {
        throw forged
      })

      expect(reads).toEqual(['toString', 'code', 'message'])
      expect(result._tag).toBe('Failure')

      if (Predicate.isTagged(result, 'Failure')) {
        expect(result.failure.message).toBe('Could not configure MCP client: branded-parse')
        expect(result.failure.cause).toBe('protocol')
      }
    })
  )

  it.effect('does not read code or message getters for branded ProtocolError cause', () =>
    Effect.gen(function* () {
      const reads: Array<string> = []

      const forged = {
        get code() {
          reads.push('code')

          return SdkErrorCode.RequestTimeout
        },
        get message() {
          reads.push('message')

          return 'JSON parse failed'
        },
        toString() {
          reads.push('toString')

          return 'branded-protocol'
        }
      }

      Object.defineProperty(forged, mcpErrorBrands, {
        value: new Set(['mcp.ProtocolError']),
        enumerable: false,
        configurable: true
      })

      expect(forged instanceof ProtocolError).toBe(true)
      expect(forged instanceof Error).toBe(false)

      const result = yield* listRemoteConfigureClientFailure(() => {
        throw forged
      })

      expect(reads).toEqual(['toString'])
      expect(result._tag).toBe('Failure')

      if (Predicate.isTagged(result, 'Failure')) {
        expect(result.failure.message).toBe('Could not configure MCP client: branded-protocol')
        expect(result.failure.cause).toBe('protocol')
      }
    })
  )

  it.effect('lets ProtocolError brand win over SdkError brand without code reads', () =>
    Effect.gen(function* () {
      const reads: Array<string> = []

      const forged = {
        get code() {
          reads.push('code')

          return SdkErrorCode.RequestTimeout
        },
        get message() {
          reads.push('message')

          return 'JSON parse failed'
        },
        toString() {
          reads.push('toString')

          return 'dual-brand'
        }
      }

      Object.defineProperty(forged, mcpErrorBrands, {
        value: new Set(['mcp.ProtocolError', 'mcp.SdkError']),
        enumerable: false,
        configurable: true
      })

      expect(forged instanceof ProtocolError).toBe(true)
      expect(forged instanceof SdkError).toBe(true)

      const result = yield* listRemoteConfigureClientFailure(() => {
        throw forged
      })

      expect(reads).toEqual(['toString'])
      expect(result._tag).toBe('Failure')

      if (Predicate.isTagged(result, 'Failure')) {
        expect(result.failure.message).toBe('Could not configure MCP client: dual-brand')
        expect(result.failure.cause).toBe('protocol')
      }
    })
  )

  it.effect('observes String() projection before Protocol then SdkError Set.has brand probes', () =>
    Effect.gen(function* () {
      const reads: Array<string> = []
      const brandProbes: Array<string> = []

      const forged = {
        get code() {
          reads.push('code')

          return SdkErrorCode.RequestTimeout
        },
        get message() {
          reads.push('message')

          return 'JSON parse failed'
        },
        toString() {
          reads.push('toString')

          return 'brand-probe-order'
        }
      }

      const brands = new Set(['mcp.SdkError'])
      const setHas = brands.has.bind(brands)

      brands.has = (brand: string) => {
        brandProbes.push(brand)
        reads.push(`brand:${brand}`)

        return setHas(brand)
      }

      Object.defineProperty(forged, mcpErrorBrands, {
        value: brands,
        enumerable: false,
        configurable: true
      })

      expect(forged instanceof SdkError).toBe(true)
      expect(forged instanceof ProtocolError).toBe(false)
      expect(forged instanceof Error).toBe(false)

      brandProbes.length = 0
      reads.length = 0

      const result = yield* listRemoteConfigureClientFailure(() => {
        throw forged
      })

      expect(reads[0]).toBe('toString')
      expect(brandProbes).toEqual(['mcp.ProtocolError', 'mcp.SdkError'])
      expect(reads).toEqual(['toString', 'brand:mcp.ProtocolError', 'brand:mcp.SdkError', 'code'])
      expect(result._tag).toBe('Failure')

      if (Predicate.isTagged(result, 'Failure')) {
        expect(result.failure.message).toBe('Could not configure MCP client: brand-probe-order')
        expect(result.failure.cause).toBe('timeout')
      }
    })
  )
})
