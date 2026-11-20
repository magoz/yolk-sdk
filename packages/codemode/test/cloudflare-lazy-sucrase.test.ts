import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import * as Schema from 'effect/Schema'

const packageDir = fileURLToPath(new URL('..', import.meta.url))

const Observed = Schema.Struct({
  afterImports: Schema.Boolean,
  afterCreate: Schema.Boolean,
  afterExecute: Schema.Boolean,
  result: Schema.Unknown
})

/**
 * Runs in a fresh Node process (the test runner's module graph already holds what other tests
 * imported). Node strips the source's TypeScript; module hooks stub `cloudflare:workers` and record
 * every module loaded, so each step reports whether Sucrase has been evaluated yet.
 */
const childScript = `
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'

const stub = pathToFileURL('./test/cloudflare-workers-stub.ts').href
const loaded = []
registerHooks({
  resolve: (specifier, context, next) =>
    specifier === 'cloudflare:workers' ? { url: stub, shortCircuit: true } : next(specifier, context),
  load(url, context, next) {
    loaded.push(url)
    return next(url, context)
  }
})
const sucraseLoaded = () => loaded.some(url => url.includes('/sucrase/'))

await import(pathToFileURL('./src/index.ts').href)
const cloudflare = await import(pathToFileURL('./src/cloudflare.ts').href)
const afterImports = sucraseLoaded()

const executor = cloudflare.makeDynamicWorkerCodeModeExecutor({
  loader: () => {
    throw new Error('no loader in this test')
  }
})
const afterCreate = sucraseLoaded()

const result = await executor.execute('const value: number = 1\\nreturn value', {
  tools: [],
  globals: [],
  timeoutMs: 1000,
  memoryLimitBytes: 1024 * 1024,
  store: {},
  signal: new AbortController().signal
})

process.stdout.write(JSON.stringify({ afterImports, afterCreate, afterExecute: sucraseLoaded(), result }))
`

describe('Dynamic Worker executor Sucrase loading', () => {
  it.effect(
    'evaluates Sucrase only when a script runs',
    () =>
      Effect.gen(function* () {
        const { stdout } = yield* Effect.promise(() =>
          promisify(execFile)(process.execPath, ['--input-type=module', '--eval', childScript], {
            cwd: packageDir
          })
        )

        const observed = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Observed))(stdout)

        expect(observed).toEqual({
          afterImports: false,
          afterCreate: false,
          // The script was stripped (Sucrase loaded) before the loader failed.
          afterExecute: true,
          result: {
            ok: false,
            error: { kind: 'sandbox', message: 'Could not load the script sandbox.' },
            output: []
          }
        })
      }),
    30_000
  )
})
