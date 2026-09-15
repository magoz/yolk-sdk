import * as Schema from 'effect/Schema'

export class AppSearchIndexStoreError extends Schema.TaggedError<AppSearchIndexStoreError>()(
  'AppSearchIndexStoreError',
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown)
  }
) {}

export class AppKnowledgeDocumentNotFoundError extends Schema.TaggedError<AppKnowledgeDocumentNotFoundError>()(
  'AppKnowledgeDocumentNotFoundError',
  {
    message: Schema.String,
    documentId: Schema.String
  }
) {}

export class AppKnowledgeCollectionNotFoundError extends Schema.TaggedError<AppKnowledgeCollectionNotFoundError>()(
  'AppKnowledgeCollectionNotFoundError',
  {
    message: Schema.String,
    collectionId: Schema.String
  }
) {}

export class AppKnowledgeSearchError extends Schema.TaggedError<AppKnowledgeSearchError>()(
  'AppKnowledgeSearchError',
  {
    message: Schema.String,
    stage: Schema.Literals(['store', 'embed']),
    cause: Schema.optional(Schema.Unknown)
  }
) {}

export class AppKnowledgeExtractorError extends Schema.TaggedError<AppKnowledgeExtractorError>()(
  'AppKnowledgeExtractorError',
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown)
  }
) {}

export class AppKnowledgeEmbedderError extends Schema.TaggedError<AppKnowledgeEmbedderError>()(
  'AppKnowledgeEmbedderError',
  {
    message: Schema.String,
    isTransient: Schema.optional(Schema.Literal(true)),
    cause: Schema.optional(Schema.Unknown)
  }
) {}

export class AppKnowledgeSummarizerError extends Schema.TaggedError<AppKnowledgeSummarizerError>()(
  'AppKnowledgeSummarizerError',
  {
    message: Schema.String,
    isTransient: Schema.optional(Schema.Literal(true)),
    cause: Schema.optional(Schema.Unknown)
  }
) {}

export const isAppSearchIndexStoreError = Schema.is(AppSearchIndexStoreError)

export const isAppKnowledgeDocumentNotFoundError = Schema.is(AppKnowledgeDocumentNotFoundError)

export const isAppKnowledgeCollectionNotFoundError = Schema.is(AppKnowledgeCollectionNotFoundError)

export const isAppKnowledgeSearchError = Schema.is(AppKnowledgeSearchError)

export const isAppKnowledgeSummarizerError = Schema.is(AppKnowledgeSummarizerError)
