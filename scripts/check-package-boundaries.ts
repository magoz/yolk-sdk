import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import process from 'node:process'

type BoundaryRule = {
  readonly packageDir: string
  readonly forbiddenImports: ReadonlyArray<string>
}

const workspaceRoot = process.cwd()

const rules: ReadonlyArray<BoundaryRule> = [
  {
    packageDir: 'app',
    forbiddenImports: [
      '@yolk/agent-loop',
      '@yolk/agent-runtime',
      '@yolk/client',
      '@yolk/mcp-client',
      '@yolk/protocol',
      '@yolk/tool-registry'
    ]
  },
  {
    packageDir: 'lib',
    forbiddenImports: [
      '@yolk/agent-loop',
      '@yolk/agent-runtime',
      '@yolk/client',
      '@yolk/mcp-client',
      '@yolk/protocol',
      '@yolk/tool-registry'
    ]
  },
  {
    packageDir: 'cloudflare/agent/src',
    forbiddenImports: [
      '@yolk/agent-loop',
      '@yolk/agent-runtime',
      '@yolk/client',
      '@yolk/mcp-client',
      '@yolk/protocol',
      '@yolk/tool-registry'
    ]
  },
  {
    packageDir: 'e2e',
    forbiddenImports: [
      '@yolk/agent-loop',
      '@yolk/agent-runtime',
      '@yolk/client',
      '@yolk/mcp-client',
      '@yolk/protocol',
      '@yolk/tool-registry'
    ]
  },
  {
    packageDir: 'packages/agent/src',
    forbiddenImports: ['@yolk/rag', '@yolk/mcp', '@yolk/react', 'next', 'react', 'node:']
  },
  {
    packageDir: 'packages/rag/src',
    forbiddenImports: ['@yolk/mcp', '@yolk/react', 'next', 'react', 'node:']
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

const violates = (specifier: string, forbidden: string) =>
  specifier === forbidden || specifier.startsWith(`${forbidden}/`)

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

if (violations.length > 0) {
  console.error('Package boundary violations:')
  for (const violation of violations) {
    console.error(
      `- ${relative(workspaceRoot, violation.file)} imports ${violation.specifier} (forbidden: ${violation.forbidden})`
    )
  }
  process.exitCode = 1
}
