import { Effect, Layer, Stream } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import {
  activatedToolNames,
  AssistantAgentMessage,
  declaredToolDefs,
  HostToolCallPart,
  ToolApprovalPolicy,
  ToolCall,
  ToolDef,
  ToolResult,
  toolResultMessageFromResult,
  UserMessage
} from '@yolk-sdk/agent/protocol'
import { ContextTransformer, LoopConfig, run, ToolExecutor, type LLMRequest } from '../../src/loop'
import { FauxProvider, Reply } from '../../src/loop/testing'
import { makeTool, resolveTools, type ToolModule, type ToolRegistration } from '../../src/tools'

type Ctx = { readonly tenant: string }

const context: Ctx = { tenant: 'tenant_1' }

const Query = Schema.Struct({ query: Schema.String })

const tool = (
  name: string,
  description: string,
  options: { readonly deferred?: boolean; readonly approval?: boolean } = {}
): ToolRegistration<Ctx> => {
  const execute = ({ call }: { readonly call: ToolCall }) =>
    Effect.succeed(ToolResult.make({ toolCallId: call.id, content: name }))

  const loading = options.deferred === true ? 'deferred' : 'eager'

  return options.approval === true
    ? makeTool<Ctx, typeof Query>({
        name,
        description,
        parameters: Query,
        access: 'write',
        approval: ToolApprovalPolicy.make({ mode: 'manual' }),
        loading,
        execute
      })
    : makeTool<Ctx, typeof Query>({
        name,
        description,
        parameters: Query,
        access: 'read',
        loading,
        execute
      })
}

const modules: ReadonlyArray<ToolModule<Ctx>> = [
  {
    id: 'github',
    description: 'GitHub MCP server',
    tools: [
      tool('list_issues', 'List issues of a repository', { deferred: true }),
      tool('create_issue', 'Create an issue', { deferred: true, approval: true }),
      tool('lookup', 'Look up knowledge')
    ]
  }
]

const names = (defs: ReadonlyArray<ToolDef>) => defs.map(def => def.name)

const searchCall = ToolCall.make({
  id: 'search_1',
  name: 'tool_search',
  params: { query: 'issue issues' }
})

describe('tool_search', () => {
  it.effect('is added when deferred tools resolve, and activates matches by search', () =>
    Effect.gen(function* () {
      const toolSet = yield* resolveTools(modules, context)

      expect(names(toolSet.tools)).toContain('tool_search')

      const result = yield* toolSet.execute(searchCall)

      // Ranked by relevance: both match, in score order.
      expect(result.structuredContent).toEqual({
        toolSearch: { activated: ['create_issue', 'list_issues'] }
      })
      expect(result.content).toContain('- list_issues: List issues of a repository')
    })
  )

  it.effect('is not added without deferred tools, when the host opts out, or when one exists', () =>
    Effect.gen(function* () {
      const eager = yield* resolveTools([{ id: 'm', tools: [tool('lookup', 'x')] }], context)
      const optedOut = yield* resolveTools(modules, context, { toolSearch: false })

      const hostOwned = yield* resolveTools(
        [...modules, { id: 'host', tools: [tool('tool_search', 'host search')] }],
        context
      )

      expect(names(eager.tools)).not.toContain('tool_search')
      expect(names(optedOut.tools)).not.toContain('tool_search')
      expect(names(hostOwned.tools).filter(name => name === 'tool_search')).toHaveLength(1)
    })
  )

  it.effect('rejects loading on codemode-only tools and deferral of host-owned lifecycles', () =>
    Effect.gen(function* () {
      const resolve = (registration: ToolRegistration<Ctx>) =>
        resolveTools([{ id: 'm', tools: [registration] }], context).pipe(Effect.flip)

      const codemodeOnly = yield* resolve({
        def: ToolDef.make({
          name: 'script_only',
          description: 'x',
          parameters: { type: 'object' },
          callableBy: 'codemode',
          loading: 'deferred'
        }),
        access: 'read',
        execute: ({ call }) => Effect.succeed(ToolResult.make({ toolCallId: call.id, content: '' }))
      })

      const nestedAccess = yield* resolve({
        def: ToolDef.make({
          name: 'runner',
          description: 'x',
          parameters: { type: 'object' },
          loading: 'deferred'
        }),
        access: 'write',
        nestedToolAccess: true,
        execute: ({ call }) => Effect.succeed(ToolResult.make({ toolCallId: call.id, content: '' }))
      })

      expect(codemodeOnly.cause).toBe('invalid_tool_exposure')
      expect(nestedAccess.cause).toBe('deferred_unsupported_tool')
    })
  )
})

describe('declared tool definitions', () => {
  const assistant = (call: ToolCall) =>
    AssistantAgentMessage.make({ parts: [HostToolCallPart.make({ call })] })

  it.effect('declare deferred tools only once a tool_search result activated them', () =>
    Effect.gen(function* () {
      const toolSet = yield* resolveTools(modules, context)
      const result = yield* toolSet.execute(searchCall)
      const before = [UserMessage.make({ content: 'hi' })]
      const after = [...before, assistant(searchCall), toolResultMessageFromResult(result)]

      expect(names(declaredToolDefs(toolSet.tools, before))).toEqual(['lookup', 'tool_search'])
      expect(names(declaredToolDefs(toolSet.tools, after))).toEqual([
        'list_issues',
        'create_issue',
        'lookup',
        'tool_search'
      ])
      // An activated gated tool keeps its approval.
      expect(
        declaredToolDefs(toolSet.tools, after).find(def => def.name === 'create_issue')?.approval
      ).toMatchObject({ mode: 'manual' })
    })
  )

  it('never counts a look-alike result of another tool as an activation', () => {
    const other = ToolCall.make({ id: 'other_1', name: 'lookup', params: { query: 'x' } })

    const messages = [
      assistant(other),
      toolResultMessageFromResult(
        ToolResult.make({
          toolCallId: other.id,
          content: 'x',
          structuredContent: { toolSearch: { activated: ['list_issues'] } }
        })
      )
    ]

    expect(activatedToolNames(messages).size).toBe(0)
  })

  it.effect('loads a tool between model requests of one run', () =>
    Effect.gen(function* () {
      const toolSet = yield* resolveTools(modules, context)
      const requests: Array<LLMRequest> = []

      yield* run({
        messages: [UserMessage.make({ content: 'list the issues' })],
        systemPrompt: 'Be brief.',
        tools: toolSet.tools,
        model: 'faux'
      }).pipe(
        Stream.runDrain,
        Effect.provide(
          Layer.mergeAll(
            FauxProvider.layerWithRequests({
              responses: [
                Reply.toolCall({
                  id: 'search_1',
                  name: 'tool_search',
                  params: { query: 'list issues' }
                }),
                Reply.text('ok')
              ],
              requests
            }),
            Layer.succeed(ToolExecutor, ToolExecutor.of({ execute: call => toolSet.execute(call) }))
          ).pipe(
            Layer.provideMerge(Layer.mergeAll(ContextTransformer.identity, LoopConfig.defaultLayer))
          )
        )
      )

      expect(names(requests[0]?.tools ?? [])).toEqual(['lookup', 'tool_search'])
      expect(names(requests[1]?.tools ?? [])).toContain('list_issues')
    })
  )
})
