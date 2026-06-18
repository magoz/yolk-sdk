import { Effect, Option } from 'effect'
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

const jsonMessageField = (body: string, keys: ReadonlyArray<string>) => {
  const parsed = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(body)
  if (Option.isNone(parsed) || !isJsonObject(parsed.value)) return undefined
  for (const key of keys) {
    const value = parsed.value[key]
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  const error = parsed.value.error
  if (!isJsonObject(error)) return undefined
  const message = error.message
  return typeof message === 'string' && message.trim() !== '' ? message : undefined
}

const providerMessage = (fallback: string, body: string) => {
  const detail = jsonMessageField(body, ['message', 'error_description', 'error'])
  return detail === undefined ? fallback : `${fallback}: ${detail}`
}

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
  ActionResult.failure(
    new ProviderFailure({
      code: providerCode(input.code, input.status),
      message: providerMessage(input.message, input.body),
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
