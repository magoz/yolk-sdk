import { Match, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import * as SchemaAST from 'effect/SchemaAST'
import type * as SchemaIssue from 'effect/SchemaIssue'

// Model-facing hints for invalid tool-call arguments. Tool and interaction argument decoding
// rejects unknown keys; Effect's issue text names the key but not what the model should send
// instead. Shared by the tools registry and the loop (which cannot import tools).

type UnknownArgument = {
  readonly parent: ReadonlyArray<PropertyKey>
  readonly key: PropertyKey
  readonly allowed: ReadonlyArray<string>
}

const maxAllowedNames = 40

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
 * object declares, or `undefined` when there are no unknown keys. */
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

  return groups.size === 0 ? undefined : Array.from(groups.values(), formatGroup).join('\n')
}

/** Appends {@link toolArgumentsErrorHint} to an argument-validation message when available. */
export const withToolArgumentsErrorHint = (message: string, error: unknown): string => {
  const hint = error instanceof Schema.SchemaError ? toolArgumentsErrorHint(error) : undefined

  return hint === undefined ? message : `${message}\n${hint}`
}
