/**
 * Forms an elicited tool shows the user through MCP form elicitation (`2026-07-28`): a flat object
 * of fields, each a decoder (Effect Schema, applied to the client's untrusted answer) paired with
 * the restricted JSON Schema the client renders. Only three field kinds: a yes/no checkbox, one
 * choice among titled options, and a multi-select of titled options. Every field is required.
 */
import { Array as Arr, type Option } from 'effect'
import * as Schema from 'effect/Schema'
import type {
  BooleanSchema,
  ElicitRequestFormParams,
  PrimitiveSchemaDefinition,
  TitledMultiSelectEnumSchema,
  TitledSingleSelectEnumSchema
} from '@modelcontextprotocol/server'

/** One titled option of a choice or multi-select field. */
export type McpServerFormOption<V extends string> = {
  readonly value: V
  readonly title: string
}

type FieldText = {
  readonly title: string
  readonly description?: string
}

/**
 * A form field: the schema that decodes the user's answer (it needs no services), carrying the
 * field's JSON Schema as the client renders it (`mcpFormField`).
 */
export type McpServerFormField = Schema.Top & {
  readonly DecodingServices: never
  readonly mcpFormField: PrimitiveSchemaDefinition
}

const describe = (input: FieldText) =>
  input.description === undefined
    ? { title: input.title }
    : { title: input.title, description: input.description }

// `annotate` returns a fresh schema, so the JSON is attached to this field's instance only.
const field = <S extends Schema.Top>(schema: S, json: PrimitiveSchemaDefinition) =>
  Object.assign(schema.annotate({}), { mcpFormField: json })

/** A yes/no checkbox; the answer is a boolean. */
export const mcpFormBoolean = (input: FieldText & { readonly default?: boolean }) => {
  const json: BooleanSchema = { type: 'boolean', ...describe(input) }

  return field(
    Schema.Boolean,
    input.default === undefined ? json : { ...json, default: input.default }
  )
}

const optionJson = <V extends string>(option: McpServerFormOption<V>) => ({
  const: option.value,
  title: option.title
})

const optionValues = <V extends string>(
  options: Arr.NonEmptyReadonlyArray<McpServerFormOption<V>>
) => Arr.map(options, option => option.value)

/** One choice among titled options; the answer is the chosen option's value. */
export const mcpFormChoice = <const V extends string>(
  input: FieldText & {
    readonly options: Arr.NonEmptyReadonlyArray<McpServerFormOption<V>>
    readonly default?: V
  }
) => {
  const json: TitledSingleSelectEnumSchema = {
    type: 'string',
    ...describe(input),
    oneOf: input.options.map(optionJson)
  }

  return field(
    Schema.Literals(optionValues(input.options)),
    input.default === undefined ? json : { ...json, default: input.default }
  )
}

/**
 * Several titled options; the answer lists the chosen values, at least `minItems` (default 1) and
 * at most `maxItems`, without duplicates. `default` preselects options (all of them for an "untick
 * what you do not want" review).
 */
export const mcpFormMultiSelect = <const V extends string>(
  input: FieldText & {
    readonly options: Arr.NonEmptyReadonlyArray<McpServerFormOption<V>>
    readonly minItems?: number
    readonly maxItems?: number
    readonly default?: ReadonlyArray<V>
  }
) => {
  const minItems = input.minItems ?? 1
  const items = { anyOf: input.options.map(optionJson) }

  const json: TitledMultiSelectEnumSchema =
    input.maxItems === undefined
      ? { type: 'array', ...describe(input), minItems, items }
      : { type: 'array', ...describe(input), minItems, maxItems: input.maxItems, items }

  const values = Schema.Array(Schema.Literals(optionValues(input.options)))

  const bounded =
    input.maxItems === undefined
      ? values.check(Schema.isMinLength(minItems), Schema.isUnique())
      : values.check(
          Schema.isMinLength(minItems),
          Schema.isMaxLength(input.maxItems),
          Schema.isUnique()
        )

  return field(
    bounded,
    input.default === undefined ? json : { ...json, default: [...input.default] }
  )
}

/** A form: the decoder of a whole answer and the `requestedSchema` the client renders. */
export type McpServerForm<A> = {
  readonly decode: (content: unknown) => Option.Option<A>
  readonly requestedSchema: ElicitRequestFormParams['requestedSchema']
}

/**
 * A form of the given fields, all required. `mcpServerForm({})` is a plain accept/decline: its
 * answer is `{}`.
 */
export const mcpServerForm = <const F extends Readonly<Record<string, McpServerFormField>>>(
  fields: F
): McpServerForm<Schema.Struct<F>['Type']> => {
  const properties: Record<string, PrimitiveSchemaDefinition> = {}

  for (const [key, entry] of Object.entries(fields)) properties[key] = entry.mcpFormField

  const keys = Object.keys(fields)

  // No `required` without fields: the plain accept/decline prompt keeps its exact wire shape.
  const requestedSchema: ElicitRequestFormParams['requestedSchema'] =
    keys.length === 0
      ? { type: 'object', properties }
      : { type: 'object', properties, required: keys }

  return { decode: Schema.decodeUnknownOption(Schema.Struct(fields)), requestedSchema }
}
