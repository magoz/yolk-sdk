/**
 * Local Oxlint JavaScript rules for Effect-TS best practices
 *
 * These rules enforce the conventions documented in patterns/EFFECT_BEST_PRACTICES.md
 */

import { noDisableValidation } from './no-disable-validation.js'
import { noCatchAllCause } from './no-catch-all-cause.js'
import { noSchemaFromSelf } from './no-schema-from-self.js'
import { noSchemaDecodeSync } from './no-schema-decode-sync.js'
import { preferOptionFromNullable } from './prefer-option-from-nullable.js'
import { noNodeDepsInAgentTools } from './no-node-deps-in-agent-tools.js'

/** @type {import('@oxlint/plugins').Plugin} */
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
    'no-node-deps-in-agent-tools': noNodeDepsInAgentTools,
    'prefer-option-from-nullable': preferOptionFromNullable
  }
}

export default localRulesPlugin
