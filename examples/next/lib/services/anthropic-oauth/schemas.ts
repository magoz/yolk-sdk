import * as Schema from 'effect/Schema'

export const AnthropicClaudeOAuthTokenSchema = Schema.Struct({
  type: Schema.Literal('oauth'),
  refresh: Schema.String,
  access: Schema.String,
  expires: Schema.Number
})

export type AnthropicClaudeOAuthToken = typeof AnthropicClaudeOAuthTokenSchema.Type

export const AnthropicClaudeTokenResponseSchema = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Number)
})

export type AnthropicClaudeTokenResponse = typeof AnthropicClaudeTokenResponseSchema.Type
