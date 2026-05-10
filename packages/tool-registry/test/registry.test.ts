import { Effect } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { ToolExecutor } from '@yolk/agent-loop'
import { ToolDef, ToolResult } from '@yolk/protocol'
import { makeToolExecutorLayer, resolveTools, type ToolModule, type ToolRegistration } from '../src'

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

const makeModule = (tools: ReadonlyArray<ToolRegistration<TestContext>>): ToolModule<TestContext> => ({
  id: 'test',
  tools
})

describe('resolveTools', () => {
  it.effect('resolves tool definitions and metadata', () =>
    Effect.gen(function* () {
      const toolSet = yield* resolveTools([makeModule([makeTool('echo')])], { enabled: true })

      expect(toolSet.tools.map(tool => tool.name)).toEqual(['echo'])
      expect(toolSet.metadata).toEqual([{ moduleId: 'test', name: 'echo', access: 'read' }])
    }))

  it.effect('filters disabled tools', () =>
    Effect.gen(function* () {
      const toolSet = yield* resolveTools([makeModule([gatedTool])], { enabled: false })

      expect(toolSet.tools).toEqual([])
      expect(toolSet.metadata).toEqual([])
    }))

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
    }))

  it.effect('rejects duplicate tool names', () =>
    Effect.gen(function* () {
      const result = yield* resolveTools([makeModule([makeTool('echo'), makeTool('echo')])], {
        enabled: true
      }).pipe(Effect.result)

      expect(result).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'ToolRegistryError', cause: 'duplicate_tool' }
      })
    }))
})
