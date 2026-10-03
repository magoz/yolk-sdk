import { Match } from 'effect'
import * as Schema from 'effect/Schema'

/** The SheetJS tarball consumers install; npm `xlsx` stops at the vulnerable 0.18.5. */
export const sheetJsInstallCommand = 'pnpm add https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz'

/** Lowest SheetJS release with fixes for CVE-2023-30533 and CVE-2024-22363. */
export const minimumSheetJsVersion = '0.20.3'

/**
 * Why an isolated extraction stopped before the parsers finished:
 *
 * - `resource-limit`: the worker ran out of its V8 heap (`maxOldGenerationSizeMb`, …);
 * - `timeout`: the worker exceeded `timeoutMs` and was terminated;
 * - `worker-unavailable`: the worker could not start (a missing or unloadable worker file);
 * - `worker-failed`: the worker crashed or exited without a result.
 */
export const FileExtractionFailureReason = Schema.Literals([
  'resource-limit',
  'timeout',
  'worker-unavailable',
  'worker-failed'
])

export type FileExtractionFailureReason = typeof FileExtractionFailureReason.Type

/**
 * Reading, validating, or bounding a file failed. `message` is safe to show to users. `reason`
 * is set only when an isolated worker was stopped (see `FileExtractionFailureReason`).
 */
export class FileExtractionError extends Schema.TaggedError<FileExtractionError>()(
  'FileExtractionError',
  {
    message: Schema.String,
    format: Schema.String,
    reason: Schema.optional(FileExtractionFailureReason),
    cause: Schema.optional(Schema.Unknown)
  }
) {}

/** Neither the filename extension nor the media type maps to a supported format. */
export class UnsupportedFileFormatError extends Schema.TaggedError<UnsupportedFileFormatError>()(
  'UnsupportedFileFormatError',
  {
    filename: Schema.String,
    mediaType: Schema.String
  }
) {
  get message(): string {
    return `Unsupported file format: ${this.filename}`
  }
}

/** A DOCX, XLSX, or PPTX ZIP archive failed bounded validation or normalization. */
export class OfficeArchiveError extends Schema.TaggedError<OfficeArchiveError>()(
  'OfficeArchiveError',
  {
    message: Schema.String,
    expandedBytes: Schema.optional(Schema.Number)
  }
) {}

/**
 * SheetJS (`xlsx`, an optional peer) is missing, is not a usable SheetJS module, or is older than
 * 0.20.3. This is host misconfiguration, not a problem with the uploaded file.
 */
export class SheetJsUnavailableError extends Schema.TaggedError<SheetJsUnavailableError>()(
  'SheetJsUnavailableError',
  {
    reason: Schema.Literals(['missing', 'invalid', 'outdated']),
    installedVersion: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Unknown)
  }
) {
  get message(): string {
    const problem = Match.value(this.reason).pipe(
      Match.when('missing', () => 'SheetJS (xlsx) is not installed'),
      Match.when(
        'outdated',
        () => `SheetJS ${this.installedVersion ?? 'unknown'} is older than ${minimumSheetJsVersion}`
      ),
      Match.when('invalid', () => 'The installed xlsx module is not a usable SheetJS build'),
      Match.exhaustive
    )

    return `${problem}. XLSX extraction needs SheetJS ${minimumSheetJsVersion} or newer from the SheetJS CDN (npm xlsx is unmaintained and vulnerable): ${sheetJsInstallCommand}`
  }
}

export type FileExtractorError =
  | FileExtractionError
  | UnsupportedFileFormatError
  | SheetJsUnavailableError
