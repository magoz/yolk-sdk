import * as Schema from 'effect/Schema'

export class OpenAiCodexOAuthError extends Schema.TaggedErrorClass<OpenAiCodexOAuthError>()(
  'OpenAiCodexOAuthError',
  {
    message: Schema.String,
    status: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Unknown)
  }
) {}

export class OpenAiCodexAuthNotFoundError extends Schema.TaggedErrorClass<OpenAiCodexAuthNotFoundError>()(
  'OpenAiCodexAuthNotFoundError',
  {
    message: Schema.String
  }
) {}

export class OpenAiCodexAuthInvalidError extends Schema.TaggedErrorClass<OpenAiCodexAuthInvalidError>()(
  'OpenAiCodexAuthInvalidError',
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown)
  }
) {}
