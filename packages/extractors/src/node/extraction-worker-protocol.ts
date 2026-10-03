import { Match, Option } from 'effect'
import * as Schema from 'effect/Schema'
import { FileExtractionError, OfficeArchiveError, SheetJsUnavailableError } from '../errors.ts'
import type { FileExtractorError } from '../errors.ts'
import { extractedFileFormats } from '../format.ts'
import { FileExtractorLimits } from '../limits.ts'

/**
 * Messages between the Node layer and `extraction-worker.ts`. Both sides encode and decode with
 * these schemas; only plain data crosses the thread boundary (no parser objects).
 */

export const ParsedFileFormat = Schema.Literals(['pdf', 'docx', 'pptx', 'xlsx'])

/** `workerData`: the input bytes arrive in a transferred buffer. */
export const ExtractionWorkerRequest = Schema.Struct({
  filename: Schema.String,
  mediaType: Schema.String,
  bytes: Schema.Uint8Array,
  format: ParsedFileFormat,
  limits: FileExtractorLimits
})

export type ExtractionWorkerRequest = typeof ExtractionWorkerRequest.Type

const ExtractedFileMessage = Schema.Struct({
  content: Schema.String,
  metadata: Schema.Struct({
    format: Schema.Literals(extractedFileFormats),
    title: Schema.optional(Schema.String),
    pageCount: Schema.optional(Schema.Number),
    sheetNames: Schema.optional(Schema.Array(Schema.String))
  })
})

/** Posted once the worker's modules have loaded. */
export class WorkerStarted extends Schema.TaggedClass<WorkerStarted>()('WorkerStarted', {}) {}

export class WorkerSucceeded extends Schema.TaggedClass<WorkerSucceeded>()('WorkerSucceeded', {
  file: ExtractedFileMessage
}) {}

export class WorkerFailed extends Schema.TaggedClass<WorkerFailed>()('WorkerFailed', {
  error: Schema.Union([FileExtractionError, SheetJsUnavailableError])
}) {}

/** An unexpected defect inside the worker (a bug, not a property of the file). */
export class WorkerDefect extends Schema.TaggedClass<WorkerDefect>()('WorkerDefect', {
  message: Schema.String
}) {}

export const ExtractionWorkerMessage = Schema.Union([
  WorkerStarted,
  WorkerSucceeded,
  WorkerFailed,
  WorkerDefect
])

export const decodeWorkerMessage = Schema.decodeUnknownOption(ExtractionWorkerMessage)

/** A cause as it crosses the thread boundary: its name, message, and archive size, if any. */
const PortableCause = Schema.Struct({
  name: Schema.String,
  message: Schema.String,
  expandedBytes: Schema.optional(Schema.Number)
})

const archiveErrorName = 'OfficeArchiveError'

const portableCause = (cause: unknown): typeof PortableCause.Type | undefined => {
  if (cause instanceof OfficeArchiveError)
    return { name: archiveErrorName, message: cause.message, expandedBytes: cause.expandedBytes }

  return cause instanceof Error ? { name: cause.name, message: cause.message } : undefined
}

/** The worker's reply for a failed extraction. */
export const failureMessage = (error: FileExtractorError): WorkerFailed | WorkerDefect =>
  Match.valueTags(error, {
    FileExtractionError: failure =>
      WorkerFailed.make({
        error: new FileExtractionError({
          message: failure.message,
          format: failure.format,
          reason: failure.reason,
          cause: portableCause(failure.cause)
        })
      }),
    SheetJsUnavailableError: failure =>
      WorkerFailed.make({
        error: new SheetJsUnavailableError({
          reason: failure.reason,
          installedVersion: failure.installedVersion,
          cause: portableCause(failure.cause)
        })
      }),
    UnsupportedFileFormatError: () =>
      WorkerDefect.make({ message: 'The worker received an unsupported format' })
  })

/** Turn a portable archive cause back into an `OfficeArchiveError`; other causes stay as sent. */
const revivedCause = (cause: unknown) =>
  Option.match(Schema.decodeUnknownOption(PortableCause)(cause), {
    onNone: () => cause,
    onSome: portable =>
      portable.name === archiveErrorName
        ? new OfficeArchiveError({
            message: portable.message,
            expandedBytes: portable.expandedBytes
          })
        : portable
  })

/** The error a worker reported, with its archive cause revived. */
export const revivedError = (error: WorkerFailed['error']) =>
  Match.valueTags(error, {
    FileExtractionError: failure =>
      new FileExtractionError({
        message: failure.message,
        format: failure.format,
        reason: failure.reason,
        cause: revivedCause(failure.cause)
      }),
    SheetJsUnavailableError: failure =>
      new SheetJsUnavailableError({
        reason: failure.reason,
        installedVersion: failure.installedVersion,
        cause: revivedCause(failure.cause)
      })
  })
