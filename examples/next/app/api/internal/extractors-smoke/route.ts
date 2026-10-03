import { Config, Effect } from 'effect'
import type { Layer } from 'effect'
import { HttpEffect, HttpServerResponse } from 'effect/http'
import { FileExtractionError, FileExtractor } from '@yolk-sdk/extractors'
import { FileExtractorLayer, makeFileExtractorLayer } from '@yolk-sdk/extractors/node'
import * as XLSX from 'xlsx'

export const dynamic = 'force-dynamic'

// Production-build smoke for `@yolk-sdk/extractors` worker isolation: one real extraction in the
// packaged worker, plus a heap-limit and a timeout run that only a worker can report. Disabled
// (404) unless `YOLK_EXTRACTORS_SMOKE=true`; it takes no input.

const workbookBytes = (rows: ReadonlyArray<ReadonlyArray<string | number>>) => {
  const book = XLSX.utils.book_new()

  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows.map(row => [...row])), 'Smoke')

  return new Uint8Array(XLSX.write(book, { type: 'array', bookType: 'xlsx', compression: true }))
}

const extract = (layer: Layer.Layer<FileExtractor>, bytes: Uint8Array) =>
  Effect.gen(function* () {
    const extractor = yield* FileExtractor

    return yield* extractor.extract({ filename: 'smoke.xlsx', mediaType: '', bytes })
  }).pipe(Effect.provide(layer))

const failureReason = (layer: Layer.Layer<FileExtractor>, bytes: Uint8Array) =>
  extract(layer, bytes).pipe(
    Effect.flip,
    Effect.map(error => (error instanceof FileExtractionError ? (error.reason ?? null) : null))
  )

const handler = Effect.gen(function* () {
  const enabled = yield* Config.Boolean('YOLK_EXTRACTORS_SMOKE').pipe(Config.withDefault(false))

  if (!enabled) return yield* HttpServerResponse.json({ error: 'Not found' }, { status: 404 })

  const small = workbookBytes([
    ['Name', 'Count'],
    ['Alpha', 2]
  ])

  const heavy = workbookBytes(
    Array.from({ length: 30_000 }, (_, row) => Array.from({ length: 10 }, () => row))
  )

  const extracted = yield* extract(FileExtractorLayer, small)

  const heapLimit = yield* failureReason(
    makeFileExtractorLayer({ isolation: { maxOldGenerationSizeMb: 16 } }),
    heavy
  )

  const timeout = yield* failureReason(
    makeFileExtractorLayer({ isolation: { timeoutMs: 1 } }),
    small
  )

  return yield* HttpServerResponse.json({ extracted, heapLimit, timeout })
}).pipe(
  Effect.catch(() => HttpServerResponse.json({ error: 'Extractor smoke failed' }, { status: 500 }))
)

const effectHandler = HttpEffect.toWebHandler(handler)

export const GET = (request: Request) => effectHandler(request)
