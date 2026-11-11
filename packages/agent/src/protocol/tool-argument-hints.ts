import { Match, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import * as SchemaAST from 'effect/SchemaAST'
import type * as SchemaIssue from 'effect/SchemaIssue'

// Model-facing hints for invalid tool-call arguments. Tool and interaction argument decoding
// rejects unknown keys; Effect's issue text names the key but not what the model should send
// instead. It also rejects a number or boolean sent as a JSON string ("120"); Effect's issue text
// says only "Expected number", which a model that believes it sent a number reads as a broken
// system, so the hint names the string it received. Shared by the tools registry and the loop
// (which cannot import tools).

type UnknownArgument = {
  readonly parent: ReadonlyArray<PropertyKey>
  readonly key: PropertyKey
  readonly allowed: ReadonlyArray<string>
}

const maxAllowedNames = 40

// Effect's issues carry no input, so `decodeToolArguments` records each failure's arguments here
// for the wrong-type hint. Weak keys: an error holds its arguments only while the error lives.
const decodedArguments = new WeakMap<Schema.SchemaError, unknown>()

/** Records the arguments a tool-argument decode rejected, for {@link toolArgumentsErrorHint}.
 * @internal */
export const recordToolArgumentsInput = (error: Schema.SchemaError, input: unknown) => {
  decodedArguments.set(error, input)
}

type ScalarKind = 'number' | 'boolean'

type WrongTypeArgument = {
  readonly path: ReadonlyArray<PropertyKey>
  readonly kinds: ReadonlyArray<ScalarKind>
}

// The scalar kinds a schema accepts, through unions (`number | null`, `Int | Literal`).
const scalarKinds = (ast: SchemaAST.AST): ReadonlyArray<ScalarKind> => {
  if (SchemaAST.isNumber(ast)) return ['number']

  if (SchemaAST.isBoolean(ast)) return ['boolean']

  if (SchemaAST.isUnion(ast)) {
    const kinds = new Set(ast.types.flatMap(scalarKinds))

    return Array.from(kinds)
  }

  return []
}

// Leaf failures whose schema accepts a number or boolean; the input decides whether a string sat
// there. A key failing in several union members is reported once by its path.
const wrongTypeArgumentsIn = (
  issue: SchemaIssue.Issue,
  path: ReadonlyArray<PropertyKey>
): ReadonlyArray<WrongTypeArgument> =>
  Match.value(issue).pipe(
    Match.tag('Pointer', pointer =>
      wrongTypeArgumentsIn(pointer.issue, [...path, ...pointer.path])
    ),
    Match.tag('Filter', wrapper => wrongTypeArgumentsIn(wrapper.issue, path)),
    Match.tag('Encoding', wrapper => {
      const kinds = scalarKinds(wrapper.ast)

      return kinds.length > 0 && path.length > 0
        ? [{ path, kinds }]
        : wrongTypeArgumentsIn(wrapper.issue, path)
    }),
    Match.tag('Composite', group =>
      group.issues.flatMap(child => wrongTypeArgumentsIn(child, path))
    ),
    Match.tag('AnyOf', group => {
      const kinds = scalarKinds(group.ast)

      return kinds.length > 0 && path.length > 0
        ? [{ path, kinds }]
        : group.issues.flatMap(child => wrongTypeArgumentsIn(child, path))
    }),
    Match.tag('InvalidType', invalid => {
      const kinds = scalarKinds(invalid.ast)

      return kinds.length > 0 && path.length > 0 ? [{ path, kinds }] : []
    }),
    Match.orElse(() => [])
  )

// The value at `path` in the recorded arguments, read through own data properties only.
const argumentAt = (input: unknown, path: ReadonlyArray<PropertyKey>): unknown => {
  let current = input

  for (const segment of path) {
    if (!Predicate.isObjectKeyword(current)) return undefined

    const descriptor = Object.getOwnPropertyDescriptor(current, segment)

    if (descriptor === undefined || !('value' in descriptor)) return undefined

    current = descriptor.value
  }

  return current
}

// A string that is exactly a JSON literal of one of the kinds, unquoted ("120" → 120).
const literalFor = (text: string, kinds: ReadonlyArray<ScalarKind>): string | undefined => {
  const trimmed = text.trim()

  if (kinds.includes('boolean') && (trimmed === 'true' || trimmed === 'false')) return trimmed

  if (!kinds.includes('number') || trimmed === '') return undefined

  return Number.isFinite(Number(trimmed)) && /^-?\d/.test(trimmed)
    ? JSON.stringify(Number(trimmed))
    : undefined
}

// Keeps the hint one short line even when a model sends long text where a number belongs.
const maxQuotedValueCharacters = 40

const formatWrongType = (argument: WrongTypeArgument, value: string) => {
  const expected = argument.kinds.map(kind => `a JSON ${kind}`).join(' or ')
  const literal = literalFor(value, argument.kinds)

  const received =
    value.length > maxQuotedValueCharacters ? `a string` : `the string ${JSON.stringify(value)}`

  return literal === undefined
    ? `Argument ${formatPath(argument.path)} must be ${expected}, but it was ${received}.`
    : `Argument ${formatPath(argument.path)} must be ${expected}, but it was ${received}: send ${literal} without quotes.`
}

const wrongTypeHints = (error: Schema.SchemaError): ReadonlyArray<string> => {
  if (!decodedArguments.has(error)) return []

  const input = decodedArguments.get(error)
  const lines = new Map<string, string>()

  for (const argument of wrongTypeArgumentsIn(error.issue, [])) {
    const value = argumentAt(input, argument.path)
    const id = JSON.stringify(argument.path.map(String))

    if (Predicate.isString(value) && !lines.has(id)) lines.set(id, formatWrongType(argument, value))
  }

  return Array.from(lines.values())
}

const unknownArgumentsIn = (
  issue: SchemaIssue.Issue,
  path: ReadonlyArray<PropertyKey>
): ReadonlyArray<UnknownArgument> =>
  Match.value(issue).pipe(
    Match.tag('Pointer', pointer => unknownArgumentsIn(pointer.issue, [...path, ...pointer.path])),
    Match.tag('Filter', 'Encoding', wrapper => unknownArgumentsIn(wrapper.issue, path)),
    Match.tag('Composite', 'AnyOf', group =>
      group.issues.flatMap(child => unknownArgumentsIn(child, path))
    ),
    Match.tag('UnexpectedKey', unexpected => {
      const key = path.at(-1)

      // Extra tuple elements (Arrays AST) are not argument names; the base message covers them.
      if (key === undefined || !SchemaAST.isObjects(unexpected.ast)) return []

      const allowed = unexpected.ast.propertySignatures
        .map(property => property.name)
        .filter(Predicate.isString)

      return [{ parent: path.slice(0, -1), key, allowed }]
    }),
    // `Record(String, Never)` (e.g. `EmptyToolParams`) rejects every key's value as `never`.
    Match.tag('InvalidType', invalid => {
      const key = path.at(-1)

      return key !== undefined && SchemaAST.isNever(invalid.ast)
        ? [{ parent: path.slice(0, -1), key, allowed: [] }]
        : []
    }),
    Match.orElse(() => [])
  )

// A quoted dotted path when unambiguous (`"a.b"`), otherwise an unquoted JSON path array
// (`["a.b"]`). The two forms never collide: only the array form starts with `[`, and any segment
// that could look like path syntax or break the line (empty, `.`, `[`, `"`, newline) forces the
// array form.
const needsArrayForm = (segment: string) => segment === '' || /[.["\n\r]/.test(segment)

const formatPath = (path: ReadonlyArray<PropertyKey>) => {
  const segments = path.map(String)

  return segments.some(needsArrayForm) ? JSON.stringify(segments) : `"${segments.join('.')}"`
}

const formatAllowed = (allowed: ReadonlyArray<string>) =>
  allowed.length === 0
    ? 'none'
    : allowed.length > maxAllowedNames
      ? `${allowed.slice(0, maxAllowedNames).join(', ')}, …`
      : allowed.join(', ')

type UnknownArgumentGroup = {
  readonly parent: ReadonlyArray<PropertyKey>
  readonly keys: Array<string>
  readonly allowed: ReadonlyArray<string>
}

const formatGroup = (group: UnknownArgumentGroup) => {
  // JSON-escaped so quotes, commas or newlines in a key cannot look like several keys.
  const keys = group.keys.map(key => JSON.stringify(key)).join(', ')
  const label = group.keys.length === 1 ? 'Unknown argument' : 'Unknown arguments'

  return group.parent.length === 0
    ? `${label} ${keys}. Allowed arguments: ${formatAllowed(group.allowed)}.`
    : `${label} ${keys} in ${formatPath(group.parent)}. Allowed there: ${formatAllowed(group.allowed)}.`
}

/** Actionable hint for unknown-key failures: one line per object (path and allowed-key set; union
 * members at one path can each produce a line), naming its unknown keys and listing the keys that
 * object declares. For arguments `decodeToolArguments` rejected, also one line per number or
 * boolean argument sent as a JSON string, naming the string and the literal to send. `undefined`
 * when there is nothing to add. */
export const toolArgumentsErrorHint = (error: Schema.SchemaError): string | undefined => {
  const groups = new Map<string, UnknownArgumentGroup>()

  for (const argument of unknownArgumentsIn(error.issue, [])) {
    // Structural identity: distinct paths or allowed lists never merge.
    const id = JSON.stringify([argument.parent.map(String), argument.allowed])
    const key = String(argument.key)
    const group = groups.get(id)

    if (group === undefined) {
      groups.set(id, { parent: argument.parent, keys: [key], allowed: argument.allowed })
    } else if (!group.keys.includes(key)) {
      group.keys.push(key)
    }
  }

  const lines = [...Array.from(groups.values(), formatGroup), ...wrongTypeHints(error)]

  return lines.length === 0 ? undefined : lines.join('\n')
}

/** Appends {@link toolArgumentsErrorHint} to an argument-validation message when available. */
export const withToolArgumentsErrorHint = (message: string, error: unknown): string => {
  const hint = error instanceof Schema.SchemaError ? toolArgumentsErrorHint(error) : undefined

  return hint === undefined ? message : `${message}\n${hint}`
}
