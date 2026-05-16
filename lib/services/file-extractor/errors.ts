import { Data } from 'effect'

export class FileExtractionError extends Data.TaggedError('FileExtractionError')<{
  readonly message: string
  readonly format: string
  readonly cause?: unknown
}> {}

export class UnsupportedFileFormatError extends Data.TaggedError('UnsupportedFileFormatError')<{
  readonly filename: string
  readonly mediaType: string
}> {
  get message(): string {
    return `Unsupported file format: ${this.filename}`
  }
}
