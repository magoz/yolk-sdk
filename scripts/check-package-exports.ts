import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

type PackageExportShape = {
  readonly packageDir: string
  readonly packageName: string
  readonly expectedExports: ReadonlyArray<string>
  readonly tinyRoot: boolean
}

const workspaceRoot = process.cwd()

const packageExportShapes: ReadonlyArray<PackageExportShape> = [
  {
    packageDir: 'packages/agent',
    packageName: '@yolk-sdk/agent',
    expectedExports: [
      './package.json',
      '.',
      './client',
      './compaction',
      './loop',
      './loop/testing',
      './oauth',
      './protocol',
      './providers/anthropic',
      './providers/anthropic/claude',
      './providers/anthropic/claude-provider',
      './providers/openai',
      './providers/openai/codex',
      './providers/openai/codex-provider',
      './providers/openai/provider',
      './react',
      './runtime',
      './skillset',
      './tools',
      './voice'
    ],
    tinyRoot: true
  },
  {
    packageDir: 'packages/mcp',
    packageName: '@yolk-sdk/mcp',
    expectedExports: ['./package.json', '.', './client', './client/node', './protocol', './server'],
    tinyRoot: true
  },
  {
    packageDir: 'packages/knowledge',
    packageName: '@yolk-sdk/knowledge',
    expectedExports: [
      '.',
      './package.json',
      './agent',
      './artifacts',
      './chunking',
      './context',
      './embeddings',
      './errors',
      './extraction',
      './ingestion',
      './search-store',
      './documents',
      './links',
      './records',
      './provenance',
      './representations',
      './search',
      './store',
      './summarization',
      './vector-store'
    ],
    tinyRoot: false
  },
  {
    packageDir: 'packages/connectors',
    packageName: '@yolk-sdk/connectors',
    expectedExports: [
      './package.json',
      '.',
      './agent',
      './figma',
      './google',
      './linkedin-search',
      './notion',
      './r2-storage',
      './telegram',
      './todoist'
    ],
    tinyRoot: false
  },
  {
    packageDir: 'packages/vercel-workflows',
    packageName: '@yolk-sdk/vercel-workflows',
    expectedExports: ['./package.json', '.', './workflow'],
    tinyRoot: false
  }
]

const field = (value: unknown, key: string): unknown => {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }

  return Object.entries(value).find(([entryKey]) => entryKey === key)?.[1]
}

const stringField = (value: unknown, key: string): string | undefined => {
  const result = field(value, key)
  return typeof result === 'string' ? result : undefined
}

const booleanField = (value: unknown, key: string): boolean | undefined => {
  const result = field(value, key)
  return typeof result === 'boolean' ? result : undefined
}

const objectKeysField = (value: unknown, key: string): ReadonlyArray<string> => {
  const result = field(value, key)
  if (typeof result !== 'object' || result === null) {
    return []
  }

  return Object.keys(result)
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'))

const normalizedRootSource = (source: string) =>
  source
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '' && !line.startsWith('//'))

const sorted = (values: ReadonlyArray<string>) => [...values].sort((left, right) => left.localeCompare(right))

const sameMembers = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
  sorted(left).join('\n') === sorted(right).join('\n')

const failures = packageExportShapes.flatMap(shape => {
  const packageJsonPath = join(workspaceRoot, shape.packageDir, 'package.json')
  const packageJson = readJson(packageJsonPath)
  const exportKeys = objectKeysField(packageJson, 'exports')
  const rootSource = readFileSync(join(workspaceRoot, shape.packageDir, 'src/index.ts'), 'utf8')
  const rootStatements = normalizedRootSource(rootSource)
  const packageFailures: Array<string> = []

  if (stringField(packageJson, 'name') !== shape.packageName) {
    packageFailures.push(`${shape.packageDir}/package.json name must be ${shape.packageName}`)
  }

  if (stringField(packageJson, 'type') !== 'module') {
    packageFailures.push(`${shape.packageDir}/package.json must use type=module`)
  }

  if (booleanField(packageJson, 'sideEffects') !== false) {
    packageFailures.push(`${shape.packageDir}/package.json must declare sideEffects=false`)
  }

  if (!sameMembers(exportKeys, shape.expectedExports)) {
    packageFailures.push(
      `${shape.packageDir}/package.json exports mismatch: expected ${sorted(shape.expectedExports).join(', ')}, got ${sorted(exportKeys).join(', ')}`
    )
  }

  if (exportKeys.some(exportKey => exportKey.includes('*'))) {
    packageFailures.push(`${shape.packageDir}/package.json exports must be explicit, no wildcards`)
  }

  if (shape.tinyRoot && (rootStatements.length !== 1 || rootStatements[0] !== 'export {}')) {
    packageFailures.push(`${shape.packageDir}/src/index.ts root must stay tiny: only export {}`)
  }

  return packageFailures
})

if (failures.length > 0) {
  console.error('Package export/tree-shake smoke failures:')
  for (const failure of failures) {
    console.error(`- ${failure}`)
  }
  process.exitCode = 1
}
