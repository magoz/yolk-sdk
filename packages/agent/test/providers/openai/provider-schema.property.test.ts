import { Effect, Schema } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { UserMessage } from '@yolk-sdk/agent/protocol'
import { ToolResult } from '@yolk-sdk/agent/protocol'
import { EmptyToolParams, makeTool } from '@yolk-sdk/agent/tools'
import { toOpenAiCodexRequestBody } from '../../../src/providers/openai/codex-provider.ts'
import { toOpenAiRequestBody } from '../../../src/providers/openai/provider.ts'

const defaultPropertyRuns = 50
const propertyRunsEnv = process.env.PROPERTY_RUNS
const parsedPropertyRuns =
  propertyRunsEnv === undefined ? defaultPropertyRuns : Number(propertyRunsEnv)
const propertyRuns =
  Number.isInteger(parsedPropertyRuns) && parsedPropertyRuns > 0
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
  'literalField',
  'deepArrayStruct',
  'optionalNestedStruct',
  'literalArray',
  'recordField',
  'unionField'
])

const schemaVariantArbitrary = Schema.toArbitrary(schemaVariant)

const isJsonObject = (input: unknown): input is Readonly<Record<string, unknown>> =>
  input !== null && typeof input === 'object' && !Array.isArray(input)

const field = (input: unknown, key: string) =>
  isJsonObject(input) ? Object.getOwnPropertyDescriptor(input, key)?.value : undefined

const localDefinitionName = (ref: unknown) => {
  if (typeof ref !== 'string') return undefined

  const prefix = '#/$defs/'

  return ref.startsWith(prefix) ? ref.slice(prefix.length) : undefined
}

const collectLocalRefs = (input: unknown): ReadonlyArray<string> => {
  const ref = localDefinitionName(field(input, '$ref'))
  const current = ref === undefined ? [] : [ref]

  if (Array.isArray(input)) {
    return [...current, ...input.flatMap(collectLocalRefs)]
  }

  if (!isJsonObject(input)) {
    return current
  }

  return [...current, ...Object.values(input).flatMap(collectLocalRefs)]
}

const schemaParameters = (variant: typeof schemaVariant.Type) => {
  switch (variant) {
    case 'emptyParams':
      return EmptyToolParams
    case 'emptyStruct':
      return Schema.Struct({})
    case 'flatRequired':
      return Schema.Struct({ text: Schema.String, count: Schema.Number })
    case 'flatOptional':
      return Schema.Struct({ text: Schema.String, note: Schema.optional(Schema.String) })
    case 'nestedStruct':
      return Schema.Struct({ child: Schema.Struct({ id: Schema.String, active: Schema.Boolean }) })
    case 'arrayOfStruct':
      return Schema.Struct({ items: Schema.Array(Schema.Struct({ id: Schema.String })) })
    case 'literalField':
      return Schema.Struct({ mode: Schema.Literals(['read', 'write']) })
    case 'deepArrayStruct':
      return Schema.Struct({
        groups: Schema.Array(
          Schema.Struct({
            id: Schema.String,
            tags: Schema.Array(Schema.String),
            meta: Schema.Struct({ active: Schema.Boolean })
          })
        )
      })
    case 'optionalNestedStruct':
      return Schema.Struct({
        filter: Schema.optional(
          Schema.Struct({ query: Schema.String, limit: Schema.optional(Schema.Number) })
        )
      })
    case 'literalArray':
      return Schema.Struct({ modes: Schema.Array(Schema.Literals(['read', 'write'])) })
    case 'recordField':
      return Schema.Struct({ labels: Schema.Record(Schema.String, Schema.String) })
    case 'unionField':
      return Schema.Struct({
        mode: Schema.Union([
          Schema.Literal('auto'),
          Schema.Struct({ type: Schema.Literal('manual'), value: Schema.String })
        ])
      })
  }
}

const schemaProbeTool = <
  ParamsSchema extends Schema.Schema<unknown> & { readonly DecodingServices: never }
>(
  parameters: ParamsSchema
) =>
  makeTool({
    name: 'schema_probe',
    description: 'Probe schema output.',
    parameters,
    access: 'read',
    execute: ({ call }) => Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'ok' }))
  })

const providerSafeTool = (variant: typeof schemaVariant.Type) =>
  schemaProbeTool(schemaParameters(variant))

const assertProviderSafeParameters = (parameters: unknown) => {
  expect(field(parameters, 'type')).toBe('object')
  expect(field(parameters, '$ref')).toBeUndefined()

  const anyOf = field(parameters, 'anyOf')
  expect(Array.isArray(anyOf) && anyOf.some(item => field(item, 'type') === 'array')).toBe(false)

  const definitions = field(parameters, '$defs')
  for (const ref of collectLocalRefs(parameters)) {
    expect(field(definitions, ref)).toBeDefined()
  }
}

const requestForTool = (variant: typeof schemaVariant.Type) => ({
  model: 'gpt-5.4',
  systemPrompt: 'Use tools safely.',
  messages: [UserMessage.make({ content: 'hello' })],
  tools: [providerSafeTool(variant).def]
})

describe('OpenAI provider schema properties', () => {
  it.effect.prop(
    'Chat Completions request tools keep registry-derived schemas provider-safe',
    [schemaVariantArbitrary],
    ([variant]) =>
      Effect.gen(function* () {
        const body = yield* toOpenAiRequestBody(requestForTool(variant), {
          maxCompletionTokens: 123
        })
        const tool = Array.isArray(body.tools) ? body.tools[0] : undefined
        const functionSchema = field(tool, 'function')

        assertProviderSafeParameters(field(functionSchema, 'parameters'))
      }),
    propertyOptions
  )

  it.effect.prop(
    'Codex request tools keep registry-derived schemas provider-safe',
    [schemaVariantArbitrary],
    ([variant]) =>
      Effect.gen(function* () {
        const body = yield* toOpenAiCodexRequestBody(requestForTool(variant), {
          maxOutputTokens: 123
        })
        const tool = Array.isArray(body.tools) ? body.tools[0] : undefined

        assertProviderSafeParameters(field(tool, 'parameters'))
      }),
    propertyOptions
  )
})
