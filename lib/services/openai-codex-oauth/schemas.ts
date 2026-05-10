import * as Schema from 'effect/Schema'

export const OpenAiCodexOAuthTokenSchema = Schema.Struct({
  type: Schema.Literal('oauth'),
  refresh: Schema.String,
  access: Schema.String,
  expires: Schema.Number,
  accountId: Schema.optional(Schema.String)
})

export type OpenAiCodexOAuthToken = typeof OpenAiCodexOAuthTokenSchema.Type

export const OpenAiCodexTokenResponseSchema = Schema.Struct({
  id_token: Schema.String,
  access_token: Schema.String,
  refresh_token: Schema.String,
  expires_in: Schema.optional(Schema.Number)
})

export type OpenAiCodexTokenResponse = typeof OpenAiCodexTokenResponseSchema.Type

export const OpenAiCodexDeviceAuthUserCodeResponseSchema = Schema.Struct({
  device_auth_id: Schema.String,
  user_code: Schema.String,
  interval: Schema.String
})

export type OpenAiCodexDeviceAuthUserCodeResponse =
  typeof OpenAiCodexDeviceAuthUserCodeResponseSchema.Type

export const OpenAiCodexDeviceAuthTokenResponseSchema = Schema.Struct({
  authorization_code: Schema.String,
  code_verifier: Schema.String
})

export type OpenAiCodexDeviceAuthTokenResponse =
  typeof OpenAiCodexDeviceAuthTokenResponseSchema.Type
