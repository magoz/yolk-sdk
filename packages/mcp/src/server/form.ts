/**
 * Forms an elicited tool shows the user through MCP form elicitation (`2026-07-28`): a flat object
 * of fields, each a decoder (Effect Schema, applied to the client's untrusted answer) paired with
 * the restricted JSON Schema the client renders. Only three field kinds, built only here: a yes/no
 * checkbox, one choice among titled options, and a multi-select of titled options. Every field is
 * required; a `default` only preselects in the client and never stands in for a missing answer.
 *
 * Options often come from data (plan items), so a form that cannot be shown faithfully (repeated
 * option values, a default the field would not accept, impossible selection bounds, a field named
 * `__proto__`) is not thrown: it lists its `problems`, and the tool answers an error instead of
 * asking.
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
 * Set only by this module's builders, so the types accept no hand-made field or form (a host can
 * still forge one by spreading; it is trusted code, and the brand guards against mistakes).
 */
export const mcpFormFieldBrand: unique symbol = Symbol('@yolk-sdk/mcp/McpServerFormField')

/** Set only by `mcpServerForm`. */
export const mcpServerFormBrand: unique symbol = Symbol('@yolk-sdk/mcp/McpServerForm')

/**
 * A form field, built only by `mcpFormBoolean`, `mcpFormChoice` or `mcpFormMultiSelect`: the
 * schema that decodes the user's answer (it needs no services), carrying the field's JSON Schema
 * as the client renders it (`mcpFormField`) and why it cannot be shown (`mcpFormProblems`, empty
 * when it can).
 */
export type McpServerFormField = Schema.Top & { readonly DecodingServices: never } & FieldParts

type FieldParts = {
  readonly [mcpFormFieldBrand]: true
  readonly mcpFormField: PrimitiveSchemaDefinition
  readonly mcpFormProblems: ReadonlyArray<string>
}

const describe = (input: FieldText) =>
  input.description === undefined
    ? { title: input.title }
    : { title: input.title, description: input.description }

/** A field built from schema `S`: its exported name, so a host's declarations can name it. */
export type McpServerFormFieldOf<S extends Schema.Top> = S['Rebuild'] & FieldParts

// `annotate` returns a fresh schema, so the JSON is attached to this field's instance only.
const field = <S extends Schema.Top>(
  schema: S,
  json: PrimitiveSchemaDefinition & FieldText,
  problems: ReadonlyArray<string>
): McpServerFormFieldOf<S> =>
  Object.assign(schema.annotate({}), {
    [mcpFormFieldBrand]: true as const,
    mcpFormField: json,
    mcpFormProblems: problems.map(problem => `${json.title}: ${problem}`)
  })

/** A yes/no checkbox; the answer is a boolean. */
export const mcpFormBoolean = (input: FieldText & { readonly default?: boolean }) => {
  const json: BooleanSchema & FieldText = { type: 'boolean', ...describe(input) }

  return field(
    Schema.Boolean,
    input.default === undefined ? json : { ...json, default: input.default },
    []
  )
}

const optionJson = <V extends string>(option: McpServerFormOption<V>) => ({
  const: option.value,
  title: option.title
})

const optionValues = <V extends string>(
  options: Arr.NonEmptyReadonlyArray<McpServerFormOption<V>>
) => Arr.map(options, option => option.value)

const repeated = (values: ReadonlyArray<string>) =>
  Arr.dedupe(values.filter((value, index) => values.indexOf(value) !== index))

// Two options with one value would be two `oneOf` / `anyOf` branches matching the same answer.
const optionProblems = (values: ReadonlyArray<string>, defaults: ReadonlyArray<string>) => [
  ...repeated(values).map(value => `option value ${JSON.stringify(value)} is repeated`),
  ...defaults.flatMap(value =>
    values.includes(value) ? [] : [`default ${JSON.stringify(value)} is not an option`]
  )
]

/** One choice among titled options; the answer is the chosen option's value. */
export const mcpFormChoice = <const V extends string>(
  input: FieldText & {
    readonly options: Arr.NonEmptyReadonlyArray<McpServerFormOption<V>>
    readonly default?: V
  }
) => {
  const values = optionValues(input.options)

  const json: TitledSingleSelectEnumSchema & FieldText = {
    type: 'string',
    ...describe(input),
    oneOf: input.options.map(optionJson)
  }

  return field(
    Schema.Literals(values),
    input.default === undefined ? json : { ...json, default: input.default },
    optionProblems(values, input.default === undefined ? [] : [input.default])
  )
}

const isSelectionBound = (maxItems: number, options: number) =>
  Number.isInteger(maxItems) && maxItems >= 1 && maxItems <= options

const selectionProblems = (input: {
  readonly options: number
  readonly maxItems: number | undefined
  readonly defaults: ReadonlyArray<string> | undefined
}) => {
  const { options, maxItems, defaults } = input
  const most = maxItems ?? options

  return [
    ...(isSelectionBound(most, options)
      ? []
      : ['maxItems must be an integer from 1 to the number of options']),
    ...(defaults === undefined
      ? []
      : [
          ...repeated(defaults).map(value => `default ${JSON.stringify(value)} is repeated`),
          ...(defaults.length === 0 ? ['default selects nothing'] : []),
          ...(defaults.length > most ? ['default selects more than maxItems'] : [])
        ])
  ]
}

/**
 * Several titled options; the answer lists the chosen values, at least one (an empty selection is
 * no answer) and at most `maxItems`, without duplicates. `default` preselects options (all of them
 * for an "untick what you do not want" review) and must itself be such an answer.
 */
export const mcpFormMultiSelect = <const V extends string>(
  input: FieldText & {
    readonly options: Arr.NonEmptyReadonlyArray<McpServerFormOption<V>>
    readonly maxItems?: number
    readonly default?: ReadonlyArray<V>
  }
) => {
  const values = optionValues(input.options)
  const { maxItems } = input
  const items = { anyOf: input.options.map(optionJson) }

  const json: TitledMultiSelectEnumSchema & FieldText =
    maxItems === undefined
      ? { type: 'array', ...describe(input), minItems: 1, items }
      : { type: 'array', ...describe(input), minItems: 1, maxItems, items }

  // An out-of-range `maxItems` is a problem, never thrown: Effect's length check throws on a
  // non-finite bound, so the decoder of a form that will not be shown caps at the options.
  const most =
    maxItems !== undefined && isSelectionBound(maxItems, values.length) ? maxItems : values.length

  const answer = Schema.Array(Schema.Literals(values)).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(most),
    Schema.isUnique()
  )

  return field(
    answer,
    input.default === undefined ? json : { ...json, default: [...input.default] },
    [
      ...optionProblems(values, input.default ?? []),
      ...selectionProblems({ options: values.length, maxItems, defaults: input.default })
    ]
  )
}

/**
 * A form: the decoder of a whole answer, the `requestedSchema` the client renders, and why it
 * cannot be shown (`problems`, empty when it can).
 */
export type McpServerForm<A> = {
  readonly [mcpServerFormBrand]: true
  readonly decode: (content: unknown) => Option.Option<A>
  readonly requestedSchema: ElicitRequestFormParams['requestedSchema']
  readonly problems: ReadonlyArray<string>
}

/**
 * A form of the given fields, all required. `mcpServerForm({})` is a plain accept/decline: its
 * answer is `{}`. Keys the answer has beyond the fields are dropped.
 */
export const mcpServerForm = <const F extends Readonly<Record<string, McpServerFormField>>>(
  fields: F
): McpServerForm<Schema.Struct<F>['Type']> => {
  const entries = Object.entries(fields)
  const keys = entries.map(([key]) => key)

  // `fromEntries` defines own properties, so no key can reach the prototype.
  const properties = Object.fromEntries(entries.map(([key, entry]) => [key, entry.mcpFormField]))

  // No `required` without fields: the plain accept/decline prompt keeps its exact wire shape.
  const requestedSchema: ElicitRequestFormParams['requestedSchema'] =
    keys.length === 0
      ? { type: 'object', properties }
      : { type: 'object', properties, required: keys }

  return {
    [mcpServerFormBrand]: true,
    decode: Schema.decodeUnknownOption(Schema.Struct(fields)),
    requestedSchema,
    problems: [
      ...(keys.includes('__proto__') ? ['a field is named __proto__'] : []),
      ...entries.flatMap(([, entry]) => entry.mcpFormProblems)
    ]
  }
}
