/**
 * Load original eslint-plugin-react `no-deprecated` into Oxlint.
 * Native Oxlint has no `react/no-deprecated`; `react` is a reserved plugin name.
 * No visitor rewrite and no context shim — original rule object only.
 */
import { Predicate } from 'effect'
import react from 'eslint-plugin-react'

const noDeprecated = react.rules['no-deprecated']

if (noDeprecated === undefined || Predicate.isFunction(noDeprecated.create) === false) {
  throw new Error('react-compat missing original react/no-deprecated')
}

/** @type {import('@oxlint/plugins').Plugin} */
const reactCompatPlugin = {
  meta: { name: 'react-compat' },
  rules: {
    'no-deprecated': noDeprecated
  }
}

export default reactCompatPlugin
