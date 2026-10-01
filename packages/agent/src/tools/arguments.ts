import { Effect, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import type * as SchemaAST from 'effect/SchemaAST'
import * as SchemaIssue from 'effect/SchemaIssue'
import { ToolCall, type ToolJsonSchema } from '@yolk-sdk/agent/protocol'

// Model tool-call arguments are JSON that the model produced from the advertised `ToolDef.parameters`.
// That advertisement is `Schema.toJsonSchemaDocument(schema)`, which describes the canonical JSON
// codec of the schema, not its type side: the JSON codec encodes `undefined` as `null`, so every
// `Schema.optional(X)` is advertised as `X | null`. Two steps make execution accept exactly what the
// model was shown, without changing the advertisement:
//
// 1. `decodeToolArguments` decodes with `Schema.toCodecJson(schema)`. `null` on `Schema.optional(X)`
//    becomes `undefined` (and `withDecodingDefault` applies), while `Schema.optional(Schema.NullOr(X))`
//    keeps `null` as a meaningful value. Required non-nullable fields still reject `null`.
// 2. `omitNullOptionalToolArguments` covers properties advertised as optional WITHOUT `null`
//    (`Schema.optionalKey(X)`, raw/MCP JSON Schemas). Strict-mode models still fill those with `null`;
//    the registry drops such a `null` before any registration decodes or forwards the arguments.

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

/** Decoder for model-produced tool/interaction call arguments.
 *
 * Decodes through `Schema.toCodecJson(schema)`, the codec that `ToolDef.parameters` advertises, so
 * `null` on `Schema.optional(X)` decodes as absent. The JSON codec also accepts the strings
 * `"NaN"`/`"Infinity"`/`"-Infinity"` for bare `Schema.Number`; JSON arguments never carried
 * non-finite numbers before, so any non-finite number in the decoded value is a validation error.
 */
export const decodeToolArguments = <S extends ToolArgumentsSchema>(
  schema: S,
  options?: SchemaAST.ParseOptions
) => {
  const decode = Schema.decodeUnknownEffect(Schema.toCodecJson(schema), options)

  return (input: unknown): Effect.Effect<S['Type'], Schema.SchemaError> =>
    decode(input).pipe(
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

/** Whether a union member can describe the value. Object members are matched on literal
 * discriminators, required keys, and closed property sets; optional `null` values count as absent
 * so a strict-mode `null` does not disqualify the intended member.
 */
const unionMemberMatches = (
  member: Schema.Json,
  value: Schema.Json,
  definitions: JsonObject
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
      if (ownValue(record, 'additionalProperties') === false && propertyValue !== null) {
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
  depth: number
): JsonObject => {
  const properties = schemaRecord(schema, 'properties')
  const additionalProperties = ownValue(schema, 'additionalProperties')

  if (properties === undefined && jsonObject(additionalProperties) === undefined) return value

  const required = requiredKeys(schema)
  const normalized: { [key: string]: Schema.Json } = {}
  let changed = false

  for (const [key, propertyValue] of Object.entries(value)) {
    const declaredSchema = properties === undefined ? undefined : ownValue(properties, key)
    const propertySchema = declaredSchema ?? additionalProperties

    if (
      declaredSchema !== undefined &&
      propertyValue === null &&
      !required.has(key) &&
      !admitsNull(declaredSchema, definitions, 0)
    ) {
      changed = true

      continue
    }

    const normalizedValue =
      jsonObject(propertySchema) === undefined
        ? propertyValue
        : normalizeValue(propertySchema, propertyValue, definitions, depth + 1)

    changed ||= normalizedValue !== propertyValue
    normalized[key] = normalizedValue
  }

  return changed ? normalized : value
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
  depth: number
): Schema.Json => {
  const candidates = members.filter(member => unionMemberMatches(member, value, definitions))
  const [candidate] = candidates

  // Ambiguous or unmatched unions stay untouched; the decoder reports the real error.
  return candidates.length === 1 ? normalizeValue(candidate, value, definitions, depth + 1) : value
}

const normalizeValue = (
  schema: Schema.Json | undefined,
  value: Schema.Json,
  definitions: JsonObject,
  depth: number
): Schema.Json => {
  if (depth > maxSchemaDepth || !(isJsonObject(value) || isJsonArray(value))) return value

  const resolved = jsonObject(resolveSchema(schema, definitions))

  if (resolved === undefined) return value

  let normalized: Schema.Json = value

  for (const member of schemaArray(resolved, 'allOf') ?? []) {
    normalized = normalizeValue(member, normalized, definitions, depth + 1)
  }

  for (const key of ['anyOf', 'oneOf']) {
    const members = schemaArray(resolved, key)

    if (members !== undefined) normalized = normalizeUnion(members, normalized, definitions, depth)
  }

  if (isJsonArray(normalized)) return normalizeArray(resolved, normalized, definitions, depth)

  const record = jsonObject(normalized)

  return record === undefined ? normalized : normalizeObject(resolved, record, definitions, depth)
}

/** Drops `null` from model-produced tool arguments only where the advertised JSON Schema marks
 * the property optional and does not admit `null` (for example `Schema.optionalKey(X)` or a raw
 * MCP schema). Follows local `$ref`/`$defs`, `allOf`, discriminated `anyOf`/`oneOf`, and arrays;
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
