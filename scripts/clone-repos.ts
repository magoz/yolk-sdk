/**
 * Clone reference repos into .repos/ at pinned versions.
 *
 * Two modes:
 * - `dependency`: reads version from package.json, clones at tag
 * - `branch`: clones a specific branch (for repos not in package.json)
 *
 * Re-run to update (deletes + re-clones). Repos are gitignored.
 *
 * Usage: pnpm clone-repos
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { Data, Effect } from 'effect'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type DependencyRepo = Readonly<{
  mode: 'dependency'
  name: string
  repo: string
  /** Prefix before the version number in git tags (e.g. "effect@", "v") */
  tagPrefix: string
  /** Key in package.json dependencies/devDependencies */
  depKey: string
}>

type BranchRepo = Readonly<{
  mode: 'branch'
  name: string
  repo: string
  branch: string
}>

type RepoSpec = DependencyRepo | BranchRepo

// ---------------------------------------------------------------------------
// Config — single source of truth for which repos to fetch
// ---------------------------------------------------------------------------

const repos: ReadonlyArray<RepoSpec> = [
  {
    mode: 'dependency',
    name: 'effect',
    repo: 'https://github.com/Effect-TS/effect-smol.git',
    tagPrefix: 'effect@',
    depKey: 'effect'
  },
  {
    mode: 'branch',
    name: 'pi',
    repo: 'git@github.com:badlogic/pi-mono.git',
    branch: 'main'
  },
  {
    mode: 'branch',
    name: 'opencode',
    repo: 'git@github.com:anomalyco/opencode.git',
    branch: 'dev'
  }
]

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

class CommandError extends Data.TaggedError('CommandError')<{
  readonly command: string
  readonly details: string
  readonly cause?: unknown
}> {}

class DependencyNotFoundError extends Data.TaggedError('DependencyNotFoundError')<{
  readonly depKey: string
}> {}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ROOT = resolve(import.meta.dirname, '..')
const REPOS_DIR = resolve(ROOT, '.repos')

const exec = (cmd: string, cwd?: string) =>
  Effect.tryPromise({
    try: async () => {
      const { execSync } = await import('node:child_process')
      return execSync(cmd, { cwd, stdio: 'pipe', encoding: 'utf-8' })
    },
    catch: (error) =>
      new CommandError({
        command: cmd,
        details: error instanceof Error ? error.message : String(error),
        cause: error
      })
  })

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const readVersion = (depKey: string) =>
  Effect.gen(function* () {
    const pkgPath = resolve(ROOT, 'package.json')
    const pkg: unknown = JSON.parse(readFileSync(pkgPath, 'utf-8'))

    if (!isRecord(pkg)) {
      return yield* new DependencyNotFoundError({ depKey })
    }

    const deps = isRecord(pkg['dependencies']) ? pkg['dependencies'] : {}
    const devDeps = isRecord(pkg['devDependencies']) ? pkg['devDependencies'] : {}
    const value = deps[depKey] ?? devDeps[depKey]
    const raw = typeof value === 'string' ? value : undefined

    if (raw === undefined) {
      return yield* new DependencyNotFoundError({ depKey })
    }

    return raw.replace(/^[\^~]/, '')
  })

// ---------------------------------------------------------------------------
// Clone logic
// ---------------------------------------------------------------------------

const cloneRepo = (spec: RepoSpec) =>
  Effect.gen(function* () {
    const dest = resolve(REPOS_DIR, spec.name)

    if (existsSync(dest)) {
      yield* Effect.sync(() => console.log(`  Removing existing ${spec.name}/...`))
      rmSync(dest, { recursive: true, force: true })
    }

    switch (spec.mode) {
      case 'dependency': {
        const version = yield* readVersion(spec.depKey)
        const tag = `${spec.tagPrefix}${version}`

        yield* Effect.sync(() => console.log(`  Cloning ${spec.name} @ ${tag}...`))

        yield* exec(`git clone --depth 1 --branch "${tag}" "${spec.repo}" "${dest}"`).pipe(
          Effect.catchTag('CommandError', () =>
            Effect.gen(function* () {
              yield* Effect.sync(() =>
                console.log(`  Tag "${tag}" not found, falling back to default branch...`)
              )
              yield* exec(`git clone --depth 1 "${spec.repo}" "${dest}"`)
              return ''
            })
          )
        )

        yield* Effect.sync(() => console.log(`  ✓ ${spec.name} @ ${version}`))
        break
      }

      case 'branch': {
        yield* Effect.sync(() =>
          console.log(`  Cloning ${spec.name} @ branch ${spec.branch}...`)
        )
        yield* exec(
          `git clone --depth 1 --branch "${spec.branch}" "${spec.repo}" "${dest}"`
        )
        yield* Effect.sync(() => console.log(`  ✓ ${spec.name} @ ${spec.branch}`))
        break
      }
    }

    // Remove .git to save space
    const gitDir = resolve(dest, '.git')
    if (existsSync(gitDir)) {
      rmSync(gitDir, { recursive: true, force: true })
    }
  })

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const program = Effect.gen(function* () {
  yield* Effect.sync(() => console.log('Cloning reference repos into .repos/\n'))

  if (!existsSync(REPOS_DIR)) {
    mkdirSync(REPOS_DIR, { recursive: true })
  }

  for (const spec of repos) {
    yield* cloneRepo(spec)
    yield* Effect.sync(() => console.log(''))
  }

  yield* Effect.sync(() => console.log('Done. Use these for local reference only.'))
})

const formatError = (error: CommandError | DependencyNotFoundError): string => {
  switch (error._tag) {
    case 'DependencyNotFoundError':
      return `"${error.depKey}" not found in package.json dependencies`
    case 'CommandError':
      return `${error.details}\nCommand: ${error.command}`
  }
}

await Effect.runPromise(
  program.pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        console.error(formatError(error))
        process.exitCode = 1
      })
    )
  )
)
