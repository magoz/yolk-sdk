import { Effect, Layer } from 'effect'
import * as Schema from 'effect/Schema'
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
  type ToolModule,
  type ToolRegistration
} from '@yolk-sdk/agent/tools'
import {
  ActionResult,
  defineAction,
  defineConnector,
  makeIntegration,
  type ConnectorError
} from '@yolk-sdk/connectors'
import {
  makeConnectorToolModule,
  makeConnectorToolRegistration,
  type ConnectorToolActionInfo
} from '@yolk-sdk/connectors/agent'

const Echo = Schema.Struct({ text: Schema.String })

const echo = (id: string, access: 'read' | 'write') =>
  defineAction({
    id,
    description: `${id} action.`,
    access,
    inputSchema: Echo,
    outputSchema: Echo,
    execute: ({ input }) => Effect.succeed(ActionResult.success({ text: `${id}:${input.text}` }))
  })

const TestConnector = defineConnector({
  id: 'test',
  actions: [echo('test.read', 'read'), echo('test.write', 'write')]
})

const options = { integration: makeIntegration({ connectorId: 'test' }), layer: Layer.empty }

type Context = { readonly tenant: string }

const context: Context = { tenant: 'tenant_1' }

/** A nested-access registration that lists the script-callable tools and calls one. */
const nestedHost = (target: string): ToolRegistration<Context> =>
  makeTool<Context, typeof EmptyToolParams>({
    name: 'host',
    description: 'Nested host.',
    parameters: EmptyToolParams,
    access: 'write',
    nestedToolAccess: true,
    execute: ({ call, nested }) =>
      Effect.gen(function* () {
        const names = nested?.tools.map(tool => tool.def.name) ?? []

        const result = yield* (
          nested?.execute(
            ToolCall.make({ id: `${call.id}/1`, name: target, params: { text: 'hi' } })
          ) ?? Effect.die(new Error('no nested executor'))
        )

        return ToolResult.make({
          toolCallId: call.id,
          content: JSON.stringify({ names, content: result.content })
        })
      })
  })

describe('connector tool exposure', () => {
  it('applies one exposure value to every action of a module', () => {
    const toolModule = makeConnectorToolModule<Context, never, ConnectorError>(TestConnector, {
      ...options,
      exposure: { callableBy: 'codemode', discovery: 'search' }
    })

    expect(
      toolModule.tools.map(tool => [tool.def.name, tool.def.callableBy, tool.def.discovery])
    ).toEqual([
      ['test.read', 'codemode', 'search'],
      ['test.write', 'codemode', 'search']
    ])
  })

  it('resolves exposure per action from its id and declared metadata', () => {
    const seen: Array<readonly [string, ConnectorToolActionInfo | undefined]> = []

    const exposure = (actionId: string, action: ConnectorToolActionInfo | undefined) => {
      seen.push([actionId, action])

      return action?.access === 'read'
        ? { callableBy: 'codemode' as const, discovery: 'search' as const }
        : { callableBy: 'model' as const }
    }

    const read = makeConnectorToolRegistration(TestConnector, 'test.read', {
      ...options,
      exposure
    })

    const write = makeConnectorToolRegistration(TestConnector, 'test.write', {
      ...options,
      exposure
    })

    const missing = makeConnectorToolRegistration(TestConnector, 'test.missing', {
      ...options,
      exposure
    })

    expect([read.def.callableBy, read.def.discovery]).toEqual(['codemode', 'search'])
    expect([write.def.callableBy, write.def.discovery]).toEqual(['model', undefined])
    expect(missing.def.callableBy).toBe('model')
    expect(seen.map(([actionId, action]) => [actionId, action?.access])).toEqual([
      ['test.read', 'read'],
      ['test.write', 'write'],
      ['test.missing', undefined]
    ])
  })

  it.effect('keeps codemode-only connector tools off providers but callable from scripts', () =>
    Effect.gen(function* () {
      const modules: ReadonlyArray<ToolModule<Context>> = [
        { id: 'host', tools: [nestedHost('test.read')] },
        makeConnectorToolModule<Context, never, ConnectorError>(TestConnector, {
          ...options,
          exposure: actionId =>
            actionId === 'test.read'
              ? { callableBy: 'codemode', discovery: 'search' }
              : { callableBy: 'model' }
        })
      ]

      const toolSet = yield* resolveTools(modules, context)

      expect(providerToolDefs(toolSet.tools).map(def => def.name)).toEqual(['host', 'test.write'])

      const result = yield* toolSet.execute(
        ToolCall.make({ id: 'call_1', name: 'host', params: {} })
      )

      expect(JSON.parse(String(result.content))).toEqual({
        names: ['test.read'],
        content: JSON.stringify({ text: 'test.read:hi' })
      })

      // A provider-issued call to a codemode-only tool fails closed.
      const direct = yield* Effect.flip(
        toolSet.execute(ToolCall.make({ id: 'call_2', name: 'test.read', params: { text: 'x' } }))
      )

      expect(direct).toMatchObject({ cause: 'not_found' })
    })
  )

  it.effect('keeps the fail-closed rules: invalid combinations fail resolution', () =>
    Effect.gen(function* () {
      const QuestionConnector = defineConnector({
        id: 'ask',
        actions: [echo('question', 'read')]
      })

      const loopOwned = yield* Effect.flip(
        resolveTools(
          [
            makeConnectorToolModule<Context, never, ConnectorError>(QuestionConnector, {
              ...options,
              exposure: { callableBy: 'codemode' }
            })
          ],
          context
        )
      )

      expect(loopOwned).toMatchObject({ cause: 'codemode_unsupported_tool' })

      const approved: ToolRegistration<Context> = {
        ...makeConnectorToolRegistration<Context, never, ConnectorError>(
          TestConnector,
          'test.write',
          {
            ...options,
            exposure: { callableBy: 'codemode' }
          }
        ),
        approval: ToolApprovalPolicy.make({ mode: 'manual' })
      }

      const approval = yield* Effect.flip(
        resolveTools([{ id: 'test', tools: [approved] }], context)
      )

      expect(approval).toMatchObject({ cause: 'codemode_unsupported_tool' })
    })
  )
})
