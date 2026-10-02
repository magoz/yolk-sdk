import { Effect } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import {
  ToolApprovalPolicy,
  ToolCall,
  ToolResult,
  providerToolDefs
} from '@yolk-sdk/agent/protocol'
import {
  EmptyToolParams,
  makeTool,
  resolveTools,
  type ToolRegistration
} from '@yolk-sdk/agent/tools'
import { mcpToolToToolDef, McpTool, type McpToolExposureResolver } from '../../src/client'

type Context = { readonly tenant: string }

const context: Context = { tenant: 'tenant_1' }

const listedTool = (name: string, readOnly: boolean): McpTool =>
  McpTool.make({
    name,
    inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
    annotations: { readOnlyHint: readOnly }
  })

const searchTool = listedTool('search', true)

const deleteTool = listedTool('delete', false)

/** Read-only MCP tools become codemode-only search tools; others stay model-only. */
const byReadOnlyHint: McpToolExposureResolver = tool =>
  tool.annotations?.['readOnlyHint'] === true
    ? { callableBy: 'codemode', discovery: 'search' }
    : { callableBy: 'model' }

/** The host-side registration shape: an adapted def plus an executor. */
const registration = (def: ReturnType<typeof mcpToolToToolDef>): ToolRegistration<Context> => ({
  def,
  access: 'read',
  execute: ({ call }) =>
    Effect.succeed(ToolResult.make({ toolCallId: call.id, content: `${call.name}:ok` }))
})

const nestedHost = (target: string): ToolRegistration<Context> =>
  makeTool<Context, typeof EmptyToolParams>({
    name: 'host',
    description: 'Nested host.',
    parameters: EmptyToolParams,
    access: 'write',
    nestedToolAccess: true,
    execute: ({ call, nested }) =>
      Effect.gen(function* () {
        const result = yield* (
          nested?.execute(
            ToolCall.make({ id: `${call.id}/1`, name: target, params: { q: 'x' } })
          ) ?? Effect.die(new Error('no nested executor'))
        )

        return ToolResult.make({
          toolCallId: call.id,
          content: JSON.stringify({
            names: nested?.tools.map(tool => tool.def.name) ?? [],
            content: result.content
          })
        })
      })
  })

describe('MCP tool exposure', () => {
  it('sets nothing by default and applies a value or a per-tool resolver', () => {
    const plain = mcpToolToToolDef({ serverName: 'docs', tool: searchTool })

    expect(Object.hasOwn(plain, 'callableBy')).toBe(false)
    expect(Object.hasOwn(plain, 'discovery')).toBe(false)

    const valued = mcpToolToToolDef({
      serverName: 'docs',
      tool: deleteTool,
      exposure: { callableBy: 'codemode' }
    })

    expect([valued.callableBy, valued.discovery]).toEqual(['codemode', undefined])

    const seen: Array<string> = []

    const resolve: McpToolExposureResolver = (tool, serverName) => {
      seen.push(`${serverName}/${tool.name}`)

      return byReadOnlyHint(tool, serverName)
    }

    const search = mcpToolToToolDef({ serverName: 'docs', tool: searchTool, exposure: resolve })
    const remove = mcpToolToToolDef({ serverName: 'docs', tool: deleteTool, exposure: resolve })

    expect([search.callableBy, search.discovery]).toEqual(['codemode', 'search'])
    expect([remove.callableBy, Object.hasOwn(remove, 'discovery')]).toEqual(['model', false])
    expect(seen).toEqual(['docs/search', 'docs/delete'])
  })

  it.effect('keeps codemode-only MCP tools off providers but callable from scripts', () =>
    Effect.gen(function* () {
      const search = mcpToolToToolDef({
        serverName: 'docs',
        tool: searchTool,
        exposure: byReadOnlyHint
      })

      const remove = mcpToolToToolDef({
        serverName: 'docs',
        tool: deleteTool,
        exposure: byReadOnlyHint
      })

      const toolSet = yield* resolveTools(
        [
          { id: 'host', tools: [nestedHost(search.name)] },
          { id: 'mcp-docs', tools: [registration(search), registration(remove)] }
        ],
        context
      )

      expect(providerToolDefs(toolSet.tools).map(def => def.name)).toEqual(['host', 'docs_delete'])

      const result = yield* toolSet.execute(
        ToolCall.make({ id: 'call_1', name: 'host', params: {} })
      )

      expect(JSON.parse(String(result.content))).toEqual({
        names: ['docs_search'],
        content: 'docs_search:ok'
      })
    })
  )

  it.effect('keeps the fail-closed rules: codemode on an approval registration fails', () =>
    Effect.gen(function* () {
      const def = mcpToolToToolDef({
        serverName: 'docs',
        tool: deleteTool,
        exposure: { callableBy: 'codemode', discovery: 'search' }
      })

      const error = yield* Effect.flip(
        resolveTools(
          [
            {
              id: 'mcp-docs',
              tools: [
                { ...registration(def), approval: ToolApprovalPolicy.make({ mode: 'manual' }) }
              ]
            }
          ],
          context
        )
      )

      expect(error).toMatchObject({ cause: 'codemode_unsupported_tool' })
    })
  )
})
