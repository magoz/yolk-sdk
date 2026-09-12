// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Effect, Exit, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import hooks from 'eslint-plugin-react-hooks'
import react from 'eslint-plugin-react'
import { afterEach, describe, expect, it } from 'vitest'
import { COMPILER_RULES } from './plugins/hooks-compat.js'
import hooksCompat from './plugins/hooks-compat.js'
import reactCompat from './plugins/react-compat.js'

const root = process.cwd()

const oxlint = path.join(root, 'node_modules/oxlint/bin/oxlint')

const rootConfig = path.join(root, '.oxlintrc.json')

const PROVEN_COMPILER_RULES = [
  'error-boundaries',
  'immutability',
  'incompatible-library',
  'purity',
  'refs',
  'set-state-in-effect',
  'set-state-in-render',
  'static-components'
]

const UNPROVEN_COMPILER_RULES = [
  'component-hook-factories',
  'config',
  'gating',
  'globals',
  'preserve-manual-memoization',
  'unsupported-syntax',
  'use-memo'
]

const tempDirs: Array<string> = []

const makeTempDir = (prefix: string) => {
  const directory = mkdtempSync(path.join(tmpdir(), prefix))
  tempDirs.push(directory)

  return directory
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const directory = tempDirs.pop()

    if (directory !== undefined) {
      rmSync(directory, { force: true, recursive: true })
    }
  }
})

const OxlintDiagnostic = Schema.Struct({
  code: Schema.optionalKey(Schema.String),
  severity: Schema.String,
  message: Schema.String,
  filename: Schema.String
})

const OxlintReport = Schema.Struct({
  diagnostics: Schema.Array(OxlintDiagnostic)
})

const PrintConfig = Schema.Struct({
  plugins: Schema.Array(Schema.String),
  jsPlugins: Schema.Array(
    Schema.Union([
      Schema.String,
      Schema.Struct({
        name: Schema.optionalKey(Schema.String),
        specifier: Schema.optionalKey(Schema.String)
      })
    ])
  ),
  rules: Schema.Struct({
    'oxc/no-accumulating-spread': Schema.String
  })
})

const UpstreamCompilerRules = Schema.Struct({
  'component-hook-factories': Schema.Unknown,
  config: Schema.Unknown,
  'error-boundaries': Schema.Unknown,
  gating: Schema.Unknown,
  globals: Schema.Unknown,
  immutability: Schema.Unknown,
  'incompatible-library': Schema.Unknown,
  'preserve-manual-memoization': Schema.Unknown,
  purity: Schema.Unknown,
  refs: Schema.Unknown,
  'set-state-in-effect': Schema.Unknown,
  'set-state-in-render': Schema.Unknown,
  'static-components': Schema.Unknown,
  'unsupported-syntax': Schema.Unknown,
  'use-memo': Schema.Unknown
})

const decodeOxlintReport = Schema.decodeUnknownEffect(Schema.fromJsonString(OxlintReport))

const decodePrintConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(PrintConfig))

const decodeUpstreamCompilerRules = Schema.decodeUnknownEffect(UpstreamCompilerRules)

type OxlintDiagnostic = typeof OxlintDiagnostic.Type

const execute = (args: Array<string>, filename: string) => {
  const result = spawnSync(process.execPath, [oxlint, ...args, filename], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30000
  })

  if (result.error !== undefined || result.signal !== null) {
    throw new Error(
      `Oxlint failed to run: ${result.error?.message ?? `signal ${result.signal}`}\n${result.stderr}`
    )
  }

  const decoded = Effect.runSyncExit(decodeOxlintReport(result.stdout))

  if (Exit.isFailure(decoded)) {
    throw new Error(
      [
        `Oxlint returned non-JSON output (status ${String(result.status)}).`,
        `stdout: ${result.stdout}`,
        `stderr: ${result.stderr}`
      ].join('\n')
    )
  }

  return { status: result.status, diagnostics: decoded.value.diagnostics, stderr: result.stderr }
}

const lintRoot = (filename: string) =>
  execute(['--config', rootConfig, '--no-ignore', '--format', 'json'], filename)

const writeTemp = (name: string, source: string) => {
  const directory = makeTempDir('yolk-oxlint-root-')
  const filename = path.join(directory, name)
  writeFileSync(filename, `${source.trim()}\n`)

  return filename
}

const hasCode = (diagnostics: ReadonlyArray<OxlintDiagnostic>, code: string) =>
  diagnostics.some(diagnostic => diagnostic.code === code)

describe('root Oxlint config reachability', () => {
  it('registers all 15 original compiler rules and react/no-deprecated without shims', () => {
    expect(COMPILER_RULES).toHaveLength(15)
    expect(Object.keys(hooksCompat.rules)).toEqual(COMPILER_RULES.map(([name]) => name))
    expect(UNPROVEN_COMPILER_RULES).toHaveLength(7)
    expect(PROVEN_COMPILER_RULES).toHaveLength(8)

    const decodedUpstream = Effect.runSyncExit(decodeUpstreamCompilerRules(hooks.rules))

    if (Exit.isFailure(decodedUpstream)) {
      throw new Error('eslint-plugin-react-hooks.rules missing the 15 compiler rule fields')
    }

    const upstreamCompilerRules = decodedUpstream.value

    expect(hooksCompat.rules['component-hook-factories']).toBe(
      upstreamCompilerRules['component-hook-factories']
    )
    expect(hooksCompat.rules.config).toBe(upstreamCompilerRules.config)
    expect(hooksCompat.rules['error-boundaries']).toBe(upstreamCompilerRules['error-boundaries'])
    expect(hooksCompat.rules.gating).toBe(upstreamCompilerRules.gating)
    expect(hooksCompat.rules.globals).toBe(upstreamCompilerRules.globals)
    expect(hooksCompat.rules.immutability).toBe(upstreamCompilerRules.immutability)
    expect(hooksCompat.rules['incompatible-library']).toBe(
      upstreamCompilerRules['incompatible-library']
    )
    expect(hooksCompat.rules['preserve-manual-memoization']).toBe(
      upstreamCompilerRules['preserve-manual-memoization']
    )
    expect(hooksCompat.rules.purity).toBe(upstreamCompilerRules.purity)
    expect(hooksCompat.rules.refs).toBe(upstreamCompilerRules.refs)
    expect(hooksCompat.rules['set-state-in-effect']).toBe(
      upstreamCompilerRules['set-state-in-effect']
    )
    expect(hooksCompat.rules['set-state-in-render']).toBe(
      upstreamCompilerRules['set-state-in-render']
    )
    expect(hooksCompat.rules['static-components']).toBe(upstreamCompilerRules['static-components'])
    expect(hooksCompat.rules['unsupported-syntax']).toBe(
      upstreamCompilerRules['unsupported-syntax']
    )
    expect(hooksCompat.rules['use-memo']).toBe(upstreamCompilerRules['use-memo'])
    expect(Predicate.isFunction(hooksCompat.rules['purity'].create)).toBe(true)
    expect(reactCompat.rules['no-deprecated']).toBe(react.rules['no-deprecated'])
    expect(COMPILER_RULES.map(([, severity]) => severity)).toEqual([
      'error',
      'error',
      'error',
      'error',
      'error',
      'error',
      'warn',
      'error',
      'error',
      'error',
      'error',
      'error',
      'error',
      'warn',
      'error'
    ])

    const printed = spawnSync(
      process.execPath,
      [oxlint, '--config', rootConfig, '--print-config', 'packages/agent/src/index.ts'],
      { cwd: root, encoding: 'utf8' }
    )

    expect(printed.status, printed.stderr).toBe(0)
    const decodedConfig = Effect.runSyncExit(decodePrintConfig(printed.stdout))

    if (Exit.isFailure(decodedConfig)) {
      throw new Error(`oxlint --print-config was not valid JSON: ${printed.stdout}`)
    }

    const config = decodedConfig.value

    expect(config.plugins).toEqual(
      expect.arrayContaining(['import', 'jsx-a11y', 'nextjs', 'react', 'typescript', 'oxc'])
    )

    const jsPluginIds = config.jsPlugins.map(plugin => {
      if (Predicate.isString(plugin)) {
        return plugin
      }

      return plugin.name
    })

    expect(jsPluginIds.some(id => id?.includes('eslint-local-rules'))).toBe(true)
    expect(jsPluginIds).toEqual(
      expect.arrayContaining(['hooks-compat', 'react-compat', 'anti-slop', 'anti-slop-effect'])
    )
    expect(config.rules['oxc/no-accumulating-spread']).toBe('deny')
  })

  it('reaches any, assertion, underscore, JSX unused, local, legacy aliases, and accumulating-spread', () => {
    const anyFile = writeTemp('any.ts', 'export const value: any = 1')
    expect(hasCode(lintRoot(anyFile).diagnostics, 'typescript(no-explicit-any)')).toBe(true)

    const assertionFile = writeTemp('assertion.ts', 'export const value = 1 as string')
    expect(
      hasCode(lintRoot(assertionFile).diagnostics, 'typescript(consistent-type-assertions)')
    ).toBe(true)

    const unusedFile = writeTemp(
      'unused.ts',
      'export function take(value: number) { return 1 }\nconst leftover = 2'
    )

    expect(hasCode(lintRoot(unusedFile).diagnostics, 'eslint(no-unused-vars)')).toBe(true)

    const underscoreFile = writeTemp(
      'underscore.ts',
      'export function take(_value: number) { return 1 }\nconst _leftover = 2\nvoid take'
    )

    expect(hasCode(lintRoot(underscoreFile).diagnostics, 'eslint(no-unused-vars)')).toBe(false)

    const usedJsx = writeTemp(
      'used.tsx',
      `function Used() { return <div>ok</div> }
       export function App() { return <Used /> }`
    )

    expect(hasCode(lintRoot(usedJsx).diagnostics, 'eslint(no-unused-vars)')).toBe(false)

    const unusedJsx = writeTemp(
      'unused-component.tsx',
      `function UnusedComponent() { return <div>ok</div> }
       export function App() { return <div>ok</div> }`
    )

    expect(hasCode(lintRoot(unusedJsx).diagnostics, 'eslint(no-unused-vars)')).toBe(true)

    const localFile = writeTemp(
      'disable-validation.ts',
      'export const invalid = { disableValidation: true }'
    )

    expect(hasCode(lintRoot(localFile).diagnostics, 'local(no-disable-validation)')).toBe(true)

    const legacyFile = writeTemp(
      'legacy.tsx',
      `/* eslint-disable react-hooks/rules-of-hooks -- compatibility probe */
       import { useState } from 'react'
       function helper() { useState(0) }
       /* eslint-enable react-hooks/rules-of-hooks */
       // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- compatibility probe
       const mocked = {} as string
       const invalid = { disableValidation: true }
       export const Example = () => (
         <>
           {/* eslint-disable-next-line @next/next/no-img-element -- compatibility probe */}
           <img src="/fixture.png" alt="" />
         </>
       )
       void helper
       void mocked
       void invalid
       void Example`
    )

    const legacy = lintRoot(legacyFile).diagnostics
    expect(hasCode(legacy, 'typescript(consistent-type-assertions)')).toBe(false)
    expect(hasCode(legacy, 'react(rules-of-hooks)')).toBe(false)
    expect(hasCode(legacy, 'nextjs(no-img-element)')).toBe(false)
    expect(hasCode(legacy, 'local(no-disable-validation)')).toBe(true)

    const accumFile = writeTemp(
      'accum.ts',
      'export const values = items.reduce((acc, item) => [...acc, item], [])'
    )

    expect(hasCode(lintRoot(accumFile).diagnostics, 'oxc(no-accumulating-spread)')).toBe(true)
  })

  it('proves the 8 known React-compat sensitive cases and reports the 7 negative gaps', () => {
    const cases: Array<{ file: string; source: string; code: string }> = [
      {
        file: 'error-boundaries.tsx',
        code: 'hooks-compat(error-boundaries)',
        source: `function Child() { return <div>child</div> }
          export function TryCatchChild() {
            try {
              return <Child />
            } catch {
              return <div>fallback</div>
            }
          }`
      },
      {
        file: 'immutability.tsx',
        code: 'hooks-compat(immutability)',
        source: `export function WriteGlobal() {
            window.__yolkCompatProbe = true
            return <div>ok</div>
          }`
      },
      {
        file: 'incompatible-library.tsx',
        code: 'hooks-compat(incompatible-library)',
        source: `import { useForm } from 'react-hook-form'
          export function FormWatch() {
            const { watch } = useForm()
            const name = watch('name')
            return <div>{name}</div>
          }`
      },
      {
        file: 'purity.tsx',
        code: 'hooks-compat(purity)',
        source: `export function NowLabel() {
            const now = Date.now()
            return <div>{now}</div>
          }`
      },
      {
        file: 'refs.tsx',
        code: 'hooks-compat(refs)',
        source: `import { useRef } from 'react'
          export function ReadRefDuringRender() {
            const ref = useRef<HTMLDivElement | null>(null)
            const current = ref.current
            return <div ref={ref}>{current ? 'yes' : 'no'}</div>
          }`
      },
      {
        file: 'set-state-in-effect.tsx',
        code: 'hooks-compat(set-state-in-effect)',
        source: `import { useEffect, useState } from 'react'
          export function SyncSet() {
            const [n, setN] = useState(0)
            useEffect(() => {
              setN(1)
            }, [])
            return <div>{n}</div>
          }`
      },
      {
        file: 'set-state-in-render.tsx',
        code: 'hooks-compat(set-state-in-render)',
        source: `import { useState } from 'react'
          export function SetDuringRender() {
            const [n, setN] = useState(0)
            setN(n + 1)
            return <div>{n}</div>
          }`
      },
      {
        file: 'static-components.tsx',
        code: 'hooks-compat(static-components)',
        source: `export function Outer() {
            function Inner() {
              return <span>inner</span>
            }
            return <Inner />
          }`
      }
    ]

    for (const testCase of cases) {
      const filename = writeTemp(testCase.file, testCase.source)
      const result = lintRoot(filename)
      expect(
        hasCode(result.diagnostics, testCase.code),
        `${testCase.file} -> ${testCase.code}`
      ).toBe(true)
    }

    const deprecated = writeTemp(
      'no-deprecated-class.tsx',
      `import { Component } from 'react'
       export class Legacy extends Component {
         componentWillMount() {}
         render() { return <div>legacy</div> }
       }`
    )

    expect(hasCode(lintRoot(deprecated).diagnostics, 'react-compat(no-deprecated)')).toBe(true)

    const valid = writeTemp(
      'pure-counter.tsx',
      `import { useState } from 'react'
       export function Counter() {
         const [n, setN] = useState(0)
         return <button onClick={() => setN(n + 1)}>{n}</button>
       }`
    )

    const validDiagnostics = lintRoot(valid).diagnostics.filter(diagnostic => {
      if (Predicate.isString(diagnostic.code) === false) {
        return false
      }

      return diagnostic.code.startsWith('hooks-compat(')
    })

    expect(validDiagnostics).toEqual([])

    expect(UNPROVEN_COMPILER_RULES).toEqual([
      'component-hook-factories',
      'config',
      'gating',
      'globals',
      'preserve-manual-memoization',
      'unsupported-syntax',
      'use-memo'
    ])

    const decodedUnproven = Effect.runSyncExit(decodeUpstreamCompilerRules(hooks.rules))

    if (Exit.isFailure(decodedUnproven)) {
      throw new Error('eslint-plugin-react-hooks.rules missing the 15 compiler rule fields')
    }

    expect(hooksCompat.rules['component-hook-factories']).toBe(
      decodedUnproven.value['component-hook-factories']
    )
    expect(hooksCompat.rules.config).toBe(decodedUnproven.value.config)
    expect(hooksCompat.rules.gating).toBe(decodedUnproven.value.gating)
    expect(hooksCompat.rules.globals).toBe(decodedUnproven.value.globals)
    expect(hooksCompat.rules['preserve-manual-memoization']).toBe(
      decodedUnproven.value['preserve-manual-memoization']
    )
    expect(hooksCompat.rules['unsupported-syntax']).toBe(
      decodedUnproven.value['unsupported-syntax']
    )
    expect(hooksCompat.rules['use-memo']).toBe(decodedUnproven.value['use-memo'])
  })
})
