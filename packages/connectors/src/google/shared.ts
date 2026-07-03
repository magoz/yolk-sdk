import { Effect, Result } from 'effect'
import * as Schema from 'effect/Schema'
import { resolveCredential } from '../credential.ts'
import type { CredentialSlot } from '../credential.ts'
import { ConnectorError } from '../error.ts'
import { ActionResult, ProviderFailure } from '../result.ts'
import type { ConnectorIntegration } from '../integration.ts'
import { GoogleOAuthCredentialSlot } from './oauth.ts'

const JsonObject = Schema.Record(Schema.String, Schema.Unknown)
const isJsonObject = Schema.is(JsonObject)

export const resolveGoogleAccessToken = (
  integration: ConnectorIntegration,
  slot: CredentialSlot = GoogleOAuthCredentialSlot
) =>
  Effect.gen(function* () {
    const credential = yield* resolveCredential(integration, slot)

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
            slotId: slot.id
          })
        )
    }
  })

const decodeJsonObject = (body: string) =>
  Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(body).pipe(
    Effect.result,
    Effect.map(result => {
      if (Result.isFailure(result) || !isJsonObject(result.success)) return undefined
      return result.success
    })
  )

const jsonMessageField = (body: string, keys: ReadonlyArray<string>) =>
  decodeJsonObject(body).pipe(
    Effect.map(parsed => {
      if (parsed === undefined) return undefined
      for (const key of keys) {
        const value = parsed[key]
        if (typeof value === 'string' && value.trim() !== '') return value
      }
      const error = parsed.error
      if (!isJsonObject(error)) return undefined
      const message = error.message
      return typeof message === 'string' && message.trim() !== '' ? message : undefined
    })
  )

const providerMessage = (fallback: string, body: string) =>
  jsonMessageField(body, ['message', 'error_description', 'error']).pipe(
    Effect.map(detail => (detail === undefined ? fallback : `${fallback}: ${detail}`))
  )

const providerCode = (fallback: string, status: number) => {
  switch (status) {
    case 401:
    case 403:
      return 'google_unauthorized'
    case 404:
      return 'google_not_found'
    case 429:
      return 'google_rate_limited'
    default:
      return fallback
  }
}

export const providerFailureFromResponse = (input: {
  readonly code: string
  readonly message: string
  readonly status: number
  readonly body: string
}) =>
  providerMessage(input.message, input.body).pipe(
    Effect.map(message =>
      ActionResult.failure(
        new ProviderFailure({
          code: providerCode(input.code, input.status),
          message,
          status: input.status,
          underlying: input.body
        })
      )
    )
  )

export const isSuccessStatus = (status: number) => status >= 200 && status < 300

export const appendSearchParam = (
  params: URLSearchParams,
  key: string,
  value: string | undefined
) => {
  if (value !== undefined && value.trim() !== '') {
    params.set(key, value)
  }
}

export const appendNumberSearchParam = (
  params: URLSearchParams,
  key: string,
  value: number | undefined
) => {
  if (value !== undefined) {
    params.set(key, String(value))
  }
}
