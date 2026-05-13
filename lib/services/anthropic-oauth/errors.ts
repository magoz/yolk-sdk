import * as Schema from 'effect/Schema'

export class AnthropicClaudeOAuthError extends Schema.TaggedErrorClass<AnthropicClaudeOAuthError>()(
  'AnthropicClaudeOAuthError',
  {
    message: Schema.String,
    status: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Unknown)
  }
) {}

export class AnthropicClaudeAuthNotFoundError extends Schema.TaggedErrorClass<AnthropicClaudeAuthNotFoundError>()(
  'AnthropicClaudeAuthNotFoundError',
  {
    message: Schema.String
  }
) {}

export class AnthropicClaudeAuthInvalidError extends Schema.TaggedErrorClass<AnthropicClaudeAuthInvalidError>()(
  'AnthropicClaudeAuthInvalidError',
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown)
  }
) {}
