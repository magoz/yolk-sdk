/**
 * Load original eslint-plugin-react-hooks compiler rules into Oxlint.
 * `react` / `react-hooks` namespaces are reserved; this plugin uses `hooks-compat`.
 * No visitor rewrite and no context shim — original rule objects only.
 */
import { Predicate } from 'effect'
import hooks from 'eslint-plugin-react-hooks'

export const COMPILER_RULES = [
  ['component-hook-factories', 'error'],
  ['config', 'error'],
  ['error-boundaries', 'error'],
  ['gating', 'error'],
  ['globals', 'error'],
  ['immutability', 'error'],
  ['incompatible-library', 'warn'],
  ['preserve-manual-memoization', 'error'],
  ['purity', 'error'],
  ['refs', 'error'],
  ['set-state-in-effect', 'error'],
  ['set-state-in-render', 'error'],
  ['static-components', 'error'],
  ['unsupported-syntax', 'warn'],
  ['use-memo', 'error']
]

const original = hooks.rules

const rules = {
  'component-hook-factories': original['component-hook-factories'],
  config: original.config,
  'error-boundaries': original['error-boundaries'],
  gating: original.gating,
  globals: original.globals,
  immutability: original.immutability,
  'incompatible-library': original['incompatible-library'],
  'preserve-manual-memoization': original['preserve-manual-memoization'],
  purity: original.purity,
  refs: original.refs,
  'set-state-in-effect': original['set-state-in-effect'],
  'set-state-in-render': original['set-state-in-render'],
  'static-components': original['static-components'],
  'unsupported-syntax': original['unsupported-syntax'],
  'use-memo': original['use-memo']
}

const missing = []

for (const [name, rule] of Object.entries(rules)) {
  if (rule === undefined || Predicate.isFunction(rule.create) === false) {
    missing.push(name)
  }
}

if (missing.length > 0) {
  throw new Error(`hooks-compat missing original rules: ${missing.join(', ')}`)
}

if (Object.keys(rules).length !== 15) {
  throw new Error(`hooks-compat expected 15 compiler rules, loaded ${Object.keys(rules).length}`)
}

/** @type {import('@oxlint/plugins').Plugin} */
const hooksCompatPlugin = {
  meta: { name: 'hooks-compat' },
  rules
}

export default hooksCompatPlugin
