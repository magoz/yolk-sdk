import { Buffer } from 'node:buffer'
import { Effect, Option, Predicate } from 'effect'
import { FileExtractionError } from '../errors.ts'
import type { FileExtractorError } from '../errors.ts'
import type {
  ExtractedFile,
  ExtractedFileFormat,
  ExtractedFileMetadata,
  FileInput,
  OfficeFileFormat
} from '../format.ts'
import type { FileExtractorLimits } from '../limits.ts'
import { sanitizeExtractedText } from '../sanitize.ts'
import { readOfficeArchive, storedArchive } from './office-archive.ts'
import type { NormalizedOfficeArchive } from './office-archive.ts'
import { extractPptxText } from './pptx-text.ts'
import { asXlsxWorkbook, loadSheetJs } from './sheetjs.ts'
import type { SheetJsLoader } from './sheetjs.ts'
import { resolveXlsxHyperlinks } from './xlsx-hyperlinks.ts'
import { buildSheetJsInput } from './xlsx-sheetjs-input.ts'
import { extractBoundedXlsxText } from './xlsx-text.ts'

/** Formats whose bytes go through a parser (and, by default, an isolated worker). */
export type ParsedFileFormat = 'pdf' | OfficeFileFormat

export const isParsedFileFormat = (format: ExtractedFileFormat): format is ParsedFileFormat =>
  format === 'pdf' || format === 'docx' || format === 'pptx' || format === 'xlsx'

/** Sanitize extracted text; empty results fail. */
export const makeExtractedFile = (content: string, metadata: ExtractedFileMetadata) => {
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

/**
 * PDF.js 6 releases a document through its loading task (`PDFDocumentProxy` no longer has
 * `destroy()`); unpdf releases the documents it opens the same way.
 */
type PdfDocumentResource = {
  readonly loadingTask: { readonly destroy: () => Promise<void> }
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
          try: () => document.loadingTask.destroy(),
          catch: () => new FileExtractionError({ message: 'Could not release PDF parser', format })
        }).pipe(Effect.ignore)
      )

      return yield* use(document)
    })
  )

const extractPdf = (input: FileInput) =>
  Effect.gen(function* () {
    // Loaded on first use, so a worker extracting another format never loads PDF.js.
    const { extractText, getDocumentProxy, getMeta } = yield* Effect.tryPromise({
      try: () => import('unpdf'),
      catch: cause =>
        new FileExtractionError({ message: 'Could not read PDF', format: 'pdf', cause })
    })

    return yield* withAcquiredPdfDocument(
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
              new FileExtractionError({
                message: 'Could not extract PDF text',
                format: 'pdf',
                cause
              })
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
  })

const validatedArchive = (
  input: FileInput,
  format: OfficeFileFormat,
  limits: FileExtractorLimits
): Effect.Effect<NormalizedOfficeArchive, FileExtractionError> =>
  readOfficeArchive(
    input.bytes,
    format,
    limits,
    // One extra tag detects a workbook over the cap.
    format === 'xlsx' ? { maxHyperlinkTags: limits.maxXlsxHyperlinks + 1 } : {}
  ).pipe(
    Effect.mapError(
      error => new FileExtractionError({ message: error.message, format, cause: error })
    )
  )

const extractDocx = (input: FileInput, limits: FileExtractorLimits) =>
  Effect.gen(function* () {
    const { parts } = yield* validatedArchive(input, 'docx', limits)

    const result = yield* Effect.tryPromise({
      try: async () => {
        const { default: mammoth } = await import('mammoth')

        return await mammoth.extractRawText({ buffer: Buffer.from(storedArchive(parts)) })
      },
      catch: cause =>
        new FileExtractionError({ message: 'Could not extract DOCX text', format: 'docx', cause })
    })

    return yield* makeExtractedFile(result.value, { format: 'docx', title: input.filename })
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

const extractXlsx = (input: FileInput, limits: FileExtractorLimits, loader: SheetJsLoader) =>
  Effect.gen(function* () {
    const normalized = yield* validatedArchive(input, 'xlsx', limits)

    // SheetJS never sees the uploaded archive: only this allowlisted rebuild of its parts.
    const sheetJsInput = yield* Effect.try({
      try: () => buildSheetJsInput(normalized.parts, limits.maxXlsxSheets),
      catch: cause =>
        cause instanceof FileExtractionError
          ? cause
          : new FileExtractionError({ message: 'Could not read XLSX', format: 'xlsx', cause })
    })

    const sheetJs = yield* loadSheetJs(loader)

    const parsed = yield* Effect.try({
      try: () => sheetJs.read(sheetJsInput.archive),
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
        : normalized.hyperlinkTags,
      sheetJsInput.sheets
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
      title: sheetJsInput.title ?? input.filename,
      sheetNames: workbook.SheetNames
    })
  })

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

/**
 * Extract a PDF, DOCX, XLSX, or PPTX file in the current thread. The Node layer runs this inside
 * an isolated worker unless `isolation: 'none'` is configured.
 */
export const extractParsedFile = (
  input: FileInput,
  format: ParsedFileFormat,
  limits: FileExtractorLimits,
  loader: SheetJsLoader
): Effect.Effect<ExtractedFile, FileExtractorError> => {
  if (format === 'pdf') return extractPdf(input)

  if (format === 'docx') return extractDocx(input, limits)

  if (format === 'xlsx') return extractXlsx(input, limits, loader)

  return extractPptx(input, limits)
}
