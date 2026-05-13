import * as Schema from 'effect/Schema'

export const OAuthErrorCause = Schema.Literals([
  'broker_error',
  'credential_missing',
  'credential_invalid',
  'refresh_failed',
  'unauthorized'
])
export type OAuthErrorCause = typeof OAuthErrorCause.Type

export class OAuthError extends Schema.TaggedErrorClass<OAuthError>()('OAuthError', {
  cause: OAuthErrorCause,
  message: Schema.String,
  status: Schema.optional(Schema.Number),
  underlying: Schema.optional(Schema.Unknown)
}) {}
