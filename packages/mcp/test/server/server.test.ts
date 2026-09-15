import { Effect, Option, Predicate, Result } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import {
  AudioPart,
  DocumentPart,
  ImagePart,
  TextPart,
  ToolDef,
  ToolResult,
  inlineBase64Source
} from '@yolk-sdk/agent/protocol'
import { McpServerError, makeMcpToolServer } from '../../src/server'

const decodeJson = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)

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
              AudioPart.make({ source: inlineBase64Source('def'), mimeType: 'audio/mpeg' })
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
    })
  })
}

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
            { type: 'audio', data: 'def', mimeType: 'audio/mpeg' }
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
