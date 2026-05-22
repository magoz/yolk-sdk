import { Data } from 'effect'
import * as Schema from 'effect/Schema'

export class SearchIndexStoreError extends Data.TaggedError('SearchIndexStoreError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export class KnowledgeExtractionError extends Data.TaggedError('KnowledgeExtractionError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export class KnowledgeChunkingError extends Data.TaggedError('KnowledgeChunkingError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export class KnowledgeEmbeddingError extends Data.TaggedError('KnowledgeEmbeddingError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export class KnowledgeSummarizationError extends Data.TaggedError('KnowledgeSummarizationError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export class KnowledgeIngestionError extends Data.TaggedError('KnowledgeIngestionError')<{
  readonly message: string
  readonly stage: 'store' | 'extract' | 'chunk' | 'embed' | 'summarize'
  readonly cause?: unknown
}> {}

export class KnowledgeSearchError extends Data.TaggedError('KnowledgeSearchError')<{
  readonly message: string
  readonly stage: 'store' | 'embed'
  readonly cause?: unknown
}> {}

export class KnowledgeStoreError extends Schema.TaggedErrorClass<KnowledgeStoreError>()(
  'KnowledgeStoreError',
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown)
  }
) {}

export class KnowledgeArtifactError extends Schema.TaggedErrorClass<KnowledgeArtifactError>()(
  'KnowledgeArtifactError',
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown)
  }
) {}

export class KnowledgeContextError extends Schema.TaggedErrorClass<KnowledgeContextError>()(
  'KnowledgeContextError',
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown)
  }
) {}
