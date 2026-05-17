import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import { ToolExecutor } from '@yolk/agent/loop'
import { ToolDef, ToolResult } from '@yolk/agent/protocol'
import { EmptyToolParams, makeTool as makeSchemaTool, makeToolExecutorLayer, resolveTools, type ToolModule, type ToolRegistration } from '../../src/tools'

type TestContext = {
  readonly enabled: boolean
}

const makeToolDef = (name: string) =>
  ToolDef.make({
    name,
    description: `${name} tool`,
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  })

const makeTool = (name: string): ToolRegistration<TestContext> => ({
  def: makeToolDef(name),
  access: 'read',
  execute: ({ call }) => Effect.succeed(ToolResult.make({ toolCallId: call.id, content: name }))
})

const gatedTool: ToolRegistration<TestContext> = {
  def: makeToolDef('gated'),
  access: 'write',
  isEnabled: context => Effect.succeed(context.enabled),
  execute: ({ call }) => Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'gated' }))
}

const makeModule = (
  tools: ReadonlyArray<ToolRegistration<TestContext>>
): ToolModule<TestContext> => ({
  id: 'test',
  tools
})

describe('resolveTools', () => {
  it.effect('resolves tool definitions and metadata', () =>
    Effect.gen(function* () {
      const toolSet = yield* resolveTools([makeModule([makeTool('echo')])], { enabled: true })

      expect(toolSet.tools.map(tool => tool.name)).toEqual(['echo'])
      expect(toolSet.metadata).toEqual([{ moduleId: 'test', name: 'echo', access: 'read' }])
    })
  )

  it.effect('filters disabled tools', () =>
    Effect.gen(function* () {
      const toolSet = yield* resolveTools([makeModule([gatedTool])], { enabled: false })

      expect(toolSet.tools).toEqual([])
      expect(toolSet.metadata).toEqual([])
    })
  )

  it.effect('executes resolved tools through ToolExecutor layer', () =>
    Effect.gen(function* () {
      const toolSet = yield* resolveTools([makeModule([makeTool('echo')])], { enabled: true })
      const executor = yield* Effect.provide(
        Effect.gen(function* () {
          const service = yield* ToolExecutor
          return yield* service.execute({ id: 'call_1', name: 'echo', params: {} })
        }),
        makeToolExecutorLayer(toolSet)
      )

      expect(executor).toMatchObject({ toolCallId: 'call_1', content: 'echo' })
    })
  )

  it.effect('fails unknown tool execution as not found', () =>
    Effect.gen(function* () {
      const toolSet = yield* resolveTools([makeModule([makeTool('echo')])], { enabled: true })
      const result = yield* Effect.provide(
        Effect.gen(function* () {
          const service = yield* ToolExecutor
          return yield* service.execute({ id: 'call_1', name: 'missing', params: {} })
        }),
        makeToolExecutorLayer(toolSet)
      ).pipe(Effect.result)

      expect(result).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'ToolError', cause: 'not_found' }
      })
    })
  )

  it.effect('rejects duplicate tool names', () =>
    Effect.gen(function* () {
      const result = yield* resolveTools([makeModule([makeTool('echo'), makeTool('echo')])], {
        enabled: true
      }).pipe(Effect.result)

      expect(result).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'ToolRegistryError', cause: 'duplicate_tool' }
      })
    })
  )

  it.effect('derives tool parameters from Effect Schema and decodes before execute', () =>
    Effect.gen(function* () {
      const tool = makeSchemaTool({
        name: 'schema_echo',
        description: 'Echo schema input.',
        parameters: Schema.Struct({
          text: Schema.String.pipe(Schema.annotate({ description: 'Text to echo.' }))
        }),
        access: 'read',
        execute: ({ call, params }) =>
          Effect.succeed(ToolResult.make({ toolCallId: call.id, content: params.text }))
      })
      const toolSet = yield* resolveTools([makeModule([tool])], { enabled: true })
      const result = yield* toolSet.execute({ id: 'call_1', name: 'schema_echo', params: { text: 'hi' } })

      expect(result.content).toBe('hi')
      expect(toolSet.tools[0]?.parameters).toMatchObject({
        type: 'object',
        properties: { text: { type: 'string', description: 'Text to echo.' } },
        required: ['text']
      })
    })
  )

  it.effect('derives empty object parameters for no-arg tools', () =>
    Effect.gen(function* () {
      const tool = makeSchemaTool({
        name: 'empty',
        description: 'No args.',
        parameters: Schema.Struct({}),
        access: 'read',
        execute: ({ call }) =>
          Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'ok' }))
      })
      const toolSet = yield* resolveTools([makeModule([tool])], { enabled: true })

      expect(toolSet.tools[0]?.parameters).toEqual({
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false
      })
    })
  )

  it.effect('derives provider-safe parameters for empty tool params', () =>
    Effect.gen(function* () {
      const tool = makeSchemaTool({
        name: 'empty_params',
        description: 'No args.',
        parameters: EmptyToolParams,
        access: 'read',
        execute: ({ call }) =>
          Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'ok' }))
      })
      const toolSet = yield* resolveTools([makeModule([tool])], { enabled: true })

      expect(toolSet.tools[0]?.parameters).toEqual({
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false
      })
      expect(toolSet.tools[0]?.parameters).not.toHaveProperty('anyOf')
    })
  )

  it.effect('rejects unexpected parameters for empty tool params', () =>
    Effect.gen(function* () {
      const tool = makeSchemaTool({
        name: 'empty_params',
        description: 'No args.',
        parameters: EmptyToolParams,
        access: 'read',
        execute: ({ call }) =>
          Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'ok' }))
      })
      const toolSet = yield* resolveTools([makeModule([tool])], { enabled: true })
      const result = yield* toolSet.execute({ id: 'call_1', name: 'empty_params', params: { extra: true } }).pipe(Effect.result)

      expect(result).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'ToolError', cause: 'validation' }
      })
    })
  )
})
