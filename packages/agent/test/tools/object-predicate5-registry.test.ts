import { Effect } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { ToolResult } from '@yolk-sdk/agent/protocol'
import {
  EmptyToolParams,
  makeTool,
  resolveTools,
  type ToolModule,
  type ToolRegistration
} from '@yolk-sdk/agent/tools'

type TestContext = {
  readonly enabled: boolean
}

const makeModule = (
  tools: ReadonlyArray<ToolRegistration<TestContext>>
): ToolModule<TestContext> => ({
  id: 'test',
  tools
})

describe('registry objectField json schema path', () => {
  it.effect('still projects EmptyToolParams through own descriptors', () =>
    Effect.gen(function* () {
      const tool = makeTool({
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
})
