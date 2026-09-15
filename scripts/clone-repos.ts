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
import { Data, Effect, Match } from 'effect'
import * as Schema from 'effect/Schema'

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
  },
  {
    mode: 'branch',
    name: 'opencode-simulation',
    repo: 'https://github.com/sst/opencode.git',
    branch: 'jlongster/simulation-rebase'
  },
  {
    mode: 'branch',
    name: 'fast-check',
    repo: 'https://github.com/dubzzz/fast-check.git',
    branch: 'main'
  },
  {
    mode: 'branch',
    name: 't3code',
    repo: 'https://github.com/pingdotgg/t3code.git',
    branch: 'main'
  },
  {
    mode: 'branch',
    name: 'ai',
    repo: 'https://github.com/vercel/ai.git',
    branch: 'main'
  },
  {
    mode: 'branch',
    name: 'kody',
    repo: 'https://github.com/kentcdodds/kody.git',
    branch: 'main'
  },
  {
    mode: 'branch',
    name: 'flue',
    repo: 'https://github.com/withastro/flue.git',
    branch: 'main'
  },
  {
    mode: 'branch',
    name: 'mcp-sdk',
    repo: 'https://github.com/modelcontextprotocol/typescript-sdk.git',
    branch: 'main'
  },
  {
    mode: 'branch',
    name: 'clanka',
    repo: 'https://github.com/Effectful-Tech/clanka.git',
    branch: 'master'
  },
  {
    mode: 'branch',
    name: 'executor',
    repo: 'https://github.com/rhyssullivan/executor.git',
    branch: 'main'
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

class PackageManifestError extends Data.TaggedError('PackageManifestError')<{
  readonly path: string
  readonly details: string
  readonly cause?: unknown
}> {}

const PackageDependencyMap = Schema.Record(Schema.String, Schema.String)

const RootPackageManifest = Schema.Struct({
  dependencies: Schema.optionalKey(PackageDependencyMap),
  devDependencies: Schema.optionalKey(PackageDependencyMap)
})

const decodeRootPackageManifest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RootPackageManifest)
)

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
    catch: error =>
      new CommandError({
        command: cmd,
        details: error instanceof Error ? error.message : String(error),
        cause: error
      })
  })

const readVersion = (depKey: string) =>
  Effect.gen(function* () {
    const pkgPath = resolve(ROOT, 'package.json')

    const raw = yield* Effect.try({
      try: () => readFileSync(pkgPath, 'utf-8'),
      catch: error =>
        new PackageManifestError({
          path: pkgPath,
          details: 'Could not read package.json',
          cause: error
        })
    })

    const pkg = yield* decodeRootPackageManifest(raw).pipe(
      Effect.mapError(
        error =>
          new PackageManifestError({
            path: pkgPath,
            details: error.message,
            cause: error
          })
      )
    )

    const version = pkg.dependencies?.[depKey] ?? pkg.devDependencies?.[depKey]

    if (version === undefined) {
      return yield* new DependencyNotFoundError({ depKey })
    }

    return version.replace(/^[\^~]/, '')
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
        yield* Effect.sync(() => console.log(`  Cloning ${spec.name} @ branch ${spec.branch}...`))
        yield* exec(`git clone --depth 1 --branch "${spec.branch}" "${spec.repo}" "${dest}"`)
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

const formatError = (
  error: CommandError | DependencyNotFoundError | PackageManifestError
): string =>
  Match.value(error).pipe(
    Match.tag(
      'DependencyNotFoundError',
      current => `"${current.depKey}" not found in package.json dependencies`
    ),
    Match.tag('CommandError', current => `${current.details}\nCommand: ${current.command}`),
    Match.tag('PackageManifestError', current => `${current.details}\nManifest: ${current.path}`),
    Match.exhaustive
  )

await Effect.runPromise(
  program.pipe(
    Effect.catch(error =>
      Effect.sync(() => {
        console.error(formatError(error))
        process.exitCode = 1
      })
    )
  )
)
