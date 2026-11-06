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
import { HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/http'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import { describe, expect, it } from '@effect/vitest'
import { join } from 'node:path'
import {
  AudioPart,
  FileDescriptor,
  ImagePart,
  TextPart,
  inlineBase64Source
} from '@yolk-sdk/agent/protocol'
import { makeToolFileCapture, type FileStoreApi } from '@yolk-sdk/agent/tools'
import {
  JsonRpcMessage,
  listLocalMcpServerTools,
  callLocalMcpServerTool,
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
  | 'blob-result'
  | 'legacy'

const receipt = new TextEncoder().encode('%PDF receipt')

const receiptBlock = {
  type: 'resource',
  resource: {
    uri: 'file:///receipts/receipt.pdf',
    mimeType: 'application/pdf',
    blob: Buffer.from(receipt).toString('base64')
  }
}

const receiptStore: FileStoreApi = {
  put: ({ bytes, name, mimeType }) =>
    Effect.succeed(
      FileDescriptor.make({ fileId: 'file_receipt', name, mimeType, size: bytes.byteLength })
    ),
  head: () => Effect.succeed(Option.none()),
  read: () => Effect.succeed(receipt),
  signRead: ({ fileId }) => Effect.succeed(`https://files.example/${fileId}`)
}

const capturedReceipt = {
  fileId: 'file_receipt',
  name: 'receipt.pdf',
  mimeType: 'application/pdf',
  size: receipt.byteLength
}

const decodeStdinMessage = Schema.decodeUnknownOption(Schema.fromJsonString(JsonRpcMessage))

type LocalAnswer = { readonly result: unknown } | { readonly error: unknown }

/**
 * A local stdio server that answers each request it reads on stdin by method, so a test sees
 * exactly which requests were sent (`sent`) and in which order. Requests without an answer get none.
 */
const makeScriptedLocalMcpLayer = (
  answers: Readonly<Record<string, LocalAnswer>>,
  sent: Array<string>
) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(command =>
      Effect.sync(() => {
        if (!ChildProcess.isStandardCommand(command)) {
          throw new Error('Expected standard command')
        }

        const stdinConfig = command.options.stdin

        const stdin =
          Predicate.isObject(stdinConfig) &&
          Predicate.hasProperty(stdinConfig, 'stream') &&
          Stream.isStream(stdinConfig.stream)
            ? stdinConfig.stream
            : Stream.empty

        const stdout = stdin.pipe(
          Stream.decodeText,
          Stream.splitLines,
          Stream.filter(line => line.length > 0),
          Stream.flatMap(line =>
            Option.match(decodeStdinMessage(line), {
              onNone: () => Stream.empty,
              onSome: message => {
                sent.push(message.method)

                const answer = answers[message.method]

                return 'id' in message && answer !== undefined
                  ? Stream.make(
                      `${JSON.stringify({ jsonrpc: '2.0', id: message.id, ...answer })}\n`
                    )
                  : Stream.empty
              }
            })
          ),
          Stream.encodeText
        )

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
                  : mode === 'blob-result'
                    ? {
                        resultType: 'complete',
                        content: [{ type: 'text', text: 'remote result' }, receiptBlock]
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

  it.effect('applies the exposure option to listed tool definitions', () =>
    Effect.gen(function* () {
      const tools = yield* listRemoteMcpServerTools(
        { name: 'remote', type: 'remote', url: 'https://example.com/mcp' },
        {
          securityPolicy: { allowLocalServers: false, allowDevHttpLocalhost: false },
          exposure: tool =>
            tool.annotations?.['readOnlyHint'] === true
              ? { callableBy: 'codemode', discovery: 'search' }
              : { callableBy: 'model' }
        }
      ).pipe(Effect.provide(makeFakeRemoteMcpLayer('metadata')))

      expect(tools).toMatchObject([
        { mcpToolName: 'search', def: { callableBy: 'codemode', discovery: 'search' } }
      ])
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

  it.effect('validates local structured content against the listed output schema', () =>
    Effect.gen(function* () {
      const initializeResponse =
        '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","capabilities":{},"serverInfo":{"name":"local","version":"0"}}}'

      const toolsResponse = (name: string) =>
        JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          result: {
            tools: [
              {
                name,
                inputSchema: { type: 'object' },
                outputSchema: {
                  type: 'object',
                  properties: { total: { type: 'number' } },
                  required: ['total']
                }
              }
            ]
          }
        })

      const callResponse = (structuredContent: unknown) =>
        JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          result: { content: [{ type: 'text', text: 'done' }], structuredContent }
        })

      const call = (lines: ReadonlyArray<string>) =>
        callLocalMcpServerTool({
          config: {
            name: 'local',
            type: 'local',
            command: ['fake-mcp'],
            environment: { MCP_TOKEN: 'token' }
          },
          mcpToolName: 'sum',
          toolCallId: 'call_1',
          params: {},
          options: { securityPolicy: { allowLocalServers: true, allowDevHttpLocalhost: false } }
        }).pipe(Effect.provide(makeFakeLocalMcpLayer(lines)), Effect.result)

      const valid = yield* call([
        initializeResponse,
        toolsResponse('sum'),
        callResponse({ total: 3 })
      ])

      expect(Predicate.isTagged(valid, 'Success') && valid.success.structuredContent).toEqual({
        value: { total: 3 },
        files: []
      })

      const invalid = yield* call([
        initializeResponse,
        toolsResponse('sum'),
        callResponse({ total: 'three' })
      ])

      expectMcpFailureCause(invalid, 'validation')

      const missing = yield* call([
        initializeResponse,
        toolsResponse('sum'),
        JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          result: { content: [{ type: 'text', text: 'x' }] }
        })
      ])

      expectMcpFailureCause(missing, 'validation')

      // A tool the listing does not hold is not checked.
      const unlisted = yield* call([
        initializeResponse,
        toolsResponse('other'),
        callResponse({ total: 'three' })
      ])

      expect(Predicate.isTagged(unlisted, 'Success')).toBe(true)
    })
  )

  describe('local calls list before they call', () => {
    const initialized = {
      result: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        serverInfo: { name: 'local', version: '0' }
      }
    }

    const totalSchema = {
      type: 'object',
      properties: { total: { type: 'number' } },
      required: ['total']
    }

    const listing = (tool: Schema.Json) => ({ result: { tools: [tool] } })

    const answered = (structuredContent: unknown) => ({
      result: { content: [{ type: 'text', text: 'done' }], structuredContent }
    })

    const call = (answers: Readonly<Record<string, LocalAnswer>>) =>
      Effect.gen(function* () {
        const sent: Array<string> = []

        const result = yield* callLocalMcpServerTool({
          config: { name: 'local', type: 'local', command: ['fake-mcp'] },
          mcpToolName: 'sum',
          toolCallId: 'call_1',
          params: {},
          options: { securityPolicy: { allowLocalServers: true, allowDevHttpLocalhost: false } },
          fileCapture: makeToolFileCapture({ store: receiptStore })
        }).pipe(Effect.provide(makeScriptedLocalMcpLayer(answers, sent)), Effect.result)

        return { result, sent }
      })

    const listedAndCalled = ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']

    const listedOnly = ['initialize', 'notifications/initialized', 'tools/list']

    it.effect('sends no tools/call when the output schema is unusable or does not compile', () =>
      Effect.gen(function* () {
        const unusable = [
          { name: 'sum', inputSchema: { type: 'object' }, outputSchema: 42 },
          {
            name: 'sum',
            inputSchema: { type: 'object' },
            outputSchema: { type: 'object', properties: { a: { type: 'string', pattern: '(' } } }
          }
        ]

        for (const tool of unusable) {
          const { result, sent } = yield* call({
            initialize: initialized,
            'tools/list': listing(tool),
            'tools/call': answered({ total: 3 })
          })

          expectMcpFailureCause(result, 'validation')
          expect(Predicate.isTagged(result, 'Failure') && result.failure.message).toContain(
            "Tool 'sum' has an invalid outputSchema"
          )
          expect(sent).toEqual(listedOnly)
        }
      })
    )

    it.effect('sends no tools/call when initialize fails', () =>
      Effect.gen(function* () {
        const { result, sent } = yield* call({
          initialize: { error: { code: -32603, message: 'boom' } },
          'tools/list': listing({ name: 'sum', inputSchema: { type: 'object' } }),
          'tools/call': answered({ total: 3 })
        })

        expectMcpFailureCause(result, 'protocol')
        expect(sent).not.toContain('tools/call')
      })
    )

    it.effect('still calls, unvalidated, when the listing fails or lacks the tool', () =>
      Effect.gen(function* () {
        const listings: ReadonlyArray<LocalAnswer> = [
          { error: { code: -32601, message: 'Method not found' } },
          { result: { tools: 'not a list' } },
          { result: { tools: [{ name: 'other', outputSchema: totalSchema }], nextCursor: 'p2' } }
        ]

        for (const toolsList of listings) {
          const { result, sent } = yield* call({
            initialize: initialized,
            'tools/list': toolsList,
            'tools/call': answered({ total: 'three' })
          })

          expect(sent).toEqual(listedAndCalled)
          expect(Predicate.isTagged(result, 'Success') && result.success.structuredContent).toEqual(
            { value: { total: 'three' }, files: [] }
          )
        }
      })
    )

    it.effect('validates a tool whose input schema lacks type against its output schema', () =>
      Effect.gen(function* () {
        const tool = { name: 'sum', inputSchema: {}, outputSchema: totalSchema }

        const valid = yield* call({
          initialize: initialized,
          'tools/list': listing(tool),
          'tools/call': answered({ total: 3 })
        })

        expect(valid.sent).toEqual(listedAndCalled)
        expect(Predicate.isTagged(valid.result, 'Success')).toBe(true)

        const invalid = yield* call({
          initialize: initialized,
          'tools/list': listing(tool),
          'tools/call': answered({ total: 'three' })
        })

        expect(invalid.sent).toEqual(listedAndCalled)
        expectMcpFailureCause(invalid.result, 'validation')
      })
    )

    it.effect('stores blobs through the fileCapture option', () =>
      Effect.gen(function* () {
        const { result } = yield* call({
          initialize: initialized,
          'tools/list': listing({ name: 'sum', inputSchema: { type: 'object' } }),
          'tools/call': { result: { content: [receiptBlock] } }
        })

        expect(Predicate.isTagged(result, 'Success') && result.success.structuredContent).toEqual({
          value: null,
          files: [capturedReceipt]
        })
      })
    )
  })

  it.effect('stores remote blobs through the fileCapture option', () =>
    Effect.gen(function* () {
      const input = {
        config: { name: 'remote', type: 'remote' as const, url: 'https://example.com/mcp' },
        mcpToolName: 'search',
        toolCallId: 'call_1',
        params: {},
        options: { securityPolicy: { allowLocalServers: false, allowDevHttpLocalhost: false } }
      }

      const captured = yield* callRemoteMcpServerTool({
        ...input,
        fileCapture: makeToolFileCapture({ store: receiptStore })
      }).pipe(Effect.provide(makeFakeRemoteMcpLayer('blob-result')))

      expect(captured.structuredContent).toEqual({
        value: 'remote result',
        files: [capturedReceipt]
      })
      expect(captured.files).toEqual([FileDescriptor.make(capturedReceipt)])

      const uncaptured = yield* callRemoteMcpServerTool(input).pipe(
        Effect.provide(makeFakeRemoteMcpLayer('blob-result'))
      )

      expect(uncaptured.structuredContent).toEqual({
        value: 'remote result',
        files: [{ unavailable: 'no file store', name: 'receipt.pdf', mimeType: 'application/pdf' }]
      })
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
