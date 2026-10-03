import { Effect, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import * as SchemaAST from 'effect/SchemaAST'
import * as SchemaIssue from 'effect/SchemaIssue'
import { ToolCall, type ToolJsonSchema } from '@yolk-sdk/agent/protocol'

// Model tool-call arguments are JSON that the model produced from the advertised `ToolDef.parameters`.
// That advertisement is `Schema.toJsonSchemaDocument(schema)`, which describes the canonical JSON
// codec of the schema, not its type side: the JSON codec encodes `undefined` as `null`, so every
// `Schema.optional(X)` is advertised as `X | null`, and objects as closed
// (`additionalProperties: false`). Execution accepts exactly what the model was shown, without
// changing the advertisement. Policy: normalize what is unambiguous (`null` means "not sent"), and
// reject what would otherwise be silently lost (an unknown key the model believes it set), so the
// model gets a precise, recoverable validation error instead of a call that quietly did less.
//
// 1. `decodeToolArguments` decodes with `Schema.toCodecJson(schema)` and `onExcessProperty: 'error'`.
//    `null` on `Schema.optional(X)` becomes `undefined` (and `withDecodingDefault` applies), while
//    `Schema.optional(Schema.NullOr(X))` keeps `null` as a meaningful value. Required non-nullable
//    fields still reject `null`; unknown keys are rejected at any depth, also through declarations
//    whose JSON codec bypasses their own parser.
// 2. `omitNullOptionalToolArguments` covers properties advertised as optional WITHOUT `null`
//    (`Schema.optionalKey(X)`, raw/MCP JSON Schemas) and `null` on an undeclared key that another
//    member of the enclosing union declares (provider-flattened unions show every member's
//    fields). Strict-mode models still fill those with `null`; the registry drops such a `null`
//    before any registration decodes or forwards the arguments.

type ToolArgumentsSchema = Schema.Schema<unknown> & { readonly DecodingServices: never }

type PropertyPath = ReadonlyArray<PropertyKey>

const nonFiniteNumberPath = (
  value: unknown,
  path: PropertyPath,
  seen: Set<object>
): PropertyPath | undefined => {
  if (Predicate.isNumber(value)) return Number.isFinite(value) ? undefined : path

  if (!Predicate.isObjectOrArray(value) || value instanceof Date || seen.has(value)) {
    return undefined
  }

  seen.add(value)

  const entries: Iterable<readonly [PropertyKey, unknown]> = Array.isArray(value)
    ? value.entries()
    : Object.entries(value)

  for (const [key, item] of entries) {
    const found = nonFiniteNumberPath(item, [...path, key], seen)

    if (found !== undefined) return found
  }

  return undefined
}

const nonFiniteNumberError = (path: PropertyPath) =>
  new Schema.SchemaError(
    new SchemaIssue.Pointer(
      path,
      new SchemaIssue.InvalidValue({ message: 'Expected a finite number' })
    )
  )

export const hasPlainPrototype = (value: object) => {
  const prototype = Object.getPrototypeOf(value)

  return prototype === Object.prototype || prototype === null
}

/** Drops `undefined`-valued keys from plain objects at any depth, as JSON serialization would.
 * Model arguments are JSON and never carry `undefined`; in-process callers building params from
 * optional values do. Returns the same reference when nothing changes.
 */
export const omitUndefinedKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    const items = value.map(omitUndefinedKeys)

    return items.some((item, index) => item !== value[index]) ? items : value
  }

  if (!Predicate.isObject(value) || !hasPlainPrototype(value)) return value

  let changed = false

  const entries = Object.entries(value).flatMap(([key, item]) => {
    if (item === undefined) {
      changed = true

      return []
    }

    const normalized = omitUndefinedKeys(item)

    changed ||= normalized !== item

    return [[key, normalized]]
  })

  return changed ? Object.fromEntries(entries) : value
}

/** Decoder for model-produced tool/interaction call arguments.
 *
 * Decodes through `Schema.toCodecJson(schema)`, the codec that `ToolDef.parameters` advertises, so
 * `null` on `Schema.optional(X)` decodes as absent, and unknown keys are rejected (callers may
 * override `onExcessProperty`). `undefined`-valued keys from in-process callers count as absent. The JSON codec also accepts the strings
 * `"NaN"`/`"Infinity"`/`"-Infinity"` for bare `Schema.Number`; JSON arguments never carried
 * non-finite numbers before, so any non-finite number in the decoded value is a validation error.
 */
/** `Schema.Struct({})`: Effect parses an empty struct as any non-nullish value, without an
 * excess-property check, while it is advertised as a closed empty object. */
export const isEmptyStructSchema = (schema: Schema.Top) => {
  const ast = Schema.toEncoded(schema).ast

  return (
    SchemaAST.isObjects(ast) &&
    ast.propertySignatures.length === 0 &&
    ast.indexSignatures.length === 0
  )
}

const NoArguments = Schema.Record(Schema.String, Schema.Never)

export const decodeToolArguments = <S extends ToolArgumentsSchema>(
  schema: S,
  options?: SchemaAST.ParseOptions
) => {
  // Report every issue (each unknown key, each invalid field) so the model can fix the call in one
  // retry, and reject unknown keys as the closed advertised schema says.
  const parseOptions: SchemaAST.ParseOptions = {
    errors: 'all',
    onExcessProperty: 'error',
    ...options
  }

  const decode = Schema.decodeUnknownEffect(Schema.toCodecJson(schema), parseOptions)

  // A root empty struct would accept unknown keys; check it as "no arguments" first.
  const checkNoArguments = isEmptyStructSchema(schema)
    ? Schema.decodeUnknownEffect(NoArguments, parseOptions)
    : undefined

  const decodeChecked = (input: unknown) =>
    checkNoArguments === undefined
      ? decode(input)
      : checkNoArguments(input).pipe(Effect.flatMap(() => decode(input)))

  return (input: unknown): Effect.Effect<S['Type'], Schema.SchemaError> =>
    decodeChecked(omitUndefinedKeys(input)).pipe(
      Effect.flatMap(decoded => {
        const path = nonFiniteNumberPath(decoded, [], new Set())

        return path === undefined
          ? Effect.succeed(decoded)
          : Effect.fail(nonFiniteNumberError(path))
      })
    )
}

type JsonObject = Schema.JsonObject

const maxSchemaDepth = 32

const localDefinitionPrefix = '#/$defs/'

const isJson = Schema.is(Schema.Json)

const isJsonObject = (value: Schema.Json | undefined): value is JsonObject =>
  Predicate.isObject(value)

const isJsonArray = (value: Schema.Json | undefined): value is Schema.JsonArray =>
  Array.isArray(value)

const jsonObject = (value: Schema.Json | undefined): JsonObject | undefined =>
  isJsonObject(value) ? value : undefined

const ownValue = (record: JsonObject, key: string): Schema.Json | undefined =>
  Object.hasOwn(record, key) ? record[key] : undefined

const schemaArray = (record: JsonObject, key: string): ReadonlyArray<Schema.Json> | undefined => {
  const value = ownValue(record, key)

  return Array.isArray(value) ? value : undefined
}

const schemaRecord = (record: JsonObject, key: string): JsonObject | undefined =>
  jsonObject(ownValue(record, key))

const requiredKeys = (schema: JsonObject): ReadonlySet<string> =>
  new Set((schemaArray(schema, 'required') ?? []).filter(Predicate.isString))

const resolveSchema = (
  schema: Schema.Json | undefined,
  definitions: JsonObject
): Schema.Json | undefined => {
  let current = schema

  for (let hop = 0; hop < maxSchemaDepth; hop++) {
    const record = jsonObject(current)

    if (record === undefined) return current

    const ref = ownValue(record, '$ref')

    if (!Predicate.isString(ref) || !ref.startsWith(localDefinitionPrefix)) return current

    const name = ref.slice(localDefinitionPrefix.length)

    if (!Object.hasOwn(definitions, name)) return current

    current = definitions[name]
  }

  return current
}

const jsonTypeOf = (value: Schema.Json) => {
  if (value === null) return 'null'

  if (Array.isArray(value)) return 'array'

  if (Predicate.isString(value)) return 'string'

  if (Predicate.isNumber(value)) return 'number'

  if (Predicate.isBoolean(value)) return 'boolean'

  return 'object'
}

const typeAccepts = (type: Schema.Json | undefined, value: Schema.Json) => {
  const valueType = jsonTypeOf(value)

  const accepts = (candidate: Schema.Json) =>
    candidate === valueType ||
    (candidate === 'integer' && Predicate.isNumber(value) && Number.isInteger(value))

  if (Predicate.isString(type)) return accepts(type)

  if (Array.isArray(type)) return type.some(accepts)

  return true
}

/** Whether a JSON Schema admits `null`. Unconstrained or unknown schemas conservatively do. */
const admitsNull = (
  schema: Schema.Json | undefined,
  definitions: JsonObject,
  depth: number
): boolean => {
  if (depth > maxSchemaDepth) return true

  const resolved = resolveSchema(schema, definitions)

  if (Predicate.isBoolean(resolved)) return resolved

  const record = jsonObject(resolved)

  if (record === undefined) return true

  if (Object.hasOwn(record, 'type') && !typeAccepts(record['type'], null)) return false

  if (Object.hasOwn(record, 'const') && record['const'] !== null) return false

  const enumValues = schemaArray(record, 'enum')

  if (enumValues !== undefined && !enumValues.includes(null)) return false

  for (const key of ['anyOf', 'oneOf']) {
    const members = schemaArray(record, key)

    if (members !== undefined && !members.some(item => admitsNull(item, definitions, depth + 1))) {
      return false
    }
  }

  const allOf = schemaArray(record, 'allOf')

  return allOf === undefined || allOf.every(item => admitsNull(item, definitions, depth + 1))
}

const matchesLiteral = (schema: JsonObject, value: Schema.Json) => {
  if (Object.hasOwn(schema, 'const')) return schema['const'] === value

  const enumValues = schemaArray(schema, 'enum')

  return enumValues === undefined || enumValues.includes(value)
}

// What the enclosing schema knows about the object being normalized:
// - `siblingKeys`: names declared by any member of the enclosing union. Provider-flattened
//   schemas (Anthropic) show the model every member's fields, so a `null` there means "not sent".
// - `declared` / `required`: names declared / required anywhere in the enclosing `allOf`
//   conjunction. One conjunct must never drop a `null` that another conjunct declares or requires.
type ObjectScope = {
  readonly siblingKeys: ReadonlySet<string>
  readonly declared: ReadonlySet<string>
  readonly required: ReadonlySet<string>
}

const noKeys: ReadonlySet<string> = new Set()

const emptyScope: ObjectScope = { siblingKeys: noKeys, declared: noKeys, required: noKeys }

const union = (left: ReadonlySet<string>, right: Iterable<string>): ReadonlySet<string> =>
  new Set([...left, ...right])

const withConjunction = (
  scope: ObjectScope,
  parts: ReadonlyArray<Schema.Json>,
  definitions: JsonObject
): ObjectScope => {
  const declared = new Set<string>()
  const required = new Set<string>()

  for (const part of parts) {
    const record = jsonObject(resolveSchema(part, definitions))

    if (record === undefined) continue

    for (const name of Object.keys(schemaRecord(record, 'properties') ?? {})) declared.add(name)

    for (const name of requiredKeys(record)) required.add(name)
  }

  return {
    siblingKeys: scope.siblingKeys,
    declared: union(scope.declared, declared),
    required: union(scope.required, required)
  }
}

// Property names declared by any member of a union. Provider-flattened schemas (Anthropic) show
// the model every member's fields, so a `null` on one of these keys means "not sent".
const unionPropertyNames = (
  members: ReadonlyArray<Schema.Json>,
  definitions: JsonObject
): ReadonlySet<string> => {
  const names = new Set<string>()

  for (const member of members) {
    const record = jsonObject(resolveSchema(member, definitions))

    if (record === undefined) continue

    for (const part of [record, ...(schemaArray(record, 'allOf') ?? [])]) {
      const properties = schemaRecord(
        jsonObject(resolveSchema(part, definitions)) ?? {},
        'properties'
      )

      for (const name of Object.keys(properties ?? {})) names.add(name)
    }
  }

  return names
}

/** Whether a union member can describe the value. Object members are matched on literal
 * discriminators, required keys, and closed property sets; optional `null` values, and `null` on
 * a key only another member declares, count as absent so a strict-mode `null` does not
 * disqualify the intended member.
 */
const unionMemberMatches = (
  member: Schema.Json,
  value: Schema.Json,
  definitions: JsonObject,
  siblingKeys: ReadonlySet<string>
): boolean => {
  const resolved = resolveSchema(member, definitions)

  if (Predicate.isBoolean(resolved)) return resolved

  const record = jsonObject(resolved)

  if (record === undefined) return true

  if (Object.hasOwn(record, 'type') && !typeAccepts(record['type'], value)) return false

  if (!matchesLiteral(record, value)) return false

  const valueRecord = jsonObject(value)

  if (valueRecord === undefined) return true

  const properties = schemaRecord(record, 'properties') ?? {}
  const required = requiredKeys(record)

  for (const key of required) {
    if (!Object.hasOwn(valueRecord, key)) return false
  }

  for (const [key, propertyValue] of Object.entries(valueRecord)) {
    const propertySchema = resolveSchema(ownValue(properties, key), definitions)

    if (propertySchema === undefined) {
      if (
        ownValue(record, 'additionalProperties') === false &&
        !(propertyValue === null && siblingKeys.has(key))
      ) {
        return false
      }

      continue
    }

    if (propertyValue === null && !required.has(key)) continue

    const propertyRecord = jsonObject(propertySchema)

    if (propertyRecord !== undefined && !matchesLiteral(propertyRecord, propertyValue)) {
      return false
    }
  }

  return true
}

const normalizeObject = (
  schema: JsonObject,
  value: JsonObject,
  definitions: JsonObject,
  depth: number,
  scope: ObjectScope
): JsonObject => {
  const properties = schemaRecord(schema, 'properties')
  const additionalProperties = ownValue(schema, 'additionalProperties')

  if (
    properties === undefined &&
    scope.siblingKeys.size === 0 &&
    jsonObject(additionalProperties) === undefined
  ) {
    return value
  }

  const required = union(requiredKeys(schema), scope.required)
  // Entries, not property assignment: an own `__proto__` key must stay an own key (and fail
  // decoding as unknown) instead of replacing the rebuilt object's prototype.
  const entries: Array<readonly [string, Schema.Json]> = []
  let changed = false

  for (const [key, propertyValue] of Object.entries(value)) {
    const declaredSchema = properties === undefined ? undefined : ownValue(properties, key)
    const propertySchema = declaredSchema ?? additionalProperties

    // `null` means "not sent": drop it on optional non-nullable properties, and on an undeclared
    // key only another member of the enclosing union declares (provider-flattened unions show
    // every member's fields). Any other undeclared key stays and fails decoding, so a misspelled
    // `null` (e.g. a "clear" meant for another key) never silently succeeds.
    if (
      propertyValue === null &&
      !required.has(key) &&
      (declaredSchema === undefined
        ? scope.siblingKeys.has(key) && !scope.declared.has(key)
        : !admitsNull(declaredSchema, definitions, 0))
    ) {
      changed = true

      continue
    }

    const normalizedValue =
      jsonObject(propertySchema) === undefined
        ? propertyValue
        : normalizeValue(propertySchema, propertyValue, definitions, depth + 1)

    changed ||= normalizedValue !== propertyValue
    entries.push([key, normalizedValue])
  }

  return changed ? Object.fromEntries(entries) : value
}

const normalizeArray = (
  schema: JsonObject,
  value: ReadonlyArray<Schema.Json>,
  definitions: JsonObject,
  depth: number
): ReadonlyArray<Schema.Json> => {
  const prefixItems = schemaArray(schema, 'prefixItems') ?? []
  const items = ownValue(schema, 'items')
  let changed = false

  const normalized = value.map((item, index) => {
    const itemSchema = index < prefixItems.length ? prefixItems[index] : items

    if (jsonObject(itemSchema) === undefined) return item

    const normalizedItem = normalizeValue(itemSchema, item, definitions, depth + 1)

    changed ||= normalizedItem !== item

    return normalizedItem
  })

  return changed ? normalized : value
}

const normalizeUnion = (
  members: ReadonlyArray<Schema.Json>,
  value: Schema.Json,
  definitions: JsonObject,
  depth: number,
  scope: ObjectScope
): Schema.Json => {
  const siblingKeys = unionPropertyNames(members, definitions)
  const memberScope: ObjectScope = { ...scope, siblingKeys }

  const candidates = members.filter(member =>
    unionMemberMatches(member, value, definitions, siblingKeys)
  )

  const [candidate] = candidates

  // Ambiguous or unmatched unions stay untouched; the decoder reports the real error.
  return candidates.length === 1
    ? normalizeValue(candidate, value, definitions, depth + 1, memberScope)
    : value
}

const normalizeValue = (
  schema: Schema.Json | undefined,
  value: Schema.Json,
  definitions: JsonObject,
  depth: number,
  scope: ObjectScope = emptyScope
): Schema.Json => {
  if (depth > maxSchemaDepth || !(isJsonObject(value) || isJsonArray(value))) return value

  const resolved = jsonObject(resolveSchema(schema, definitions))

  if (resolved === undefined) return value

  let normalized: Schema.Json = value
  const allOf = schemaArray(resolved, 'allOf')

  const objectScope =
    allOf === undefined ? scope : withConjunction(scope, [resolved, ...allOf], definitions)

  for (const member of allOf ?? []) {
    normalized = normalizeValue(member, normalized, definitions, depth + 1, objectScope)
  }

  for (const key of ['anyOf', 'oneOf']) {
    const members = schemaArray(resolved, key)

    if (members !== undefined) {
      normalized = normalizeUnion(members, normalized, definitions, depth, objectScope)
    }
  }

  if (isJsonArray(normalized)) return normalizeArray(resolved, normalized, definitions, depth)

  const record = jsonObject(normalized)

  return record === undefined
    ? normalized
    : normalizeObject(resolved, record, definitions, depth, objectScope)
}

/** Drops `null` from model-produced tool arguments only where the advertised JSON Schema marks
 * the property optional and does not admit `null` (for example `Schema.optionalKey(X)` or a raw
 * MCP schema), or on an undeclared key that another member of the enclosing union declares
 * (provider-flattened unions show every member's fields) and no conjunct of the enclosing `allOf`
 * declares. Follows local `$ref`/`$defs`, `allOf`, discriminated `anyOf`/`oneOf`, and arrays;
 * ambiguous unions are left untouched. A declared nullable value is never rewritten. Non-JSON
 * arguments and unchanged arguments are returned as the same reference.
 */
export const omitNullOptionalToolArguments = (
  parameters: ToolJsonSchema,
  params: unknown
): unknown => {
  if (!isJson(params)) return params

  const root = Predicate.isBoolean(parameters) ? undefined : parameters
  const definitions = root === undefined ? {} : (schemaRecord(root, '$defs') ?? {})

  return normalizeValue(parameters, params, definitions, 0)
}

/** Applies {@link omitNullOptionalToolArguments} to a call, preserving identity when unchanged. */
export const omitNullOptionalToolCallArguments = (
  parameters: ToolJsonSchema,
  call: ToolCall
): ToolCall => {
  const params = omitNullOptionalToolArguments(parameters, call.params)

  return params === call.params ? call : ToolCall.make({ id: call.id, name: call.name, params })
}
