/**
 * @fileoverview Disallow Effect.catchCause (v4) / Effect.catchAllCause (v3)
 *
 * Effect.catchCause catches both expected errors AND defects (bugs).
 * Use Effect.catch or Effect.mapError instead to only catch expected errors.
 *
 * Detects both v4 name (catchCause) and v3 name (catchAllCause) for safety.
 */

const BANNED_METHODS = ['catchCause', 'catchAllCause']

/** @type {import('eslint').Rule.RuleModule} */
export const noCatchAllCause = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow Effect.catchCause - use Effect.catch or mapError instead',
      category: 'Best Practices',
      recommended: true
    },
    messages: {
      noCatchAllCause:
        'Avoid Effect.{{name}} - it catches defects (bugs) that should crash. Use Effect.catch or Effect.mapError to only catch expected errors. See patterns/EFFECT_BEST_PRACTICES.md'
    },
    schema: []
  },
  create(context) {
    return {
      // Match Effect.catchCause(...) / Effect.catchAllCause(...)
      CallExpression(node) {
        if (
          node.callee.type === 'MemberExpression' &&
          node.callee.object.type === 'Identifier' &&
          node.callee.object.name === 'Effect' &&
          node.callee.property.type === 'Identifier' &&
          BANNED_METHODS.includes(node.callee.property.name)
        ) {
          context.report({
            node,
            messageId: 'noCatchAllCause',
            data: { name: node.callee.property.name }
          })
        }
      },
      // Match .pipe(Effect.catchCause, ...) / .pipe(Effect.catchAllCause, ...)
      Identifier(node) {
        if (
          BANNED_METHODS.includes(node.name) &&
          node.parent &&
          node.parent.type === 'MemberExpression' &&
          node.parent.object.type === 'Identifier' &&
          node.parent.object.name === 'Effect'
        ) {
          // Only report if not already caught by CallExpression
          if (node.parent.parent && node.parent.parent.type !== 'CallExpression') {
            context.report({
              node: node.parent,
              messageId: 'noCatchAllCause',
              data: { name: node.name }
            })
          }
        }
      }
    }
  }
}
