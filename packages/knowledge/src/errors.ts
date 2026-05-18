import * as Schema from 'effect/Schema'

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
