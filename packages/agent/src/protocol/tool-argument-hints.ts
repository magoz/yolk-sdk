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

const formatPath = (path: ReadonlyArray<PropertyKey>) => path.map(String).join('.')

const formatAllowed = (allowed: ReadonlyArray<string>) =>
  allowed.length === 0
    ? 'none'
    : allowed.length > maxAllowedNames
      ? `${allowed.slice(0, maxAllowedNames).join(', ')}, …`
      : allowed.join(', ')

const formatUnknownArgument = (argument: UnknownArgument) =>
  argument.parent.length === 0
    ? `Unknown argument "${String(argument.key)}". Allowed arguments: ${formatAllowed(argument.allowed)}.`
    : `Unknown argument "${String(argument.key)}" in "${formatPath(argument.parent)}". Allowed there: ${formatAllowed(argument.allowed)}.`

/** Actionable hint for unknown-key failures (one line per unknown key, listing the keys the
 * matched object declares), or `undefined` when the error has no unknown keys. */
export const toolArgumentsErrorHint = (error: Schema.SchemaError): string | undefined => {
  const lines = Array.from(new Set(unknownArgumentsIn(error.issue, []).map(formatUnknownArgument)))

  return lines.length === 0 ? undefined : lines.join('\n')
}

/** Appends {@link toolArgumentsErrorHint} to an argument-validation message when available. */
export const withToolArgumentsErrorHint = (message: string, error: unknown): string => {
  const hint = error instanceof Schema.SchemaError ? toolArgumentsErrorHint(error) : undefined

  return hint === undefined ? message : `${message}\n${hint}`
}
