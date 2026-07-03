import { Effect, Schema } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { ToolResult } from '@yolk-sdk/agent/protocol'
import { EmptyToolParams, makeTool } from '../../src/tools'
import { propertyOptions } from './property-options'

const schemaVariant = Schema.Literals([
  'emptyParams',
  'emptyStruct',
  'flatRequired',
  'flatOptional',
  'nestedStruct',
  'arrayOfStruct',
  'literalField'
])

const schemaVariantArbitrary = Schema.toArbitrary(schemaVariant)

const invalidSchemaVariant = Schema.Literals([
  'emptyParams',
  'flatRequired',
  'flatOptional',
  'nestedStruct',
  'arrayOfStruct',
  'literalField'
])

const invalidSchemaVariantArbitrary = Schema.toArbitrary(invalidSchemaVariant)

const isJsonObject = (input: unknown): input is Readonly<Record<string, unknown>> =>
  input !== null && typeof input === 'object' && !Array.isArray(input)

const field = (input: unknown, key: string) =>
  isJsonObject(input) ? Object.getOwnPropertyDescriptor(input, key)?.value : undefined

const objectEntries = (input: unknown): ReadonlyArray<readonly [string, unknown]> =>
  isJsonObject(input) ? Object.entries(input) : []

const schemaContainsTopLevelRef = (schema: unknown) => field(schema, '$ref') !== undefined

const schemaContainsEmptyStructAnyOf = (schema: unknown) => {
  const anyOf = field(schema, 'anyOf')

  return Array.isArray(anyOf) && anyOf.some(item => field(item, 'type') === 'array')
}

const nestedDefinitions = (schema: unknown) => {
  const definitions = field(schema, '$defs')

  return objectEntries(definitions)
}

const providerSafeTool = (variant: typeof schemaVariant.Type) => {
  switch (variant) {
    case 'emptyParams':
      return makeTool({
        name: 'schema_probe',
        description: 'Probe schema output.',
        parameters: EmptyToolParams,
        access: 'read',
        execute: ({ call }) =>
          Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'ok' }))
      })
    case 'emptyStruct':
      return makeTool({
        name: 'schema_probe',
        description: 'Probe schema output.',
        parameters: Schema.Struct({}),
        access: 'read',
        execute: ({ call }) =>
          Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'ok' }))
      })
    case 'flatRequired':
      return makeTool({
        name: 'schema_probe',
        description: 'Probe schema output.',
        parameters: Schema.Struct({ text: Schema.String, count: Schema.Number }),
        access: 'read',
        execute: ({ call }) =>
          Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'ok' }))
      })
    case 'flatOptional':
      return makeTool({
        name: 'schema_probe',
        description: 'Probe schema output.',
        parameters: Schema.Struct({ text: Schema.String, note: Schema.optional(Schema.String) }),
        access: 'read',
        execute: ({ call }) =>
          Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'ok' }))
      })
    case 'nestedStruct':
      return makeTool({
        name: 'schema_probe',
        description: 'Probe schema output.',
        parameters: Schema.Struct({
          child: Schema.Struct({ id: Schema.String, active: Schema.Boolean })
        }),
        access: 'read',
        execute: ({ call }) =>
          Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'ok' }))
      })
    case 'arrayOfStruct':
      return makeTool({
        name: 'schema_probe',
        description: 'Probe schema output.',
        parameters: Schema.Struct({ items: Schema.Array(Schema.Struct({ id: Schema.String })) }),
        access: 'read',
        execute: ({ call }) =>
          Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'ok' }))
      })
    case 'literalField':
      return makeTool({
        name: 'schema_probe',
        description: 'Probe schema output.',
        parameters: Schema.Struct({ mode: Schema.Literals(['read', 'write']) }),
        access: 'read',
        execute: ({ call }) =>
          Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'ok' }))
      })
  }
}

const validParams = (variant: typeof schemaVariant.Type) => {
  switch (variant) {
    case 'emptyParams':
    case 'emptyStruct':
      return {}
    case 'flatRequired':
      return { text: 'hello', count: 1 }
    case 'flatOptional':
      return { text: 'hello', note: 'optional' }
    case 'nestedStruct':
      return { child: { id: 'child_1', active: true } }
    case 'arrayOfStruct':
      return { items: [{ id: 'item_1' }] }
    case 'literalField':
      return { mode: 'read' }
  }
}

const invalidParams = (variant: typeof invalidSchemaVariant.Type) => {
  switch (variant) {
    case 'emptyParams':
      return { extra: true }
    case 'flatRequired':
      return { text: 'hello', count: 'one' }
    case 'flatOptional':
      return { note: 'optional' }
    case 'nestedStruct':
      return { child: { id: 'child_1', active: 'yes' } }
    case 'arrayOfStruct':
      return { items: [{ id: 1 }] }
    case 'literalField':
      return { mode: 'delete' }
  }
}

describe('tool schema property tests', () => {
  it.prop(
    'schema-derived tool parameters stay provider-safe',
    [schemaVariantArbitrary],
    ([variant]) => {
      const parameters = providerSafeTool(variant).def.parameters

      expect(field(parameters, 'type')).toBe('object')
      expect(schemaContainsTopLevelRef(parameters)).toBe(false)
      expect(schemaContainsEmptyStructAnyOf(parameters)).toBe(false)
      expect(() => JSON.stringify(parameters)).not.toThrow()

      for (const [, definition] of nestedDefinitions(parameters)) {
        expect(schemaContainsTopLevelRef(definition)).toBe(false)
      }
    },
    propertyOptions
  )

  it.effect.prop(
    'valid schema-derived tool params decode before execution',
    [schemaVariantArbitrary],
    ([variant]) =>
      Effect.gen(function* () {
        const tool = providerSafeTool(variant)
        const result = yield* tool.execute({
          context: undefined,
          call: { id: 'call_1', name: tool.def.name, params: validParams(variant) }
        })

        expect(result).toMatchObject({ toolCallId: 'call_1', content: 'ok' })
      }),
    propertyOptions
  )

  it.effect.prop(
    'invalid schema-derived tool params return model-visible errors before execution',
    [invalidSchemaVariantArbitrary],
    ([variant]) =>
      Effect.gen(function* () {
        const tool = providerSafeTool(variant)
        const result = yield* tool.execute({
          context: undefined,
          call: { id: 'call_1', name: tool.def.name, params: invalidParams(variant) }
        })

        expect(result).toMatchObject({
          toolCallId: 'call_1',
          content: expect.stringContaining(`Invalid ${tool.def.name} arguments`),
          isError: true
        })
      }),
    propertyOptions
  )
})
