import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const repoRoot = process.cwd()

const oxlintPath = path.join(repoRoot, 'node_modules/oxlint/bin/oxlint')

const localConfig = path.join(repoRoot, 'eslint-local-rules/test.oxlintrc.json')

const pluginSource = readFileSync(
  path.join(repoRoot, 'eslint-local-rules/prefer-option-from-nullable.js'),
  'utf8'
)

const tempDirs = []

const makeTempDir = prefix => {
  const directory = mkdtempSync(path.join(tmpdir(), prefix))
  tempDirs.push(directory)

  return directory
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { force: true, recursive: true })
  }
})

const runOxlint = (args, files) => {
  const result = spawnSync(process.execPath, [oxlintPath, ...args, ...files], {
    cwd: repoRoot,
    encoding: 'utf8'
  })

  if (result.error !== undefined || result.signal !== null) {
    throw new Error(
      `Oxlint process failed to run: ${result.error?.message ?? `signal ${result.signal}`}`
    )
  }

  let output

  try {
    output = JSON.parse(result.stdout)
  } catch (error) {
    throw new Error(
      [
        `Oxlint returned non-JSON output (status ${String(result.status)}).`,
        `stdout: ${result.stdout}`,
        `stderr: ${result.stderr}`,
        `parse error: ${error instanceof Error ? error.message : String(error)}`
      ].join('\n')
    )
  }

  if (!Array.isArray(output.diagnostics)) {
    throw new Error(
      [
        `Oxlint JSON missing diagnostics (status ${String(result.status)}).`,
        `stdout: ${result.stdout}`,
        `stderr: ${result.stderr}`
      ].join('\n')
    )
  }

  return { status: result.status, diagnostics: output.diagnostics, raw: output }
}

const lintLocal = files =>
  runOxlint(['--config', localConfig, '--no-ignore', '--format', 'json'], files)

const writeFile = (directory, relative, source) => {
  const filename = path.join(directory, relative)
  mkdirSync(path.dirname(filename), { recursive: true })
  writeFileSync(filename, `${source.trim()}\n`)

  return filename
}

const codes = diagnostics => diagnostics.map(diagnostic => diagnostic.code).toSorted()

const messages = diagnostics => diagnostics.map(diagnostic => diagnostic.message)

const byCode = (diagnostics, code) => diagnostics.filter(diagnostic => diagnostic.code === code)

describe('local/prefer-option-from-nullable', () => {
  it('maps loose nullish guards to fromNullishOr and strict guards precisely', () => {
    const directory = makeTempDir('yolk-local-option-')

    const valid = [
      writeFile(
        directory,
        'valid-getter.js',
        `import { Option } from 'effect'
         const user = { name: 'a' }
         const result = user.name !== null ? Option.some(user.name) : Option.none()`
      ),
      writeFile(
        directory,
        'valid-transform.js',
        `import { Option } from 'effect'
         const label = (value) => value
         const x = 'a'
         const result = x !== null ? Option.some(label(x)) : Option.none()`
      ),
      writeFile(
        directory,
        'valid-shadow-option.js',
        `const Option = { some: (value) => value, none: () => null }
         const x = 'a'
         const result = x != null ? Option.some(x) : Option.none()`
      ),
      writeFile(
        directory,
        'valid-no-import.js',
        `const x = 'a'
         const result = x != null ? Option.some(x) : Option.none()`
      ),
      writeFile(
        directory,
        'valid-extra-args.js',
        `import { Option } from 'effect'
         const x = 'a'
         const first = x != null ? Option.some(x, 1) : Option.none()
         const second = x != null ? Option.some(x) : Option.none(x)`
      ),
      writeFile(
        directory,
        'valid-inverted.js',
        `import { Option } from 'effect'
         const x = 'a'
         const result = x === null ? Option.none() : Option.some(x)`
      ),
      writeFile(
        directory,
        'valid-let.js',
        `import { Option } from 'effect'
         let x = 'a'
         const result = x != null ? Option.some(x) : Option.none()`
      ),
      writeFile(
        directory,
        'valid-inner-binding.js',
        `import { Option } from 'effect'
         const x = 'a'
         const run = () => {
           const y = 'b'
           return x != null ? Option.some(y) : Option.none()
         }`
      )
    ]

    const invalidCases = [
      {
        file: writeFile(
          directory,
          'invalid-nullish.js',
          `import { Option } from 'effect'
           const x = 'a'
           const result = x != null ? Option.some(x) : Option.none()`
        ),
        helper: 'Option.fromNullishOr'
      },
      {
        file: writeFile(
          directory,
          'invalid-null.js',
          `import { Option } from 'effect'
           const x = 'a'
           const result = x !== null ? Option.some(x) : Option.none()`
        ),
        helper: 'Option.fromNullOr'
      },
      {
        file: writeFile(
          directory,
          'invalid-undefined.js',
          `import { Option } from 'effect'
           const x = 'a'
           const result = x !== undefined ? Option.some(x) : Option.none()`
        ),
        helper: 'Option.fromUndefinedOr'
      },
      {
        file: writeFile(
          directory,
          'invalid-loose-undefined.js',
          `import { Option } from 'effect'
           const x = 'a'
           const result = x != undefined ? Option.some(x) : Option.none()`
        ),
        helper: 'Option.fromNullishOr'
      },
      {
        file: writeFile(
          directory,
          'invalid-alias.js',
          `import { Option as O } from 'effect'
           const x = 'a'
           const result = null != x ? O.some(x) : O.none()`
        ),
        helper: 'Option.fromNullishOr'
      },
      {
        file: writeFile(
          directory,
          'invalid-param.js',
          `import { Option } from 'effect'
           const run = (x) => (x != null ? Option.some(x) : Option.none())`
        ),
        helper: 'Option.fromNullishOr'
      },
      {
        file: writeFile(
          directory,
          'invalid-option-namespace.js',
          `import * as O from 'effect/Option'
           const x = 'a'
           const result = x != null ? O.some(x) : O.none()`
        ),
        helper: 'Option.fromNullishOr'
      },
      {
        file: writeFile(
          directory,
          'invalid-direct.js',
          `import { some, none } from 'effect/Option'
           const x = 'a'
           const result = x !== null ? some(x) : none()`
        ),
        helper: 'Option.fromNullOr'
      },
      {
        file: writeFile(
          directory,
          'invalid-direct-alias.js',
          `import { some as s, none as n } from 'effect/Option'
           const x = 'a'
           const result = x != null ? s(x) : n()`
        ),
        helper: 'Option.fromNullishOr'
      },
      {
        file: writeFile(
          directory,
          'invalid-root-namespace.js',
          `import * as E from 'effect'
           const x = 'a'
           const result = x != null ? E.Option.some(x) : E.Option.none()`
        ),
        helper: 'Option.fromNullishOr'
      }
    ]

    const validResult = lintLocal(valid)
    expect(validResult.diagnostics).toEqual([])

    for (const invalid of invalidCases) {
      const result = lintLocal([invalid.file])
      const hits = byCode(result.diagnostics, 'local(prefer-option-from-nullable)')
      expect(hits).toHaveLength(1)
      expect(hits[0].severity).toBe('warning')
      expect(hits[0].message).toContain(invalid.helper)
      expect(hits[0].message).toContain('x')
      expect(hits[0]).not.toHaveProperty('fix')
      expect(hits[0]).not.toHaveProperty('fixed')
    }

    expect(pluginSource).not.toMatch(/fixable/)
    expect(pluginSource).toContain('sourceCode.getScope')
    expect(pluginSource).toContain("def.type !== 'ImportBinding'")
  })

  it('rejects root-effect some/none and shadows, stays silent off-effect', () => {
    const directory = makeTempDir('yolk-local-option-skip-')

    const files = [
      writeFile(
        directory,
        'skip-root-namespace.js',
        `import * as E from 'effect'
         const x = 'a'
         const result = x != null ? E.some(x) : E.none()`
      ),
      writeFile(
        directory,
        'skip-root-named.js',
        `import { some, none } from 'effect'
         const x = 'a'
         const result = x != null ? some(x) : none()`
      ),
      writeFile(
        directory,
        'skip-shadow-namespace.js',
        `const O = { some: (value) => value, none: () => null }
         const x = 'a'
         const result = x != null ? O.some(x) : O.none()`
      ),
      writeFile(
        directory,
        'skip-shadow-helpers.js',
        `const some = (value) => value
         const none = () => null
         const x = 'a'
         const result = x != null ? some(x) : none()`
      )
    ]

    expect(lintLocal(files).diagnostics).toEqual([])
  })

  it('flags TS generic none<T> in namespace and direct forms', () => {
    const directory = makeTempDir('yolk-local-option-ts-')

    const namespace = writeFile(
      directory,
      'generic-namespace.ts',
      `import { Option } from 'effect'
       const x = 'a'
       const result = x != null ? Option.some(x) : Option.none<number>()`
    )

    const direct = writeFile(
      directory,
      'generic-direct.ts',
      `import { some, none } from 'effect/Option'
       const x = 'a'
       const result = x !== null ? some(x) : none<number>()`
    )

    const namespaceHits = byCode(
      lintLocal([namespace]).diagnostics,
      'local(prefer-option-from-nullable)'
    )

    expect(namespaceHits).toHaveLength(1)
    expect(namespaceHits[0].severity).toBe('warning')
    expect(namespaceHits[0].message).toContain('Option.fromNullishOr')

    const directHits = byCode(lintLocal([direct]).diagnostics, 'local(prefer-option-from-nullable)')
    expect(directHits).toHaveLength(1)
    expect(directHits[0].severity).toBe('warning')
    expect(directHits[0].message).toContain('Option.fromNullOr')

    const before = readFileSync(namespace, 'utf8')

    const fixResult = spawnSync(
      process.execPath,
      [oxlintPath, '--config', localConfig, '--no-ignore', '--fix', namespace],
      { cwd: repoRoot, encoding: 'utf8' }
    )

    expect(fixResult.error).toBeUndefined()
    expect(readFileSync(namespace, 'utf8')).toBe(before)
  })
})

describe('local rule regression coverage', () => {
  it('no-disable-validation bans the flag, allows false', () => {
    const directory = makeTempDir('yolk-local-disable-')

    const valid = writeFile(
      directory,
      'valid.js',
      `Schema.decodeUnknownSync(schema, { disableValidation: false })`
    )

    const invalid = writeFile(
      directory,
      'invalid.js',
      `Schema.decodeUnknownSync(schema, { disableValidation: true })`
    )

    expect(byCode(lintLocal([valid]).diagnostics, 'local(no-disable-validation)')).toEqual([])
    const hits = byCode(lintLocal([invalid]).diagnostics, 'local(no-disable-validation)')
    expect(hits).toHaveLength(1)
    expect(hits[0].severity).toBe('error')
    expect(hits[0].message).toContain('Never use { disableValidation: true }')
  })

  it('no-catch-all-cause bans v4 and v3 names, allows Effect.catch', () => {
    const directory = makeTempDir('yolk-local-catch-')
    const valid = writeFile(directory, 'valid.js', `Effect.catch(effect, { onFailure: handle })`)

    const catchCause = writeFile(
      directory,
      'catch-cause.js',
      `Effect.catchCause(effect, { onFailure: handle })`
    )

    const catchAllCause = writeFile(
      directory,
      'catch-all-cause.js',
      `Effect.catchAllCause(effect, { onFailure: handle })`
    )

    const identifier = writeFile(directory, 'identifier.js', `const handler = Effect.catchCause`)

    expect(lintLocal([valid]).diagnostics).toEqual([])
    expect(byCode(lintLocal([catchCause]).diagnostics, 'local(no-catch-all-cause)')).toHaveLength(1)
    expect(
      byCode(lintLocal([catchAllCause]).diagnostics, 'local(no-catch-all-cause)')
    ).toHaveLength(1)
    expect(byCode(lintLocal([identifier]).diagnostics, 'local(no-catch-all-cause)')).toHaveLength(1)
    expect(messages(lintLocal([catchCause]).diagnostics)[0]).toContain('catchCause')
    expect(messages(lintLocal([catchAllCause]).diagnostics)[0]).toContain('catchAllCause')
  })

  it('no-schema-from-self bans FromSelf variants, allows current names', () => {
    const directory = makeTempDir('yolk-local-from-self-')
    const valid = writeFile(directory, 'valid.js', `Schema.Option`)
    const invalid = writeFile(directory, 'invalid.js', `Schema.OptionFromSelf`)

    expect(lintLocal([valid]).diagnostics).toEqual([])
    const hits = byCode(lintLocal([invalid]).diagnostics, 'local(no-schema-from-self)')
    expect(hits).toHaveLength(1)
    expect(hits[0].severity).toBe('error')
    expect(hits[0].message).toContain('OptionFromSelf')
    expect(hits[0].message).toContain('Option')
  })

  it('no-schema-decode-sync bans sync variants, allows Effect variants', () => {
    const directory = makeTempDir('yolk-local-decode-')
    const valid = writeFile(directory, 'valid.js', `Schema.decodeUnknownEffect(schema)`)
    const invalid = writeFile(directory, 'invalid.js', `Schema.decodeSync(schema)`)

    expect(lintLocal([valid]).diagnostics).toEqual([])
    const hits = byCode(lintLocal([invalid]).diagnostics, 'local(no-schema-decode-sync)')
    expect(hits).toHaveLength(1)
    expect(hits[0].severity).toBe('error')
    expect(hits[0].message).toContain('decodeSync')
  })

  it('no-node-deps-in-agent-tools is scoped to tool files', () => {
    const directory = makeTempDir('yolk-local-agent-tools-')

    const serviceNode = writeFile(
      directory,
      'examples/next/lib/services/probe.ts',
      `import fs from 'node:fs'`
    )

    const toolLocal = writeFile(
      directory,
      'examples/next/lib/agents/tools/local.ts',
      `import { helper } from './local'`
    )

    const serviceFetch = writeFile(
      directory,
      'examples/next/lib/services/fetch.ts',
      `fetch('https://example.com')`
    )

    const toolNode = writeFile(
      directory,
      'examples/next/lib/agents/tools/probe.ts',
      `import fs from 'node:fs'`
    )

    const toolFetch = writeFile(
      directory,
      'examples/next/lib/agents/tools/fetch.ts',
      `fetch('https://example.com')`
    )

    expect(codes(lintLocal([serviceNode, toolLocal, serviceFetch]).diagnostics)).toEqual([])

    const nodeHits = byCode(lintLocal([toolNode]).diagnostics, 'local(no-node-deps-in-agent-tools)')
    expect(nodeHits).toHaveLength(1)
    expect(nodeHits[0].severity).toBe('error')
    expect(nodeHits[0].message).toContain('node:fs')

    const fetchHits = byCode(
      lintLocal([toolFetch]).diagnostics,
      'local(no-node-deps-in-agent-tools)'
    )

    expect(fetchHits).toHaveLength(1)
    expect(fetchHits[0].severity).toBe('error')
    expect(fetchHits[0].message).toContain('raw fetch()')
  })
})
