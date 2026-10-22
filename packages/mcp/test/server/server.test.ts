import { Context, Deferred, Effect, Fiber, Layer, Option, Predicate, Result } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import {
  AudioPart,
  DocumentPart,
  FilePart,
  ImagePart,
  TextPart,
  ToolDef,
  ToolResult,
  inlineBase64Source,
  refAttachmentSource
} from '@yolk-sdk/agent/protocol'
import { McpServerError, makeMcpToolServer } from '../../src/server'

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))

const server = makeMcpToolServer({
  name: 'test-server',
  version: '0',
  tools: [
    {
      def: ToolDef.make({ name: 'echo', description: 'Echo', parameters: { type: 'object' } }),
      execute: call =>
        Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'server result' }))
    }
  ]
})

const failingServer = makeMcpToolServer({
  name: 'test-server',
  version: '0',
  tools: [
    {
      def: ToolDef.make({ name: 'fail', description: 'Fail', parameters: { type: 'object' } }),
      execute: () => Effect.fail(new McpServerError({ message: 'boom', cause: 'tool_error' }))
    }
  ]
})

const richResultServer = makeMcpToolServer({
  name: 'test-server',
  version: '0',
  tools: [
    {
      def: ToolDef.make({ name: 'rich', description: 'Rich', parameters: { type: 'object' } }),
      execute: call =>
        Effect.succeed(
          ToolResult.make({
            toolCallId: call.id,
            content: [
              TextPart.make({ text: 'hello' }),
              ImagePart.make({ source: inlineBase64Source('abc'), mimeType: 'image/png' }),
              DocumentPart.make({
                source: inlineBase64Source('ghi='),
                mimeType: 'application/pdf',
                filename: 'brief v1.pdf'
              }),
              AudioPart.make({ source: inlineBase64Source('def'), mimeType: 'audio/mpeg' }),
              FilePart.make({
                source: inlineBase64Source('emlw'),
                mimeType: 'application/zip',
                filename: 'out.zip'
              }),
              FilePart.make({
                source: refAttachmentSource('file_abc'),
                mimeType: 'application/zip',
                filename: 'kept.zip',
                size: 3
              })
            ],
            isError: true,
            structuredContent: { ok: true }
          })
        )
    }
  ]
})

const isJsonObject = (value: Schema.Json): value is Schema.JsonObject =>
  Predicate.isObjectOrArray(value) && !Array.isArray(value)

const requestLine = (value: Schema.Json) =>
  JSON.stringify(
    Option.getOrThrowWith(
      Schema.decodeUnknownOption(Schema.Json)(value),
      () => new Error('Expected JSON fixture')
    )
  )

const handleJson = (value: Schema.Json) =>
  Effect.gen(function* () {
    const json = yield* Schema.decodeUnknownEffect(Schema.Json)(value)
    const response = yield* server.handleLine(JSON.stringify(json))

    if (Option.isNone(response)) {
      return yield* Effect.fail(new Error('Expected MCP response'))
    }

    return yield* decodeJson(response.value)
  })

const handleHttpJson = (value: Schema.Json) =>
  Effect.gen(function* () {
    const json = yield* Schema.decodeUnknownEffect(Schema.Json)(value)

    const response = yield* server.handleHttpRequest(
      new Request('https://example.com/mcp', { method: 'POST', body: JSON.stringify(json) })
    )

    const body = yield* Effect.promise(() => response.text())

    return yield* decodeJson(body)
  })

const modernMeta = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'test-client', version: '1.0.0' }
}

const modernHttpRequest = (input: {
  readonly method: string
  readonly id?: string | number
  readonly params?: Schema.JsonObject
  readonly headers?: Readonly<Record<string, string>>
  readonly signal?: AbortSignal
}) => {
  const params = Option.getOrThrowWith(
    Option.filter(Schema.decodeUnknownOption(Schema.Json)(input.params ?? {}), isJsonObject),
    () => new Error('Expected JSON object fixture params')
  )

  return new Request('https://example.com/mcp', {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-method': input.method,
      'mcp-protocol-version': '2026-07-28',
      ...(input.headers ?? {})
    },
    body: requestLine({
      jsonrpc: '2.0',
      id: input.id ?? 1,
      method: input.method,
      params: { ...params, _meta: modernMeta }
    }),
    signal: input.signal ?? null
  })
}

/** A 2025-era Streamable HTTP POST without a session: the SDK answers it with an SSE stream. */
const legacyStreamableHttpRequest = (
  body: Schema.Json,
  options?: {
    readonly signal?: AbortSignal
    readonly headers?: Readonly<Record<string, string>>
  }
) =>
  new Request('https://example.com/mcp', {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-protocol-version': '2025-06-18',
      ...options?.headers
    },
    body: requestLine(body),
    signal: options?.signal ?? null
  })

const sseMessages = (body: string) =>
  Effect.forEach(
    body.split('\n').flatMap(line => (line.startsWith('data: ') ? [line.slice(6)] : [])),
    data => decodeJson(data)
  )

/** A host resource that only lives as long as the scope that provides it, like an HTTP agent. */
class ScopedResource extends Context.Service<ScopedResource, { readonly isOpen: () => boolean }>()(
  'test/ScopedResource'
) {}

const ScopedResourceLive = Layer.effect(
  ScopedResource,
  Effect.gen(function* () {
    const state = { open: true }

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        state.open = false
      })
    )

    return ScopedResource.of({ isOpen: () => state.open })
  })
)

const scopedResourceServer = makeMcpToolServer({
  name: 'test-server',
  version: '0',
  tools: [
    {
      def: ToolDef.make({ name: 'scoped', description: 'Scoped', parameters: { type: 'object' } }),
      execute: call =>
        Effect.gen(function* () {
          const resource = yield* ScopedResource

          // Real async work, so the tool is still running when the HTTP response is produced.
          yield* Effect.sleep('10 millis')

          return ToolResult.make({
            toolCallId: call.id,
            content: resource.isOpen() ? 'resource open' : 'resource released'
          })
        })
    }
  ]
})

/**
 * A server whose one tool waits until interrupted. Its interruption finalizer does real async work
 * and then reports whether the scoped resource is still open.
 */
const waitingServer = (started: Deferred.Deferred<void>, finalized: Deferred.Deferred<boolean>) =>
  makeMcpToolServer({
    name: 'test-server',
    version: '0',
    tools: [
      {
        def: ToolDef.make({ name: 'wait', description: 'Wait', parameters: { type: 'object' } }),
        execute: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() =>
              Effect.gen(function* () {
                const resource = yield* ScopedResource

                yield* Effect.sleep('10 millis')
                yield* Deferred.succeed(finalized, resource.isOpen())
              })
            )
          )
      }
    ]
  })

/**
 * Cancels a running tool call, by the client aborting its request or by the host interrupting
 * `handleHttpRequest`. The tool must be interrupted, and its finalizer must finish before
 * `handleHttpRequest` ends, while the caller's scope is open.
 */
const expectCancelledToolInterrupted = (
  request: (signal: AbortSignal) => Request,
  cancelledBy: 'client' | 'host' = 'client'
) =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const finalized = yield* Deferred.make<boolean>()
    const controller = new AbortController()

    const exchange = yield* Effect.forkChild(
      waitingServer(started, finalized)
        .handleHttpRequest(request(controller.signal))
        .pipe(Effect.provide(ScopedResourceLive), Effect.scoped)
    )

    yield* Deferred.await(started).pipe(Effect.timeout('1 second'))

    if (cancelledBy === 'client') {
      controller.abort()
      yield* Fiber.join(exchange).pipe(Effect.timeout('1 second'))
    } else {
      yield* Fiber.interrupt(exchange).pipe(Effect.timeout('1 second'))
    }

    expect(yield* Deferred.isDone(finalized)).toBe(true)
    expect(yield* Deferred.await(finalized)).toBe(true)
  })

describe('MCP tool server', () => {
  it.effect('handles initialize', () =>
    Effect.gen(function* () {
      const response = yield* handleJson({ jsonrpc: '2.0', id: 1, method: 'initialize' })

      expect(response).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        result: { serverInfo: { name: 'test-server', version: '0' } }
      })
    })
  )

  it.effect('lists tools', () =>
    Effect.gen(function* () {
      const response = yield* handleJson({ jsonrpc: '2.0', id: 2, method: 'tools/list' })

      expect(response).toMatchObject({
        jsonrpc: '2.0',
        id: 2,
        result: { tools: [{ name: 'echo', description: 'Echo' }] }
      })
    })
  )

  it.effect('calls tools', () =>
    Effect.gen(function* () {
      const response = yield* handleJson({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'echo', arguments: { text: 'hello' } }
      })

      expect(response).toMatchObject({
        jsonrpc: '2.0',
        id: 3,
        result: { content: [{ type: 'text', text: 'server result' }] }
      })
    })
  )

  it.effect('returns JSON-RPC errors for unknown methods', () =>
    Effect.gen(function* () {
      const response = yield* handleJson({ jsonrpc: '2.0', id: 4, method: 'unknown' })

      expect(response).toMatchObject({
        jsonrpc: '2.0',
        id: 4,
        error: { code: -32_601 }
      })
    })
  )

  it.effect('returns JSON-RPC errors for unknown tools', () =>
    Effect.gen(function* () {
      const response = yield* handleJson({
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'missing' }
      })

      expect(response).toMatchObject({
        jsonrpc: '2.0',
        id: 5,
        error: { code: -32_602 }
      })
    })
  )

  it.effect('returns JSON-RPC errors for invalid tool params', () =>
    Effect.gen(function* () {
      const response = yield* handleJson({
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: { arguments: {} }
      })

      expect(response).toMatchObject({
        jsonrpc: '2.0',
        id: 6,
        error: { code: -32_600 }
      })
    })
  )

  it.effect('returns JSON-RPC errors for malformed JSON', () =>
    Effect.gen(function* () {
      const responseOption = yield* server.handleLine('{')

      if (Option.isNone(responseOption)) {
        return yield* Effect.fail(new Error('Expected MCP response'))
      }

      const response = yield* decodeJson(responseOption.value)

      expect(response).toMatchObject({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32_700 }
      })
    })
  )

  it.effect('returns safe MCP error results for tool failures', () =>
    Effect.gen(function* () {
      const responseOption = yield* failingServer.handleLine(
        requestLine({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'fail' } })
      )

      if (Option.isNone(responseOption)) {
        return yield* Effect.fail(new Error('Expected MCP response'))
      }

      const response = yield* decodeJson(responseOption.value)

      expect(response).toMatchObject({
        jsonrpc: '2.0',
        id: 7,
        result: { content: [{ type: 'text', text: 'MCP tool failed: boom' }], isError: true }
      })
    })
  )

  it.effect('preserves protocol media and structured tool results', () =>
    Effect.gen(function* () {
      const responseOption = yield* richResultServer.handleLine(
        requestLine({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'rich' } })
      )

      if (Option.isNone(responseOption)) {
        return yield* Effect.fail(new Error('Expected MCP response'))
      }

      const response = yield* decodeJson(responseOption.value)

      expect(response).toMatchObject({
        jsonrpc: '2.0',
        id: 9,
        result: {
          content: [
            { type: 'text', text: 'hello' },
            { type: 'image', data: 'abc', mimeType: 'image/png' },
            {
              type: 'resource',
              resource: {
                uri: 'file:///brief%20v1.pdf',
                name: 'brief v1.pdf',
                mimeType: 'application/pdf',
                blob: 'ghi='
              }
            },
            { type: 'audio', data: 'def', mimeType: 'audio/mpeg' },
            {
              type: 'resource',
              resource: { uri: 'file:///out.zip', mimeType: 'application/zip', blob: 'emlw' }
            },
            { type: 'text', text: '[file file_abc: kept.zip, application/zip, 3 B]' }
          ],
          isError: true,
          structuredContent: { ok: true }
        }
      })
    })
  )

  it.effect('handles HTTP POST requests', () =>
    Effect.gen(function* () {
      const response = yield* handleHttpJson({ jsonrpc: '2.0', id: 8, method: 'tools/list' })

      expect(response).toMatchObject({
        jsonrpc: '2.0',
        id: 8,
        result: { tools: [{ name: 'echo' }] }
      })
    })
  )

  it.effect('serves stateless 2026-07-28 HTTP requests', () =>
    Effect.gen(function* () {
      const response = yield* server.handleHttpRequest(
        modernHttpRequest({ method: 'tools/list', id: 10 })
      )

      const json = yield* Effect.promise(() => response.text()).pipe(Effect.flatMap(decodeJson))

      expect(response.status).toBe(200)
      expect(response.headers.get('mcp-session-id')).toBeNull()
      expect(json).toMatchObject({
        jsonrpc: '2.0',
        id: 10,
        result: {
          resultType: 'complete',
          tools: [{ name: 'echo' }],
          ttlMs: 0,
          cacheScope: 'private'
        }
      })
    })
  )

  // The host's scope (here `Effect.scoped`, in a route its request layer) closes when the Effect
  // returns, so a tool still running on a streamed body would see released resources. The SDK
  // checks `Mcp-Method` only on modern requests, so a 2025-era one claiming listen is still read.
  for (const [label, headers] of [
    ['streamed tool calls', {}],
    ['streamed tool calls claiming subscriptions/listen', { 'mcp-method': 'subscriptions/listen' }]
  ] as const) {
    it.live(`runs ${label} inside the caller scope`, () =>
      Effect.gen(function* () {
        const response = yield* scopedResourceServer
          .handleHttpRequest(
            legacyStreamableHttpRequest(
              {
                jsonrpc: '2.0',
                id: 11,
                method: 'tools/call',
                params: { name: 'scoped', arguments: {} }
              },
              { headers }
            )
          )
          .pipe(Effect.provide(ScopedResourceLive), Effect.scoped)

        const messages = yield* Effect.promise(() => response.text()).pipe(
          Effect.flatMap(sseMessages)
        )

        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toBe('text/event-stream')
        expect(messages).toMatchObject([
          { jsonrpc: '2.0', id: 11, result: { content: [{ type: 'text', text: 'resource open' }] } }
        ])
      })
    )
  }

  it.live('passes accepted 2025-era notifications through as 202', () =>
    Effect.gen(function* () {
      const response = yield* server.handleHttpRequest(
        legacyStreamableHttpRequest({ jsonrpc: '2.0', method: 'notifications/initialized' })
      )

      expect(response.status).toBe(202)
      expect(response.body).toBeNull()
    })
  )

  // A listen stream runs no tool and ends only when the per-request handler closes, after this
  // returns: it is not read first, and answers the acknowledgement plus a `complete` result.
  it.live('answers subscriptions/listen without waiting for the stream to end', () =>
    Effect.gen(function* () {
      const response = yield* server
        .handleHttpRequest(
          modernHttpRequest({
            method: 'subscriptions/listen',
            id: 13,
            params: { notifications: {} }
          })
        )
        .pipe(Effect.timeout('1 second'))

      const messages = yield* Effect.promise(() => response.text()).pipe(
        Effect.timeout('1 second'),
        Effect.flatMap(sseMessages)
      )

      expect(response.headers.get('content-type')).toBe('text/event-stream')
      expect(messages).toMatchObject([
        { method: 'notifications/subscriptions/acknowledged' },
        { id: 13, result: { resultType: 'complete' } }
      ])
    })
  )

  it.live('stops a 2026-07-28 tool call when the client cancels the request', () =>
    expectCancelledToolInterrupted(signal =>
      modernHttpRequest({
        method: 'tools/call',
        params: { name: 'wait', arguments: {} },
        headers: { 'mcp-name': 'wait' },
        signal
      })
    )
  )

  it.live('stops a 2025-era streamed tool call when the client cancels the request', () =>
    expectCancelledToolInterrupted(signal =>
      legacyStreamableHttpRequest(
        { jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'wait', arguments: {} } },
        { signal }
      )
    )
  )

  it.live('stops a streamed tool call when the host interrupts the request', () =>
    expectCancelledToolInterrupted(
      signal =>
        legacyStreamableHttpRequest(
          { jsonrpc: '2.0', id: 14, method: 'tools/call', params: { name: 'wait', arguments: {} } },
          { signal }
        ),
      'host'
    )
  )

  it.effect('rejects mismatched modern HTTP routing headers', () =>
    Effect.gen(function* () {
      const response = yield* server.handleHttpRequest(
        modernHttpRequest({
          method: 'tools/call',
          params: { name: 'echo', arguments: {} },
          headers: { 'mcp-name': 'different' }
        })
      )

      const json = yield* Effect.promise(() => response.text()).pipe(Effect.flatMap(decodeJson))

      expect(response.status).toBe(400)
      expect(json).toMatchObject({ error: { code: -32_020 } })
    })
  )

  it.effect('rejects invalid browser origins', () =>
    Effect.gen(function* () {
      const response = yield* server.handleHttpRequest(
        new Request('https://example.com/mcp', {
          headers: { origin: 'https://attacker.example' }
        })
      )

      expect(response.status).toBe(403)
    })
  )

  it.effect('rejects non-POST HTTP requests', () =>
    Effect.gen(function* () {
      const response = yield* server.handleHttpRequest(new Request('https://example.com/mcp'))
      const body = yield* Effect.promise(() => response.text())
      const json = yield* decodeJson(body)

      expect(response.status).toBe(405)
      expect(json).toMatchObject({ error: { code: -32_600 } })
    })
  )

  it.effect('maps consumed HTTP request bodies to JSON-RPC bad request', () =>
    Effect.gen(function* () {
      const request = new Request('https://example.com/mcp', {
        method: 'POST',
        body: requestLine({ jsonrpc: '2.0', id: 1, method: 'initialize' })
      })

      yield* Effect.promise(() => request.text())

      const response = yield* server.handleHttpRequest(request)
      const body = yield* Effect.promise(() => response.text())
      const json = yield* decodeJson(body)

      expect(json).toMatchObject({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32_600 }
      })
      expect(JSON.stringify(json)).toContain('Could not read request body:')
    })
  )

  it('rejects non-finite JSON requestLine fixtures before stringify', () => {
    expect(() => requestLine(Infinity)).toThrow('Expected JSON fixture')
    expect(() => requestLine({ n: Infinity })).toThrow('Expected JSON fixture')
  })

  it.effect('rejects non-finite JSON in Effect fixture helpers', () =>
    Effect.gen(function* () {
      const rootLine = yield* handleJson(Infinity).pipe(Effect.result)
      const nestedLine = yield* handleJson({ n: Infinity }).pipe(Effect.result)
      const rootHttp = yield* handleHttpJson(Infinity).pipe(Effect.result)
      const nestedHttp = yield* handleHttpJson({ n: Infinity }).pipe(Effect.result)

      expect(Result.isFailure(rootLine)).toBe(true)
      expect(Result.isFailure(nestedLine)).toBe(true)
      expect(Result.isFailure(rootHttp)).toBe(true)
      expect(Result.isFailure(nestedHttp)).toBe(true)

      if (
        !Result.isFailure(rootLine) ||
        !Result.isFailure(nestedLine) ||
        !Result.isFailure(rootHttp) ||
        !Result.isFailure(nestedHttp)
      ) {
        return yield* Effect.fail(new Error('expected non-finite JSON fixtures to fail admission'))
      }

      expect(Schema.isSchemaError(rootLine.failure)).toBe(true)
      expect(Schema.isSchemaError(nestedLine.failure)).toBe(true)
      expect(Schema.isSchemaError(rootHttp.failure)).toBe(true)
      expect(Schema.isSchemaError(nestedHttp.failure)).toBe(true)
    })
  )
})
