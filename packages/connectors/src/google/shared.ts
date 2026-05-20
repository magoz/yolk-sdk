import { Effect } from 'effect'
import { resolveCredential } from '../credential.ts'
import { ConnectorError } from '../error.ts'
import { ActionResult, ProviderFailure } from '../result.ts'
import type { ConnectorIntegration } from '../integration.ts'
import { GoogleOAuthCredentialSlot } from './oauth.ts'

export const resolveGoogleAccessToken = (integration: ConnectorIntegration) =>
  Effect.gen(function* () {
    const credential = yield* resolveCredential(integration, GoogleOAuthCredentialSlot)

    switch (credential._tag) {
      case 'OAuthCredential':
        return credential.accessToken
      case 'BearerTokenCredential':
        return credential.token
      case 'ApiKeyCredential':
        return yield* Effect.fail(
          new ConnectorError({
            cause: 'credential_invalid',
            message: 'Google connector requires an OAuth or bearer token credential',
            connectorId: integration.connectorId,
            slotId: GoogleOAuthCredentialSlot.id
          })
        )
    }
  })

export const providerFailureFromResponse = (input: {
  readonly code: string
  readonly message: string
  readonly status: number
  readonly body: string
}) =>
  ActionResult.failure(
    new ProviderFailure({
      code: input.code,
      message: input.message,
      status: input.status,
      underlying: input.body
    })
  )

export const isSuccessStatus = (status: number) => status >= 200 && status < 300

export const appendSearchParam = (params: URLSearchParams, key: string, value: string | undefined) => {
  if (value !== undefined && value.trim() !== '') {
    params.set(key, value)
  }
}

export const appendNumberSearchParam = (params: URLSearchParams, key: string, value: number | undefined) => {
  if (value !== undefined) {
    params.set(key, String(value))
  }
}
