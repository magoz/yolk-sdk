import * as Schema from 'effect/Schema'

export class AnthropicClaudeOAuthError extends Schema.TaggedError<AnthropicClaudeOAuthError>()(
  'AnthropicClaudeOAuthError',
  {
    message: Schema.String,
    status: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Unknown)
  }
) {}

export class AnthropicClaudeAuthNotFoundError extends Schema.TaggedError<AnthropicClaudeAuthNotFoundError>()(
  'AnthropicClaudeAuthNotFoundError',
  {
    message: Schema.String
  }
) {}

export class AnthropicClaudeAuthInvalidError extends Schema.TaggedError<AnthropicClaudeAuthInvalidError>()(
  'AnthropicClaudeAuthInvalidError',
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown)
  }
) {}
