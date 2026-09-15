import * as Schema from 'effect/Schema'

export class OpenAiCodexOAuthError extends Schema.TaggedError<OpenAiCodexOAuthError>()(
  'OpenAiCodexOAuthError',
  {
    message: Schema.String,
    status: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Unknown)
  }
) {}

export class OpenAiCodexAuthNotFoundError extends Schema.TaggedError<OpenAiCodexAuthNotFoundError>()(
  'OpenAiCodexAuthNotFoundError',
  {
    message: Schema.String
  }
) {}

export class OpenAiCodexAuthInvalidError extends Schema.TaggedError<OpenAiCodexAuthInvalidError>()(
  'OpenAiCodexAuthInvalidError',
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown)
  }
) {}
