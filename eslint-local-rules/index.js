/**
 * Local ESLint rules for Effect-TS best practices
 *
 * These rules enforce the conventions documented in patterns/EFFECT_BEST_PRACTICES.md
 */

import { noDisableValidation } from './no-disable-validation.js'
import { noCatchAllCause } from './no-catch-all-cause.js'
import { noSchemaFromSelf } from './no-schema-from-self.js'
import { noSchemaDecodeSync } from './no-schema-decode-sync.js'
import { preferOptionFromNullable } from './prefer-option-from-nullable.js'

/** @type {import('eslint').ESLint.Plugin} */
export const localRulesPlugin = {
  meta: {
    name: 'local',
    version: '1.0.0'
  },
  rules: {
    'no-disable-validation': noDisableValidation,
    'no-catch-all-cause': noCatchAllCause,
    'no-schema-from-self': noSchemaFromSelf,
    'no-schema-decode-sync': noSchemaDecodeSync,
    'prefer-option-from-nullable': preferOptionFromNullable
  }
}

// Recommended config preset
export const recommended = {
  plugins: {
    local: localRulesPlugin
  },
  rules: {
    'local/no-disable-validation': 'error',
    'local/no-catch-all-cause': 'error',
    'local/no-schema-from-self': 'error',
    'local/no-schema-decode-sync': 'error',
    'local/prefer-option-from-nullable': 'warn'
  }
}
