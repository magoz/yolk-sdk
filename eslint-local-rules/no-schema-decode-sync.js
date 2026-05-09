/**
 * @fileoverview Disallow synchronous Schema decode/encode operations
 *
 * Sync variants throw exceptions. Use the Effect variants that return
 * Effect<A, ParseError> for proper error handling.
 *
 * v4 note: The Effect variants were renamed (e.g. decodeUnknown → decodeUnknownEffect),
 * but the sync variants still exist with the same names.
 */

const SYNC_METHODS = [
  'decodeUnknownSync',
  'decodeSync',
  'encodeUnknownSync',
  'encodeSync',
  'validateSync',
  'asserts'
]

/** @type {import('eslint').Rule.RuleModule} */
export const noSchemaDecodeSync = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow synchronous Schema decode/encode operations',
      category: 'Best Practices',
      recommended: true
    },
    messages: {
      noSyncMethod:
        'Avoid Schema.{{name}} - it throws exceptions. Use Schema.{{alternative}} which returns an Effect. See patterns/EFFECT_BEST_PRACTICES.md'
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
          SYNC_METHODS.includes(node.property.name)
        ) {
          const name = node.property.name
          let alternative = name.replace('Sync', 'Effect')
          if (name === 'asserts') {
            alternative = 'is (for type guards) or decodeUnknownEffect (for validation)'
          }

          context.report({
            node,
            messageId: 'noSyncMethod',
            data: { name, alternative }
          })
        }
      }
    }
  }
}
