import { Effect, Predicate, Result } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import { AudioPart, ImagePart, TextPart, inlineBase64Source } from '@yolk-sdk/agent/protocol'
import {
  defaultMcpSecurityPolicy,
  InitializeClientInfo,
  InitializeParams,
  InitializedNotification,
  JsonRpcRequest,
  legacyMcpProtocolVersion,
  makeInitializeParams,
  makeInitializedNotification,
  makeJsonRpcRequest,
  mcpToolToToolDef,
  McpTool,
  sanitizeMcpName,
  toolCallResultToToolResult,
  ToolsCallParams,
  ToolsListResult
} from '../../src/client'
import { callLocalMcpServerToolNode } from '../../src/client/node.ts'

describe('MCP protocol helpers', () => {
  it('constructs initialize and JSON-RPC messages through protocol schemas', () => {
    const clientInfo = InitializeClientInfo.make({ name: 'yolk', version: '0.1.0' })

    const params = InitializeParams.make({
      protocolVersion: legacyMcpProtocolVersion,
      capabilities: {},
      clientInfo
    })

    const hostInfo = { name: 'yolk', version: '0.1.0', privateNote: 'not-on-the-wire' }

    expect(params).toEqual(makeInitializeParams(hostInfo))
    expect(Object.keys(params)).toEqual(['protocolVersion', 'capabilities', 'clientInfo'])
    expect(JSON.stringify(params)).toBe(
      '{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"yolk","version":"0.1.0"}}'
    )

    const initialized = InitializedNotification.make({
      jsonrpc: '2.0',
      method: 'notifications/initialized'
    })

    expect(initialized).toEqual(makeInitializedNotification())
    expect('id' in initialized).toBe(false)
    expect('params' in initialized).toBe(false)
    expect(JSON.stringify(initialized)).toBe(
      '{"jsonrpc":"2.0","method":"notifications/initialized"}'
    )

    const listed = JsonRpcRequest.make({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list'
    })

    expect('params' in listed).toBe(false)
    expect(Object.keys(listed)).toEqual(['jsonrpc', 'id', 'method'])
    expect(JSON.stringify(listed)).toBe('{"jsonrpc":"2.0","id":2,"method":"tools/list"}')

    const call = JsonRpcRequest.make({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: ToolsCallParams.make({ name: 'echo', arguments: { text: 'hello' } })
    })

    expect(call.params).toEqual({ name: 'echo', arguments: { text: 'hello' } })
  })

  it('preserves constructor getter order, omitted params, and opaque argument identity', () => {
    const reads: string[] = []
    let nestedReads = 0

    const opaque = {
      get value() {
        nestedReads += 1

        return 'opaque'
      }
    }

    const params = ToolsCallParams.make({ name: 'echo', arguments: opaque })

    const request = makeJsonRpcRequest({
      get id() {
        reads.push('id')

        return 3
      },
      get method() {
        reads.push('method')

        return 'tools/call'
      },
      get params() {
        reads.push('params')

        return params
      }
    })

    expect(reads).toEqual(['id', 'method', 'params', 'params'])
    expect(request.params).toBe(params)
    expect(params.arguments).toBe(opaque)
    expect(nestedReads).toBe(0)
    expect(Object.keys(request)).toEqual(['jsonrpc', 'id', 'method', 'params'])
    expect(JSON.stringify(request)).toBe(
      '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"echo","arguments":{"value":"opaque"}}}'
    )
    expect(nestedReads).toBe(1)

    const absentReads: string[] = []

    const absent = makeJsonRpcRequest({
      get id() {
        absentReads.push('id')

        return 2
      },
      get method() {
        absentReads.push('method')

        return 'tools/list'
      },
      get params() {
        absentReads.push('params')

        return undefined
      }
    })

    expect(absentReads).toEqual(['id', 'method', 'params'])
    expect(Object.hasOwn(absent, 'params')).toBe(false)
    expect(Object.keys(absent)).toEqual(['jsonrpc', 'id', 'method'])
    expect(JSON.stringify(absent)).toBe('{"jsonrpc":"2.0","id":2,"method":"tools/list"}')
  })

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
    expect(def.parameters).toEqual({ type: 'object', properties: {} })
    expect(sanitizeMcpName('***')).toBe('___')

    const omitted = mcpToolToToolDef({
      serverName: 'docs',
      tool: { name: 'echo' }
    })

    expect(omitted.parameters).toEqual({ type: 'object', additionalProperties: true })
  })

  it('admits MCP inputSchema as a plain JSON object at tools/list decode, not ToolDef.make', () => {
    const inputSchema = { type: 'object', properties: { q: { type: 'string' } } }

    const listed = Schema.decodeUnknownResult(ToolsListResult)({
      tools: [{ name: 'search', inputSchema }]
    })

    expect(Result.isSuccess(listed)).toBe(true)

    if (Result.isSuccess(listed)) {
      expect(listed.success.tools[0]?.inputSchema).toBe(inputSchema)

      const def = mcpToolToToolDef({
        serverName: 'docs',
        tool: listed.success.tools[0] ?? { name: 'search', inputSchema }
      })

      expect(def.parameters).toBe(inputSchema)
    }

    const rejected = [
      true,
      false,
      [{ type: 'object' }],
      { n: Infinity },
      { extra: () => undefined },
      { default: new Date('2020-01-01T00:00:00.000Z') }
    ]

    for (const inputSchema of rejected) {
      const tool = Schema.decodeUnknownResult(McpTool)({ name: 'echo', inputSchema })

      const list = Schema.decodeUnknownResult(ToolsListResult)({
        tools: [{ name: 'echo', inputSchema }]
      })

      expect(Result.isFailure(tool)).toBe(true)
      expect(Result.isFailure(list)).toBe(true)

      if (Result.isFailure(tool) && Result.isFailure(list)) {
        expect(Schema.isSchemaError(tool.failure)).toBe(true)
        expect(Schema.isSchemaError(list.failure)).toBe(true)
        expect(tool.failure.message).toContain('JSON Schema')
        expect(list.failure.message).toContain('JSON Schema')
        expect(list.failure.message).not.toContain('2020-01-01')
      }
    }
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

  it('preserves structured content and maps supported media blocks', () => {
    const structuredContent = { answer: 42 }

    const result = toolCallResultToToolResult({
      toolCallId: 'call_1',
      result: {
        structuredContent,
        isError: true,
        content: [
          { type: 'text', text: 'hello' },
          { type: 'image', data: 'abc', mimeType: 'image/png' },
          { type: 'audio', data: 'def', mimeType: 'audio/mpeg' },
          { type: 'resource', resource: { uri: 'file:///tmp/out.txt', text: 'file text' } },
          { type: 'resource_link', uri: 'file:///tmp/linked.txt', name: 'linked.txt' }
        ]
      }
    })

    expect(result.structuredContent).toEqual(structuredContent)
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([
      TextPart.make({ text: 'hello' }),
      ImagePart.make({ source: inlineBase64Source('abc'), mimeType: 'image/png' }),
      AudioPart.make({ source: inlineBase64Source('def'), mimeType: 'audio/mpeg' }),
      TextPart.make({ text: 'file text' }),
      TextPart.make({ text: 'MCP resource link: linked.txt (file:///tmp/linked.txt)' })
    ])
  })

  it('maps embedded blob resources to agent-readable text', () => {
    const result = toolCallResultToToolResult({
      toolCallId: 'call_1',
      result: {
        content: [
          {
            type: 'resource',
            resource: { uri: 'file:///tmp/out.bin', blob: 'Ym9keQ==', mimeType: 'text/plain' }
          }
        ]
      }
    })

    expect(result.content).toEqual([
      TextPart.make({ text: 'MCP resource: file:///tmp/out.bin\nYm9keQ==' })
    ])
  })

  it('uses a readable placeholder for structured-only results', () => {
    const result = toolCallResultToToolResult({
      toolCallId: 'call_1',
      result: { structuredContent: { ok: true } }
    })

    expect(result.content).toBe('Structured MCP tool result.')
    expect(result.structuredContent).toEqual({ ok: true })
  })

  it.effect('rejects local MCP when disabled by policy', () =>
    Effect.gen(function* () {
      const result = yield* callLocalMcpServerToolNode({
        config: {
          name: 'local',
          type: 'local',
          command: ['node', 'server.js']
        },
        mcpToolName: 'search',
        toolCallId: 'call_1',
        params: {},
        options: { securityPolicy: defaultMcpSecurityPolicy }
      }).pipe(Effect.result)

      expect(result._tag).toBe('Failure')

      if (Predicate.isTagged(result, 'Failure')) {
        expect(result.failure.cause).toBe('security')
      }
    })
  )
})
