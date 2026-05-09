/**
 * @fileoverview Disallow { disableValidation: true } in Schema operations
 *
 * This rule prevents disabling validation in Effect Schema operations,
 * which defeats the purpose of using Schema for type-safe data validation.
 */

/** @type {import('eslint').Rule.RuleModule} */
export const noDisableValidation = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow { disableValidation: true } in Schema operations',
      category: 'Best Practices',
      recommended: true
    },
    messages: {
      noDisableValidation:
        'Never use { disableValidation: true }. Fix the data or schema instead. See patterns/EFFECT_BEST_PRACTICES.md'
    },
    schema: []
  },
  create(context) {
    return {
      Property(node) {
        // Check for disableValidation: true
        if (
          node.key &&
          ((node.key.type === 'Identifier' && node.key.name === 'disableValidation') ||
            (node.key.type === 'Literal' && node.key.value === 'disableValidation')) &&
          node.value &&
          node.value.type === 'Literal' &&
          node.value.value === true
        ) {
          context.report({
            node,
            messageId: 'noDisableValidation'
          })
        }
      }
    }
  }
}
