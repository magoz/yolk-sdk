// Runtime-portable root: types, errors, format detection, limits, and the service tag. Parsers
// live behind `@yolk-sdk/extractors/node`.

export {
  FileExtractionError,
  minimumSheetJsVersion,
  OfficeArchiveError,
  SheetJsUnavailableError,
  sheetJsInstallCommand,
  UnsupportedFileFormatError
} from './errors.ts'

export type { FileExtractorError } from './errors.ts'

export { extractedFileFormats, fileFormatFor, isOfficeFileFormat } from './format.ts'

export type {
  ExtractedFile,
  ExtractedFileFormat,
  ExtractedFileMetadata,
  FileInput,
  OfficeFileFormat
} from './format.ts'

export { defaultFileExtractorLimits, FileExtractorLimits } from './limits.ts'

export { sanitizeExtractedText } from './sanitize.ts'

export { FileExtractor } from './service.ts'

export type { FileExtractorApi } from './service.ts'
