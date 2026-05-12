import { Effect, Option } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import { AudioPart, ImagePart, TextPart, ToolDef, ToolResult } from '@yolk/protocol'
import { McpServerError, makeMcpToolServer } from '../src'

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
              ImagePart.make({ data: 'abc', mimeType: 'image/png' }),
              AudioPart.make({ data: 'def', format: 'mp3' })
            ],
            isError: true,
            structuredContent: { ok: true }
          })
        )
    }
  ]
})

const requestLine = (value: unknown) => JSON.stringify(value)

const handleJson = (value: unknown) =>
  Effect.gen(function* () {
    const response = yield* server.handleLine(requestLine(value))
    if (Option.isNone(response)) {
      return yield* Effect.fail(new Error('Expected MCP response'))
    }

    return yield* decodeJson(response.value)
  })

const handleHttpJson = (value: unknown) =>
  Effect.gen(function* () {
    const response = yield* server.handleHttpRequest(
      new Request('https://example.com/mcp', { method: 'POST', body: requestLine(value) })
    )
    const body = yield* Effect.promise(() => response.text())

    return yield* decodeJson(body)
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
            { type: 'audio', data: 'def', mimeType: 'audio/mp3' }
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

  it.effect('rejects non-POST HTTP requests', () =>
    Effect.gen(function* () {
      const response = yield* server.handleHttpRequest(new Request('https://example.com/mcp'))
      const body = yield* Effect.promise(() => response.text())
      const json = yield* decodeJson(body)

      expect(response.status).toBe(405)
      expect(json).toMatchObject({ error: { code: -32_600 } })
    })
  )
})
