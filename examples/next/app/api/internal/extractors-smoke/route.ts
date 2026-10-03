import { Config, Data, Effect, Layer, Logger } from 'effect'
import { HttpEffect, HttpServerResponse } from 'effect/http'
import { FileExtractionError, FileExtractor } from '@yolk-sdk/extractors'
import { FileExtractorLayer, makeFileExtractorLayer } from '@yolk-sdk/extractors/node'
import * as XLSX from 'xlsx'
import { TelemetryLayer } from '@/lib/services/telemetry/live-layer'
import { reportError } from '@/lib/services/telemetry/report-error'

export const dynamic = 'force-dynamic'

// Production-build smoke for `@yolk-sdk/extractors` worker isolation: one real extraction in the
// packaged worker, plus a heap-limit and a timeout run that only a worker can report. Disabled
// (404) unless `YOLK_EXTRACTORS_SMOKE=true`; it takes no input.

class ExtractorsSmokeRouteError extends Data.TaggedError('ExtractorsSmokeRouteError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

const operation = 'api.internal.extractorsSmoke'

const workbookBytes = (rows: ReadonlyArray<ReadonlyArray<string | number>>) => {
  const book = XLSX.utils.book_new()

  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows.map(row => [...row])), 'Smoke')

  return new Uint8Array(XLSX.write(book, { type: 'array', bookType: 'xlsx', compression: true }))
}

const extract = (bytes: Uint8Array) =>
  Effect.gen(function* () {
    const extractor = yield* FileExtractor

    return yield* extractor.extract({ filename: 'smoke.xlsx', mediaType: '', bytes })
  })

/** The `reason` of an expected failure under a stricter layer. */
const failureReason = (layer: Layer.Layer<FileExtractor>, bytes: Uint8Array) =>
  extract(bytes).pipe(
    Effect.provide(layer),
    Effect.flip,
    Effect.map(error => (error instanceof FileExtractionError ? (error.reason ?? null) : null))
  )

/** Report an unexpected failure (including a worker defect) before answering 500. */
const failed = (cause: unknown) =>
  reportError(
    new ExtractorsSmokeRouteError({
      message: `Extractor smoke failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      cause
    }),
    { operation, status: 500, cause_type: cause instanceof Error ? cause.name : 'unknown' }
  ).pipe(
    Effect.andThen(HttpServerResponse.json({ error: 'Extractor smoke failed' }, { status: 500 }))
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

  const extracted = yield* extract(small)

  const heapLimit = yield* failureReason(
    makeFileExtractorLayer({ isolation: { maxOldGenerationSizeMb: 16 } }),
    heavy
  )

  const timeout = yield* failureReason(
    makeFileExtractorLayer({ isolation: { timeoutMs: 1 } }),
    small
  )

  return yield* HttpServerResponse.json({ extracted, heapLimit, timeout })
}).pipe(Effect.withSpan(operation), Effect.catch(failed), Effect.catchDefect(failed))

const RouteLayer = Layer.mergeAll(
  FileExtractorLayer,
  Logger.layer([Logger.consolePretty()]),
  TelemetryLayer
)

const { handler: effectHandler } = HttpEffect.toWebHandlerLayer(handler, RouteLayer)

export const GET = (request: Request) => effectHandler(request)
