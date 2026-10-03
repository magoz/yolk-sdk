import { Buffer } from 'node:buffer'
import { Effect, Layer, Option, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import mammoth from 'mammoth'
import { extractText, getDocumentProxy, getMeta } from 'unpdf'
import { FileExtractionError, UnsupportedFileFormatError } from '../errors.ts'
import { fileFormatFor, isOfficeFileFormat } from '../format.ts'
import type {
  ExtractedFile,
  ExtractedFileFormat,
  ExtractedFileMetadata,
  FileInput,
  OfficeFileFormat
} from '../format.ts'
import { defaultFileExtractorLimits, FileExtractorLimits } from '../limits.ts'
import { sanitizeExtractedText } from '../sanitize.ts'
import { FileExtractor } from '../service.ts'
import type { FileExtractorApi } from '../service.ts'
import { readOfficeArchive } from './office-archive.ts'
import type { NormalizedOfficeArchive } from './office-archive.ts'
import { extractPptxText } from './pptx-text.ts'
import { asXlsxWorkbook, defaultSheetJsLoader, loadSheetJs, workbookTitle } from './sheetjs.ts'
import type { SheetJsLoader } from './sheetjs.ts'
import { resolveXlsxHyperlinks } from './xlsx-hyperlinks.ts'
import { extractBoundedXlsxText } from './xlsx-text.ts'

export type FileExtractorOptions = {
  /** Override any default limit; see `defaultFileExtractorLimits`. */
  readonly limits?: Partial<FileExtractorLimits>
  /**
   * Load SheetJS. Defaults to a lazy `import('xlsx')`, run only when an XLSX file is extracted.
   * Missing, non-SheetJS, or pre-0.20.3 modules fail with `SheetJsUnavailableError`.
   */
  readonly loadSheetJs?: SheetJsLoader
}

const makeExtractedFile = (content: string, metadata: ExtractedFileMetadata) => {
  const sanitized = sanitizeExtractedText(content)

  if (sanitized.length === 0)
    return Effect.fail(
      new FileExtractionError({
        message: 'Extracted file content is empty',
        format: metadata.format
      })
    )

  return Effect.succeed<ExtractedFile>({ content: sanitized, metadata })
}

const decodeText = (bytes: Uint8Array) => new TextDecoder('utf-8', { fatal: false }).decode(bytes)

type PdfDocumentResource = {
  readonly destroy: () => Promise<void>
}

/** Run `use` with an opened PDF document and always release the parser afterwards. */
export const withAcquiredPdfDocument = <D extends PdfDocumentResource, A, E, R>(
  open: Effect.Effect<D, E, R>,
  use: (document: D) => Effect.Effect<A, E, R>,
  format: ExtractedFileFormat
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const document = yield* Effect.acquireRelease(open, document =>
        Effect.tryPromise({
          try: () => document.destroy(),
          catch: () => new FileExtractionError({ message: 'Could not release PDF parser', format })
        }).pipe(Effect.ignore)
      )

      return yield* use(document)
    })
  )

const extractPdf = (input: FileInput) =>
  withAcquiredPdfDocument(
    Effect.tryPromise({
      // PDF.js may detach the buffer it is given; never hand it the caller's bytes.
      try: () => getDocumentProxy(new Uint8Array(input.bytes)),
      catch: cause =>
        new FileExtractionError({ message: 'Could not read PDF', format: 'pdf', cause })
    }),
    document =>
      Effect.gen(function* () {
        const extracted = yield* Effect.tryPromise({
          try: () => extractText(document, { mergePages: true }),
          catch: cause =>
            new FileExtractionError({ message: 'Could not extract PDF text', format: 'pdf', cause })
        })

        const meta = yield* Effect.tryPromise({
          try: () => getMeta(document),
          catch: cause =>
            new FileExtractionError({
              message: 'Could not read PDF metadata',
              format: 'pdf',
              cause
            })
        }).pipe(Effect.option)

        const rawTitle = Option.isSome(meta) ? meta.value.info.Title : undefined
        const title = Predicate.isString(rawTitle) && rawTitle.length > 0 ? rawTitle : undefined

        const metadata: ExtractedFileMetadata =
          title === undefined
            ? { format: 'pdf', pageCount: extracted.totalPages }
            : { format: 'pdf', title, pageCount: extracted.totalPages }

        return yield* makeExtractedFile(extracted.text, metadata)
      }),
    'pdf'
  )

const validatedArchive = (
  input: FileInput,
  format: OfficeFileFormat,
  limits: FileExtractorLimits
): Effect.Effect<NormalizedOfficeArchive, FileExtractionError> =>
  readOfficeArchive(
    input.bytes,
    format,
    limits,
    format === 'xlsx' ? limits.maxXlsxHyperlinks + 1 : 0
  ).pipe(
    Effect.mapError(
      error => new FileExtractionError({ message: error.message, format, cause: error })
    )
  )

const extractDocx = (input: FileInput, limits: FileExtractorLimits) =>
  Effect.gen(function* () {
    const { archive } = yield* validatedArchive(input, 'docx', limits)

    const result = yield* Effect.tryPromise({
      try: () => mammoth.extractRawText({ buffer: Buffer.from(archive) }),
      catch: cause =>
        new FileExtractionError({ message: 'Could not extract DOCX text', format: 'docx', cause })
    })

    return yield* makeExtractedFile(result.value, { format: 'docx', title: input.filename })
  })

const extractXlsx = (input: FileInput, limits: FileExtractorLimits, loader: SheetJsLoader) =>
  Effect.gen(function* () {
    const normalized = yield* validatedArchive(input, 'xlsx', limits)
    const sheetJs = yield* loadSheetJs(loader)

    const parsed = yield* Effect.try({
      try: () => sheetJs.read(normalized.archive),
      catch: cause =>
        new FileExtractionError({ message: 'Could not read XLSX', format: 'xlsx', cause })
    })

    const workbook = asXlsxWorkbook(parsed)

    if (workbook === undefined)
      return yield* Effect.fail(
        new FileExtractionError({ message: 'Could not read XLSX', format: 'xlsx' })
      )

    // One extra tag was captured to detect that the workbook exceeds the hyperlink cap.
    const capturedTags = [...normalized.hyperlinkTags.values()].reduce(
      (total, tags) => total + tags.length,
      0
    )

    const hyperlinksTruncated = capturedTags > limits.maxXlsxHyperlinks

    const hyperlinks = resolveXlsxHyperlinks(
      normalized.parts,
      hyperlinksTruncated
        ? capHyperlinkTags(normalized.hyperlinkTags, limits.maxXlsxHyperlinks)
        : normalized.hyperlinkTags
    )

    const content = yield* Effect.try({
      try: () => extractBoundedXlsxText(workbook, limits, { hyperlinks, hyperlinksTruncated }),
      catch: cause =>
        cause instanceof FileExtractionError
          ? cause
          : new FileExtractionError({
              message: 'Could not extract XLSX text',
              format: 'xlsx',
              cause
            })
    })

    return yield* makeExtractedFile(content, {
      format: 'xlsx',
      title: workbookTitle(parsed) ?? input.filename,
      sheetNames: workbook.SheetNames
    })
  })

/** Keep the first `max` tags in archive order. */
const capHyperlinkTags = (
  tagsByPart: ReadonlyMap<string, ReadonlyArray<string>>,
  max: number
): ReadonlyMap<string, ReadonlyArray<string>> => {
  const capped = new Map<string, ReadonlyArray<string>>()
  let remaining = max

  for (const [part, tags] of tagsByPart) {
    if (remaining <= 0) break

    const kept = tags.slice(0, remaining)
    remaining -= kept.length
    capped.set(part, kept)
  }

  return capped
}

const extractPptx = (input: FileInput, limits: FileExtractorLimits) =>
  Effect.gen(function* () {
    const { parts } = yield* validatedArchive(input, 'pptx', limits)

    const text = yield* Effect.try({
      try: () => extractPptxText(parts),
      catch: cause =>
        new FileExtractionError({ message: 'Could not extract PPTX text', format: 'pptx', cause })
    })

    return yield* makeExtractedFile(text, { format: 'pptx', title: input.filename })
  })

/** Build the Node `FileExtractor` implementation. */
export const makeFileExtractor = (
  limits: FileExtractorLimits,
  loader: SheetJsLoader = defaultSheetJsLoader
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

      if (isOfficeFileFormat(format)) {
        if (format === 'docx') return yield* extractDocx(input, limits)

        if (format === 'xlsx') return yield* extractXlsx(input, limits, loader)

        return yield* extractPptx(input, limits)
      }

      if (format === 'pdf') return yield* extractPdf(input)

      return yield* makeExtractedFile(decodeText(input.bytes), {
        format,
        title: input.filename
      })
    }).pipe(Effect.withSpan('FileExtractor.extract'))
})

/** Node `FileExtractor` layer with custom limits or SheetJS loader. Invalid limits are defects. */
export const makeFileExtractorLayer = (options: FileExtractorOptions = {}) =>
  Layer.effect(
    FileExtractor,
    Schema.decodeUnknownEffect(FileExtractorLimits)({
      ...defaultFileExtractorLimits,
      ...options.limits
    }).pipe(
      Effect.orDie,
      Effect.map(limits => FileExtractor.of(makeFileExtractor(limits, options.loadSheetJs)))
    )
  )

/** Node `FileExtractor` layer with the default limits and lazy SheetJS loading. */
export const FileExtractorLayer = makeFileExtractorLayer()
