import { Effect, Layer } from 'effect'
import * as Schema from 'effect/Schema'
import { FileExtractionError, UnsupportedFileFormatError } from '../errors.ts'
import { fileFormatFor } from '../format.ts'
import { defaultFileExtractorLimits, FileExtractorLimits } from '../limits.ts'
import { FileExtractor } from '../service.ts'
import type { FileExtractorApi } from '../service.ts'
import { extractParsedFile, isParsedFileFormat, makeExtractedFile } from './extract-file.ts'
import type { ParsedFileFormat } from './extract-file.ts'
import {
  defaultExtractionWorkerUrl,
  defaultWorkerIsolation,
  makeWorkerExtractor,
  WorkerIsolationSettings
} from './extraction-isolation.ts'
import type { FileExtractorIsolation, WorkerExtractor } from './extraction-isolation.ts'
import { defaultSheetJsLoader } from './sheetjs.ts'
import type { SheetJsLoader } from './sheetjs.ts'

export type FileExtractorOptions = {
  /** Override any default limit; see `defaultFileExtractorLimits`. */
  readonly limits?: Partial<FileExtractorLimits>
  /**
   * Where parsers run (default `'worker'`): each PDF, DOCX, XLSX, and PPTX extraction runs in a
   * fresh worker thread with V8 heap, stack, and time limits, admitted through a pool of 4 workers
   * per JavaScript realm; pass an object to change them. `'none'` parses in the calling thread and is
   * unsafe for untrusted input.
   */
  readonly isolation?: FileExtractorIsolation
  /**
   * Load SheetJS in the calling thread. Only with `isolation: 'none'` (a worker cannot receive a
   * function and always imports the installed `xlsx` itself); any other isolation is a defect
   * when the layer is built. Defaults to a lazy `import('xlsx')`. Missing, non-SheetJS, or
   * pre-0.20.3 modules fail with `SheetJsUnavailableError`.
   */
  readonly loadSheetJs?: SheetJsLoader
}

const decodeText = (bytes: Uint8Array) => new TextDecoder('utf-8', { fatal: false }).decode(bytes)

type ParsedFileExtractor = WorkerExtractor

/** Build the Node `FileExtractor` from validated limits and the parser runner. */
const makeFileExtractor = (
  limits: FileExtractorLimits,
  extractParsed: ParsedFileExtractor
): FileExtractorApi => ({
  extract: input =>
    Effect.gen(function* () {
      const format = fileFormatFor(input)

      if (format === undefined)
        return yield* Effect.fail(
          new UnsupportedFileFormatError({ filename: input.filename, mediaType: input.mediaType })
        )

      yield* Effect.annotateCurrentSpan({
        'file_extractor.format': format,
        'file_extractor.file_size': input.bytes.byteLength
      })

      if (input.bytes.byteLength > limits.maxInputBytes)
        return yield* Effect.fail(
          new FileExtractionError({ message: 'File exceeds the extraction size limit', format })
        )

      if (isParsedFileFormat(format)) return yield* extractParsed(input, format, limits)

      // Text formats are only decoded and sanitized; no parser reads them.
      return yield* makeExtractedFile(decodeText(input.bytes), { format, title: input.filename })
    }).pipe(Effect.withSpan('FileExtractor.extract'))
})

const parsedFileExtractor = (
  options: FileExtractorOptions
): Effect.Effect<ParsedFileExtractor, Schema.SchemaError> => {
  const isolation = options.isolation ?? 'worker'

  if (isolation === 'none') {
    const loader = options.loadSheetJs ?? defaultSheetJsLoader

    return Effect.succeed((input, format: ParsedFileFormat, limits) =>
      extractParsedFile(input, format, limits, loader)
    )
  }

  if (options.loadSheetJs !== undefined)
    return Effect.die(
      new Error(
        'FileExtractorOptions.loadSheetJs runs SheetJS in the calling thread and needs isolation: "none"'
      )
    )

  const overrides = isolation === 'worker' ? {} : isolation
  const timeoutMs = overrides.timeoutMs ?? defaultWorkerIsolation.timeoutMs

  return Schema.decodeUnknownEffect(WorkerIsolationSettings)({
    maxOldGenerationSizeMb:
      overrides.maxOldGenerationSizeMb ?? defaultWorkerIsolation.maxOldGenerationSizeMb,
    maxYoungGenerationSizeMb:
      overrides.maxYoungGenerationSizeMb ?? defaultWorkerIsolation.maxYoungGenerationSizeMb,
    stackSizeMb: overrides.stackSizeMb ?? defaultWorkerIsolation.stackSizeMb,
    timeoutMs,
    maxConcurrentWorkers:
      overrides.maxConcurrentWorkers ?? defaultWorkerIsolation.maxConcurrentWorkers,
    maxQueueWaitMs: overrides.maxQueueWaitMs ?? timeoutMs
  }).pipe(
    Effect.flatMap(settings =>
      makeWorkerExtractor(settings, overrides.workerUrl ?? defaultExtractionWorkerUrl())
    )
  )
}

/**
 * Node `FileExtractor` layer with custom limits, isolation, or (in-process) SheetJS loader.
 * Invalid limits or isolation settings are defects.
 */
export const makeFileExtractorLayer = (options: FileExtractorOptions = {}) =>
  Layer.effect(
    FileExtractor,
    Effect.gen(function* () {
      const limits = yield* Schema.decodeUnknownEffect(FileExtractorLimits)({
        ...defaultFileExtractorLimits,
        ...options.limits
      })

      const extractParsed = yield* parsedFileExtractor(options)

      return FileExtractor.of(makeFileExtractor(limits, extractParsed))
    }).pipe(Effect.orDie)
  )

/**
 * Node `FileExtractor` layer with the default limits, worker isolation, and lazy SheetJS loading.
 */
export const FileExtractorLayer = makeFileExtractorLayer()
