import { Effect } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { ToolError } from '@yolk/agent-loop'
import { ToolCall } from '@yolk/protocol'
import { resolveAgentTools } from './registry'
import {
  executeWebSearchTool,
  parseMcpWebSearchResponse,
  selectWebSearchProvider,
  type McpWebSearchRequest,
  type WebSearchDependencies
} from './web-search-tool'

const mcpResult = (text: string) =>
  JSON.stringify({
    result: {
      content: [{ type: 'text', text }]
    }
  })

const makeDependencies = (
  respond: (input: McpWebSearchRequest) => Effect.Effect<string, ToolError>
) => {
  const requested: Array<McpWebSearchRequest> = []
  const deps: WebSearchDependencies = {
    request: input => {
      requested.push(input)

      return respond(input)
    }
  }

  return { deps, requested }
}

describe('web_search tool', () => {
  it.effect('parses JSON and SSE MCP responses', () =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const parsed = yield* parseMcpWebSearchResponse(mcpResult('plain results'))

        expect(parsed).toBe('plain results')
      })
      yield* Effect.gen(function* () {
        const parsed = yield* parseMcpWebSearchResponse(`event: message\ndata: ${mcpResult('sse results')}\n\n`)

        expect(parsed).toBe('sse results')
      })
    }))

  it('selects override before stable query split', () => {
    expect(selectWebSearchProvider('anything', 'exa')).toBe('exa')
    expect(selectWebSearchProvider('anything', 'parallel')).toBe('parallel')
    expect(selectWebSearchProvider('b')).toBe('exa')
    expect(selectWebSearchProvider('a')).toBe('parallel')
  })

  it.effect('calls Exa MCP for selected Exa searches', () =>
    Effect.gen(function* () {
      const { deps, requested } = makeDependencies(() => Effect.succeed(mcpResult('Search result with source.')))
      const result = yield* executeWebSearchTool(
        ToolCall.make({
          id: 'call_1',
          name: 'web_search',
          params: { query: 'b', numResults: 3 }
        }),
        deps
      )

      expect(requested).toHaveLength(1)
      expect(requested[0]).toMatchObject({
        provider: 'exa',
        url: 'https://mcp.exa.ai/mcp',
        tool: 'web_search_exa',
        arguments: { query: 'b', numResults: 3 }
      })
      expect(result.content).toContain('Provider: exa')
      expect(result.content).toContain('Search result with source.')
    }))

  it.effect('falls back to alternate provider without override', () =>
    Effect.gen(function* () {
      const { deps, requested } = makeDependencies(input =>
        input.provider === 'exa'
          ? Effect.fail(
              new ToolError({
                tool: 'web_search',
                message: 'primary failed',
                cause: 'execution'
              })
            )
          : Effect.succeed(mcpResult('Fallback result.'))
      )
      const result = yield* executeWebSearchTool(
        ToolCall.make({
          id: 'call_1',
          name: 'web_search',
          params: { query: 'b' }
        }),
        deps
      )

      expect(requested.map(request => request.provider)).toEqual(['exa', 'parallel'])
      expect(result.content).toContain('Provider: parallel')
      expect(result.content).toContain('Fallback result.')
    }))

  it.effect('enables web_search only for text agents', () =>
    Effect.gen(function* () {
      const textTools = yield* resolveAgentTools({ surface: 'text', route: '/agent', userId: 'user_1' })
      const voiceTools = yield* resolveAgentTools({ surface: 'voice', route: '/agent', userId: 'user_1' })

      expect(textTools.tools.map(tool => tool.name)).toEqual(['web_fetch', 'web_search'])
      expect(voiceTools.tools.map(tool => tool.name)).toEqual([])
    }))
})
