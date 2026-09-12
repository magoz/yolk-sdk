import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import * as ts from 'typescript'
import {
  collectSpecifiers,
  createResolverContext,
  ownerOfFile,
  rulePathFiles,
  runCheck,
  violates
} from '../check-package-boundaries.ts'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')

const tsxCli = join(repoRoot, 'node_modules/tsx/dist/cli.mjs')

const checker = join(repoRoot, 'scripts/check-package-boundaries.ts')

const fixtureDirectory = (): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'yolk-boundary-')))
  onTestFinished(() => rmSync(root, { recursive: true, force: true }))

  return root
}

const write = (root: string, rel: string, content: string): void => {
  const file = join(root, rel)

  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
}

const agentManifest = {
  name: '@yolk-sdk/agent',
  exports: {
    '.': './src/index.ts',
    './protocol': './src/protocol/index.ts',
    './react': './src/react/index.ts'
  }
}

const scaffoldPackages = (root: string): void => {
  write(root, 'packages/agent/package.json', JSON.stringify(agentManifest))
  write(root, 'packages/mcp/package.json', JSON.stringify({ name: '@yolk-sdk/mcp' }))
  write(root, 'packages/harness/package.json', JSON.stringify({ name: '@yolk-sdk/harness' }))
  write(root, 'packages/connectors/package.json', JSON.stringify({ name: '@yolk-sdk/connectors' }))
  write(root, 'packages/agent/src/loop/y.ts', `export const y = 1\n`)
  write(root, 'packages/agent/src/index.ts', `export const root = 1\n`)
  write(root, 'packages/agent/src/react/index.ts', `export const react = 1\n`)
  write(root, 'packages/agent/src/protocol/index.ts', `export const protocol = 1\n`)
  write(root, 'examples/next/leak.ts', `export const leak = 1\n`)
}

const violationsFor = (root: string, fileRel: string) =>
  runCheck(root).violations.filter(violation => violation.file === join(root, fileRel))

describe('violates', () => {
  it('matches the node: namespace including bare builtins, not lookalikes', () => {
    expect(violates('node:fs', 'node:')).toBe(true)
    expect(violates('node:fs/promises', 'node:')).toBe(true)
    expect(violates('fs', 'node:')).toBe(true)
    expect(violates('fs/promises', 'node:')).toBe(true)
    expect(violates('fss', 'node:')).toBe(false)
    expect(violates('fs-extra', 'node:')).toBe(false)
    expect(violates('react', 'node:')).toBe(false)
  })

  it('distinguishes exact, prefix/subpath, and lookalike matches', () => {
    expect(violates('next/image', 'next')).toBe(true)
    expect(violates('next', 'next')).toBe(true)
    expect(violates('next-auth', 'next')).toBe(false)
    expect(violates('@yolk-sdk/agent', '@yolk-sdk/agent$')).toBe(true)
    expect(violates('@yolk-sdk/agent/loop', '@yolk-sdk/agent$')).toBe(false)
    expect(violates('@yolk-sdk/mcp/client', '@yolk-sdk/mcp')).toBe(true)
  })
})

describe('collectSpecifiers', () => {
  it('reads imports, re-exports, import types, and literal dynamic imports', () => {
    expect(
      collectSpecifiers(
        `import a from 'node:fs'
import type { T } from 'node:path'
export * from './local'
export type { U } from 'node:os'
type V = import('node:crypto')
const m = await import('node:util')
`,
        'probe.ts'
      ).specifiers
    ).toEqual(['node:fs', 'node:path', './local', 'node:os', 'node:crypto', 'node:util'])
  })

  it('parses .ts files as TS so angle-bracket generics do not swallow imports', () => {
    const source = `const id = <T>(x: T) => x\nconst m = await import('node:fs')\n\nexport const probe = [id, m]\n`
    const result = collectSpecifiers(source, 'probe.ts')

    expect(result.specifiers).toEqual(['node:fs'])
    expect(result.parseErrors).toEqual([])
  })

  it('handles declaration files without throwing', () => {
    const result = collectSpecifiers('export type Stats = import("node:fs").Stats;\n', 'probe.d.ts')

    expect(result.specifiers).toEqual(['node:fs'])
    expect(result.parseErrors).toEqual([])
  })

  it('reports TSX parse errors instead of silently missing imports', () => {
    const source = `const id = <T>(x: T) => x\nconst m = await import('node:fs')\n`
    const result = collectSpecifiers(source, 'probe.tsx')

    expect(result.parseErrors.length).toBeGreaterThan(0)
  })

  it('accepts dynamic imports with options and TS import-equals references', () => {
    expect(
      collectSpecifiers(
        `const a = await import('node:fs', { with: { type: 'json' } })\nimport legacy = require('node:path')\n`,
        'probe.ts'
      ).specifiers
    ).toEqual(['node:fs', 'node:path'])
  })

  it('ignores comments, raw strings, and computed dynamic imports', () => {
    expect(
      collectSpecifiers(
        `// import 'node:fs'
/* export * from 'node:fs' */
const text = "import x from 'node:fs'"
const label = 'export * from "node:fs"'
const dynamic = await import(specifier)
const template = await import(\`node:\${name}\`)
`,
        'probe.ts'
      ).specifiers
    ).toEqual([])
  })
})

describe('runCheck on a fixture workspace', () => {
  it('flags node:, bare builtins, and relative crossings into forbidden owners', () => {
    const root = fixtureDirectory()

    scaffoldPackages(root)
    write(
      root,
      'packages/agent/src/voice/has-node.ts',
      `import fs from 'node:fs'\nimport { readFile } from 'node:fs/promises'\nimport path from 'path'\nimport ok from 'next-auth'\n\nexport const probe = [fs, readFile, path, ok]\n`
    )
    write(
      root,
      'packages/agent/src/voice/rel-mcp.ts',
      `import { x } from '../../../mcp/src/x'\n\nexport const probe = x\n`
    )
    write(root, 'packages/mcp/src/x.ts', `export const x = 1\n`)
    write(root, 'packages/agent/src/loop/y.ts', `export const y = 1\n`)
    write(
      root,
      'packages/harness/src/rel-agent.ts',
      `import { y } from '../../agent/src/loop/y'\n\nexport const probe = y\n`
    )

    const nodeViolations = violationsFor(root, 'packages/agent/src/voice/has-node.ts')

    expect(nodeViolations.map(violation => violation.specifier).sort()).toEqual([
      'node:fs',
      'node:fs/promises',
      'path'
    ])

    const relative = violationsFor(root, 'packages/agent/src/voice/rel-mcp.ts')

    expect(relative).toHaveLength(1)
    expect(relative[0]?.forbidden).toBe('@yolk-sdk/mcp')
    expect(relative[0]?.resolved).toBe(join(root, 'packages/mcp/src/x.ts'))

    const harness = violationsFor(root, 'packages/harness/src/rel-agent.ts')

    expect(harness).toHaveLength(1)
    expect(harness[0]?.forbidden).toBe('@yolk-sdk/agent')
  })

  it('catches literal dynamic/type imports and alias crossings, allows lookalikes and Cloudflare reuse', () => {
    const root = fixtureDirectory()

    scaffoldPackages(root)
    write(
      root,
      'tsconfig.json',
      JSON.stringify({ compilerOptions: { paths: { '@/*': ['./examples/*'] } } })
    )
    write(root, 'examples/next/lib/z.ts', `export const z = 1\n`)
    write(root, 'examples/peek/a.ts', `export const a = 1\n`)
    write(
      root,
      'packages/agent/src/voice/dynamic.ts',
      `export const load = async () => {\n  const first = await import('node:fs')\n  const second = await import('next-auth')\n\n  return [first, second]\n}\n\nexport type Late = import('node:os')\n`
    )
    write(
      root,
      'packages/agent/src/voice/alias-cross.ts',
      `import { a } from '@/peek/a'\n\nexport const probe = a\n`
    )
    write(
      root,
      'cloudflare/agent/src/uses-examples.ts',
      `import { z } from '../../../examples/next/lib/z'\n\nexport const probe = z\n`
    )

    const dynamic = violationsFor(root, 'packages/agent/src/voice/dynamic.ts')

    expect(dynamic.map(violation => violation.specifier).sort()).toEqual(['node:fs', 'node:os'])

    const alias = violationsFor(root, 'packages/agent/src/voice/alias-cross.ts')

    expect(alias).toHaveLength(1)
    expect(alias[0]?.forbidden).toContain('packages/* must not import')

    // Legitimate private Cloudflare -> examples reuse stays allowed.
    expect(violationsFor(root, 'cloudflare/agent/src/uses-examples.ts')).toEqual([])
  })
})

describe('global packages -> apps ban', () => {
  it('fires outside per-area rules and inside local exclusions', () => {
    const root = fixtureDirectory()

    scaffoldPackages(root)
    write(root, 'packages/sandbox/package.json', JSON.stringify({ name: '@yolk-sdk/sandbox' }))
    write(
      root,
      'packages/connectors/src/leak.ts',
      `import { leak } from '../../../examples/next/leak'\n\nexport const probe = leak\n`
    )
    write(
      root,
      'packages/harness/src/outcome.ts',
      `import { leak } from '../../../examples/next/leak'\n\nexport const probe = leak\n`
    )
    write(
      root,
      'packages/sandbox/src/agent.ts',
      `import { leak } from '../../../examples/next/leak'\n\nexport const probe = leak\n`
    )
    write(root, 'packages/mcp/src/ok.ts', `import { x } from './x'\n\nexport const probe = x\n`)
    write(root, 'packages/mcp/src/x.ts', `export const x = 1\n`)

    for (const file of [
      'packages/connectors/src/leak.ts',
      'packages/harness/src/outcome.ts',
      'packages/sandbox/src/agent.ts'
    ]) {
      const found = violationsFor(root, file)

      expect(found).toHaveLength(1)
      expect(found[0]?.forbidden).toContain('packages/* must not import')
    }

    expect(violationsFor(root, 'packages/mcp/src/ok.ts')).toEqual([])
  })

  it('resolves export subpaths so namespace edges fire on relative targets', () => {
    const root = fixtureDirectory()

    scaffoldPackages(root)
    write(
      root,
      'packages/agent/src/protocol/victim.ts',
      `import { react } from '../react/index.ts'\n\nexport const probe = react\n`
    )
    write(
      root,
      'packages/harness/src/uses-root.ts',
      `import { root } from '../../agent/src/index.ts'\n\nexport const probe = root\n`
    )

    const victim = violationsFor(root, 'packages/agent/src/protocol/victim.ts')

    expect(victim).toHaveLength(1)
    expect(victim[0]?.forbidden).toBe('@yolk-sdk/agent/react')
    expect(victim[0]?.resolved).toBe(join(root, 'packages/agent/src/react/index.ts'))

    const usesRoot = violationsFor(root, 'packages/harness/src/uses-root.ts')

    expect(usesRoot).toHaveLength(1)
    expect(usesRoot[0]?.forbidden).toBe('@yolk-sdk/agent')
  })

  it('inherits tsconfig paths through extends without ancestor fallback', () => {
    const root = fixtureDirectory()

    scaffoldPackages(root)
    write(
      root,
      'config/base.json',
      JSON.stringify({ compilerOptions: { baseUrl: '..', paths: { '@w/*': ['./examples/*'] } } })
    )
    write(root, 'tsconfig.json', JSON.stringify({ extends: './config/base.json' }))
    write(root, 'packages/agent/tsconfig.json', JSON.stringify({ compilerOptions: {} }))
    write(
      root,
      'packages/agent/src/voice/ext-cross.ts',
      `import { leak } from '@w/next/leak'\n\nexport const probe = leak\n`
    )
    write(
      root,
      'packages/mcp/src/ext-cross.ts',
      `import { leak } from '@w/next/leak'\n\nexport const probe = leak\n`
    )
    write(root, 'packages/mcp/src/x.ts', `export const x = 1\n`)

    // Nearest tsconfig (packages/agent) has no paths: no ancestor fallback.
    expect(violationsFor(root, 'packages/agent/src/voice/ext-cross.ts')).toEqual([])

    // packages/mcp inherits root paths through extends with a relative baseUrl.
    const inherited = violationsFor(root, 'packages/mcp/src/ext-cross.ts')

    expect(inherited).toHaveLength(1)
    expect(inherited[0]?.forbidden).toContain('packages/* must not import')
  })

  it('reports malformed manifests instead of laundering names', () => {
    const root = fixtureDirectory()

    scaffoldPackages(root)
    write(root, 'packages/broken/package.json', '{"name": 42}')
    write(root, 'packages/broken/src/a.ts', `export const a = 1\n`)
    write(root, 'packages/broken-json/package.json', '{oops')
    write(root, 'packages/broken-json/src/a.ts', `export const a = 1\n`)
    write(
      root,
      'packages/agent/src/voice/to-broken.ts',
      `import { a } from '../../../broken/src/a'\n\nexport const probe = a\n`
    )
    write(
      root,
      'packages/agent/src/voice/to-broken-json.ts',
      `import { a } from '../../../broken-json/src/a'\n\nexport const probe = a\n`
    )

    const report = runCheck(root)

    expect(report.configErrors.some(error => error.includes('broken'))).toBe(true)
    expect(violationsFor(root, 'packages/agent/src/voice/to-broken.ts')).toEqual([])
    expect(violationsFor(root, 'packages/agent/src/voice/to-broken-json.ts')).toEqual([])
  })

  it('never follows symlinks into external trees', () => {
    const root = fixtureDirectory()
    const outside = fixtureDirectory()

    scaffoldPackages(root)
    write(outside, 'evil.ts', `import fs from 'node:fs'\n\nexport const probe = fs\n`)
    write(root, 'packages/agent/src/voice/clean.ts', `export const clean = 1\n`)
    symlinkSync(join(outside, 'evil.ts'), join(root, 'packages/agent/src/voice/evil-link.ts'))

    const report = runCheck(root)

    expect(report.violations.filter(violation => violation.file.endsWith('evil-link.ts'))).toEqual(
      []
    )
    expect(report.violations.some(violation => violation.file.startsWith(outside))).toBe(false)
  })

  it('maps index-owned subtrees with longest-match owners', () => {
    const root = fixtureDirectory()

    scaffoldPackages(root)
    write(
      root,
      'packages/agent/package.json',
      JSON.stringify({
        name: '@yolk-sdk/agent',
        exports: {
          '.': './src/index.ts',
          './react': './src/react/index.ts',
          './shared': './src/shared/index.ts',
          './shared/deep': './src/shared/deep/index.ts'
        }
      })
    )
    write(root, 'packages/agent/src/react/internal.ts', `export const internal = 1\n`)
    write(root, 'packages/agent/src/react.ts', `export const sibling = 1\n`)
    write(root, 'packages/agent/src/shared/deep/x.ts', `export const x = 1\n`)
    write(root, 'packages/agent/src/shared/y.ts', `export const y = 1\n`)

    const context = createResolverContext(root)
    const owner = (rel: string) => ownerOfFile(context, join(root, rel))

    expect(owner('packages/agent/src/react/internal.ts')).toEqual({
      kind: 'package',
      specifier: '@yolk-sdk/agent/react'
    })
    expect(owner('packages/agent/src/react.ts')).toEqual({
      kind: 'package',
      specifier: '@yolk-sdk/agent'
    })
    expect(owner('packages/agent/src/shared/deep/x.ts')).toEqual({
      kind: 'package',
      specifier: '@yolk-sdk/agent/shared/deep'
    })
    expect(owner('packages/agent/src/shared/y.ts')).toEqual({
      kind: 'package',
      specifier: '@yolk-sdk/agent/shared'
    })
    expect(context.configErrors).toEqual([])
  })

  it('fires namespace edges on internal descendants of export subtrees', () => {
    const root = fixtureDirectory()

    scaffoldPackages(root)
    write(root, 'packages/agent/src/react/internal.ts', `export const internal = 1\n`)
    write(
      root,
      'packages/agent/src/protocol/deep-victim.ts',
      `import { internal } from '../react/internal.ts'\n\nexport const probe = internal\n`
    )

    const victim = violationsFor(root, 'packages/agent/src/protocol/deep-victim.ts')

    expect(victim).toHaveLength(1)
    expect(victim[0]?.forbidden).toBe('@yolk-sdk/agent/react')
  })

  it('resolves baseUrl-only aliases without paths or ancestor fallback', () => {
    const root = fixtureDirectory()

    scaffoldPackages(root)
    write(
      root,
      'packages/agent/tsconfig.json',
      JSON.stringify({ compilerOptions: { baseUrl: '../../examples/next' } })
    )
    write(root, 'examples/next/private.ts', `export const hidden = 1\n`)
    write(
      root,
      'packages/agent/src/protocol/baseurl-leak.ts',
      `import { hidden } from 'private'\n\nexport const probe = hidden\n`
    )

    const report = runCheck(root)

    const found = report.violations.filter(
      violation => violation.file === join(root, 'packages/agent/src/protocol/baseurl-leak.ts')
    )

    expect(found).toHaveLength(1)
    expect(found[0]?.forbidden).toContain('packages/* must not import')
    expect(report.configErrors).toEqual([])
  })

  it('validates source manifests even when their files are clean', () => {
    const root = fixtureDirectory()

    scaffoldPackages(root)
    write(root, 'packages/broken-src/package.json', '{oops')
    write(root, 'packages/broken-src/src/clean.ts', `export const clean = 1\n`)

    const report = runCheck(root)

    expect(report.configErrors.some(error => error.includes('broken-src'))).toBe(true)
  })

  it('scans .mts/.cts sources under the same TypeScript policy', () => {
    const root = fixtureDirectory()

    scaffoldPackages(root)
    write(
      root,
      'packages/agent/src/voice/native.mts',
      `import fs from 'node:fs'\n\nexport const probe = fs\n`
    )
    write(
      root,
      'packages/agent/src/voice/native.cts',
      `import path from 'node:path'\n\nexport const probe = path\n`
    )

    expect(
      violationsFor(root, 'packages/agent/src/voice/native.mts').map(v => v.specifier)
    ).toEqual(['node:fs'])
    expect(
      violationsFor(root, 'packages/agent/src/voice/native.cts').map(v => v.specifier)
    ).toEqual(['node:path'])
  })

  it('does not expand config input globs or probe through directory symlinks', () => {
    const root = fixtureDirectory()
    const outside = fixtureDirectory()
    scaffoldPackages(root)
    write(outside, 'private.ts', 'export const hidden = 1')
    symlinkSync(outside, join(root, 'packages/agent/linked'))
    write(
      root,
      'packages/agent/tsconfig.json',
      JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@hidden/*': ['linked/*'] } } })
    )
    write(root, 'packages/agent/src/protocol/leak.ts', 'import "@hidden/private"')

    // Observe the real compiler system without replacing its implementation.
    const scan = vi.spyOn(ts.sys, 'readDirectory')
    const probe = vi.spyOn(ts.sys, 'directoryExists')
    onTestFinished(() => scan.mockRestore())
    onTestFinished(() => probe.mockRestore())

    const report = runCheck(root)

    expect(report.configErrors).toEqual([])
    expect(scan).not.toHaveBeenCalled()
    expect(probe.mock.calls.some(([path]) => path.includes('/linked'))).toBe(false)
  })

  it('normalizes the selected workspace while rejecting descendant links', () => {
    const root = fixtureDirectory()
    const aliases = fixtureDirectory()
    scaffoldPackages(root)
    write(root, 'packages/agent/src/protocol/native.ts', 'import "node:fs"')
    write(
      root,
      'tsconfig.json',
      JSON.stringify({
        compilerOptions: {
          paths: { '@private/*': ['./examples/next/*'] }
        }
      })
    )
    write(root, 'packages/mcp/src/leak.ts', 'import "@private/leak"')
    const alias = join(aliases, 'workspace')
    symlinkSync(root, alias)

    const expected = runCheck(root)

    expect(expected.violations).toHaveLength(2)
    expect(expected.configErrors).toEqual([])
    expect(runCheck(`${root}/`)).toEqual(expected)
    expect(runCheck(alias)).toEqual(expected)
    expect(rulePathFiles(alias, 'packages/agent/src/protocol')).toEqual(
      rulePathFiles(root, 'packages/agent/src/protocol')
    )
    expect(rulePathFiles(root, '../')).toEqual([])
  })

  it('scans hidden source directories but not documented generated trees', () => {
    const root = fixtureDirectory()
    scaffoldPackages(root)
    const source = 'import "../../../../examples/next/leak"'
    write(root, 'packages/connectors/src/.internal/leak.ts', source)
    write(root, 'packages/connectors/src/.workflow-build/leak.ts', source)

    const found = runCheck(root).violations

    expect(found).toHaveLength(1)
    expect(found[0]?.file).toBe(join(root, 'packages/connectors/src/.internal/leak.ts'))
  })

  it('keeps a more specific export owner above a root index namespace', () => {
    const root = fixtureDirectory()
    scaffoldPackages(root)
    write(
      root,
      'packages/agent/package.json',
      JSON.stringify({
        name: '@yolk-sdk/agent',
        exports: { './cli': './index.ts', './react': './src/react/index.ts' }
      })
    )

    const context = createResolverContext(root)

    expect(ownerOfFile(context, join(root, 'packages/agent/src/react/internal.ts'))).toEqual({
      kind: 'package',
      specifier: '@yolk-sdk/agent/react'
    })
    expect(ownerOfFile(context, join(root, 'packages/agent/src/other.ts'))).toEqual({
      kind: 'package',
      specifier: '@yolk-sdk/agent/cli'
    })
  })

  it('does not enter symlinked scope paths', () => {
    const root = fixtureDirectory()

    scaffoldPackages(root)
    write(root, 'packages/agent/src/voice/clean.ts', `export const clean = 1\n`)
    symlinkSync(join(root, 'packages/agent/src/voice'), join(root, 'linkscope'))

    expect(rulePathFiles(root, 'linkscope')).toEqual([])
    expect(rulePathFiles(root, 'packages/agent/src/voice').length).toBeGreaterThan(0)
  })
})

describe('boundary CLI', () => {
  it('exits non-zero on violations and zero on a clean tree', async () => {
    const dirty = fixtureDirectory()

    scaffoldPackages(dirty)
    write(
      dirty,
      'packages/agent/src/voice/has-node.ts',
      `import fs from 'node:fs'\n\nexport const probe = fs\n`
    )

    const dirtyResult = await new Promise<{ failed: boolean; stderr: string }>(resolvePromise => {
      execFile(process.execPath, [tsxCli, checker], { cwd: dirty }, (error, _stdout, stderr) => {
        resolvePromise({ failed: error !== null, stderr: String(stderr) })
      })
    })

    expect(dirtyResult.failed).toBe(true)
    expect(dirtyResult.stderr).toContain('Package boundary violations:')

    const clean = fixtureDirectory()

    scaffoldPackages(clean)
    write(
      clean,
      'packages/agent/src/voice/clean.ts',
      `import { Option } from 'effect'\n\nexport const probe = Option\n`
    )

    const cleanResult = await new Promise<{ failed: boolean; stderr: string }>(resolvePromise => {
      execFile(process.execPath, [tsxCli, checker], { cwd: clean }, (error, _stdout, stderr) => {
        resolvePromise({ failed: error !== null, stderr: String(stderr) })
      })
    })

    expect(cleanResult.failed).toBe(false)
    expect(cleanResult.stderr).not.toContain('Package boundary violations:')
  }, 120000)
})
