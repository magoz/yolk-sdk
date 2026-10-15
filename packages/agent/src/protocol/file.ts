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

const mimeTypePattern = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u

/**
 * `type/subtype` of an untrusted MIME type, lower-cased and without parameters; anything that is
 * not one becomes `application/octet-stream`.
 */
export const normalizeFileMimeType = (mimeType: string | null | undefined) => {
  const essence = (mimeType ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? ''

  return mimeTypePattern.test(essence) ? essence : 'application/octet-stream'
}

// Names come from untrusted sources (email, MCP): no control characters or brackets, so a name
// cannot end a label or forge another one.
const labelText = (text: string) => text.replace(/[\u0000-\u001f\u007f[\]]/gu, '_')

/** The model-visible line for a captured file. */
export const fileLabel = (file: {
  readonly fileId: string
  readonly name: string
  readonly mimeType: string
  readonly size?: number
}) => {
  const head = `${file.fileId}: ${labelText(file.name)}, ${labelText(file.mimeType)}`

  return file.size === undefined ? `[file ${head}]` : `[file ${head}, ${formatFileSize(file.size)}]`
}

/** The model-visible line for bytes that were not stored, so no base64 reaches the model. */
export const fileNotCapturedLabel = (input: {
  readonly name: string
  readonly mimeType: string
  readonly reason: string
}) =>
  `[file not captured (${input.reason}): ${labelText(input.name)}, ${labelText(input.mimeType)}]`
