/**
 * @fileoverview Prefer Effect Option nullish helpers over manual ternary branches.
 *
 * Soundness contract (verified against effect 4.0.0-beta.80 `Option.d.ts`):
 * - `Option.fromNullable` / `Option.fromNullish` do NOT exist in this version.
 *   The real constructors are `Option.fromNullishOr` (null|undefined -> None),
 *   `Option.fromNullOr` (null -> None, undefined stays Some) and
 *   `Option.fromUndefinedOr` (undefined -> None, null stays Some).
 * - Only `x != null ? NS.some(x) : NS.none()` (loose, nullish) maps to
 *   `fromNullishOr`; only `x !== null ? NS.some(x) : NS.none()` maps to
 *   `fromNullOr`; only `x !== undefined ? NS.some(x) : NS.none()` maps to
 *   `fromUndefinedOr`. Anything else (strict `!== null` confused with nullish,
 *   `==`/`===`, other literals) is left alone.
 * - Only a stable bound identifier `x` is matched: member expressions and
 *   accessors are skipped because `a.b !== null ? some(a.b) : none()` reads the
 *   (possibly getter-backed, side-effecting) member twice, which the helper
 *   would collapse to a single read. The tested name must resolve through
 *   ESLint scope to a const/parameter/import binding.
 * - The `Some` argument must be exactly the same bound identifier (no
 *   transforms like `some(transform(x))`, no extra arguments, no spreads) and
 *   `None` must take no value arguments, otherwise the shape is not equivalent.
 * - The `Option`/`some`/`none` names must resolve through ESLint scope to a
 *   real Effect import, verified against the installed `effect` runtime:
 *   `import { Option } from 'effect'` (including aliases such as
 *   `import { Option as O } from 'effect'`); `import * as E from 'effect'`
 *   used as `E.Option.some`/`E.Option.none` (the index re-exports the Option
 *   namespace); `import * as O from 'effect/Option'` used as `O.some`/`O.none`;
 *   or direct `import { some, none } from 'effect/Option'` (including aliases).
 *   The effect root exports no `some`/`none`, and the `Effect` namespace
 *   module exposes no value-level `Option`, so `E.some(...)` and
 *   `import { some } from 'effect'` are (invalid) non-matches. Shadowed locals
 *   and same-named objects from other libraries are ignored, so no production
 *   import changes are needed to satisfy this rule.
 *
 * There is no autofix: the helper choice depends on null-vs-undefined intent,
 * which the author must confirm.
 */

/** @type {import('@oxlint/plugins').Rule} */
export const preferOptionFromNullable = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Prefer Effect Option nullish helpers (fromNullishOr/fromNullOr/fromUndefinedOr) over manual ternary branches',
      category: 'Best Practices',
      recommended: true
    },
    messages: {
      preferOptionHelper:
        'Use {{helper}}({{name}}) instead of a manual ternary with Option.some/Option.none. Loose != null maps to fromNullishOr; strict !== null maps to fromNullOr; strict !== undefined maps to fromUndefinedOr. See patterns/EFFECT_BEST_PRACTICES.md'
    },
    schema: []
  },
  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode()

    const findVariable = (scope, name) => {
      let current = scope

      while (current) {
        const variable = current.variables.find(candidate => candidate.name === name)

        if (variable) {
          return variable
        }

        current = current.upper
      }

      return null
    }

    // Resolve a local name to its import binding: { source, imported }, where
    // imported is the original exported name ('*' for namespace imports).
    // Non-import bindings (shadowed locals, parameters, globals) yield null.
    const importBinding = (scope, name) => {
      const variable = findVariable(scope, name)

      if (!variable || variable.defs.length !== 1) {
        return null
      }

      const [def] = variable.defs

      if (def.type !== 'ImportBinding') {
        return null
      }

      const parent = def.parent

      if (!parent || parent.type !== 'ImportDeclaration') {
        return null
      }

      const node = def.node

      if (node.type === 'ImportSpecifier') {
        if (node.imported.type !== 'Identifier') {
          return null
        }

        return { source: parent.source.value, imported: node.imported.name }
      }

      if (node.type === 'ImportNamespaceSpecifier') {
        return { source: parent.source.value, imported: '*' }
      }

      return null
    }

    // `NS` in `NS.some` / `NS.none`: the effect Option namespace object.
    const isOptionNamespace = (scope, name) => {
      const binding = importBinding(scope, name)

      if (!binding) {
        return false
      }

      return (
        (binding.source === 'effect' && binding.imported === 'Option') ||
        (binding.source === 'effect/Option' && binding.imported === '*')
      )
    }

    // Direct `some` / `none` helpers: only exported from the effect/Option
    // submodule, never from the effect root.
    const isDirectHelper = (scope, name, helper) => {
      const binding = importBinding(scope, name)

      return !!binding && binding.source === 'effect/Option' && binding.imported === helper
    }

    // `E.Option` in `E.Option.some` / `E.Option.none`: only the module
    // namespace of the effect root re-exports Option (`import * as E`).
    const isRootOptionMember = (scope, node) => {
      if (
        node.type !== 'MemberExpression' ||
        node.computed ||
        node.object.type !== 'Identifier' ||
        node.property.type !== 'Identifier' ||
        node.property.name !== 'Option'
      ) {
        return false
      }

      const binding = importBinding(scope, node.object.name)

      return !!binding && binding.source === 'effect' && binding.imported === '*'
    }

    const isStableBinding = variable => {
      if (!variable || variable.defs.length !== 1) {
        return false
      }

      const [def] = variable.defs

      if (def.type === 'ImportBinding') {
        return true
      }

      if (def.type === 'Parameter') {
        return true
      }

      return def.type === 'Variable' && def.parent != null && def.parent.kind === 'const'
    }

    // The object of `.some` / `.none`: either the Option namespace itself
    // (`NS`) or the root-namespace member (`E.Option`). Anything else —
    // notably bare `E.some` on a root namespace — is not an Effect helper.
    const isSomeNoneObject = (scope, object) => {
      if (object.type === 'Identifier') {
        return isOptionNamespace(scope, object.name)
      }

      return isRootOptionMember(scope, object)
    }

    const isEffectNoneCallee = (scope, callee) => {
      // NS.none / NS.none<T>() — value arguments are checked by the caller.
      const target = callee.type === 'TSInstantiationExpression' ? callee.expression : callee

      if (
        target.type === 'MemberExpression' &&
        !target.computed &&
        target.property.type === 'Identifier' &&
        target.property.name === 'none' &&
        isSomeNoneObject(scope, target.object)
      ) {
        return true
      }

      return callee.type === 'Identifier' && isDirectHelper(scope, callee.name, 'none')
    }

    const isEffectSomeCall = (scope, node, variable) => {
      if (node.type !== 'CallExpression' || node.arguments.length !== 1) {
        return false
      }

      const [argument] = node.arguments

      if (!argument || argument.type !== 'Identifier' || argument.name !== variable.name) {
        return false
      }

      // The Some argument must be the exact same binding (no transforms, and no
      // unrelated same-named variable from an inner scope).
      const argumentVariable = findVariable(sourceCode.getScope(argument), argument.name)

      if (argumentVariable !== variable) {
        return false
      }

      const callee = node.callee

      if (
        callee.type === 'MemberExpression' &&
        !callee.computed &&
        callee.property.type === 'Identifier' &&
        callee.property.name === 'some' &&
        isSomeNoneObject(scope, callee.object)
      ) {
        return true
      }

      return callee.type === 'Identifier' && isDirectHelper(scope, callee.name, 'some')
    }

    return {
      ConditionalExpression(node) {
        const { test, consequent, alternate } = node

        if (test.type !== 'BinaryExpression') {
          return
        }

        if (test.operator !== '!==' && test.operator !== '!=') {
          return
        }

        // One side must be a nullish literal; the other a plain identifier.
        // `undefined` as an Identifier resolves to no binding in normal code;
        // a locally declared `undefined` binding means the literal is shadowed.
        let testedNode = null
        let helper = null

        const isNull = side => side.type === 'Literal' && side.value === null

        const isUndefinedLiteral = side => {
          if (side.type !== 'Identifier' || side.name !== 'undefined') {
            return false
          }

          // The global `undefined` has no declarations; a declared binding
          // means the literal is shadowed and the comparison is opaque.
          const variable = findVariable(sourceCode.getScope(side), 'undefined')

          return variable === null || variable.defs.length === 0
        }

        for (const [valueSide, otherSide] of [
          [test.right, test.left],
          [test.left, test.right]
        ]) {
          if (otherSide.type !== 'Identifier') {
            continue
          }

          if (isNull(valueSide)) {
            testedNode = otherSide
            helper = test.operator === '!=' ? 'Option.fromNullishOr' : 'Option.fromNullOr'
            break
          }

          if (isUndefinedLiteral(valueSide)) {
            testedNode = otherSide
            helper = test.operator === '!=' ? 'Option.fromNullishOr' : 'Option.fromUndefinedOr'
            break
          }
        }

        if (!testedNode || !helper) {
          return
        }

        const scope = sourceCode.getScope(node)
        const variable = findVariable(scope, testedNode.name)

        if (!isStableBinding(variable)) {
          return
        }

        if (!isEffectSomeCall(scope, consequent, variable)) {
          return
        }

        // Option.none() takes no value arguments; Option.none<T>() carries
        // only type arguments. Extra value arguments are not equivalent.
        if (alternate.type !== 'CallExpression' || alternate.arguments.length !== 0) {
          return
        }

        if (!isEffectNoneCallee(scope, alternate.callee)) {
          return
        }

        context.report({
          node,
          messageId: 'preferOptionHelper',
          data: { helper, name: testedNode.name }
        })
      }
    }
  }
}
