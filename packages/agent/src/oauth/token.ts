import * as Schema from 'effect/Schema'

export class OAuthAccessToken extends Schema.Class<OAuthAccessToken>('OAuthAccessToken')({
  provider: Schema.String,
  accessToken: Schema.String,
  expiresAt: Schema.Number,
  accountId: Schema.optional(Schema.String)
}) {}

export class TokenBrokerRequest extends Schema.Class<TokenBrokerRequest>('TokenBrokerRequest')({
  provider: Schema.String,
  subjectId: Schema.String,
  minTtlSeconds: Schema.optional(Schema.Number),
  forceRefresh: Schema.optional(Schema.Boolean)
}) {}

export class TokenBrokerResponse extends Schema.Class<TokenBrokerResponse>('TokenBrokerResponse')({
  provider: Schema.String,
  accessToken: Schema.String,
  expiresAt: Schema.Number,
  accountId: Schema.optional(Schema.String)
}) {}

export const tokenRemainingTtlMs = (token: OAuthAccessToken, nowMs: number) =>
  Math.max(0, token.expiresAt - nowMs)

export const isTokenFresh = (token: OAuthAccessToken, nowMs: number, minTtlMs: number) =>
  tokenRemainingTtlMs(token, nowMs) >= minTtlMs

export const shouldRefreshToken = (token: OAuthAccessToken, nowMs: number, minTtlMs: number) =>
  !isTokenFresh(token, nowMs, minTtlMs)
