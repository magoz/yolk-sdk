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
//    (`Schema.optionalKey(X)`, raw/MCP JSON Schemas). Strict-mode models still fill those with
//    `null`; the registry drops such a `null` before any registration decodes or forwards the
//    arguments. It only drops a `null` the declaring property schema rejects (union members are
//    eliminated only on certain grounds), so it never loses meaning; a `null` on an undeclared
//    key is rejected like any unknown key.

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

/** Decoder for model-produced tool/interaction call arguments.
 *
 * Decodes through `Schema.toCodecJson(schema)`, the codec that `ToolDef.parameters` advertises, so
 * `null` on `Schema.optional(X)` decodes as absent and unknown keys are rejected (policy, not
 * configurable). `undefined`-valued keys from in-process callers count as absent. The JSON codec
 * also accepts the strings `"NaN"`/`"Infinity"`/`"-Infinity"` for bare `Schema.Number`; JSON
 * arguments never carried non-finite numbers before, so any non-finite number in the decoded value
 * is a validation error.
 */
export const decodeToolArguments = <S extends ToolArgumentsSchema>(schema: S) => {
  // Report every issue (each unknown key, each invalid field) so the model can fix the call in one
  // retry, and reject unknown keys as the closed advertised schema says.
  const parseOptions: SchemaAST.ParseOptions = { errors: 'all', onExcessProperty: 'error' }

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

// Each `$ref` hop of a schema, starting with the schema itself (bounded).
const refHops = (schema: Schema.Json | undefined, definitions: JsonObject): Array<JsonObject> => {
  const hops: Array<JsonObject> = []
  let current = schema

  for (let hop = 0; hop < maxSchemaDepth; hop++) {
    const record = jsonObject(current)

    if (record === undefined) return hops

    hops.push(record)

    const ref = ownValue(record, '$ref')

    if (!Predicate.isString(ref) || !ref.startsWith(localDefinitionPrefix)) return hops

    const name = ref.slice(localDefinitionPrefix.length)

    if (!Object.hasOwn(definitions, name)) return hops

    current = definitions[name]
  }

  return hops
}

// A schema whose `$ref` did not resolve (non-local, `#/definitions/...`, missing, or too deep) is
// unknown: its siblings may be ignored by the dialect (draft-07), so it never justifies a drop.
const isUnresolvedRef = (record: JsonObject) => Object.hasOwn(record, '$ref')

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

// Schema records already visited for one value level of normalization. Each record is applied at
// most once per value, so `$ref` cycles terminate; across property paths the walk budget bounds
// total work. A skipped revisit only means fewer drops, so it stays fail-closed.
type Visited = Set<JsonObject>

// Memoized `admitsNull` results for one call: each schema record is evaluated once, so shared
// `$ref`s stay linear and exact. A record still being evaluated (a `$ref` cycle) counts as
// admitting `null`, which only means fewer drops.
type NullMemo = Map<JsonObject, boolean>

/** Whether a JSON Schema admits `null`. Unconstrained or unknown schemas conservatively do. */
const admitsNull = (
  schema: Schema.Json | undefined,
  definitions: JsonObject,
  depth: number,
  memo: NullMemo
): boolean => {
  if (depth > maxSchemaDepth) return true

  // Keywords beside a `$ref` still apply; `nullable` on any hop must not be lost by resolving.
  if (refHops(schema, definitions).some(hop => ownValue(hop, 'nullable') === true)) return true

  const resolved = resolveSchema(schema, definitions)

  if (Predicate.isBoolean(resolved)) return resolved

  const record = jsonObject(resolved)

  if (record === undefined || isUnresolvedRef(record)) return true

  const known = memo.get(record)

  if (known !== undefined) return known

  memo.set(record, true)

  const result = recordAdmitsNull(record, definitions, depth, memo)

  memo.set(record, result)

  return result
}

const recordAdmitsNull = (
  record: JsonObject,
  definitions: JsonObject,
  depth: number,
  memo: NullMemo
): boolean => {
  // OpenAPI-style `nullable: true` (common in MCP servers) admits `null` alongside `type`.
  if (ownValue(record, 'nullable') === true) return true

  if (Object.hasOwn(record, 'type') && !typeAccepts(record['type'], null)) return false

  if (Object.hasOwn(record, 'const') && record['const'] !== null) return false

  const enumValues = schemaArray(record, 'enum')

  if (enumValues !== undefined && !enumValues.includes(null)) return false

  for (const key of ['anyOf', 'oneOf']) {
    const members = schemaArray(record, key)

    if (
      members !== undefined &&
      !members.some(item => admitsNull(item, definitions, depth + 1, memo))
    ) {
      return false
    }
  }

  const allOf = schemaArray(record, 'allOf')

  return allOf === undefined || allOf.every(item => admitsNull(item, definitions, depth + 1, memo))
}

// Literal comparison is exact only for primitives; object/array literals never eliminate.
const matchesLiteral = (schema: JsonObject, value: Schema.Json) => {
  if (Object.hasOwn(schema, 'const')) {
    const literal = schema['const']

    return (
      literal === value || Predicate.isObjectOrArray(literal) || Predicate.isObjectOrArray(value)
    )
  }

  const enumValues = schemaArray(schema, 'enum')

  return (
    enumValues === undefined ||
    enumValues.includes(value) ||
    Predicate.isObjectOrArray(value) ||
    enumValues.some(Predicate.isObjectOrArray)
  )
}

/** Whether a union member can still describe the value. A member is eliminated only on certain
 * grounds: a boolean `false` schema, a JSON `type` mismatch, a primitive literal mismatch (member
 * or declared property discriminator), or a missing required key. Closed property sets never
 * eliminate a member (`patternProperties`, nested composition and `$ref` make them uncertain), so
 * an uncertain union stays ambiguous and its value is left untouched. Optional `null` values count
 * as absent so a strict-mode `null` does not disqualify the intended member.
 */
const unionMemberMatches = (
  member: Schema.Json,
  value: Schema.Json,
  definitions: JsonObject
): boolean => {
  const resolved = resolveSchema(member, definitions)

  if (Predicate.isBoolean(resolved)) return resolved

  const record = jsonObject(resolved)

  if (record === undefined || isUnresolvedRef(record)) return true

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

    if (propertySchema === undefined) continue

    if (propertyValue === null && !required.has(key)) continue

    const propertyRecord = jsonObject(propertySchema)

    if (
      propertyRecord !== undefined &&
      !isUnresolvedRef(propertyRecord) &&
      !matchesLiteral(propertyRecord, propertyValue)
    ) {
      return false
    }
  }

  return true
}

// Per-call walk state. `budget` bounds total schema visits so hostile schemas (shared refs reached
// through many property paths) cannot stall dispatch; once spent, the rest of the value is left
// unchanged, which only means fewer drops. Each drop made before that is independently justified.
type Walk = {
  readonly definitions: JsonObject
  readonly prefixItems: boolean
  readonly budget: { remaining: number }
}

const maxSchemaVisits = 10_000

const normalizeObject = (
  schema: JsonObject,
  value: JsonObject,
  walk: Walk,
  depth: number
): JsonObject => {
  const properties = schemaRecord(schema, 'properties')

  // With `patternProperties`, an undeclared key may be governed by a pattern rather than by
  // `additionalProperties`; never normalize undeclared keys through it then.
  const additionalProperties = Object.hasOwn(schema, 'patternProperties')
    ? undefined
    : ownValue(schema, 'additionalProperties')

  if (properties === undefined && jsonObject(additionalProperties) === undefined) return value

  const required = requiredKeys(schema)
  // Entries, not property assignment: an own `__proto__` key must stay an own key (and fail
  // decoding as unknown) instead of replacing the rebuilt object's prototype.
  const entries: Array<readonly [string, Schema.Json]> = []
  let changed = false

  for (const [key, propertyValue] of Object.entries(value)) {
    // Once the walk budget is spent, keep every remaining entry unchanged.
    if (walk.budget.remaining <= 0) {
      entries.push([key, propertyValue])

      continue
    }

    const declaredSchema = properties === undefined ? undefined : ownValue(properties, key)
    const propertySchema = declaredSchema ?? additionalProperties

    // `null` means "not sent" only where this property's own declaration rejects `null`. Every
    // applicable schema must accept a value, so one rejecting declaration means the `null` could
    // never have been accepted and no meaning is lost. Undeclared keys are never touched:
    // decoding rejects them with a hint naming the allowed keys.
    if (
      propertyValue === null &&
      declaredSchema !== undefined &&
      !required.has(key) &&
      !admitsNull(declaredSchema, walk.definitions, 0, new Map())
    ) {
      changed = true

      continue
    }

    const normalizedValue =
      jsonObject(propertySchema) === undefined
        ? propertyValue
        : normalizeValue(propertySchema, propertyValue, walk, depth + 1, new Set())

    changed ||= normalizedValue !== propertyValue
    entries.push([key, normalizedValue])
  }

  return changed ? Object.fromEntries(entries) : value
}

const normalizeArray = (
  schema: JsonObject,
  value: ReadonlyArray<Schema.Json>,
  walk: Walk,
  depth: number
): ReadonlyArray<Schema.Json> => {
  const prefixItems = schemaArray(schema, 'prefixItems') ?? []

  // `prefixItems` is a 2020-12 keyword: other dialects ignore it and may apply `items` to every
  // element. Leave such arrays unchanged rather than guess.
  if (!walk.prefixItems && prefixItems.length > 0) return value

  const items = ownValue(schema, 'items')
  let changed = false

  const normalized = value.map((item, index) => {
    const itemSchema = index < prefixItems.length ? prefixItems[index] : items

    if (jsonObject(itemSchema) === undefined) return item

    const normalizedItem = normalizeValue(itemSchema, item, walk, depth + 1, new Set())

    changed ||= normalizedItem !== item

    return normalizedItem
  })

  return changed ? normalized : value
}

const normalizeUnion = (
  members: ReadonlyArray<Schema.Json>,
  value: Schema.Json,
  walk: Walk,
  depth: number,
  visited: Visited
): Schema.Json => {
  const candidates = members.filter(member => unionMemberMatches(member, value, walk.definitions))
  const [candidate] = candidates

  // Ambiguous or unmatched unions stay untouched; the decoder reports the real error.
  return candidates.length === 1
    ? normalizeValue(candidate, value, walk, depth + 1, visited)
    : value
}

const normalizeValue = (
  schema: Schema.Json | undefined,
  value: Schema.Json,
  walk: Walk,
  depth: number,
  visited: Visited
): Schema.Json => {
  if (depth > maxSchemaDepth || !(isJsonObject(value) || isJsonArray(value))) return value

  const resolved = jsonObject(resolveSchema(schema, walk.definitions))

  if (
    resolved === undefined ||
    isUnresolvedRef(resolved) ||
    visited.has(resolved) ||
    walk.budget.remaining <= 0
  ) {
    return value
  }

  walk.budget.remaining -= 1
  visited.add(resolved)

  let normalized: Schema.Json = value

  for (const member of schemaArray(resolved, 'allOf') ?? []) {
    normalized = normalizeValue(member, normalized, walk, depth + 1, visited)
  }

  for (const key of ['anyOf', 'oneOf']) {
    const members = schemaArray(resolved, key)

    if (members !== undefined) {
      normalized = normalizeUnion(members, normalized, walk, depth, visited)
    }
  }

  if (isJsonArray(normalized)) return normalizeArray(resolved, normalized, walk, depth)

  const record = jsonObject(normalized)

  return record === undefined ? normalized : normalizeObject(resolved, record, walk, depth)
}

// `prefixItems` semantics are 2020-12 (also the OpenAPI 3.1 base dialect); absent `$schema`
// follows the 2020-12 documents Yolk advertises.
const hasPrefixItemsDialect = (root: JsonObject | undefined) => {
  const dialect = root === undefined ? undefined : ownValue(root, '$schema')

  return !Predicate.isString(dialect) || /2020-12|oas\/3\.1/.test(dialect)
}

// A `$id` below the root rebases `$ref` resolution (and may hide definitions behind its own
// `$defs`); root-`$defs` resolution would then pick the wrong schema. Such documents are left
// unchanged. Bounded scan; data positions (`const`, `default`, ...) can only cause a skip.
const maxScannedNodes = 10_000

const hasNestedResourceId = (root: Schema.Json): boolean => {
  const pending: Array<Schema.Json> = [root]
  let scanned = 0

  while (pending.length > 0) {
    const node = pending.pop()

    scanned += 1

    if (scanned > maxScannedNodes) return true

    if (isJsonObject(node) && node !== root && Object.hasOwn(node, '$id')) return true

    const children = isJsonArray(node) ? node : isJsonObject(node) ? Object.values(node) : []

    // Enqueue one by one (no argument spread) and stop at the bound: huge `enum`/`default` data
    // must not throw or stall before the limit applies.
    for (const child of children) {
      if (pending.length + scanned > maxScannedNodes) return true

      pending.push(child)
    }
  }

  return false
}

/** Drops `null` from model-produced tool arguments only where the advertised JSON Schema declares
 * the property, marks it optional, and does not admit `null` there (for example
 * `Schema.optionalKey(X)` or a raw MCP schema). Such a `null` could never be accepted, so dropping
 * it loses no meaning. Undeclared keys and declared nullable values are never rewritten. Follows
 * local `$ref`/`$defs`, `allOf`, discriminated `anyOf`/`oneOf`, and arrays; ambiguous unions are
 * left untouched. Non-JSON arguments and unchanged arguments are returned as the same reference.
 */
export const omitNullOptionalToolArguments = (
  parameters: ToolJsonSchema,
  params: unknown
): unknown => {
  if (!isJson(params) || hasNestedResourceId(parameters)) return params

  const root = Predicate.isBoolean(parameters) ? undefined : parameters

  const walk: Walk = {
    definitions: root === undefined ? {} : (schemaRecord(root, '$defs') ?? {}),
    prefixItems: hasPrefixItemsDialect(root),
    budget: { remaining: maxSchemaVisits }
  }

  return normalizeValue(parameters, params, walk, 0, new Set())
}

/** Applies {@link omitNullOptionalToolArguments} to a call, preserving identity when unchanged. */
export const omitNullOptionalToolCallArguments = (
  parameters: ToolJsonSchema,
  call: ToolCall
): ToolCall => {
  const params = omitNullOptionalToolArguments(parameters, call.params)

  return params === call.params ? call : ToolCall.make({ id: call.id, name: call.name, params })
}
