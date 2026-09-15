// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Effect, Exit } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'

const root = process.cwd()

const vendor = path.join(root, 'tools/oxlint/anti-slop')

const oxlint = path.join(root, 'node_modules/oxlint/bin/oxlint')

const oxfmt = path.join(root, 'node_modules/oxfmt/bin/oxfmt')

const rootConfig = path.join(root, '.oxlintrc.json')

const OxlintDiagnostic = Schema.Struct({
  code: Schema.String,
  severity: Schema.String,
  filename: Schema.String
})

const OxlintReport = Schema.Struct({
  diagnostics: Schema.Array(OxlintDiagnostic)
})

const OxlintRuleSeverity = Schema.Literals(['error', 'warn', 'off'])

const OxlintRuleConfig = Schema.Union([OxlintRuleSeverity, Schema.Array(Schema.Unknown)])

const OxlintRules = Schema.Record(Schema.String, OxlintRuleConfig)

const OxlintConfigOverride = Schema.Struct({
  files: Schema.optionalKey(Schema.Array(Schema.String)),
  rules: Schema.optionalKey(OxlintRules)
})

const OxlintConfig = Schema.Struct({
  rules: OxlintRules,
  overrides: Schema.optionalKey(Schema.Array(OxlintConfigOverride))
})

const RootPackageManifest = Schema.Struct({
  devDependencies: Schema.Record(Schema.String, Schema.String)
})

const decodeOxlintReport = Schema.decodeUnknownEffect(Schema.fromJsonString(OxlintReport))

const decodeOxlintConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(OxlintConfig))

const decodeRootPackageManifest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RootPackageManifest)
)

type SpawnResult = {
  error?: Error
  signal: NodeJS.Signals | null
  status: number | null
  stdout: string
  stderr: string
}

type OxlintDiagnostic = typeof OxlintDiagnostic.Type

type OxlintReport = typeof OxlintReport.Type

// Independent manifest: dropping a registration or upstream suite must fail this test.
const genericProbes = {
  'no-array-filter-map': '[].filter(active).map(email)',
  'no-reduce-accumulator-copy': 'items.reduce(acc => Object.assign({}, acc), {})',
  'no-chained-type-assertions': 'const value = input as unknown as string',
  'no-conditional-empty-object-spread': 'const value = { ...(enabled ? { id: 1 } : {}) }',
  'no-known-value-widening': 'const value: unknown = {}',
  'no-module-mocking': "import { vi } from 'vitest'\n\nvi.mock('example')",
  'no-object-parameters': 'function use(value: object) { return value }',
  'no-reflect-apply': 'Reflect.apply(fn, receiver, args)',
  'no-reflect-get': "Reflect.get(value, 'id')",
  'no-runtime-typeof': "const result = typeof value === 'string'",
  'no-shape-in-symbol-names': 'type UserShape = string',
  'no-unknown-parameters': 'function use(value: unknown) { return value }',
  'no-unknown-returns': 'declare function read(): unknown',
  'no-unknown-type-aliases': 'type Value = unknown',
  'no-unsafe-dictionary-type': 'type Values = Record<string, unknown>',
  'no-widen-then-assert':
    "const source = { id: 'second' }; const widened: unknown = source; const parsed = widened as { readonly id: string };",
  'require-readable-spacing': 'export const a = 1\nexport const b = 2',
  'require-safety-comment-for-type-assertion': 'const value = input as string'
}

const effectProbes = {
  'no-manual-effect-error-tag': "Effect.catch(error => error._tag === 'NotFound' ? recover : fail)",
  'no-manual-tag-comparison': "const ready = value._tag === 'Ready'",
  'no-manual-tagged-construction': "const value = { _tag: 'Ready' }",
  'no-service-constructor-imports': "import { makeIssueService } from './issue-service.ts'",
  'prefer-effect-match': "const value = kind === 'a' ? first : kind === 'b' ? second : fallback"
}

const probes = [
  ...Object.entries(genericProbes).map(([rule, source]) => ({
    namespace: 'anti-slop',
    rule,
    source,
    suite: `rules/${rule}.test.ts`
  })),
  ...Object.entries(effectProbes).map(([rule, source]) => ({
    namespace: 'anti-slop-effect',
    rule,
    source,
    suite: `effect/rules/${rule}.test.ts`
  }))
]

// Root policy retires four syntax-only blankets that cannot see ownership,
// validation, or lifetimes. Vendor RuleTester suites for these rules still run.
const retiredRootRuleNames = new Set([
  'no-unknown-parameters',
  'no-unknown-returns',
  'no-object-parameters',
  'no-service-constructor-imports'
])

const testFileOffRuleNames = new Set(['no-module-mocking', 'no-manual-tagged-construction'])

const testFileGlobs = [
  '**/*.test.{js,jsx,mjs,cjs,ts,tsx,mts,cts}',
  '**/*.spec.{js,jsx,mjs,cjs,ts,tsx,mts,cts}'
]

const activeProbes = probes.filter(probe => retiredRootRuleNames.has(probe.rule) === false)

const retiredProbes = probes.filter(probe => retiredRootRuleNames.has(probe.rule))

const testFileOffProbes = probes.filter(probe => testFileOffRuleNames.has(probe.rule))

const representativeRepoDirs = [
  'packages/agent/src',
  'examples/next/lib',
  'cloudflare/agent/src',
  'apps/docs/lib',
  'scripts'
]

const spacingSources = {
  'comments.ts': 'export const a = 1; // trailing\n/** Attached to b. */\nexport const b = 2;\n',
  'overloads.ts':
    'export function f(a: string): string;\nexport function f(a: number): number;\nexport function f(a: string | number) { return a; }\n',
  'asi.ts': 'const a = 1\n;[1].forEach(f)\n',
  'generator.ts':
    "const f = Effect.gen(function* () {\nconst a = yield* A;\nconst b = yield* B;\nconst dispatch = Effect.fn('dispatch')(function* () {\nyield* a;\n});\nreturn dispatch;\n});\n",
  'control.ts': 'function f() {\nif (ok) { go(); }\nstop();\nwhile (ok) go();\nreturn 1;\n}\n',
  'wrapping.tsx':
    'export function Example() {\nconst config = { firstLongProperty: "first long value here", secondLongProperty: "second long value here", thirdLongProperty: "third long value here" }\nconst label = config.firstLongProperty\nreturn <div>{label}</div>\n}\n'
}

const execute = (binary: string, args: Array<string>): SpawnResult => {
  const result = spawnSync(process.execPath, [binary, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30000
  })

  return {
    error: result.error,
    signal: result.signal,
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? ''
  }
}

const parseOxlintJson = (result: SpawnResult): OxlintReport => {
  const exit = Effect.runSyncExit(decodeOxlintReport(result.stdout))

  if (Exit.isSuccess(exit)) {
    return exit.value
  }

  throw new Error(
    `oxlint emitted invalid JSON (status=${result.status} signal=${result.signal} stderr=${result.stderr.slice(0, 500)})`
  )
}

const resolvedDiagnostic = (diagnostic: OxlintDiagnostic) => ({
  code: diagnostic.code,
  severity: diagnostic.severity,
  filename: path.resolve(root, diagnostic.filename)
})

const expectRuleHit = (
  diagnostics: ReadonlyArray<OxlintDiagnostic>,
  probe: (typeof probes)[number],
  filename: string
) => {
  // Presence-only: extra diagnostics on a probe file are allowed (a probe may
  // also trip a related rule). Reachability fails only when the expected code
  // is missing.
  const expected = {
    code: `${probe.namespace}(${probe.rule})`,
    severity: 'error',
    filename: path.resolve(filename)
  }

  expect(
    diagnostics.map(resolvedDiagnostic),
    `${probe.namespace}/${probe.rule} in ${filename}`
  ).toContainEqual(expected)
}

const expectRuleAbsent = (
  diagnostics: ReadonlyArray<OxlintDiagnostic>,
  probe: (typeof probes)[number],
  filename: string
) => {
  const unexpected = {
    code: `${probe.namespace}(${probe.rule})`,
    severity: 'error',
    filename: path.resolve(filename)
  }

  expect(
    diagnostics.map(resolvedDiagnostic),
    `${probe.namespace}/${probe.rule} must not fire in ${filename}`
  ).not.toContainEqual(unexpected)
}

describe('vendored anti-slop integration', () => {
  it('pins Node 24 and the plugin API pair and accounts for every upstream suite', () => {
    expect(process.versions.node.split('.')[0]).toBe('24')

    const pkg = Effect.runSync(
      decodeRootPackageManifest(readFileSync(path.join(root, 'package.json'), 'utf8'))
    )

    expect(pkg.devDependencies.oxlint).toBe('1.78.0')
    expect(pkg.devDependencies['@oxlint/plugins']).toBe('1.78.0')
    expect(pkg.devDependencies.oxfmt).toBe('0.63.0')
    expect(pkg.devDependencies['eslint-plugin-react-hooks']).toBe('7.0.1')
    expect(pkg.devDependencies['eslint-plugin-react']).toBe('7.37.5')
    expect(probes).toHaveLength(23)
    expect(retiredProbes).toHaveLength(4)
    expect(activeProbes).toHaveLength(19)
    expect(testFileOffProbes).toHaveLength(2)

    const files = readdirSync(vendor, { encoding: 'utf8', recursive: true })
      .filter(file => file.endsWith('.test.ts'))
      .toSorted()

    expect(files).toEqual(
      [...probes.map(probe => probe.suite), 'rules/require-readable-spacing-cli.test.ts'].toSorted()
    )

    const config = Effect.runSync(decodeOxlintConfig(readFileSync(rootConfig, 'utf8')))
    const enabled = Object.keys(config.rules).filter(rule => rule.startsWith('anti-slop'))

    expect(enabled.toSorted()).toEqual(
      probes.map(probe => `${probe.namespace}/${probe.rule}`).toSorted()
    )

    for (const probe of probes) {
      const rule = `${probe.namespace}/${probe.rule}`

      if (retiredRootRuleNames.has(probe.rule)) {
        expect(config.rules[rule]).toBe('off')
        continue
      }

      expect(config.rules[rule]).toBe('error')
    }

    expect(config.rules['oxc/no-accumulating-spread']).toBe('error')

    const antiSlopOverrides = (config.overrides ?? []).flatMap(override => {
      const rules = Object.fromEntries(
        Object.entries(override.rules ?? {}).filter(([rule]) => rule.startsWith('anti-slop'))
      )

      if (Object.keys(rules).length === 0) {
        return []
      }

      return [{ files: override.files, rules }]
    })

    expect(antiSlopOverrides).toEqual([
      {
        files: testFileGlobs,
        rules: {
          'anti-slop/no-module-mocking': 'off',
          'anti-slop-effect/no-manual-tagged-construction': 'off'
        }
      }
    ])
  })

  it('rejects malformed oxlint reports, package manifests, and oxlint configs', () => {
    expect(Exit.isFailure(Effect.runSyncExit(decodeOxlintReport('')))).toBe(true)
    expect(Exit.isFailure(Effect.runSyncExit(decodeOxlintReport('{')))).toBe(true)
    expect(Exit.isFailure(Effect.runSyncExit(decodeOxlintReport('{}')))).toBe(true)
    expect(Exit.isFailure(Effect.runSyncExit(decodeOxlintReport('{"diagnostics":null}')))).toBe(
      true
    )
    expect(
      Exit.isFailure(
        Effect.runSyncExit(
          decodeOxlintReport('{"diagnostics":[{"code":1,"severity":"error","filename":"x.ts"}]}')
        )
      )
    ).toBe(true)
    expect(Exit.isSuccess(Effect.runSyncExit(decodeOxlintReport('{"diagnostics":[]}')))).toBe(true)
    expect(
      Exit.isFailure(Effect.runSyncExit(decodeRootPackageManifest('{"devDependencies":[]}')))
    ).toBe(true)
    expect(
      Exit.isFailure(
        Effect.runSyncExit(decodeOxlintConfig('{"rules":{"anti-slop/no-array-filter-map":true}}'))
      )
    ).toBe(true)
    expect(
      Exit.isSuccess(
        Effect.runSyncExit(decodeOxlintConfig('{"rules":{"oxc/no-accumulating-spread":"error"}}'))
      )
    ).toBe(true)
  })

  it.each([...probes.map(probe => probe.suite), 'rules/require-readable-spacing-cli.test.ts'])(
    'executes native Node RuleTester/CLI assertions: %s',
    suite => {
      const result = execute(path.join(vendor, suite), [])

      expect(result.error).toBeUndefined()
      expect(result.signal).toBeNull()
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    }
  )

  it.each(activeProbes)(
    'reaches $namespace/$rule as an error through the actual root config',
    probe => {
      const directory = mkdtempSync(path.join(tmpdir(), 'yolk-anti-slop-reachability-'))
      const filename = path.join(directory, 'runtime.ts')

      try {
        writeFileSync(filename, `${probe.source}\n`)

        const result = execute(oxlint, ['--config', rootConfig, '--format', 'json', filename])

        expect(result.error).toBeUndefined()
        expect(result.signal).toBeNull()
        expect(result.status, result.stderr).toBe(1)

        expectRuleHit(parseOxlintJson(result).diagnostics, probe, filename)
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    }
  )

  it.each(retiredProbes)(
    'does not fire retired $namespace/$rule through the actual root config',
    probe => {
      const directory = mkdtempSync(path.join(tmpdir(), 'yolk-anti-slop-retired-'))
      const filename = path.join(directory, 'runtime.ts')

      try {
        writeFileSync(filename, `${probe.source}\n`)

        const result = execute(oxlint, ['--config', rootConfig, '--format', 'json', filename])

        expect(result.error).toBeUndefined()
        expect(result.signal).toBeNull()

        expectRuleAbsent(parseOxlintJson(result).diagnostics, probe, filename)
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    }
  )

  it.each(representativeRepoDirs)(
    'reaches every active anti-slop rule through root config in %s',
    directory => {
      const scratch = mkdtempSync(path.join(root, directory, 'yolk-anti-slop-'))

      try {
        const files = probes.map(probe => {
          const filename = path.join(scratch, `${probe.namespace}-${probe.rule}.ts`)

          writeFileSync(filename, `${probe.source}\n`)

          return { filename, probe }
        })

        const result = execute(oxlint, [
          '--config',
          rootConfig,
          '--format',
          'json',
          ...files.map(file => file.filename)
        ])

        expect(result.error).toBeUndefined()
        expect(result.signal).toBeNull()
        expect(result.status, result.stderr).toBe(1)

        const diagnostics = parseOxlintJson(result).diagnostics

        for (const file of files) {
          if (retiredRootRuleNames.has(file.probe.rule)) {
            expectRuleAbsent(diagnostics, file.probe, file.filename)
            continue
          }

          expectRuleHit(diagnostics, file.probe, file.filename)
        }
      } finally {
        rmSync(scratch, { recursive: true, force: true })
      }
    }
  )

  it('accepts compliant code with all plugins loaded and honors upstream path-sensitive defaults', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'yolk-anti-slop-valid-'))
    const filename = path.join(directory, 'service.test.ts')

    try {
      writeFileSync(
        filename,
        "import { makeIssueService } from './issue-service.ts'\n\nexport const value = makeIssueService()\n"
      )

      const result = execute(oxlint, ['--config', rootConfig, '--format', 'json', filename])

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
      expect(parseOxlintJson(result).diagnostics).toEqual([])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('accepts decoder, opaque rejection, object walker, makeTool, and type-only make imports without retired codes', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'yolk-anti-slop-retired-clean-'))
    const filename = path.join(directory, 'runtime.ts')

    try {
      writeFileSync(
        filename,
        [
          "import { makeTool } from './registry.ts'",
          "import type { makeAgentTextRuntime } from './runtime-factory.ts'",
          '',
          'export const propertyValue = (input: unknown, _key: string): unknown => input',
          'export const onError = (error: unknown) => error',
          'export const isPlain = (value: object) => Object.getPrototypeOf(value) === Object.prototype',
          'export type AgentTextRuntimeMake = ReturnType<typeof makeAgentTextRuntime>',
          'export const tool = makeTool',
          ''
        ].join('\n')
      )

      const result = execute(oxlint, ['--config', rootConfig, '--format', 'json', filename])
      const diagnostics = parseOxlintJson(result).diagnostics

      expect(result.error).toBeUndefined()
      expect(result.signal).toBeNull()

      for (const probe of retiredProbes) {
        expectRuleAbsent(diagnostics, probe, filename)
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('still rejects known-value widening, aliases, casts, any, runtime tagged objects, and module mocks', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'yolk-anti-slop-duals-'))
    const filename = path.join(directory, 'runtime.ts')

    try {
      writeFileSync(
        filename,
        [
          "import { vi } from 'vitest'",
          '',
          'export const widened: unknown = {}',
          'export type Payload = unknown',
          'export const chained = input as unknown as string',
          'export const value: any = 1',
          'export const asserted = 1 as string',
          "export const tagged = { _tag: 'Ready' }",
          "vi.mock('example')",
          ''
        ].join('\n')
      )

      const result = execute(oxlint, ['--config', rootConfig, '--format', 'json', filename])
      const diagnostics = parseOxlintJson(result).diagnostics

      expect(result.error).toBeUndefined()
      expect(result.signal).toBeNull()
      expect(result.status, result.stderr).toBe(1)
      expect(diagnostics.map(resolvedDiagnostic)).toEqual(
        expect.arrayContaining([
          {
            code: 'anti-slop(no-known-value-widening)',
            severity: 'error',
            filename: path.resolve(filename)
          },
          {
            code: 'anti-slop(no-unknown-type-aliases)',
            severity: 'error',
            filename: path.resolve(filename)
          },
          {
            code: 'anti-slop(no-chained-type-assertions)',
            severity: 'error',
            filename: path.resolve(filename)
          },
          {
            code: 'typescript(no-explicit-any)',
            severity: 'error',
            filename: path.resolve(filename)
          },
          {
            code: 'typescript(consistent-type-assertions)',
            severity: 'error',
            filename: path.resolve(filename)
          },
          {
            code: 'anti-slop-effect(no-manual-tagged-construction)',
            severity: 'error',
            filename: path.resolve(filename)
          },
          {
            code: 'anti-slop(no-module-mocking)',
            severity: 'error',
            filename: path.resolve(filename)
          }
        ])
      )
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('turns off tagged construction and module mocking only in standard test files', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'yolk-anti-slop-test-policy-'))

    const testFiles = [
      path.join(directory, 'service.test.ts'),
      path.join(directory, 'service.spec.tsx'),
      path.join(directory, 'service.test.mts'),
      path.join(directory, 'service.test.mjs')
    ]

    const coveredRuntimeFiles = [
      path.join(directory, 'runtime.ts'),
      path.join(directory, 'runtime.test-like.ts'),
      path.join(directory, 'test.ts')
    ]

    const source = [
      "import { vi } from 'vitest'",
      '',
      "export const invalidWire = { _tag: 'Nope' }",
      "vi.mock('example')",
      ''
    ].join('\n')

    try {
      for (const filename of [...testFiles, ...coveredRuntimeFiles]) {
        writeFileSync(filename, source)
      }

      const result = execute(oxlint, [
        '--config',
        rootConfig,
        '--format',
        'json',
        ...testFiles,
        ...coveredRuntimeFiles
      ])

      const diagnostics = parseOxlintJson(result).diagnostics

      expect(result.error).toBeUndefined()
      expect(result.signal).toBeNull()
      expect(result.status, result.stderr).toBe(1)

      for (const filename of testFiles) {
        for (const probe of testFileOffProbes) {
          expectRuleAbsent(diagnostics, probe, filename)
        }
      }

      for (const filename of coveredRuntimeFiles) {
        for (const probe of testFileOffProbes) {
          expectRuleHit(diagnostics, probe, filename)
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('keeps type-widening, any, assertions, and other anti-slop rules as errors inside test files', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'yolk-anti-slop-test-duals-'))
    const filename = path.join(directory, 'service.test.ts')

    try {
      writeFileSync(
        filename,
        [
          'export const widened: unknown = {}',
          'export type Payload = unknown',
          'export type Values = Record<string, unknown>',
          'export const chained = input as unknown as string',
          'export const value: any = 1',
          'export const asserted = 1 as string',
          "export const result = typeof value === 'string'",
          ''
        ].join('\n')
      )

      const result = execute(oxlint, ['--config', rootConfig, '--format', 'json', filename])
      const diagnostics = parseOxlintJson(result).diagnostics

      expect(result.error).toBeUndefined()
      expect(result.signal).toBeNull()
      expect(result.status, result.stderr).toBe(1)
      expect(diagnostics.map(resolvedDiagnostic)).toEqual(
        expect.arrayContaining([
          {
            code: 'anti-slop(no-known-value-widening)',
            severity: 'error',
            filename: path.resolve(filename)
          },
          {
            code: 'anti-slop(no-unknown-type-aliases)',
            severity: 'error',
            filename: path.resolve(filename)
          },
          {
            code: 'anti-slop(no-unsafe-dictionary-type)',
            severity: 'error',
            filename: path.resolve(filename)
          },
          {
            code: 'anti-slop(no-chained-type-assertions)',
            severity: 'error',
            filename: path.resolve(filename)
          },
          {
            code: 'typescript(no-explicit-any)',
            severity: 'error',
            filename: path.resolve(filename)
          },
          {
            code: 'typescript(consistent-type-assertions)',
            severity: 'error',
            filename: path.resolve(filename)
          },
          {
            code: 'anti-slop(no-runtime-typeof)',
            severity: 'error',
            filename: path.resolve(filename)
          }
        ])
      )
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('converges Oxfmt and spacing fixes without detaching comments, overloads, or ASI protection', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'yolk-anti-slop-format-'))
    const config = path.join(directory, 'spacing.json')
    const names = [...Object.keys(spacingSources), 'registry.ts', 'react.ts']
    const files = names.map(name => path.join(directory, name))

    try {
      writeFileSync(
        config,
        JSON.stringify({
          categories: { correctness: 'off' },
          jsPlugins: [{ name: 'anti-slop', specifier: path.join(vendor, 'index.ts') }],
          rules: { 'anti-slop/require-readable-spacing': 'error' }
        })
      )

      for (const [name, source] of Object.entries(spacingSources)) {
        writeFileSync(path.join(directory, name), source)
      }

      writeFileSync(
        path.join(directory, 'registry.ts'),
        readFileSync(path.join(root, 'packages/agent/src/tools/registry.ts'), 'utf8')
      )
      writeFileSync(
        path.join(directory, 'react.ts'),
        readFileSync(path.join(root, 'packages/agent/src/voice/react.ts'), 'utf8')
      )

      const oxfmtConfig = path.join(root, '.oxfmtrc.json')
      const formatArgs = ['--config', oxfmtConfig, '--write', ...files]
      const lintArgs = ['--config', config, ...files]
      const normalized = execute(oxfmt, formatArgs)

      expect(normalized.status, `${normalized.stdout}\n${normalized.stderr}`).toBe(0)

      const rejected = execute(oxlint, lintArgs)

      expect(rejected.status).toBe(1)
      expect(rejected.stdout).toContain('require-readable-spacing')

      let previous: Array<string> = []
      let stable = false
      let lastCleanStatus: number | null = null
      let counterexample = ''

      for (let pass = 0; pass < 4; pass += 1) {
        const fixed = execute(oxlint, ['--fix', ...lintArgs])
        const formatted = execute(oxfmt, formatArgs)
        const clean = execute(oxlint, lintArgs)
        const current = files.map(file => readFileSync(file, 'utf8'))

        lastCleanStatus = clean.status

        expect(fixed.status, `${fixed.stdout}\n${fixed.stderr}`).toBe(0)
        expect(formatted.status, `${formatted.stdout}\n${formatted.stderr}`).toBe(0)

        if (clean.status === 0 && current.every((text, index) => text === previous[index])) {
          stable = true
          break
        }

        counterexample = names
          .map((name, index) => `--- ${name} ---\n${current[index] ?? ''}`)
          .join('\n')
        previous = current
      }

      expect(stable, `formatter/linter failed to converge\n${counterexample}`).toBe(true)
      expect(lastCleanStatus).toBe(0)

      const checked = execute(oxfmt, ['--config', oxfmtConfig, '--check', ...files])

      expect(checked.status, `${checked.stdout}\n${checked.stderr}`).toBe(0)

      const comments = readFileSync(path.join(directory, 'comments.ts'), 'utf8')

      expect(comments).toContain('// trailing')
      expect(comments).toContain('/** Attached to b. */')
      expect(comments).toMatch(
        /export const a = 1 \/\/ trailing\n\n\/\*\* Attached to b\. \*\/\nexport const b = 2\n/
      )

      const overloads = readFileSync(path.join(directory, 'overloads.ts'), 'utf8')

      expect(overloads).toContain('export function f(a: string): string')
      expect(overloads).toContain('export function f(a: number): number')
      expect(overloads).toContain('export function f(a: string | number)')

      expect(readFileSync(path.join(directory, 'asi.ts'), 'utf8')).toContain(';[1].forEach(f)')
      expect(readFileSync(path.join(directory, 'wrapping.tsx'), 'utf8')).toMatch(
        /\}\n\n\s*const label =/
      )

      const generator = readFileSync(path.join(directory, 'generator.ts'), 'utf8')

      expect(generator).toContain('yield* A')
      expect(generator).toContain('yield* B')
      expect(generator).toContain("Effect.fn('dispatch')")
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
