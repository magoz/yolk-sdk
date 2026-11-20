/**
 * Import cost of every public `@yolk-sdk/*` subpath, from the built `dist`
 * (`pnpm packages:build` first): `pnpm packages:import-cost [filter...]`.
 *
 * Each subpath is imported alone in a fresh Node process. Module hooks map `@yolk-sdk/*` to the
 * `publishConfig.exports` dist files (as npm consumers resolve them), stub `cloudflare:workers`,
 * and record every module loaded. The table reports the median import time over three runs, the
 * number and size of the modules evaluated, and the heaviest third-party packages. Times include
 * the hooks' own overhead, so compare them with each other, not with production numbers.
 *
 * Filters keep the subpaths whose specifier contains any of them (`knowledge/chunking`, `codemode`).
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { Effect, Option, Result, Schema } from 'effect'

const runs = 3

// A `publishConfig.exports` target with an ESM file (`./package.json` maps to a string: skipped).
const ImportTarget = Schema.Struct({ import: Schema.String })

const Manifest = Schema.Struct({
  name: Schema.String,
  private: Schema.optional(Schema.Boolean),
  publishConfig: Schema.optional(
    Schema.Struct({ exports: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)) })
  )
})

const Measurement = Schema.Struct({
  milliseconds: Schema.Number,
  modules: Schema.Number,
  bytes: Schema.Number,
  packages: Schema.Array(Schema.Tuple([Schema.String, Schema.Number]))
})

const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest))

const decodeMeasurement = Schema.decodeUnknownEffect(Schema.fromJsonString(Measurement))

const decodeImportTarget = Schema.decodeUnknownOption(ImportTarget)

type Entry = { readonly specifier: string; readonly file: string }

const packagesDir = join(process.cwd(), 'packages')

const readEntries = Effect.forEach(
  readdirSync(packagesDir, { withFileTypes: true }).filter(dirent => dirent.isDirectory()),
  dirent =>
    Effect.gen(function* () {
      const packageDir = join(packagesDir, dirent.name)
      const manifest = yield* decodeManifest(readFileSync(join(packageDir, 'package.json'), 'utf8'))

      if (manifest.private === true) {
        return []
      }

      return Object.entries(manifest.publishConfig?.exports ?? {}).flatMap(([subpath, target]) =>
        Option.match(decodeImportTarget(target), {
          onNone: () => [],
          onSome: ({ import: file }): ReadonlyArray<Entry> => [
            {
              specifier: subpath === '.' ? manifest.name : `${manifest.name}/${subpath.slice(2)}`,
              file: join(packageDir, file)
            }
          ]
        })
      )
    })
).pipe(Effect.map(entries => entries.flat()))

// The Effect runtime every subpath shares, for reference.
const baseline: Entry = {
  specifier: 'effect (baseline)',
  file: createRequire(join(packagesDir, 'knowledge', 'package.json')).resolve('effect')
}

const filters = process.argv.slice(2).filter(argument => argument !== '--')

// Runs in the child process: plain ESM, no TypeScript.
const childSource = `
import { registerHooks } from 'node:module'
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'

const [target, entriesFile, stubUrl] = process.argv.slice(2)
const yolk = new Map(JSON.parse(readFileSync(entriesFile, 'utf8')))
const loaded = new Map()

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'cloudflare:workers') return { url: stubUrl, shortCircuit: true }
    const file = yolk.get(specifier)
    if (file !== undefined) return { url: pathToFileURL(file).href, shortCircuit: true }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url.startsWith('file:') && !loaded.has(url)) loaded.set(url, statSync(fileURLToPath(url)).size)
    return next(url, context)
  }
})

const start = performance.now()
await import(pathToFileURL(target).href)
const milliseconds = performance.now() - start

const packageOf = url => {
  const path = fileURLToPath(url)
  const index = path.lastIndexOf('/node_modules/')
  if (index === -1) return path.includes('/packages/') ? '@yolk-sdk/' + path.split('/packages/')[1].split('/')[0] : 'other'
  const rest = path.slice(index + '/node_modules/'.length).split('/')
  return rest[0].startsWith('@') ? rest[0] + '/' + rest[1] : rest[0]
}

const packages = new Map()
for (const [url, size] of loaded) packages.set(packageOf(url), (packages.get(packageOf(url)) ?? 0) + size)

process.stdout.write(JSON.stringify({
  milliseconds,
  modules: loaded.size,
  bytes: [...loaded.values()].reduce((sum, size) => sum + size, 0),
  packages: [...packages].sort((a, b) => b[1] - a[1])
}))
`

const median = (values: ReadonlyArray<number>) =>
  [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)] ?? 0

const kilobytes = (bytes: number) => `${Math.round(bytes / 1024)}`

const cloudflareStubSource = [
  'export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env } }',
  'export class WorkerEntrypoint {}',
  'export class RpcTarget {}',
  'export const env = {}'
].join('\n')

const main = Effect.gen(function* () {
  const entries = yield* readEntries

  const selected = [
    baseline,
    ...entries.filter(
      entry => filters.length === 0 || filters.some(filter => entry.specifier.includes(filter))
    )
  ]

  const workDir = yield* Effect.acquireRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), 'yolk-import-cost-'))),
    directory => Effect.sync(() => rmSync(directory, { recursive: true, force: true }))
  )

  const childFile = join(workDir, 'measure.mjs')
  const stubFile = join(workDir, 'cloudflare-workers-stub.mjs')
  const entriesFile = join(workDir, 'entries.json')

  writeFileSync(childFile, childSource)
  writeFileSync(stubFile, cloudflareStubSource)
  writeFileSync(entriesFile, JSON.stringify(entries.map(entry => [entry.specifier, entry.file])))

  const sample = (entry: Entry) =>
    Effect.try({
      try: () =>
        execFileSync(
          process.execPath,
          [childFile, entry.file, entriesFile, pathToFileURL(stubFile).href],
          { cwd: workDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
        ),
      // The child's stderr follows the command line in the message; keep its error line.
      catch: error =>
        (error instanceof Error ? error.message : '')
          .split('\n')
          .find(line => /^\w*Error/.test(line)) ?? 'failed'
    }).pipe(
      Effect.flatMap(stdout =>
        decodeMeasurement(stdout).pipe(Effect.mapError(() => 'unreadable measurement'))
      )
    )

  const measure = (entry: Entry) =>
    Effect.replicateEffect(sample(entry), runs).pipe(
      Effect.map(samples => ({
        ...samples[0],
        milliseconds: median(samples.map(each => each.milliseconds))
      }))
    )

  console.log('| Subpath | Import ms | Modules | KB | Heaviest dependencies (KB) |')
  console.log('| --- | ---: | ---: | ---: | --- |')

  for (const entry of selected) {
    const result = yield* Effect.result(measure(entry))

    if (Result.isFailure(result)) {
      console.log(`| \`${entry.specifier}\` | failed | | | ${result.failure} |`)
      continue
    }

    const { milliseconds, modules, bytes, packages } = result.success

    const heaviest = packages
      .filter(([name]) => !name.startsWith('@yolk-sdk/') && name !== 'other')
      .slice(0, 3)
      .filter(([, size]) => size >= 20 * 1024)
      .map(([name, size]) => `${name} ${kilobytes(size)}`)
      .join(', ')

    console.log(
      `| \`${entry.specifier}\` | ${milliseconds.toFixed(0)} | ${modules} | ${kilobytes(bytes)} | ${heaviest} |`
    )
  }
}).pipe(Effect.scoped)

Effect.runPromise(main).catch(error => {
  console.error(error)
  process.exitCode = 1
})
