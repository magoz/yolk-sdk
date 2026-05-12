import { Effect } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import {
  defaultMcpSecurityPolicy,
  mcpToolToToolDef,
  sanitizeMcpName,
  toolCallResultToToolResult
} from '../src'
import { callLocalMcpServerToolNode } from '../src/node.ts'

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
      { _tag: 'Text', text: 'hello' },
      { _tag: 'Image', data: 'abc', mimeType: 'image/png' },
      { _tag: 'Audio', data: 'def', format: 'mp3' },
      { _tag: 'Text', text: 'file text' },
      { _tag: 'Text', text: 'MCP resource link: linked.txt (file:///tmp/linked.txt)' }
    ])
  })

  it('maps embedded blob resources to agent-readable text', () => {
    const result = toolCallResultToToolResult({
      toolCallId: 'call_1',
      result: {
        content: [
          { type: 'resource', resource: { uri: 'file:///tmp/out.bin', blob: 'Ym9keQ==', mimeType: 'text/plain' } }
        ]
      }
    })

    expect(result.content).toEqual([
      { _tag: 'Text', text: 'MCP resource: file:///tmp/out.bin\nYm9keQ==' }
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
      if (result._tag === 'Failure') {
        expect(result.failure.cause).toBe('security')
      }
    })
  )
})
