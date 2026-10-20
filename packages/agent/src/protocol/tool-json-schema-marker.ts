import type * as Schema from 'effect/Schema'
import { Predicate } from 'effect'
import { toolJsonSchemaOmittedNullComment } from './tool.ts'

// Internal helpers for the omitted-null marker (`toolJsonSchemaOmittedNullComment`). Lowering
// (`tools/omitted-null.ts`) adds it, Claude compatibility consumes it, and every other provider
// adapter removes it with `withoutToolJsonSchemaOmittedNullMarker` before sending a schema.

// Values under these keywords are literal data, never schemas.
const dataKeywords = new Set(['const', 'default', 'enum', 'examples'])

// Values under these keywords are maps from names (or patterns) to schemas. Their entries are
// named by the schema author, so a name such as `enum` or `default` is never read as a keyword.
// Legacy `dependencies` entries are schemas or property-name arrays; arrays of strings pass
// through unchanged.
const schemaMapKeywords = new Set([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas',
  'dependencies'
])

/** Whether a JSON value is a JSON object (not an array or a primitive). */
export const isJsonObjectValue = (value: Schema.Json): value is Schema.JsonObject =>
  Predicate.isObjectOrArray(value) && !Array.isArray(value)

const mapEntries = (
  object: Schema.JsonObject,
  f: (key: string, value: Schema.Json) => Schema.Json
): Schema.JsonObject => {
  let changed = false

  const entries = Object.entries(object).map(([key, value]): [string, Schema.Json] => {
    const next = f(key, value)

    changed ||= next !== value

    return [key, next]
  })

  return changed ? Object.fromEntries(entries) : object
}

const mapArray = (
  items: ReadonlyArray<Schema.Json>,
  f: (value: Schema.Json) => Schema.Json
): ReadonlyArray<Schema.Json> => {
  const next = items.map(f)

  return next.some((item, index) => item !== items[index]) ? next : items
}

/** Rebuilds a JSON Schema with `f` applied to every schema object, children first, following
 * schema positions only (literal data under `const`/`default`/`enum`/`examples` is untouched).
 * Unchanged subtrees keep their identity, so a schema without matches is returned as is.
 */
export const mapToolJsonSchemaObjects = (
  schema: Schema.Json,
  f: (schema: Schema.JsonObject) => Schema.JsonObject
): Schema.Json => {
  if (Array.isArray(schema)) {
    return mapArray(schema, item => mapToolJsonSchemaObjects(item, f))
  }

  if (!isJsonObjectValue(schema)) return schema

  const children = mapEntries(schema, (key, value) => {
    if (dataKeywords.has(key)) return value

    if (schemaMapKeywords.has(key) && isJsonObjectValue(value)) {
      return mapEntries(value, (_, child) => mapToolJsonSchemaObjects(child, f))
    }

    return mapToolJsonSchemaObjects(value, f)
  })

  return f(children)
}

/** Whether `schema` is a `{ type: 'null' }` member carrying the omitted-null marker. */
export const isToolJsonSchemaOmittedNull = (schema: Schema.JsonObject): boolean =>
  Object.hasOwn(schema, 'type') &&
  schema['type'] === 'null' &&
  Object.hasOwn(schema, '$comment') &&
  schema['$comment'] === toolJsonSchemaOmittedNullComment

const withoutMarker = (schema: Schema.JsonObject): Schema.JsonObject =>
  isToolJsonSchemaOmittedNull(schema)
    ? Object.fromEntries(Object.entries(schema).filter(([key]) => key !== '$comment'))
    : schema

/** The schema as providers that do not use the omitted-null marker must receive it: the exact
 * marker `$comment` is removed from `{ type: 'null' }` members in schema positions, nothing else.
 * Without a marker the same value is returned, so the request body is unchanged.
 */
export const withoutToolJsonSchemaOmittedNullMarker = (schema: Schema.Json): Schema.Json =>
  mapToolJsonSchemaObjects(schema, withoutMarker)
