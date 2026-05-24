import { Effect, Schema } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { UserMessage } from '@yolk-sdk/agent/protocol'
import { ToolResult } from '@yolk-sdk/agent/protocol'
import { EmptyToolParams, makeTool } from '@yolk-sdk/agent/tools'
import { toAnthropicClaudeRequestBody } from './claude-provider.ts'

const defaultPropertyRuns = 50
const propertyRunsEnv = process.env.PROPERTY_RUNS
const parsedPropertyRuns = propertyRunsEnv === undefined ? defaultPropertyRuns : Number(propertyRunsEnv)
const propertyRuns = Number.isInteger(parsedPropertyRuns) && parsedPropertyRuns > 0
  ? parsedPropertyRuns
  : defaultPropertyRuns
const propertyOptions = { fastCheck: { numRuns: propertyRuns } }

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

const isJsonObject = (input: unknown): input is Readonly<Record<string, unknown>> =>
  input !== null && typeof input === 'object' && !Array.isArray(input)

const field = (input: unknown, key: string) =>
  isJsonObject(input) ? Object.getOwnPropertyDescriptor(input, key)?.value : undefined

const providerSafeTool = (variant: typeof schemaVariant.Type) => {
  switch (variant) {
    case 'emptyParams':
      return makeTool({
        name: 'schema_probe',
        description: 'Probe schema output.',
        parameters: EmptyToolParams,
        access: 'read',
        execute: ({ call }) => Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'ok' }))
      })
    case 'emptyStruct':
      return makeTool({
        name: 'schema_probe',
        description: 'Probe schema output.',
        parameters: Schema.Struct({}),
        access: 'read',
        execute: ({ call }) => Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'ok' }))
      })
    case 'flatRequired':
      return makeTool({
        name: 'schema_probe',
        description: 'Probe schema output.',
        parameters: Schema.Struct({ text: Schema.String, count: Schema.Number }),
        access: 'read',
        execute: ({ call }) => Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'ok' }))
      })
    case 'flatOptional':
      return makeTool({
        name: 'schema_probe',
        description: 'Probe schema output.',
        parameters: Schema.Struct({ text: Schema.String, note: Schema.optional(Schema.String) }),
        access: 'read',
        execute: ({ call }) => Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'ok' }))
      })
    case 'nestedStruct':
      return makeTool({
        name: 'schema_probe',
        description: 'Probe schema output.',
        parameters: Schema.Struct({ child: Schema.Struct({ id: Schema.String, active: Schema.Boolean }) }),
        access: 'read',
        execute: ({ call }) => Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'ok' }))
      })
    case 'arrayOfStruct':
      return makeTool({
        name: 'schema_probe',
        description: 'Probe schema output.',
        parameters: Schema.Struct({ items: Schema.Array(Schema.Struct({ id: Schema.String })) }),
        access: 'read',
        execute: ({ call }) => Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'ok' }))
      })
    case 'literalField':
      return makeTool({
        name: 'schema_probe',
        description: 'Probe schema output.',
        parameters: Schema.Struct({ mode: Schema.Literals(['read', 'write']) }),
        access: 'read',
        execute: ({ call }) => Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'ok' }))
      })
  }
}

const assertProviderSafeParameters = (parameters: unknown) => {
  expect(field(parameters, 'type')).toBe('object')
  expect(field(parameters, '$ref')).toBeUndefined()

  const anyOf = field(parameters, 'anyOf')
  expect(Array.isArray(anyOf) && anyOf.some(item => field(item, 'type') === 'array')).toBe(false)
}

describe('Anthropic Claude provider schema properties', () => {
  it.effect.prop(
    'request tools keep registry-derived schemas provider-safe',
    [schemaVariantArbitrary],
    ([variant]) =>
      Effect.gen(function* () {
        const body = yield* toAnthropicClaudeRequestBody({
          model: 'claude-sonnet-4-6',
          systemPrompt: 'Use tools safely.',
          messages: [UserMessage.make({ content: 'hello' })],
          tools: [providerSafeTool(variant).def]
        })
        const tool = Array.isArray(body.tools) ? body.tools[0] : undefined

        assertProviderSafeParameters(field(tool, 'input_schema'))
      }),
    propertyOptions
  )
})
