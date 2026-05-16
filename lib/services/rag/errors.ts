import { Data } from 'effect'

export class AppRagStoreError extends Data.TaggedError('AppRagStoreError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export class AppRagExtractorError extends Data.TaggedError('AppRagExtractorError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export class AppRagEmbedderError extends Data.TaggedError('AppRagEmbedderError')<{
  readonly message: string
  readonly cause?: unknown
}> {}
