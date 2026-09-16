import { Arbitrary } from 'effect/unstable/arbitrary'
import { Effect, Predicate, Schema } from 'effect'
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
  'literalField',
  'unionOfStructs'
])

const schemaVariantArbitrary = Arbitrary.schema(schemaVariant)

const invalidSchemaVariant = Schema.Literals([
  'emptyParams',
  'flatRequired',
  'flatOptional',
  'nestedStruct',
  'arrayOfStruct',
  'literalField',
  'unionOfStructs'
])

const invalidSchemaVariantArbitrary = Arbitrary.schema(invalidSchemaVariant)

const isJsonObject = (input: Schema.Json | undefined): input is Schema.JsonObject =>
  Predicate.isObjectOrArray(input) && !Array.isArray(input)

const field = (input: Schema.Json | undefined, key: string) =>
  isJsonObject(input) && Object.hasOwn(input, key) ? input[key] : undefined

const objectEntries = (
  input: Schema.Json | undefined
): ReadonlyArray<readonly [string, Schema.Json]> =>
  isJsonObject(input) ? Object.entries(input) : []

const schemaContainsTopLevelRef = (schema: Schema.Json) => field(schema, '$ref') !== undefined

const schemaContainsEmptyStructAnyOf = (schema: Schema.Json) => {
  const anyOf = field(schema, 'anyOf')

  return Array.isArray(anyOf) && anyOf.some(item => field(item, 'type') === 'array')
}

const nestedDefinitions = (schema: Schema.Json) => {
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
    case 'unionOfStructs':
      return makeTool({
        name: 'schema_probe',
        description: 'Probe schema output.',
        parameters: Schema.Union([
          Schema.Struct({ operation: Schema.Literal('upsert'), title: Schema.String }),
          Schema.Struct({ operation: Schema.Literal('delete'), slug: Schema.String })
        ]),
        access: 'write',
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
    case 'unionOfStructs':
      return { operation: 'delete', slug: 'note' }
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
    case 'unionOfStructs':
      return { operation: 'upsert' }
  }
}

describe('tool schema property tests', () => {
  it.effect(
    'rejects non-JSON generated-schema annotations instead of dropping or coercing them',
    () =>
      Effect.gen(function* () {
        const parameters = yield* Schema.decodeUnknownEffect(
          Schema.Record(Schema.String, Schema.Json)
        )(providerSafeTool('flatRequired').def.parameters)

        const invalidDefaults = [undefined, () => 'not-json', Infinity]

        for (const value of invalidDefaults) {
          const result = yield* Schema.decodeUnknownEffect(Schema.Json)({
            ...parameters,
            default: value
          }).pipe(Effect.result)

          expect(result._tag).toBe('Failure')
        }
      })
  )

  it.effect('inspects own JSON keys without conflating missing, null, and falsy values', () =>
    Effect.gen(function* () {
      const parameters = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(
        '{"__proto__":{"type":"string"},"constructor":null,"enabled":false,"count":0}'
      )

      expect(field(parameters, '__proto__')).toEqual({ type: 'string' })
      expect(field(parameters, 'constructor')).toBeNull()
      expect(field(parameters, 'enabled')).toBe(false)
      expect(field(parameters, 'count')).toBe(0)
      expect(field(parameters, 'toString')).toBeUndefined()
      expect(field(parameters, 'missing')).toBeUndefined()
      expect(objectEntries(parameters).map(([key]) => key)).toEqual([
        '__proto__',
        'constructor',
        'enabled',
        'count'
      ])
    })
  )

  it.effect.prop(
    'schema-derived tool parameters stay provider-safe',
    [schemaVariantArbitrary],
    ([variant]) =>
      Effect.gen(function* () {
        const parameters = yield* Schema.decodeUnknownEffect(Schema.Json)(
          providerSafeTool(variant).def.parameters
        )

        expect(field(parameters, 'type')).toBe('object')
        expect(schemaContainsTopLevelRef(parameters)).toBe(false)
        expect(schemaContainsEmptyStructAnyOf(parameters)).toBe(false)
        expect(() => JSON.stringify(parameters)).not.toThrow()

        for (const [, definition] of nestedDefinitions(parameters)) {
          expect(schemaContainsTopLevelRef(definition)).toBe(false)
        }
      }),
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
