import { Effect, Result } from 'effect'
import * as Schema from 'effect/Schema'
import { resolveCredential } from '../credential.ts'
import type { CredentialSlot } from '../credential.ts'
import { ConnectorError } from '../error.ts'
import type { ConnectorIntegration } from '../integration.ts'
import { ActionResult, ProviderFailure } from '../result.ts'
import { MicrosoftOAuthCredentialSlot } from './oauth.ts'

export const microsoftGraphApiBaseUrl = 'https://graph.microsoft.com/v1.0'

const JsonObject = Schema.Record(Schema.String, Schema.Unknown)
const isJsonObject = Schema.is(JsonObject)

export const resolveMicrosoftAccessToken = (
  integration: ConnectorIntegration,
  slot: CredentialSlot = MicrosoftOAuthCredentialSlot
) =>
  Effect.gen(function* () {
    const credential = yield* resolveCredential(integration, slot)

    switch (credential._tag) {
      case 'OAuthCredential':
        return credential.accessToken
      case 'BearerTokenCredential':
        return credential.token
      case 'ApiKeyCredential':
      case 'UsernamePasswordCredential':
        return yield* Effect.fail(
          new ConnectorError({
            cause: 'credential_invalid',
            message: 'Microsoft connector requires an OAuth or bearer token credential',
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

const graphErrorDetail = (body: string) =>
  decodeJsonObject(body).pipe(
    Effect.map(parsed => {
      if (parsed === undefined) return undefined
      const error = parsed.error
      if (!isJsonObject(error)) return undefined
      const message = error.message
      return typeof message === 'string' && message.trim() !== '' ? message : undefined
    })
  )

const providerCode = (fallback: string, status: number) => {
  switch (status) {
    case 401:
    case 403:
      return 'microsoft_unauthorized'
    case 404:
      return 'microsoft_not_found'
    case 409:
      return 'microsoft_conflict'
    case 412:
      return 'microsoft_precondition_failed'
    case 413:
      return 'microsoft_payload_too_large'
    case 423:
      return 'microsoft_locked'
    case 429:
      return 'microsoft_rate_limited'
    case 507:
      return 'microsoft_storage_limit'
    default:
      return fallback
  }
}

const retryAfterMs = (headers: Readonly<Record<string, string>>) => {
  const retryAfter = headers['retry-after'] ?? headers['Retry-After']
  if (retryAfter === undefined) return undefined
  const seconds = Number(retryAfter)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : undefined
}

export const microsoftProviderFailure = (input: {
  readonly code: string
  readonly message: string
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}) =>
  graphErrorDetail(input.body).pipe(
    Effect.map(detail => {
      const retryAfter = retryAfterMs(input.headers)
      return ActionResult.failure(
        new ProviderFailure({
          code: providerCode(input.code, input.status),
          message: detail === undefined ? input.message : `${input.message}: ${detail}`,
          status: input.status,
          ...(retryAfter === undefined ? {} : { retryAfterMs: retryAfter }),
          underlying: input.body
        })
      )
    })
  )

export const isMicrosoftSuccessStatus = (status: number) => status >= 200 && status < 300
