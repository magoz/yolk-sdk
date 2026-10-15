import * as Schema from 'effect/Schema'

/** `file_` and an opaque, host-store-issued id (ADR 0009). */
export const fileIdPattern = /^file_[A-Za-z0-9_-]{1,128}$/u

export const FileId = Schema.String.check(Schema.isPattern(fileIdPattern)).pipe(
  Schema.annotate({ description: 'A file id (`file_…`) returned by a tool that yielded a file.' })
)

export type FileId = typeof FileId.Type

export const isFileId = (value: string) => fileIdPattern.test(value)

/** What the model and scripts see of a captured file: never its bytes. */
export class FileDescriptor extends Schema.Class<FileDescriptor>('FileDescriptor')({
  fileId: FileId,
  name: Schema.String,
  mimeType: Schema.String,
  size: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
}) {}

const byteUnits = ['B', 'KB', 'MB', 'GB'] as const

export const formatFileSize = (size: number) => {
  let value = size
  let unit = 0

  while (value >= 1024 && unit < byteUnits.length - 1) {
    value /= 1024
    unit += 1
  }

  return unit === 0 ? `${size} B` : `${value.toFixed(value >= 10 ? 0 : 1)} ${byteUnits[unit]}`
}

/** The model-visible line for a captured file. */
export const fileLabel = (file: {
  readonly fileId: string
  readonly name: string
  readonly mimeType: string
  readonly size?: number
}) =>
  file.size === undefined
    ? `[file ${file.fileId}: ${file.name}, ${file.mimeType}]`
    : `[file ${file.fileId}: ${file.name}, ${file.mimeType}, ${formatFileSize(file.size)}]`

/** The model-visible line for bytes that were not stored, so no base64 reaches the model. */
export const fileNotCapturedLabel = (input: {
  readonly name: string
  readonly mimeType: string
  readonly reason: string
}) => `[file not captured (${input.reason}): ${input.name}, ${input.mimeType}]`
