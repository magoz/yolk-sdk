import { Match, Predicate } from 'effect'
import type * as Schema from 'effect/Schema'
import type * as SchemaIssue from 'effect/SchemaIssue'
import { ProviderStreamInvalidField, type ProviderStreamFieldType } from '@yolk-sdk/agent/protocol'

// Paths name only the schema's declared fields because the provider schemas have no `Record`
// fields and no excess-key checks (`onExcessProperty: 'error'`), the only issue paths that carry
// upstream keys; keep it so. Non-identifier segments are masked as a second guard.
const fieldNamePattern = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

const maxPathSegments = 16

type IssuePath = ReadonlyArray<PropertyKey>

const leafPath = (): IssuePath => []

/** Path to the first leaf issue, depth-first: the field a decode rejected first. */
const firstIssuePath = (issue: SchemaIssue.Issue): IssuePath =>
  Match.value(issue).pipe(
    Match.tagsExhaustive({
      Pointer: pointer => [...pointer.path, ...firstIssuePath(pointer.issue)],
      Composite: composite => firstIssuePath(composite.issues[0]),
      AnyOf: anyOf => {
        const [first] = anyOf.issues

        return first === undefined ? [] : firstIssuePath(first)
      },
      Filter: filter => firstIssuePath(filter.issue),
      Encoding: encoding => firstIssuePath(encoding.issue),
      InvalidType: leafPath,
      InvalidValue: leafPath,
      MissingKey: leafPath,
      UnexpectedKey: leafPath,
      Forbidden: leafPath,
      OneOf: leafPath
    })
  )

const jsonFieldType = (value: Schema.Json | undefined): ProviderStreamFieldType => {
  if (value === undefined) return 'missing'

  if (value === null) return 'null'

  if (Array.isArray(value)) return 'array'

  if (Predicate.isString(value)) return 'string'

  if (Predicate.isNumber(value)) return 'number'

  if (Predicate.isBoolean(value)) return 'boolean'

  return 'object'
}

const isJsonObject = (value: Schema.Json): value is Schema.JsonObject =>
  Predicate.isObjectOrArray(value) && !Array.isArray(value)

const childAt = (value: Schema.Json, segment: PropertyKey): Schema.Json | undefined => {
  if (Array.isArray(value)) return Predicate.isNumber(segment) ? value[segment] : undefined

  if (!isJsonObject(value) || !Predicate.isString(segment)) return undefined

  return Object.hasOwn(value, segment) ? value[segment] : undefined
}

const valueAt = (input: Schema.Json, path: IssuePath): Schema.Json | undefined =>
  path.reduce<Schema.Json | undefined>(
    (current, segment) => (current === undefined ? undefined : childAt(current, segment)),
    input
  )

const formatSegment = (segment: PropertyKey) => {
  if (Predicate.isNumber(segment)) return '[]'

  return Predicate.isString(segment) && fieldNamePattern.test(segment) ? `.${segment}` : '.?'
}

const formatPath = (path: IssuePath) =>
  `$${path.slice(0, maxPathSegments).map(formatSegment).join('')}`

/**
 * The first field `input` (already-parsed JSON) failed in `error`, named by schema field names
 * and the JSON type found there. Never reads the rejected value beyond its type.
 */
export const invalidFieldOf = (
  input: Schema.Json,
  error: Schema.SchemaError
): ProviderStreamInvalidField => {
  const path = firstIssuePath(error.issue)

  return ProviderStreamInvalidField.make({
    path: formatPath(path),
    received: jsonFieldType(valueAt(input, path))
  })
}
