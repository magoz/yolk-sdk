import { Context, Effect, Layer } from 'effect'
import mammoth from 'mammoth'
import { extractText, getDocumentProxy, getMeta } from 'unpdf'
import * as XLSX from 'xlsx'
import { FileExtractionError, UnsupportedFileFormatError } from './errors'
import { extractPptxText } from './pptx-text'
import { sanitizeExtractedText } from './sanitize'

export type ExtractedFileFormat = 'csv' | 'docx' | 'json' | 'markdown' | 'pdf' | 'pptx' | 'text' | 'xlsx'

export type ExtractedFile = {
  readonly content: string
  readonly metadata: {
    readonly format: ExtractedFileFormat
    readonly title?: string
    readonly pageCount?: number
    readonly sheetNames?: ReadonlyArray<string>
  }
}

type FileInput = {
  readonly filename: string
  readonly mediaType: string
  readonly bytes: Uint8Array
}

const extensionFor = (filename: string) => {
  const lower = filename.toLowerCase()
  const dotIndex = lower.lastIndexOf('.')
  return dotIndex === -1 ? '' : lower.slice(dotIndex + 1)
}

const formatFor = (input: { readonly filename: string; readonly mediaType: string }) => {
  const extension = extensionFor(input.filename)
  switch (extension) {
    case 'txt':
      return 'text'
    case 'md':
    case 'markdown':
      return 'markdown'
    case 'csv':
      return 'csv'
    case 'json':
      return 'json'
    case 'pdf':
      return 'pdf'
    case 'docx':
      return 'docx'
    case 'xlsx':
      return 'xlsx'
    case 'pptx':
      return 'pptx'
    default:
      break
  }

  switch (input.mediaType) {
    case 'application/pdf':
      return 'pdf'
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return 'docx'
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
      return 'xlsx'
    case 'application/vnd.openxmlformats-officedocument.presentationml.presentation':
      return 'pptx'
    case 'application/json':
      return 'json'
    case 'text/csv':
      return 'csv'
    case 'text/markdown':
      return 'markdown'
    default:
      return input.mediaType.startsWith('text/') ? 'text' : undefined
  }
}

const toArrayBuffer = (bytes: Uint8Array) => {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

const titleFromUnknown = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

const makeExtractedFile = (content: string, metadata: ExtractedFile['metadata']) => {
  const sanitized = sanitizeExtractedText(content)
  if (sanitized.length === 0) {
    return Effect.fail(
      new FileExtractionError({ message: 'Extracted file content is empty', format: metadata.format })
    )
  }

  return Effect.succeed({ content: sanitized, metadata })
}

const decodeText = (bytes: Uint8Array) => new TextDecoder('utf-8', { fatal: false }).decode(bytes)

const extractPdf = (input: FileInput, format: ExtractedFileFormat) =>
  Effect.gen(function* () {
    const document = yield* Effect.tryPromise({
      try: () => getDocumentProxy(input.bytes),
      catch: cause => new FileExtractionError({ message: 'Could not read PDF', format, cause })
    })
    const extracted = yield* Effect.tryPromise({
      try: () => extractText(document, { mergePages: true }),
      catch: cause => new FileExtractionError({ message: 'Could not extract PDF text', format, cause })
    })
    const meta = yield* Effect.tryPromise({
      try: () => getMeta(document),
      catch: cause => new FileExtractionError({ message: 'Could not read PDF metadata', format, cause })
    }).pipe(Effect.option)
    yield* Effect.promise(() => document.destroy())

    return yield* makeExtractedFile(extracted.text, {
      format,
      title: titleFromUnknown(meta._tag === 'Some' ? meta.value.info.Title : undefined),
      pageCount: extracted.totalPages
    })
  })

const extractDocx = (input: FileInput, format: ExtractedFileFormat) =>
  Effect.gen(function* () {
    const result = yield* Effect.tryPromise({
      try: () => mammoth.extractRawText({ buffer: Buffer.from(toArrayBuffer(input.bytes)) }),
      catch: cause => new FileExtractionError({ message: 'Could not extract DOCX text', format, cause })
    })

    return yield* makeExtractedFile(result.value, { format, title: input.filename })
  })

const extractXlsx = (input: FileInput, format: ExtractedFileFormat) =>
  Effect.gen(function* () {
    const workbook = yield* Effect.try({
      try: () => XLSX.read(input.bytes, { type: 'array' }),
      catch: cause => new FileExtractionError({ message: 'Could not read XLSX', format, cause })
    })
    const sheets = workbook.SheetNames.flatMap(sheetName => {
      const sheet = workbook.Sheets[sheetName]
      if (sheet === undefined) {
        return []
      }
      return [`# ${sheetName}\n${XLSX.utils.sheet_to_csv(sheet).trim()}`]
    })

    return yield* makeExtractedFile(sheets.join('\n\n'), {
      format,
      title: workbook.Props?.Title ?? input.filename,
      sheetNames: workbook.SheetNames
    })
  })

const extractPptx = (input: FileInput, format: ExtractedFileFormat) =>
  Effect.gen(function* () {
    const text = yield* Effect.try({
      try: () => extractPptxText(input.bytes),
      catch: cause => new FileExtractionError({ message: 'Could not extract PPTX text', format, cause })
    })

    return yield* makeExtractedFile(text, { format, title: input.filename })
  })

export class FileExtractor extends Context.Service<FileExtractor>()('@app/FileExtractor', {
  make: Effect.succeed({
    extract: (input: FileInput) =>
      Effect.gen(function* () {
        const format = formatFor(input)
        if (format === undefined) {
          return yield* Effect.fail(
            new UnsupportedFileFormatError({ filename: input.filename, mediaType: input.mediaType })
          )
        }

        yield* Effect.annotateCurrentSpan({
          'file_extractor.format': format,
          'file_extractor.file_size': input.bytes.byteLength
        })

        switch (format) {
          case 'pdf':
            return yield* extractPdf(input, format)
          case 'docx':
            return yield* extractDocx(input, format)
          case 'xlsx':
            return yield* extractXlsx(input, format)
          case 'pptx':
            return yield* extractPptx(input, format)
          case 'csv':
          case 'json':
          case 'markdown':
          case 'text':
            return yield* makeExtractedFile(decodeText(input.bytes), { format, title: input.filename })
        }
      }).pipe(Effect.withSpan('FileExtractor.extract'))
  })
}) {
  static layer = Layer.effect(this, this.make)
}
