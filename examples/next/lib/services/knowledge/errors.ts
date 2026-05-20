import * as Schema from 'effect/Schema'

export class AppKnowledgeError extends Schema.TaggedErrorClass<AppKnowledgeError>()(
  'AppKnowledgeError',
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown)
  }
) {}
