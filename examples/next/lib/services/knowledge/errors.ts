import * as Schema from 'effect/Schema'

export class AppKnowledgeError extends Schema.TaggedError<AppKnowledgeError>()(
  'AppKnowledgeError',
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown)
  }
) {}
