import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import process from 'node:process'

type BoundaryRule = {
  readonly packageDir: string
  readonly forbiddenImports: ReadonlyArray<string>
}

type RetiredPackage = {
  readonly dir: string
  readonly importName: string
}

const workspaceRoot = process.cwd()

const retiredPackages: ReadonlyArray<RetiredPackage> = [
  { dir: 'packages/agent-loop', importName: '@yolk-sdk/agent-loop' },
  { dir: 'packages/agent-runtime', importName: '@yolk-sdk/agent-runtime' },
  { dir: 'packages/client', importName: '@yolk-sdk/client' },
  { dir: 'packages/mcp-client', importName: '@yolk-sdk/mcp-client' },
  { dir: 'packages/mcp-server', importName: '@yolk-sdk/mcp-server' },
  { dir: 'packages/protocol', importName: '@yolk-sdk/protocol' },
  { dir: 'packages/tool-registry', importName: '@yolk-sdk/tool-registry' }
]

const retiredImports = retiredPackages.map(retiredPackage => retiredPackage.importName)

const rules: ReadonlyArray<BoundaryRule> = [
  {
    packageDir: 'examples/next/app',
    forbiddenImports: [
      ...retiredImports,
      '@yolk-sdk/agent$',
      '@yolk-sdk/mcp$'
    ]
  },
  {
    packageDir: 'lib',
    forbiddenImports: [
      ...retiredImports,
      '@yolk-sdk/agent$',
      '@yolk-sdk/mcp$'
    ]
  },
  {
    packageDir: 'cloudflare/agent/src',
    forbiddenImports: [
      ...retiredImports,
      '@yolk-sdk/agent$',
      '@yolk-sdk/mcp$'
    ]
  },
  {
    packageDir: 'e2e',
    forbiddenImports: [
      ...retiredImports,
      '@yolk-sdk/agent$',
      '@yolk-sdk/mcp$'
    ]
  },
  {
    packageDir: 'packages/agent/src',
    forbiddenImports: ['@yolk-sdk/knowledge', '@yolk-sdk/mcp', '@yolk-sdk/react', 'next', 'react', 'node:']
  },
  {
    packageDir: 'packages/knowledge/src',
    forbiddenImports: ['@yolk-sdk/mcp', '@yolk-sdk/react', 'next', 'react', 'node:']
  },
  {
    packageDir: 'packages/react/src',
    forbiddenImports: ['next', 'node:']
  }
]

const importPattern = /(?:import|export)\s+(?:type\s+)?(?:[^'"`]*?\s+from\s+)?['"`]([^'"`]+)['"`]/g

const isTypescriptFile = (path: string) => path.endsWith('.ts') || path.endsWith('.tsx')

const walk = (dir: string): ReadonlyArray<string> => {
  const entries = readdirSync(dir, { withFileTypes: true })
  const files: Array<string> = []

  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...walk(path))
    } else if (entry.isFile() && isTypescriptFile(path)) {
      files.push(path)
    }
  }

  return files
}

const packageExists = (packageDir: string) => {
  try {
    return statSync(join(workspaceRoot, packageDir)).isDirectory()
  } catch {
    return false
  }
}

const importsFrom = (source: string): ReadonlyArray<string> => {
  const imports: Array<string> = []
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1]
    if (specifier !== undefined) {
      imports.push(specifier)
    }
  }

  return imports
}

const violates = (specifier: string, forbidden: string) => {
  if (forbidden.endsWith('$')) {
    return specifier === forbidden.slice(0, -1)
  }

  return specifier === forbidden || specifier.startsWith(`${forbidden}/`)
}

const violations = rules.flatMap(rule => {
  if (!packageExists(rule.packageDir)) {
    return []
  }

  return walk(join(workspaceRoot, rule.packageDir)).flatMap(file => {
    const source = readFileSync(file, 'utf8')
    return importsFrom(source).flatMap(specifier =>
      rule.forbiddenImports
        .filter(forbidden => violates(specifier, forbidden))
        .map(forbidden => ({ file, specifier, forbidden }))
    )
  })
})

const retiredDirViolations = retiredPackages.filter(retiredPackage => packageExists(retiredPackage.dir))

if (retiredDirViolations.length > 0) {
  console.error('Retired package directories found:')
  for (const retiredPackage of retiredDirViolations) {
    console.error(`- ${retiredPackage.dir} (${retiredPackage.importName})`)
  }
}

if (violations.length > 0) {
  console.error('Package boundary violations:')
  for (const violation of violations) {
    console.error(
      `- ${relative(workspaceRoot, violation.file)} imports ${violation.specifier} (forbidden: ${violation.forbidden})`
    )
  }
}

if (retiredDirViolations.length > 0 || violations.length > 0) {
  process.exitCode = 1
}
