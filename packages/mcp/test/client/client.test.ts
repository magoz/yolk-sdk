import {
  Duration,
  Effect,
  Fiber,
  Layer,
  Logger,
  Option,
  Predicate,
  Queue,
  References,
  Sink,
  Stream,
  type Cause,
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
import type {
  McpClientOptions,
  McpLocalServerConfig,
  McpRemoteServerConfig,
  McpServerConfig
} from '../../src/client'

const stdioFixturePath = process.cwd().endsWith(join('packages', 'mcp'))
  ? join(process.cwd(), 'test/server/fixtures/fake-stdio-mcp-server.ts')
  : join(process.cwd(), 'packages/mcp/test/server/fixtures/fake-stdio-mcp-server.ts')

const tsxCliPath = process.cwd().endsWith(join('packages', 'mcp'))
  ? join(process.cwd(), '../../node_modules/tsx/dist/cli.mjs')
  : join(process.cwd(), 'node_modules/tsx/dist/cli.mjs')

// Runs `answer` once the client has written `initialize`, `notifications/initialized` and
// `tools/list` (the client keeps stdin open until it has its answers).
const afterListingRequestsStdioScript = (answer: string) => `
let buffer = '';
let lines = 0;
process.stdin.on('data', chunk => {
  buffer += chunk;
  const parts = buffer.split('\\n');
  buffer = parts.pop();
  lines += parts.filter(part => part.length > 0).length;
  if (lines === 3) {
    ${answer}
  }
});
`

const outOfOrderStdioScript = afterListingRequestsStdioScript(`
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }] } }) + '\\n');
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'local', version: '0' } } }) + '\\n');
`)

const initializeErrorStdioScript = afterListingRequestsStdioScript(`
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }] } }) + '\\n');
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'init failed' } }) + '\\n');
`)

/**
 * A stdio server that pings, logs, and asks for roots, and answers each client request only after
 * the client has answered its own request on stdin: `initialize` after an empty result to its
 * `ping`, `tools/list` after "Method not found" for `roots/list`, `tools/call` after an empty
 * result to a ping whose id (1) equals a client request id.
 */
const requestingStdioScript = `
const readline = require('node:readline');
const write = message => process.stdout.write(JSON.stringify(message) + '\\n');
const waiting = new Map();
const ask = (request, check, then) => {
  waiting.set(request.id, reply => { if (check(reply)) then(); });
  write({ jsonrpc: '2.0', ...request });
};
const emptyResult = id => reply => JSON.stringify(reply) === JSON.stringify({ jsonrpc: '2.0', id, result: {} });
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.method === undefined) {
    const next = waiting.get(message.id);
    waiting.delete(message.id);
    if (next !== undefined) next(message);
    return;
  }
  if (message.id === undefined) return;
  const answer = result => write({ jsonrpc: '2.0', id: message.id, result });
  if (message.method === 'initialize') {
    ask({ id: 'srv-ping', method: 'ping' }, emptyResult('srv-ping'), () => {
      write({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'ready' } });
      answer({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'local', version: '0' } });
    });
  } else if (message.method === 'tools/list') {
    ask({ id: 'srv-roots', method: 'roots/list' }, reply => reply.error && reply.error.code === -32601, () =>
      answer({ tools: [{ name: 'echo', inputSchema: { type: 'object' } }] })
    );
  } else if (message.method === 'tools/call') {
    ask({ id: 1, method: 'ping' }, emptyResult(1), () =>
      answer({ content: [{ type: 'text', text: 'answered after a ping' }] })
    );
  }
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

type LocalAnswer = (
  | { readonly result: unknown }
  | { readonly error: unknown }
  // A stdout line written as is instead of a JSON-RPC response.
  | { readonly line: string }
) & {
  // Stdout lines written before the answer (a server's own requests and notifications).
  readonly before?: ReadonlyArray<string>
}

/**
 * A local stdio server that answers each request it reads on stdin by method, so a test sees
 * exactly which requests were sent (`sent`) and in which order. Requests without an answer get none.
 * Stdin lines that are no request or notification (the client's answers to server requests) are
 * kept as written in `replies`.
 */
const makeScriptedLocalMcpLayer = (
  answers: Readonly<Record<string, LocalAnswer>>,
  sent: Array<string>,
  replies: Array<string> = []
) =>
  Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.gen(function* () {
      // The layer's scope ends when the effect it is provided to finishes, after the client's own
      // scope.
      const layerScope = yield* Effect.scope

      return ChildProcessSpawner.make(command =>
        Effect.gen(function* () {
          if (!ChildProcess.isStandardCommand(command)) {
            return yield* Effect.die(new Error('Expected standard command'))
          }

          const stdinConfig = command.options.stdin

          const stdin =
            Predicate.isObject(stdinConfig) &&
            Predicate.hasProperty(stdinConfig, 'stream') &&
            Stream.isStream(stdinConfig.stream)
              ? stdinConfig.stream
              : Stream.empty

          // Reads stdin on its own fiber in the layer's scope. It outlives the client's scope, so
          // `sent` holds every request the client wrote even when it stopped reading stdout or
          // failed right after writing, and it ends with that scope instead of waiting forever.
          const out = yield* Queue.unbounded<string, Cause.Done>()

          yield* stdin.pipe(
            Stream.decodeText,
            Stream.splitLines,
            Stream.filter(line => line.length > 0),
            Stream.runForEach(line =>
              Option.match(decodeStdinMessage(line), {
                onNone: () => Effect.sync(() => replies.push(line)),
                onSome: message => {
                  sent.push(message.method)

                  const answer = answers[message.method]

                  if (!('id' in message) || answer === undefined) return Effect.void

                  const reply =
                    'line' in answer
                      ? answer.line
                      : JSON.stringify({
                          jsonrpc: '2.0',
                          id: message.id,
                          ...('result' in answer
                            ? { result: answer.result }
                            : { error: answer.error })
                        })

                  return Queue.offerAll(
                    out,
                    [...(answer.before ?? []), reply].map(written => `${written}\n`)
                  )
                }
              })
            ),
            Effect.ensuring(Queue.end(out)),
            Effect.ignore,
            Effect.forkIn(layerScope)
          )

          const stdout = Stream.fromQueue(out).pipe(Stream.encodeText)

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
    })
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

/** How the fake legacy server answers the client's `DELETE` of its session. */
type DeleteAnswer = { readonly status: number } | 'never'

type RecordedRequest = {
  readonly method: string
  readonly authorization: string | undefined
  readonly rpcMethod: string | undefined
  readonly session: string | undefined
  readonly protocolVersion: string | undefined
}

/**
 * A remote server that records every request: legacy (the era probe refused, an `initialize`
 * handshake issuing `session` when given, the standing GET 405, the `DELETE` answered as told), or
 * modern (stateless, though every answer carries `mcp-session-id: session` when given). Answers
 * are JSON.
 */
const makeSessionRemoteMcpLayer = (input: {
  readonly era: 'legacy' | 'modern'
  readonly session?: string
  readonly deleteAnswer?: DeleteAnswer
  readonly callAnswersError?: boolean
  /** `tools/call` is never answered (the operation hangs until it is interrupted). */
  readonly callHangs?: boolean
  readonly requests: Array<RecordedRequest>
}): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(request =>
      Effect.gen(function* () {
        const message = yield* requestMessage(request)
        const rpcMethod = request.method === 'POST' ? message.method : undefined

        input.requests.push({
          method: request.method,
          authorization: request.headers['authorization'],
          rpcMethod,
          session: request.headers['mcp-session-id'],
          protocolVersion: request.headers['mcp-protocol-version']
        })

        const sessionHeaders: Record<string, string> =
          input.session === undefined ? {} : { 'mcp-session-id': input.session }

        const answer = (status: number, body?: unknown, headers: Record<string, string> = {}) =>
          HttpClientResponse.fromWeb(
            request,
            new Response(body === undefined ? null : JSON.stringify(body), {
              status,
              headers:
                body === undefined ? headers : { 'content-type': 'application/json', ...headers }
            })
          )

        if (request.method === 'DELETE') {
          const deleteAnswer = input.deleteAnswer ?? { status: 200 }

          return deleteAnswer === 'never' ? yield* Effect.never : answer(deleteAnswer.status)
        }

        if (request.method === 'GET') return answer(405)

        if (rpcMethod === 'tools/call' && input.callHangs === true) return yield* Effect.never

        if (rpcMethod === 'notifications/initialized') return answer(202)

        const modern = input.era === 'modern'

        if (rpcMethod === 'server/discover' && !modern) {
          return answer(400, {
            jsonrpc: '2.0',
            id: null,
            error: { code: -32_000, message: 'Bad Request: Server not initialized' }
          })
        }

        const complete = modern ? { resultType: 'complete', ttlMs: 0, cacheScope: 'private' } : {}

        const result = () => {
          switch (rpcMethod) {
            case 'server/discover':
              return {
                ...complete,
                supportedVersions: ['2026-07-28'],
                capabilities: { tools: {} },
                _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'remote', version: '0' } }
              }
            case 'initialize':
              return {
                protocolVersion: '2025-11-25',
                capabilities: { tools: {} },
                serverInfo: { name: 'remote', version: '0' }
              }
            case 'tools/list':
              return { ...complete, tools: [{ name: 'search', inputSchema: { type: 'object' } }] }
            default:
              return { ...complete, content: [{ type: 'text', text: 'remote result' }] }
          }
        }

        return answer(
          200,
          rpcMethod === 'tools/call' && input.callAnswersError === true
            ? { jsonrpc: '2.0', id: message.id, error: { code: -32_603, message: 'boom' } }
            : { jsonrpc: '2.0', id: message.id, result: result() },
          sessionHeaders
        )
      })
    )
  )

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

  describe('a closing legacy client ends its session with DELETE', () => {
    const authorization = 'Bearer synthetic-remote-token'

    const config: McpRemoteServerConfig = {
      name: 'remote',
      type: 'remote',
      url: 'https://example.com/mcp',
      headers: { authorization }
    }

    const options = { securityPolicy: { allowLocalServers: false, allowDevHttpLocalhost: false } }

    const call = (callOptions: McpClientOptions = options) =>
      callRemoteMcpServerTool({
        config,
        mcpToolName: 'search',
        toolCallId: 'call_1',
        params: {},
        options: callOptions
      })

    const terminationFailed = 'MCP session termination failed; the server will expire the session'

    const deletes = (requests: ReadonlyArray<RecordedRequest>) =>
      requests.filter(request => request.method === 'DELETE')

    // The messages (with their values) of the debug logs written while `effect` runs.
    const withDebugLogs = <A, E>(effect: Effect.Effect<A, E>) =>
      Effect.gen(function* () {
        const messages: Array<unknown> = []

        const result = yield* effect.pipe(
          Effect.provide(Logger.layer([Logger.make(entry => messages.push(entry.message))])),
          Effect.provideService(References.MinimumLogLevel, 'Debug')
        )

        return { result, messages }
      })

    it.effect('after a listing and after a call, with the session id', () =>
      Effect.gen(function* () {
        const requests: Array<RecordedRequest> = []
        const layer = makeSessionRemoteMcpLayer({ era: 'legacy', session: 'session-1', requests })

        yield* listRemoteMcpServerTools(config, options).pipe(Effect.provide(layer))

        expect(requests.at(-1)).toEqual({
          method: 'DELETE',
          authorization,
          rpcMethod: undefined,
          session: 'session-1',
          protocolVersion: '2025-11-25'
        })

        requests.length = 0

        const result = yield* call().pipe(Effect.provide(layer))

        expect(result.content).toBe('remote result')
        expect(requests.map(request => request.rpcMethod ?? request.method)).toEqual([
          'server/discover',
          'initialize',
          'notifications/initialized',
          'GET',
          'tools/list',
          'tools/call',
          'DELETE'
        ])
        expect(deletes(requests)).toHaveLength(1)
      })
    )

    it.effect('after a failed call too, which still fails as before', () =>
      Effect.gen(function* () {
        const requests: Array<RecordedRequest> = []

        const result = yield* call().pipe(
          Effect.provide(
            makeSessionRemoteMcpLayer({
              era: 'legacy',
              session: 'session-1',
              callAnswersError: true,
              requests
            })
          ),
          Effect.result
        )

        expectMcpFailureCause(result, 'protocol')
        expect(deletes(requests)).toEqual([
          {
            method: 'DELETE',
            authorization,
            rpcMethod: undefined,
            session: 'session-1',
            protocolVersion: '2025-11-25'
          }
        ])
      })
    )

    it.effect('a 405 or 404 is accepted silently; another answer only logs at debug level', () =>
      Effect.gen(function* () {
        // 405: the server does not let clients end sessions; 404: the session is already gone.
        const answers: ReadonlyArray<readonly [number, boolean]> = [
          [405, false],
          [404, false],
          [400, true],
          [500, true]
        ]

        for (const [status, logged] of answers) {
          const requests: Array<RecordedRequest> = []

          const { result, messages } = yield* withDebugLogs(
            call().pipe(
              Effect.provide(
                makeSessionRemoteMcpLayer({
                  era: 'legacy',
                  session: 'session-1',
                  deleteAnswer: { status },
                  requests
                })
              )
            )
          )

          expect(result.content, String(status)).toBe('remote result')
          expect(deletes(requests), String(status)).toHaveLength(1)
          expect(messages, String(status)).toEqual(
            logged ? [[terminationFailed, { server: 'remote', outcome: `HTTP ${status}` }]] : []
          )
        }
      })
    )

    it.live('a DELETE left unanswered delays the result only up to its short timeout', () =>
      Effect.gen(function* () {
        const requests: Array<RecordedRequest> = []
        const started = Date.now()

        const { result, messages } = yield* withDebugLogs(
          call({ ...options, timeoutMs: 300 }).pipe(
            Effect.provide(
              makeSessionRemoteMcpLayer({
                era: 'legacy',
                session: 'session-1',
                deleteAnswer: 'never',
                requests
              })
            )
          )
        )

        expect(result.content).toBe('remote result')
        expect(deletes(requests)).toHaveLength(1)
        expect(messages).toEqual([[terminationFailed, { server: 'remote', outcome: 'timed out' }]])
        expect(Date.now() - started).toBeLessThan(2_000)
      })
    )

    it.effect('a throwing client while ending the session never replaces the result', () =>
      Effect.gen(function* () {
        const requests: Array<RecordedRequest> = []

        const { result, messages } = yield* withDebugLogs(
          listRemoteMcpServerTools(config, {
            ...options,
            configureClient: client => {
              // The era reads throw once the listing is done: only the session end reads it then.
              let listed = false
              const listTools = client.listTools.bind(client)
              const era = client.getProtocolEra.bind(client)

              client.listTools = async (...args: Parameters<typeof listTools>) => {
                const listing = await listTools(...args)

                listed = true

                return listing
              }

              client.getProtocolEra = () => {
                if (listed) throw new Error('synthetic getter failure')

                return era()
              }
            }
          }).pipe(
            Effect.provide(
              makeSessionRemoteMcpLayer({ era: 'legacy', session: 'session-1', requests })
            )
          )
        )

        expect(result.map(tool => tool.def.name)).toEqual(['remote_search'])
        expect(deletes(requests)).toEqual([])
        expect(messages).toEqual([[terminationFailed, { server: 'remote', outcome: 'defect' }]])
        expect(requests.some(request => request.rpcMethod === 'tools/list')).toBe(true)
      })
    )

    it.live('an interrupted operation closes at once and sends no DELETE', () =>
      Effect.gen(function* () {
        const requests: Array<RecordedRequest> = []

        const fiber = yield* call({ ...options, timeoutMs: 10_000 }).pipe(
          Effect.provide(
            makeSessionRemoteMcpLayer({
              era: 'legacy',
              session: 'session-1',
              // Were a DELETE sent, it would hold the interrupt for its whole timeout.
              deleteAnswer: 'never',
              callHangs: true,
              requests
            })
          ),
          Effect.forkChild
        )

        while (!requests.some(request => request.rpcMethod === 'tools/call')) {
          yield* Effect.sleep(Duration.millis(5))
        }

        const started = Date.now()

        yield* Fiber.interrupt(fiber)

        expect(Date.now() - started).toBeLessThan(1_000)
        expect(deletes(requests)).toEqual([])
      })
    )

    it.effect('nothing is sent without a session id, or on a modern connection', () =>
      Effect.gen(function* () {
        const sessionless: Array<RecordedRequest> = []

        yield* call().pipe(
          Effect.provide(makeSessionRemoteMcpLayer({ era: 'legacy', requests: sessionless }))
        )

        expect(sessionless.map(request => request.rpcMethod ?? request.method)).toEqual([
          'server/discover',
          'initialize',
          'notifications/initialized',
          'GET',
          'tools/list',
          'tools/call'
        ])

        // A modern answer carrying a session id does not make the connection stateful.
        const modern: Array<RecordedRequest> = []

        yield* call().pipe(
          Effect.provide(
            makeSessionRemoteMcpLayer({ era: 'modern', session: 'session-1', requests: modern })
          )
        )

        expect(modern.map(request => request.rpcMethod ?? request.method)).toEqual([
          'server/discover',
          'tools/list',
          'tools/call'
        ])
      })
    )
  })

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

        // The fake server's stdin reader lives in this layer's scope, so the drain below stays
        // inside it: the reader records the client's last write before the scope ends.
        const result = yield* Effect.gen(function* () {
          const outcome = yield* callLocalMcpServerTool({
            config: { name: 'local', type: 'local', command: ['fake-mcp'] },
            mcpToolName: 'sum',
            toolCallId: 'call_1',
            params: {},
            options: { securityPolicy: { allowLocalServers: true, allowDevHttpLocalhost: false } },
            fileCapture: makeToolFileCapture({ store: receiptStore })
          }).pipe(Effect.result)

          for (let turn = 0; turn < 20; turn++) yield* Effect.yieldNow

          return outcome
        }).pipe(Effect.provide(makeScriptedLocalMcpLayer(answers, sent)))

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

    it.effect('sends no tools/call when the session breaks before the listing answers', () =>
      Effect.gen(function* () {
        const { result, sent } = yield* call({
          initialize: initialized,
          'tools/list': { line: 'server log line, not JSON-RPC' },
          'tools/call': answered({ total: 3 })
        })

        expect(Predicate.isTagged(result, 'Failure')).toBe(true)
        expect(sent).toEqual(listedOnly)
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

  describe('local servers may ping, ask, and notify', () => {
    const localOptions = {
      securityPolicy: { allowLocalServers: true, allowDevHttpLocalhost: false }
    }

    const config: McpLocalServerConfig = { name: 'local', type: 'local', command: ['fake-mcp'] }

    const initialized = {
      result: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        serverInfo: { name: 'local', version: '0' }
      }
    }

    const listing = { result: { tools: [{ name: 'sum', inputSchema: { type: 'object' } }] } }

    const answered = { result: { content: [{ type: 'text', text: 'done' }] } }

    const ping = (id: string | number) => JSON.stringify({ jsonrpc: '2.0', id, method: 'ping' })

    const pong = (id: string | number) => JSON.stringify({ jsonrpc: '2.0', id, result: {} })

    const log = JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/message',
      params: { level: 'info', data: 'server log' }
    })

    const roots = JSON.stringify({ jsonrpc: '2.0', id: 'srv-roots', method: 'roots/list' })

    const methodNotFound = JSON.stringify({
      jsonrpc: '2.0',
      id: 'srv-roots',
      error: { code: -32601, message: 'Method not found' }
    })

    // Runs `effect` against the scripted server and drains its stdin reader before its scope ends.
    const scripted = <A>(
      answers: Readonly<Record<string, LocalAnswer>>,
      effect: Effect.Effect<A, McpError, ChildProcessSpawner.ChildProcessSpawner>
    ) =>
      Effect.gen(function* () {
        const sent: Array<string> = []
        const replies: Array<string> = []

        const result = yield* Effect.gen(function* () {
          const outcome = yield* Effect.result(effect)

          for (let turn = 0; turn < 20; turn++) yield* Effect.yieldNow

          return outcome
        }).pipe(Effect.provide(makeScriptedLocalMcpLayer(answers, sent, replies)))

        return { result, sent, replies }
      })

    const call = callLocalMcpServerTool({
      config,
      mcpToolName: 'sum',
      toolCallId: 'call_1',
      params: {},
      options: localOptions
    })

    it.effect('a call answers pings before and between responses and ignores notifications', () =>
      Effect.gen(function* () {
        const { result, sent, replies } = yield* scripted(
          {
            initialize: { ...initialized, before: [ping('srv-1'), log] },
            // A server request id may equal a client request id: they are separate id spaces.
            'tools/list': { ...listing, before: [ping(1)] },
            'tools/call': { ...answered, before: [log, ping('srv-3'), log] }
          },
          call
        )

        expect(Predicate.isTagged(result, 'Success') && result.success.content).toBe('done')
        expect(sent).toEqual([
          'initialize',
          'notifications/initialized',
          'tools/list',
          'tools/call'
        ])
        expect(replies).toEqual([pong('srv-1'), pong(1), pong('srv-3')])
      })
    )

    it.effect('a listing answers pings and other server requests, and ignores notifications', () =>
      Effect.gen(function* () {
        const { result, sent, replies } = yield* scripted(
          {
            initialize: { ...initialized, before: [log, ping('srv-1')] },
            'tools/list': { ...listing, before: [roots, log] }
          },
          listLocalMcpServerTools(config, localOptions)
        )

        expect(
          Predicate.isTagged(result, 'Success') && result.success.map(tool => tool.def.name)
        ).toEqual(['local_sum'])
        expect(sent).toEqual(['initialize', 'notifications/initialized', 'tools/list'])
        expect(replies).toEqual([pong('srv-1'), methodNotFound])
      })
    )

    it.effect('a server request other than ping gets Method not found and the call goes on', () =>
      Effect.gen(function* () {
        const { result, sent, replies } = yield* scripted(
          {
            initialize: initialized,
            'tools/list': listing,
            'tools/call': { ...answered, before: [roots] }
          },
          call
        )

        expect(Predicate.isTagged(result, 'Success')).toBe(true)
        expect(sent).toEqual([
          'initialize',
          'notifications/initialized',
          'tools/list',
          'tools/call'
        ])
        expect(replies).toEqual([methodNotFound])
      })
    )

    it.effect('a line that is no JSON-RPC message still breaks the session before the call', () =>
      Effect.gen(function* () {
        const malformed: ReadonlyArray<[string, McpError['cause']]> = [
          // MCP forbids a null request id: not a notification either.
          ['{"jsonrpc":"2.0","id":null,"method":"ping"}', 'validation'],
          ['{"jsonrpc":"2.0","method":7}', 'validation'],
          // MCP params are an object: scalar params make a request or notification malformed.
          ['{"jsonrpc":"2.0","id":7,"method":"ping","params":42}', 'validation'],
          ['{"jsonrpc":"2.0","method":"notifications/message","params":"log"}', 'validation'],
          ['{"jsonrpc":"2.0","id":"srv-2","method":"roots/list","params":[1]}', 'validation'],
          ['{"jsonrpc":"2.0","id":7}', 'validation'],
          ['42', 'validation'],
          ['server log line, not JSON-RPC', 'parse']
        ]

        for (const [line, cause] of malformed) {
          const { result, sent, replies } = yield* scripted(
            {
              initialize: initialized,
              'tools/list': { ...listing, before: [line] },
              'tools/call': answered
            },
            call
          )

          expectMcpFailureCause(result, cause)
          expect(sent, line).toEqual(['initialize', 'notifications/initialized', 'tools/list'])
          expect(replies, line).toEqual([])
        }
      })
    )

    it.live(
      'a real server that waits for the answers to its requests is served',
      () =>
        Effect.gen(function* () {
          const local: McpServerConfig = {
            name: 'local',
            type: 'local',
            command: [process.execPath, '-e', requestingStdioScript]
          }

          const options = { ...localOptions, timeoutMs: 10_000 }
          const tools = yield* listLocalMcpServerToolsNode(local, options)

          expect(tools.map(tool => tool.def.name)).toEqual(['local_echo'])

          const result = yield* callLocalMcpServerToolNode({
            config: local,
            mcpToolName: 'echo',
            toolCallId: 'call_1',
            params: {},
            options
          })

          expect(result.content).toBe('answered after a ping')
        }),
      30_000
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
