import { Data } from 'effect'

export class AppRagStoreError extends Data.TaggedError('AppRagStoreError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export class AppRagDocumentNotFoundError extends Data.TaggedError('AppRagDocumentNotFoundError')<{
  readonly message: string
  readonly documentId: string
}> {}

export class AppRagSetNotFoundError extends Data.TaggedError('AppRagSetNotFoundError')<{
  readonly message: string
  readonly ragSetId: string
}> {}

export class AppRagExtractorError extends Data.TaggedError('AppRagExtractorError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export class AppRagEmbedderError extends Data.TaggedError('AppRagEmbedderError')<{
  readonly message: string
  readonly isTransient?: true
  readonly cause?: unknown
}> {}
