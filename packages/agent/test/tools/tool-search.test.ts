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
import {
  makeInputTool,
  makeQuestionToolRegistration,
  makeTool,
  resolveTools,
  type ToolModule,
  type ToolRegistration
} from '../../src/tools'

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

  it.effect('rejects unknown arguments, naming them, instead of ignoring them', () =>
    Effect.gen(function* () {
      const toolSet = yield* resolveTools(modules, context)

      const result = yield* toolSet.execute(
        ToolCall.make({
          id: 'search_2',
          name: 'tool_search',
          params: { query: 'issues', state: 'open' }
        })
      )

      expect(result.isError).toBe(true)
      expect(result.content).toContain('state')
      expect(result.structuredContent).toBeUndefined()
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

      makeTool<Ctx, typeof Query>({
        name: 'script_only',
        description: 'x',
        parameters: Query,
        access: 'read',
        callableBy: 'codemode',
        // @ts-expect-error `loading` is only for model-callable tools.
        loading: 'deferred',
        execute: ({ call }) => Effect.succeed(ToolResult.make({ toolCallId: call.id, content: '' }))
      })
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

describe('exposure validation (ADR 0007)', () => {
  const defer = (registration: ToolRegistration<Ctx>): ToolRegistration<Ctx> => ({
    ...registration,
    def: ToolDef.make({ ...registration.def, loading: 'deferred' })
  })

  const rejected = (registrations: ReadonlyArray<ToolRegistration<Ctx>>) =>
    resolveTools([{ id: 'm', tools: registrations }], context).pipe(
      Effect.flip,
      Effect.map(error => error.cause)
    )

  it.effect('keeps loop-owned, input, background and tool_search tools declared', () =>
    Effect.gen(function* () {
      const question = defer(
        makeQuestionToolRegistration<Ctx>({
          execute: ({ call }) =>
            Effect.succeed(ToolResult.make({ toolCallId: call.id, content: '' }))
        })
      )

      const input = defer(
        makeInputTool<Ctx, typeof Schema.String>({
          name: 'ask_word',
          description: 'Ask for a word',
          renderer: 'text',
          response: Schema.String
        })
      )

      const background = defer({ ...tool('lookup', 'x'), background: true })
      const search = defer(tool('tool_search', 'host search'))

      expect(yield* rejected([question])).toBe('deferred_unsupported_tool')
      expect(yield* rejected([input])).toBe('deferred_unsupported_tool')
      expect(yield* rejected([background])).toBe('deferred_unsupported_tool')
      expect(yield* rejected([search])).toBe('deferred_unsupported_tool')
    })
  )

  it.effect('rejects duplicate instruction keys and instructions without nested access', () =>
    Effect.gen(function* () {
      const instruction = { key: 'catalog', state: 1, render: () => 'catalog' }

      const nested = (name: string): ToolRegistration<Ctx> => ({
        ...tool(name, 'x'),
        nestedToolAccess: true,
        instruct: () => instruction
      })

      expect(yield* rejected([nested('a'), nested('b')])).toBe('duplicate_instruction')
      expect(yield* rejected([{ ...tool('c', 'x'), instruct: () => instruction }])).toBe(
        'invalid_tool_exposure'
      )
    })
  )
})

describe('activation edge cases', () => {
  const assistant = (call: ToolCall) =>
    AssistantAgentMessage.make({ parts: [HostToolCallPart.make({ call })] })

  const activation = (id: string, names: ReadonlyArray<string>) =>
    toolResultMessageFromResult(
      ToolResult.make({
        toolCallId: id,
        content: 'x',
        structuredContent: { toolSearch: { activated: [...names] } }
      })
    )

  it('matches a result to the search call of the assistant message it follows', () => {
    // A provider reused the call id in a later turn for another tool.
    const search = ToolCall.make({ id: 'call_1', name: 'tool_search', params: { query: 'x' } })
    const lookup = ToolCall.make({ id: 'call_1', name: 'lookup', params: { query: 'x' } })

    const names = activatedToolNames([
      assistant(search),
      activation('call_1', ['list_issues']),
      assistant(lookup),
      activation('call_1', ['create_issue'])
    ])

    expect([...names]).toEqual(['list_issues'])
  })

  it.effect('reads activation from the transcript, not the compacted request', () =>
    Effect.gen(function* () {
      const toolSet = yield* resolveTools(modules, context)
      const requests: Array<LLMRequest> = []
      const searched = yield* toolSet.execute(searchCall)

      const transcript = [
        UserMessage.make({ content: 'list the issues' }),
        assistant(searchCall),
        toolResultMessageFromResult(searched),
        UserMessage.make({ content: 'go on' })
      ]

      // A transform that drops everything but the last message (like a summary would).
      const compacting = Layer.succeed(
        ContextTransformer,
        ContextTransformer.of({
          transform: messages => Effect.succeed({ messages: messages.slice(-1), events: [] })
        })
      )

      yield* run({
        messages: transcript,
        systemPrompt: 'Be brief.',
        tools: toolSet.tools,
        model: 'faux'
      }).pipe(
        Stream.runDrain,
        Effect.provide(
          Layer.mergeAll(
            FauxProvider.layerWithRequests({ responses: [Reply.text('ok')], requests }),
            Layer.succeed(ToolExecutor, ToolExecutor.of({ execute: call => toolSet.execute(call) }))
          ).pipe(Layer.provideMerge(Layer.mergeAll(compacting, LoopConfig.defaultLayer)))
        )
      )

      expect(requests[0]?.messages).toHaveLength(1)
      expect(names(requests[0]?.tools ?? [])).toContain('list_issues')
    })
  )
})
