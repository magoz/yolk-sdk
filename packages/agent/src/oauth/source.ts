import type { Effect } from 'effect'
import type { OAuthError } from './error.ts'
import { TokenBrokerRequest } from './token.ts'
import type { OAuthAccessToken } from './token.ts'

export type OAuthCredentialRequest = {
  readonly minTtlSeconds?: number
  readonly forceRefresh?: boolean
}

export type OAuthCredentialSource = {
  readonly getAccessToken: (
    request: OAuthCredentialRequest
  ) => Effect.Effect<OAuthAccessToken, OAuthError>
}

export type TokenBrokerClient = {
  readonly getAccessToken: (
    request: TokenBrokerRequest
  ) => Effect.Effect<OAuthAccessToken, OAuthError>
}

export const credentialSourceFromBroker = (
  broker: TokenBrokerClient,
  request: Omit<TokenBrokerRequest, 'minTtlSeconds' | 'forceRefresh'>
): OAuthCredentialSource => ({
  getAccessToken: input =>
    broker.getAccessToken(
      new TokenBrokerRequest({
        provider: request.provider,
        subjectId: request.subjectId,
        minTtlSeconds: input.minTtlSeconds,
        forceRefresh: input.forceRefresh
      })
    )
})
