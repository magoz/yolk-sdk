import * as Schema from 'effect/Schema'

export class AppRagStoreError extends Schema.TaggedErrorClass<AppRagStoreError>()(
  'AppRagStoreError',
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown)
  }
) {}

export class AppRagDocumentNotFoundError extends Schema.TaggedErrorClass<AppRagDocumentNotFoundError>()(
  'AppRagDocumentNotFoundError',
  {
    message: Schema.String,
    documentId: Schema.String
  }
) {}

export class AppRagSetNotFoundError extends Schema.TaggedErrorClass<AppRagSetNotFoundError>()(
  'AppRagSetNotFoundError',
  {
    message: Schema.String,
    ragSetId: Schema.String
  }
) {}

export class AppRagSearchError extends Schema.TaggedErrorClass<AppRagSearchError>()(
  'AppRagSearchError',
  {
    message: Schema.String,
    stage: Schema.Literals(['store', 'embed']),
    cause: Schema.optional(Schema.Unknown)
  }
) {}

export class AppRagExtractorError extends Schema.TaggedErrorClass<AppRagExtractorError>()(
  'AppRagExtractorError',
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown)
  }
) {}

export class AppRagEmbedderError extends Schema.TaggedErrorClass<AppRagEmbedderError>()(
  'AppRagEmbedderError',
  {
    message: Schema.String,
    isTransient: Schema.optional(Schema.Literal(true)),
    cause: Schema.optional(Schema.Unknown)
  }
) {}

export const isAppRagStoreError = Schema.is(AppRagStoreError)
export const isAppRagDocumentNotFoundError = Schema.is(AppRagDocumentNotFoundError)
export const isAppRagSetNotFoundError = Schema.is(AppRagSetNotFoundError)
export const isAppRagSearchError = Schema.is(AppRagSearchError)
