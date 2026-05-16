import { Data } from 'effect'

export class RagStoreError extends Data.TaggedError('RagStoreError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export class RagExtractionError extends Data.TaggedError('RagExtractionError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export class RagChunkingError extends Data.TaggedError('RagChunkingError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export class RagEmbeddingError extends Data.TaggedError('RagEmbeddingError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export class RagSummarizationError extends Data.TaggedError('RagSummarizationError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export class RagIngestionError extends Data.TaggedError('RagIngestionError')<{
  readonly message: string
  readonly stage: 'store' | 'extract' | 'chunk' | 'embed' | 'summarize'
  readonly cause?: unknown
}> {}

export class RagRetrievalError extends Data.TaggedError('RagRetrievalError')<{
  readonly message: string
  readonly stage: 'store' | 'embed'
  readonly cause?: unknown
}> {}
