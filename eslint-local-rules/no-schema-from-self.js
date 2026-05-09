/**
 * @fileoverview Disallow *FromSelf schema variants
 *
 * In v3, *FromSelf variants (OptionFromSelf, EitherFromSelf, etc.) expected
 * runtime representations and didn't serialize to JSON properly.
 *
 * In v4, all *FromSelf schemas were removed entirely. This rule catches
 * accidental use of stale v3 code or copy-pasted examples.
 */

const FROM_SELF_SCHEMAS = [
  'OptionFromSelf',
  'EitherFromSelf',
  'ChunkFromSelf',
  'ListFromSelf',
  'HashMapFromSelf',
  'HashSetFromSelf',
  'SortedSetFromSelf',
  'CauseFromSelf',
  'ExitFromSelf',
  'FiberIdFromSelf',
  'DurationFromSelf',
  'BigIntFromSelf',
  'SymbolFromSelf',
  'URLFromSelf',
  'RedactedFromSelf'
]

/** @type {import('eslint').Rule.RuleModule} */
export const noSchemaFromSelf = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow *FromSelf schema variants - removed in Effect v4',
      category: 'Best Practices',
      recommended: true
    },
    messages: {
      noFromSelf:
        'Schema.{{name}} does not exist in Effect v4. Use Schema.{{alternative}} instead. See patterns/EFFECT_BEST_PRACTICES.md'
    },
    schema: []
  },
  create(context) {
    return {
      MemberExpression(node) {
        if (
          node.object.type === 'Identifier' &&
          node.object.name === 'Schema' &&
          node.property.type === 'Identifier' &&
          FROM_SELF_SCHEMAS.includes(node.property.name)
        ) {
          const name = node.property.name
          const alternative = name.replace('FromSelf', '')

          context.report({
            node,
            messageId: 'noFromSelf',
            data: { name, alternative }
          })
        }
      }
    }
  }
}
