import * as Predicate from 'effect/Predicate'
import * as Schema from 'effect/Schema'

const ownClaim = (key: string) =>
  Schema.Unknown.check(
    Schema.makeFilter(input => {
      if (!Predicate.isObjectOrArray(input)) return false

      const descriptor = Object.getOwnPropertyDescriptor(input, key)

      return descriptor !== undefined && Object.hasOwn(descriptor, 'value')
    })
  )

// Guard before Struct decoding: claim accessors and inherited fields are not claims.
// Separate partial claims keep extraction best-effort and precedence-driven.
export const OpenAiCodexAccountIdClaimSchema = ownClaim('chatgpt_account_id').pipe(
  Schema.decodeTo(Schema.Struct({ chatgpt_account_id: Schema.String }))
)

export const OpenAiCodexAuthClaimSchema = ownClaim('https://api.openai.com/auth').pipe(
  Schema.decodeTo(Schema.Struct({ 'https://api.openai.com/auth': OpenAiCodexAccountIdClaimSchema }))
)

export const OpenAiCodexOrganizationsClaimSchema = ownClaim('organizations').pipe(
  Schema.decodeTo(Schema.Struct({ organizations: Schema.Array(Schema.Unknown) }))
)

export const OpenAiCodexOrganizationIdClaimSchema = ownClaim('id').pipe(
  Schema.decodeTo(Schema.Struct({ id: Schema.String }))
)

export const OpenAiCodexOAuthTokenSchema = Schema.Struct({
  type: Schema.Literal('oauth'),
  refresh: Schema.String,
  access: Schema.String,
  expires: Schema.Number,
  accountId: Schema.optional(Schema.String)
})

export type OpenAiCodexOAuthToken = typeof OpenAiCodexOAuthTokenSchema.Type

export const OpenAiCodexTokenResponseSchema = Schema.Struct({
  id_token: Schema.optional(Schema.String),
  access_token: Schema.String,
  refresh_token: Schema.optional(Schema.String),
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

export type OpenAiCodexJsonRequestBody =
  | { readonly client_id: string }
  | { readonly device_auth_id: string; readonly user_code: string }
