import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

type PackageShape = {
  readonly name: string
  readonly exports: ReadonlyArray<string>
}

const packages: ReadonlyArray<PackageShape> = [
  {
    name: '@yolk-sdk/agent',
    exports: [
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
    ]
  },
  {
    name: '@yolk-sdk/connectors',
    exports: ['.', './agent', './figma', './google', './linkedin-search', './notion', './r2-storage', './telegram', './todoist']
  },
  {
    name: '@yolk-sdk/knowledge',
    exports: ['.', './agent', './artifacts', './chunking', './context', './embeddings', './errors', './extraction', './ingestion', './search-store', './documents', './links', './records', './provenance', './representations', './search', './store', './summarization', './vector-store']
  },
  { name: '@yolk-sdk/mcp', exports: ['.', './client', './client/node', './protocol', './server'] },
  { name: '@yolk-sdk/sandbox', exports: ['.', './agent', './testing', './vercel'] },
  { name: '@yolk-sdk/vercel-workflows', exports: ['.', './workflow'] }
]

const extractTarballName = (output: string) => {
  const tarballLine = output
    .split('\n')
    .map(line => line.trim())
    .findLast(line => line.endsWith('.tgz'))

  if (tarballLine === undefined) {
    throw new Error(`Could not find packed tarball in output:\n${output}`)
  }

  return tarballLine
}

const main = async () => {
  const workspaceRoot = process.cwd()
  const fixtureDir = mkdtempSync(join(tmpdir(), 'yolk-package-smoke-'))

  try {
    const tarballs = packages.map(packageShape => {
      const output = execFileSync('pnpm', ['--filter', packageShape.name, 'pack', '--pack-destination', fixtureDir], {
        cwd: workspaceRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'inherit']
      })

      return extractTarballName(output)
    })

    const tarballPaths = tarballs.map(tarball => (isAbsolute(tarball) ? tarball : join(fixtureDir, tarball)))
    const packageJson = {
      type: 'module',
      private: true,
      dependencies: {
        '@effect/platform-node': '4.0.0-beta.65',
        '@vercel/sandbox': '2.2.1',
        effect: '4.0.0-beta.65',
        'gpt-tokenizer': '^3.4.0',
        react: '>=19',
        workflow: '^4.2.4'
      }
    }

    writeFileSync(join(fixtureDir, 'package.json'), JSON.stringify(packageJson, null, 2))
    execFileSync('pnpm', ['install', '--ignore-scripts'], {
      cwd: fixtureDir,
      stdio: 'inherit'
    })

    for (const [index, packageShape] of packages.entries()) {
      const scopedPackageDir = join(fixtureDir, 'node_modules', '@yolk-sdk', packageShape.name.replace('@yolk-sdk/', ''))
      mkdirSync(scopedPackageDir, { recursive: true })
      execFileSync('tar', ['-xzf', tarballPaths[index], '--strip-components', '1', '-C', scopedPackageDir], {
        cwd: fixtureDir,
        stdio: 'inherit'
      })
    }

    const imports = packages.flatMap(packageShape =>
      packageShape.exports.map(exportPath =>
        exportPath === '.' ? packageShape.name : `${packageShape.name}/${exportPath.slice(2)}`
      )
    )

    const smokeFile = join(fixtureDir, 'smoke.mjs')
    writeFileSync(smokeFile, imports.map((specifier, index) => `await import(${JSON.stringify(specifier)}); console.log(${JSON.stringify(index)}, ${JSON.stringify(specifier)})`).join('\n'))

    await import(pathToFileURL(smokeFile).href)
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true })
  }
}

void main()
