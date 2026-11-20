import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from '@effect/vitest'
import { Effect, Option } from 'effect'
import * as Schema from 'effect/Schema'
import { countKnowledgeChunkTokens } from '../src/chunking.ts'

const packageDir = fileURLToPath(new URL('..', import.meta.url))

const Manifest = Schema.Struct({ exports: Schema.Record(Schema.String, Schema.Unknown) })

// A source export target (`./package.json` maps to a plain string: not an entry).
const decodeSourceTarget = Schema.decodeUnknownOption(Schema.Struct({ default: Schema.String }))

// Every public source entry (`exports`, not `publishConfig`): none may evaluate the tokenizer.
const readSourceEntries = Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest))(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
).pipe(
  Effect.map(manifest =>
    Object.values(manifest.exports).flatMap(target =>
      Option.toArray(decodeSourceTarget(target)).map(entry => entry.default)
    )
  )
)

const Observed = Schema.Struct({
  afterImports: Schema.Boolean,
  afterLayer: Schema.Boolean,
  afterInvalidInput: Schema.Boolean,
  invalidInputError: Schema.String,
  afterCount: Schema.Boolean,
  count: Schema.Number,
  chunks: Schema.Array(Schema.String)
})

/**
 * Runs in a fresh Node process (the test runner's own module graph already holds whatever other
 * tests imported). Node strips the source's TypeScript; a module hook records every module the
 * process loads, so each step reports whether `gpt-tokenizer` has been evaluated yet.
 */
const childScript = (sourceEntries: ReadonlyArray<string>) => `
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'

const loaded = []
registerHooks({
  load(url, context, next) {
    loaded.push(url)
    return next(url, context)
  }
})
const tokenizerLoaded = () => loaded.some(url => url.includes('/gpt-tokenizer/'))

for (const entry of ${JSON.stringify(sourceEntries)}) await import(pathToFileURL(entry).href)
const afterImports = tokenizerLoaded()

const { Effect, Layer } = await import('effect')
const chunking = await import(pathToFileURL('./src/chunking.ts').href)
const { KnowledgeScopeId, KnowledgeDocumentId } = await import(pathToFileURL('./src/documents.ts').href)
const document = {
  scopeId: KnowledgeScopeId.make('scope_1'),
  documentId: KnowledgeDocumentId.make('doc_1'),
  content: 'Alpha beta. Gamma delta.'
}

const chunker = await Effect.runPromise(
  Effect.gen(function* () { return yield* chunking.KnowledgeChunker }).pipe(
    Effect.provide(chunking.DefaultKnowledgeChunkerLive({ maxTokens: 4 }))
  )
)
const afterLayer = tokenizerLoaded()

const invalid = await Effect.runPromise(Effect.flip(chunking.chunkKnowledgeText(document, 0)))
const afterInvalidInput = tokenizerLoaded()

const count = await Effect.runPromise(chunking.countKnowledgeChunkTokens('hello world'))
const afterCount = tokenizerLoaded()
const chunks = await Effect.runPromise(chunker.chunk(document))

process.stdout.write(JSON.stringify({
  afterImports,
  afterLayer,
  afterInvalidInput,
  invalidInputError: invalid._tag,
  afterCount,
  count,
  chunks: chunks.map(chunk => chunk.content)
}))
`

describe('default tokenizer loading', () => {
  it.effect(
    'evaluates the tokenizer only when text is counted or chunked',
    () =>
      Effect.gen(function* () {
        const sourceEntries = yield* readSourceEntries

        expect(sourceEntries).toContain('./src/chunking.ts')
        expect(sourceEntries).toContain('./src/ingestion.ts')

        const { stdout } = yield* Effect.promise(() =>
          promisify(execFile)(
            process.execPath,
            ['--input-type=module', '--eval', childScript(sourceEntries)],
            { cwd: packageDir }
          )
        )

        const observed = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Observed))(stdout)

        expect(observed).toEqual({
          afterImports: false,
          afterLayer: false,
          afterInvalidInput: false,
          invalidInputError: 'KnowledgeChunkingError',
          afterCount: true,
          count: 2,
          chunks: ['Alpha beta.', 'Gamma delta.']
        })
      }),
    30_000
  )

  it.effect('counts tokens with the default tokenizer', () =>
    Effect.gen(function* () {
      const counts = yield* Effect.all([
        countKnowledgeChunkTokens(''),
        countKnowledgeChunkTokens('hello world'),
        countKnowledgeChunkTokens('Alpha beta. Gamma delta.')
      ])

      expect(counts).toEqual([0, 2, 6])
    })
  )
})
