import { Arbitrary, Effect, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import { ToolCall, ToolResult } from '@yolk-sdk/agent/protocol'
import { EmptyToolParams, makeTool, resolveTools } from '../../src/tools'
import { propertyOptions } from './property-options'

class Prompt extends Schema.Class<Prompt>('Prompt')({
  id: Schema.String,
  label: Schema.optional(Schema.String),
  multiple: Schema.optional(Schema.Boolean)
}) {}

// Schema families used by tools, each with optional and optional nested fields. Nullable optionals
// (`Schema.optional(Schema.NullOr(X))`) are excluded: their `null` is meaningful, not omission.
const families = {
  emptyParams: EmptyToolParams,
  flatOptional: Schema.Struct({
    text: Schema.String,
    note: Schema.optional(Schema.String),
    count: Schema.optional(Schema.Number),
    flag: Schema.optional(Schema.Boolean)
  }),
  nestedOptional: Schema.Struct({
    child: Schema.optional(
      Schema.Struct({ id: Schema.String, label: Schema.optional(Schema.String) })
    ),
    meta: Schema.Struct({ tag: Schema.optional(Schema.String) })
  }),
  arrayOfOptional: Schema.Struct({
    items: Schema.Array(Schema.Struct({ id: Schema.String, note: Schema.optional(Schema.String) }))
  }),
  literalOptional: Schema.Struct({ mode: Schema.optional(Schema.Literals(['read', 'write'])) }),
  recordOptional: Schema.Struct({
    labels: Schema.optional(Schema.Record(Schema.String, Schema.String))
  }),
  unionOfStructs: Schema.Union([
    Schema.Struct({ operation: Schema.Literal('get'), query: Schema.optional(Schema.String) }),
    Schema.Struct({
      operation: Schema.Literal('search'),
      query: Schema.String,
      limit: Schema.optional(Schema.Number)
    })
  ]),
  classOptional: Schema.Struct({ prompts: Schema.Array(Prompt) }),
  optionalKey: Schema.Struct({
    task: Schema.String,
    model: Schema.optionalKey(Schema.Literals(['fast', 'deep'])),
    nested: Schema.optionalKey(Schema.Struct({ effort: Schema.optionalKey(Schema.String) }))
  }),
  decodingDefault: Schema.Struct({
    size: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(10)))
  })
}

type Family = keyof typeof families

const familyNames = Schema.Literals([
  'emptyParams',
  'flatOptional',
  'nestedOptional',
  'arrayOfOptional',
  'literalOptional',
  'recordOptional',
  'unionOfStructs',
  'classOptional',
  'optionalKey',
  'decodingDefault'
])

const propertyCase = Schema.Struct({
  family: familyNames,
  // Per optional property, in visit order: whether the generated arguments include it.
  present: Schema.Array(Schema.Boolean)
})

const propertyCaseArbitrary = Arbitrary.schema(propertyCase)

type JsonRecord = Schema.JsonObject

const isRecord = (value: Schema.Json | undefined): value is JsonRecord => Predicate.isObject(value)

const field = (schema: JsonRecord, key: string): Schema.Json | undefined =>
  Object.hasOwn(schema, key) ? schema[key] : undefined

const list = (schema: JsonRecord, key: string): ReadonlyArray<Schema.Json> => {
  const value = field(schema, key)

  return Array.isArray(value) ? value : []
}

const resolveRef = (schema: Schema.Json | undefined, defs: JsonRecord): JsonRecord => {
  let current = schema

  for (let hop = 0; hop < 32 && isRecord(current); hop++) {
    const ref = field(current, '$ref')

    if (!Predicate.isString(ref)) return current

    current = field(defs, ref.replace('#/$defs/', ''))
  }

  return isRecord(current) ? current : {}
}

// Fold Effect check constraints (emitted under `allOf`) into the base schema.
const flatten = (schema: Schema.Json | undefined, defs: JsonRecord): JsonRecord => {
  const resolved = resolveRef(schema, defs)

  const parts = [resolved, ...list(resolved, 'allOf').map(member => flatten(member, defs))]

  return Object.fromEntries(parts.flatMap(part => Object.entries(part)))
}

const unionMembers = (schema: JsonRecord) => [...list(schema, 'anyOf'), ...list(schema, 'oneOf')]

type Sampler = {
  readonly absent: 'omit' | 'null'
  readonly present: () => boolean
}

// Synthesizes arguments from the advertised JSON Schema, i.e. what a model sees.
const sample = (
  schema: Schema.Json | undefined,
  defs: JsonRecord,
  sampler: Sampler
): Schema.Json => {
  const flat = flatten(schema, defs)
  const constValue = field(flat, 'const')

  if (constValue !== undefined) return constValue

  const [firstEnum] = list(flat, 'enum')

  if (firstEnum !== undefined) return firstEnum

  const member = unionMembers(flat).find(item => field(flatten(item, defs), 'type') !== 'null')

  if (member !== undefined) return sample(member, defs, sampler)

  switch (field(flat, 'type')) {
    case 'string':
      return 'value'
    case 'number':
    case 'integer':
      return 1
    case 'boolean':
      return true
    case 'array':
      return [sample(field(flat, 'items'), defs, sampler)]
    case 'object': {
      const properties = field(flat, 'properties')
      const required = new Set(list(flat, 'required'))
      const value: { [key: string]: Schema.Json } = {}

      for (const [key, propertySchema] of Object.entries(isRecord(properties) ? properties : {})) {
        if (required.has(key) || sampler.present()) {
          value[key] = sample(propertySchema, defs, sampler)
        } else if (sampler.absent === 'null') {
          value[key] = null
        }
      }

      return value
    }
  }

  return {}
}

const makeSampler = (absent: Sampler['absent'], present: ReadonlyArray<boolean>): Sampler => {
  let index = 0

  return {
    absent,
    present: () => present.length > 0 && present[index++ % present.length] === true
  }
}

// Decoded params compared as JSON: `undefined` (decoded optional null) and omission are equal.
const asJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value) ?? 'null')

const decodeThroughRegistry = (family: Family, params: unknown) =>
  Effect.gen(function* () {
    const received: Array<unknown> = []

    const tool = makeTool({
      name: 'probe',
      description: 'Probe arguments.',
      access: 'read',
      parameters: families[family],
      execute: ({ call, params: decoded }) => {
        received.push(decoded)

        return Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'ok' }))
      }
    })

    const toolSet = yield* resolveTools([{ id: 'probe', tools: [tool] }], undefined)

    const result = yield* toolSet.execute(ToolCall.make({ id: 'call_1', name: 'probe', params }))

    return { result, received, def: tool.def }
  })

const rootBranches = (parameters: Schema.Json) => {
  const root = isRecord(parameters) ? parameters : {}
  const defsValue = field(root, '$defs')
  const defs = isRecord(defsValue) ? defsValue : {}
  const members = unionMembers(root)

  return { defs, branches: members.length > 0 ? members : [root] }
}

describe('tool argument property tests', () => {
  it.effect.prop(
    'null for every absent optional field decodes exactly like omission, per root union branch',
    [propertyCaseArbitrary],
    ([input]) =>
      Effect.gen(function* () {
        const { def } = yield* decodeThroughRegistry(input.family, {})
        const { defs, branches } = rootBranches(def.parameters)

        for (const branch of branches) {
          const omitted = sample(branch, defs, makeSampler('omit', input.present))
          const nulled = sample(branch, defs, makeSampler('null', input.present))

          const omittedRun = yield* decodeThroughRegistry(input.family, omitted)
          const nulledRun = yield* decodeThroughRegistry(input.family, nulled)

          expect(omittedRun.result.isError).toBeUndefined()
          expect(nulledRun.result.isError).toBeUndefined()
          expect(nulledRun.received).toHaveLength(1)
          expect(asJson(nulledRun.received)).toEqual(asJson(omittedRun.received))
        }
      }),
    propertyOptions
  )

  it.effect.prop(
    'an unknown key is rejected when it carries a value and ignored when it is null',
    [propertyCaseArbitrary],
    ([input]) =>
      Effect.gen(function* () {
        const { def } = yield* decodeThroughRegistry(input.family, {})
        const { defs, branches } = rootBranches(def.parameters)

        for (const branch of branches) {
          const valid = sample(branch, defs, makeSampler('omit', input.present))

          if (!isRecord(valid)) continue

          const baseline = yield* decodeThroughRegistry(input.family, valid)
          const withValue = yield* decodeThroughRegistry(input.family, { ...valid, unknown: 'x' })
          const withNull = yield* decodeThroughRegistry(input.family, { ...valid, unknown: null })

          expect(withValue.received).toHaveLength(0)
          expect(withValue.result).toMatchObject({
            isError: true,
            structuredContent: { type: 'model_visible_tool_error', reason: 'validation' }
          })
          expect(withNull.result.isError).toBeUndefined()
          expect(asJson(withNull.received)).toEqual(asJson(baseline.received))
        }
      }),
    propertyOptions
  )

  it.effect.prop(
    'null on any required field is a model-visible validation error before execution',
    [propertyCaseArbitrary],
    ([input]) =>
      Effect.gen(function* () {
        const { def } = yield* decodeThroughRegistry(input.family, {})
        const { defs, branches } = rootBranches(def.parameters)

        for (const branch of branches) {
          const flat = flatten(branch, defs)
          const valid = sample(branch, defs, makeSampler('null', input.present))

          for (const key of list(flat, 'required')) {
            if (!Predicate.isString(key) || !isRecord(valid)) continue

            const run = yield* decodeThroughRegistry(input.family, { ...valid, [key]: null })

            expect(run.received).toHaveLength(0)
            expect(run.result).toMatchObject({
              isError: true,
              structuredContent: { type: 'model_visible_tool_error', reason: 'validation' }
            })
          }
        }
      }),
    propertyOptions
  )
})
