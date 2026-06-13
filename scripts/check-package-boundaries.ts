import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import process from 'node:process'

type BoundaryRule = {
  readonly packageDir: string
  readonly forbiddenImports: ReadonlyArray<string>
  readonly excludedDirs?: ReadonlyArray<string>
}

type RetiredPackage = {
  readonly dir: string
  readonly importName: string
}

const workspaceRoot = process.cwd()

const retiredPackages: ReadonlyArray<RetiredPackage> = [
  { dir: 'packages/agent-loop', importName: '@yolk-sdk/agent-loop' },
  { dir: 'packages/agent-runtime', importName: '@yolk-sdk/agent-runtime' },
  { dir: 'packages/anthropic', importName: '@yolk-sdk/anthropic' },
  { dir: 'packages/client', importName: '@yolk-sdk/client' },
  { dir: 'packages/mcp-client', importName: '@yolk-sdk/mcp-client' },
  { dir: 'packages/mcp-server', importName: '@yolk-sdk/mcp-server' },
  { dir: 'packages/oauth', importName: '@yolk-sdk/oauth' },
  { dir: 'packages/openai', importName: '@yolk-sdk/openai' },
  { dir: 'packages/protocol', importName: '@yolk-sdk/protocol' },
  { dir: 'packages/react', importName: '@yolk-sdk/react' },
  { dir: 'packages/skillset', importName: '@yolk-sdk/skillset' },
  { dir: 'packages/tool-registry', importName: '@yolk-sdk/tool-registry' },
  { dir: 'packages/vercel-workflows-runtime', importName: '@yolk-sdk/vercel-workflows-runtime' },
  { dir: 'packages/voice-runtime', importName: '@yolk-sdk/voice-runtime' }
]

const retiredImports = retiredPackages.map(retiredPackage => retiredPackage.importName)

const agentCoreForbiddenImports = [
  ...retiredImports,
  '@yolk-sdk/knowledge',
  '@yolk-sdk/mcp',
  '@yolk-sdk/agent/react',
  'next',
  'react',
  'node:'
]

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
    packageDir: 'examples/next/lib',
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
    packageDir: 'examples/next/e2e',
    forbiddenImports: [
      ...retiredImports,
      '@yolk-sdk/agent$',
      '@yolk-sdk/mcp$'
    ]
  },
  {
    packageDir: 'packages/agent/src/protocol',
    forbiddenImports: agentCoreForbiddenImports
  },
  {
    packageDir: 'packages/agent/src/loop',
    forbiddenImports: agentCoreForbiddenImports
  },
  {
    packageDir: 'packages/agent/src/runtime',
    forbiddenImports: agentCoreForbiddenImports
  },
  {
    packageDir: 'packages/agent/src/client',
    forbiddenImports: agentCoreForbiddenImports
  },
  {
    packageDir: 'packages/agent/src/compaction',
    forbiddenImports: agentCoreForbiddenImports
  },
  {
    packageDir: 'packages/agent/src/tools',
    forbiddenImports: agentCoreForbiddenImports
  },
  {
    packageDir: 'packages/agent/src/oauth',
    forbiddenImports: agentCoreForbiddenImports
  },
  {
    packageDir: 'packages/agent/src/providers',
    forbiddenImports: agentCoreForbiddenImports
  },
  {
    packageDir: 'packages/agent/src/skillset',
    forbiddenImports: agentCoreForbiddenImports
  },
  {
    packageDir: 'packages/agent/src/voice',
    forbiddenImports: agentCoreForbiddenImports
  },
  {
    packageDir: 'packages/agent/src/react',
    forbiddenImports: [...retiredImports, '@yolk-sdk/knowledge', '@yolk-sdk/mcp', 'next', 'node:']
  },
  {
    packageDir: 'packages/knowledge/src',
    forbiddenImports: [...retiredImports, '@yolk-sdk/agent/react', '@yolk-sdk/mcp', 'next', 'react', 'node:']
  },
  {
    packageDir: 'packages/sandbox/src',
    forbiddenImports: ['@vercel/sandbox'],
    excludedDirs: ['packages/sandbox/src/vercel']
  },
  {
    packageDir: 'packages/sandbox/src',
    forbiddenImports: ['@yolk-sdk/agent'],
    excludedDirs: ['packages/sandbox/src/agent.ts']
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

const isExcludedFile = (file: string, excludedDirs: ReadonlyArray<string> = []) =>
  excludedDirs.some(excludedDir => {
    const absoluteExcludedDir = join(workspaceRoot, excludedDir)
    return file === absoluteExcludedDir || file.startsWith(`${absoluteExcludedDir}/`)
  })

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

  return walk(join(workspaceRoot, rule.packageDir)).filter(file => !isExcludedFile(file, rule.excludedDirs)).flatMap(file => {
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
