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

// Effect records no input on issues unless decoded with `reportInput`, which would also print every
// rejected value in the error text, so `decodeToolArguments` records each failure's arguments here
// for the wrong-type hint. Weak keys: an error holds its arguments only while the error lives.
const decodedArguments = new WeakMap<Schema.SchemaError, unknown>()

/** Records the arguments a tool-argument decode rejected, for {@link toolArgumentsErrorHint}.
 * @internal */
export const recordToolArgumentsInput = (error: Schema.SchemaError, input: unknown) => {
  decodedArguments.set(error, input)
}

type ScalarKind = 'number' | 'boolean'

// What a schema accepts on its wire (encoded) side: number/boolean kinds, and which strings
// (`any`, or only these literals).
type Accepted = {
  readonly kinds: ReadonlyArray<ScalarKind>
  readonly strings: 'any' | ReadonlyArray<string>
}

type WrongTypeArgument = { readonly path: ReadonlyArray<PropertyKey> } & Accepted

// The JSON codec of a bare `Schema.Number` adds these string literals; they do not make a quoted
// number valid.
const nonFiniteLiterals: ReadonlySet<string> = new Set(['NaN', 'Infinity', '-Infinity'])

const acceptedOnWire = (ast: SchemaAST.AST): Accepted => {
  if (SchemaAST.isNumber(ast)) return { kinds: ['number'], strings: [] }

  if (SchemaAST.isBoolean(ast)) return { kinds: ['boolean'], strings: [] }

  if (SchemaAST.isString(ast) || SchemaAST.isTemplateLiteral(ast)) {
    return { kinds: [], strings: 'any' }
  }

  if (SchemaAST.isLiteral(ast)) return acceptedLiterals([ast.literal])

  if (SchemaAST.isEnum(ast)) return acceptedLiterals(ast.enums.map(([, value]) => value))

  if (SchemaAST.isUnion(ast)) return mergeAccepted(ast.types.map(acceptedOnWire))

  return { kinds: [], strings: [] }
}

const acceptedLiterals = (literals: ReadonlyArray<unknown>): Accepted => {
  const kinds: Array<ScalarKind> = []

  if (literals.some(Predicate.isNumber)) kinds.push('number')

  if (literals.some(Predicate.isBoolean)) kinds.push('boolean')

  return {
    kinds,
    strings: literals.filter(Predicate.isString).filter(text => !nonFiniteLiterals.has(text))
  }
}

const mergeAccepted = (all: ReadonlyArray<Accepted>): Accepted => ({
  kinds: Array.from(new Set(all.flatMap(accepted => accepted.kinds))),
  strings: all.some(accepted => accepted.strings === 'any')
    ? 'any'
    : Array.from(
        new Set(all.flatMap(accepted => (accepted.strings === 'any' ? [] : accepted.strings)))
      )
})

const acceptedAt = (ast: SchemaAST.AST, path: ReadonlyArray<PropertyKey>) => {
  const accepted = acceptedOnWire(SchemaAST.toEncoded(ast))

  return accepted.kinds.length > 0 && path.length > 0 ? [{ path, ...accepted }] : []
}

const startsWith = (path: ReadonlyArray<PropertyKey>, prefix: ReadonlyArray<PropertyKey>) =>
  prefix.length <= path.length && prefix.every((segment, index) => path[index] === segment)

// Every path where an issue failed, so a union member can tell whether it accepted a value.
const issuePathsIn = (
  issue: SchemaIssue.Issue,
  path: ReadonlyArray<PropertyKey>
): ReadonlyArray<ReadonlyArray<PropertyKey>> =>
  Match.value(issue).pipe(
    Match.tag('Pointer', pointer => issuePathsIn(pointer.issue, [...path, ...pointer.path])),
    Match.tag('Filter', 'Encoding', wrapper => issuePathsIn(wrapper.issue, path)),
    Match.tag('Composite', 'AnyOf', group => {
      const paths = group.issues.flatMap(child => issuePathsIn(child, path))

      return paths.length === 0 ? [path] : paths
    }),
    Match.orElse(() => [path])
  )

// Union members Effect tried: an argument one member rejects is dropped when another member
// accepted the value there (it failed nowhere on or under that path), since the fix may lie
// elsewhere. A member that does not declare the key reports it as unexpected, which counts as a
// failure there.
const unionWrongTypeArguments = (
  issues: ReadonlyArray<SchemaIssue.Issue>,
  path: ReadonlyArray<PropertyKey>
): ReadonlyArray<WrongTypeArgument> => {
  if (issues.length <= 1) return issues.flatMap(child => wrongTypeArgumentsIn(child, path))

  const failures = issues.map(child => issuePathsIn(child, path))

  return issues.flatMap((child, index) =>
    wrongTypeArgumentsIn(child, path).filter(argument =>
      failures.every(
        (paths, other) =>
          other === index ||
          paths.some(
            failed => startsWith(argument.path, failed) || startsWith(failed, argument.path)
          )
      )
    )
  )
}

// Failures at a schema that takes a number or boolean on the wire; the input decides whether a
// string sat there.
const wrongTypeArgumentsIn = (
  issue: SchemaIssue.Issue,
  path: ReadonlyArray<PropertyKey>
): ReadonlyArray<WrongTypeArgument> =>
  Match.value(issue).pipe(
    Match.tag('Pointer', pointer =>
      wrongTypeArgumentsIn(pointer.issue, [...path, ...pointer.path])
    ),
    Match.tag('Filter', wrapper => wrongTypeArgumentsIn(wrapper.issue, path)),
    Match.tag('Encoding', wrapper => [
      ...acceptedAt(wrapper.ast, path),
      ...wrongTypeArgumentsIn(wrapper.issue, path)
    ]),
    Match.tag('Composite', group =>
      group.issues.flatMap(child => wrongTypeArgumentsIn(child, path))
    ),
    Match.tag('AnyOf', group => [
      ...acceptedAt(group.ast, path),
      ...unionWrongTypeArguments(group.issues, path)
    ]),
    Match.tag('InvalidType', invalid => acceptedAt(invalid.ast, path)),
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

const jsonNumber = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/

// A string that is exactly a JSON literal of one of the kinds, sent back unquoted as written.
const literalFor = (text: string, kinds: ReadonlyArray<ScalarKind>): string | undefined => {
  const trimmed = text.trim()

  if (kinds.includes('boolean') && (trimmed === 'true' || trimmed === 'false')) return trimmed

  return kinds.includes('number') && jsonNumber.test(trimmed) && Number.isFinite(Number(trimmed))
    ? trimmed
    : undefined
}

// Keeps the hint one short line even when a model sends long text where a number belongs.
const maxQuotedValueCharacters = 40

const maxWrongTypeLines = 20

const formatWrongType = (argument: WrongTypeArgument, value: string): string | undefined => {
  const literal = literalFor(value, argument.kinds)

  // A string the schema may take (`String`), or one of its string literals ("all"): only a
  // quoted literal is certainly the mistake.
  if (argument.strings === 'any' || argument.strings.includes(value)) return undefined

  if (argument.strings.length > 0 && literal === undefined) return undefined

  const expected = argument.kinds.map(kind => `a JSON ${kind}`).join(' or ')

  const received =
    value.length > maxQuotedValueCharacters ? `a string` : `the string ${JSON.stringify(value)}`

  return literal === undefined
    ? `Argument ${formatPath(argument.path)} must be ${expected}, but it was ${received}.`
    : `Argument ${formatPath(argument.path)} must be ${expected}, but it was ${received}: send ${literal} without quotes.`
}

const wrongTypeHints = (error: Schema.SchemaError): ReadonlyArray<string> => {
  if (!decodedArguments.has(error)) return []

  const input = decodedArguments.get(error)
  const byPath = new Map<string, WrongTypeArgument>()

  for (const argument of wrongTypeArgumentsIn(error.issue, [])) {
    const id = JSON.stringify(argument.path.map(String))
    const seen = byPath.get(id)

    byPath.set(
      id,
      seen === undefined ? argument : { path: argument.path, ...mergeAccepted([seen, argument]) }
    )
  }

  const lines = Array.from(byPath.values()).flatMap(argument => {
    const value = argumentAt(input, argument.path)
    const line = Predicate.isString(value) ? formatWrongType(argument, value) : undefined

    return line === undefined ? [] : [line]
  })

  return lines.length > maxWrongTypeLines
    ? [
        ...lines.slice(0, maxWrongTypeLines),
        `${lines.length - maxWrongTypeLines} more number or boolean arguments were sent as strings.`
      ]
    : lines
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
