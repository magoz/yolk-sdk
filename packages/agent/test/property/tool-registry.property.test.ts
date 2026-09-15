import { Arbitrary } from 'effect/unstable/arbitrary'
import { Effect, Predicate, Result, Schema } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { ToolExecutor } from '@yolk-sdk/agent/loop'
import { ToolDef, ToolResult } from '@yolk-sdk/agent/protocol'
import {
  makeToolExecutorLayer,
  resolveTools,
  type ToolModule,
  type ToolRegistration
} from '../../src/tools'
import { propertyOptions } from './property-options'

type TestContext = {
  readonly enabled: boolean
}

const toolName = Schema.Literals(['alpha', 'beta', 'gamma'])

const moduleId = Schema.Literals(['module_1', 'module_2'])

const toolSpec = Schema.Struct({
  name: toolName,
  moduleId,
  gated: Schema.Boolean,
  access: Schema.Literals(['read', 'write', 'destructive'])
})

const registryCase = Schema.Struct({
  enabled: Schema.Boolean,
  tools: Schema.Array(toolSpec),
  executeName: toolName
})

const registryCaseArbitrary = Arbitrary.schema(registryCase)

const makeToolDef = (name: typeof toolName.Type) =>
  ToolDef.make({
    name,
    description: `${name} tool`,
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  })

const makeTool = (spec: typeof toolSpec.Type): ToolRegistration<TestContext> => {
  const registration: ToolRegistration<TestContext> = {
    def: makeToolDef(spec.name),
    access: spec.access,
    execute: ({ call }) =>
      Effect.succeed(ToolResult.make({ toolCallId: call.id, content: spec.name }))
  }

  return spec.gated
    ? { ...registration, isEnabled: (context: TestContext) => Effect.succeed(context.enabled) }
    : registration
}

const modulesFromSpecs = (
  specs: ReadonlyArray<typeof toolSpec.Type>
): ReadonlyArray<ToolModule<TestContext>> => {
  const byModule = new Map<typeof moduleId.Type, Array<ToolRegistration<TestContext>>>()

  for (const spec of specs) {
    byModule.set(spec.moduleId, [...(byModule.get(spec.moduleId) ?? []), makeTool(spec)])
  }

  return Array.from(byModule.entries()).map(([id, tools]) => ({ id, tools }))
}

const enabledSpecs = (input: typeof registryCase.Type) =>
  input.tools.filter(tool => !tool.gated || input.enabled)

const resolvedEnabledSpecs = (input: typeof registryCase.Type) => {
  const moduleOrder = Array.from(new Set(input.tools.map(tool => tool.moduleId)))
  const active = enabledSpecs(input)

  return moduleOrder.flatMap(id => active.filter(tool => tool.moduleId === id))
}

const duplicateName = (specs: ReadonlyArray<typeof toolSpec.Type>) => {
  const names = new Set<typeof toolName.Type>()

  for (const spec of specs) {
    if (names.has(spec.name)) {
      return spec.name
    }

    names.add(spec.name)
  }

  return undefined
}

describe('tool registry property tests', () => {
  it.effect.prop(
    'resolved tool sets match enabled unique registry model',
    [registryCaseArbitrary],
    ([input]) =>
      Effect.gen(function* () {
        const activeSpecs = resolvedEnabledSpecs(input)
        const duplicate = duplicateName(activeSpecs)

        const result = yield* resolveTools(modulesFromSpecs(input.tools), {
          enabled: input.enabled
        }).pipe(Effect.result)

        if (duplicate !== undefined) {
          expect(Result.isFailure(result)).toBe(true)

          if (Result.isFailure(result)) {
            expect(Predicate.isTagged(result.failure, 'ToolRegistryError')).toBe(true)

            if (Predicate.isTagged(result.failure, 'ToolRegistryError')) {
              expect(result.failure.cause).toBe('duplicate_tool')
            }
          }

          return
        }

        expect(result._tag).toBe('Success')

        if (!Predicate.isTagged(result, 'Success')) {
          return
        }

        const toolSet = result.success
        expect(toolSet).toBeDefined()

        if (toolSet === undefined) {
          return
        }

        const expectedMetadata = activeSpecs.map(spec => ({
          moduleId: spec.moduleId,
          name: spec.name,
          access: spec.access
        }))

        expect(toolSet.tools.map(tool => tool.name)).toEqual(activeSpecs.map(tool => tool.name))
        expect(toolSet.metadata).toEqual(expectedMetadata)

        const executeResult = yield* Effect.provide(
          Effect.gen(function* () {
            const executor = yield* ToolExecutor

            return yield* executor.execute({ id: 'call_1', name: input.executeName, params: {} })
          }),
          makeToolExecutorLayer(toolSet)
        ).pipe(Effect.result)

        const executable = activeSpecs.some(spec => spec.name === input.executeName)

        if (executable) {
          const expectedExecuteResultFields = {
            success: { toolCallId: 'call_1', content: input.executeName }
          }

          expect(executeResult._tag).toBe('Success')
          expect(executeResult).toMatchObject(expectedExecuteResultFields)
        } else {
          expect(Result.isFailure(executeResult)).toBe(true)

          if (Result.isFailure(executeResult)) {
            expect(Predicate.isTagged(executeResult.failure, 'ToolError')).toBe(true)

            if (Predicate.isTagged(executeResult.failure, 'ToolError')) {
              expect(executeResult.failure.cause).toBe('not_found')
              expect(executeResult.failure.tool).toBe(input.executeName)
            }
          }
        }
      }),
    propertyOptions
  )
})
