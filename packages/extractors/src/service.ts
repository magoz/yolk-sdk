import { Context } from 'effect'
import type { Effect } from 'effect'
import type { FileExtractorError } from './errors.ts'
import type { ExtractedFile, FileInput } from './format.ts'

export type FileExtractorApi = {
  /**
   * Extract sanitized text from one file. Fails with `UnsupportedFileFormatError` for unknown
   * formats, `FileExtractionError` for unreadable, oversized, or empty files, and
   * `SheetJsUnavailableError` when an XLSX file arrives but SheetJS 0.20.3+ is not installed.
   */
  readonly extract: (input: FileInput) => Effect.Effect<ExtractedFile, FileExtractorError>
}

/**
 * The file extractor service. The tag is runtime-portable; the Node implementation lives in
 * `@yolk-sdk/extractors/node`.
 */
export class FileExtractor extends Context.Service<FileExtractor, FileExtractorApi>()(
  '@yolk-sdk/extractors/FileExtractor'
) {}
