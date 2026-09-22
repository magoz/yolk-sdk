import { Effect, Match, Predicate, Result } from 'effect'
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

    const invalidCredential = () =>
      Effect.fail(
        new ConnectorError({
          cause: 'credential_invalid',
          message: 'Microsoft connector requires an OAuth or bearer token credential',
          connectorId: integration.connectorId,
          slotId: slot.id
        })
      )

    return yield* Match.value(credential).pipe(
      Match.tag('OAuthCredential', current => Effect.succeed(current.accessToken)),
      Match.tag('BearerTokenCredential', current => Effect.succeed(current.token)),
      Match.tag('ApiKeyCredential', 'UsernamePasswordCredential', invalidCredential),
      Match.exhaustive
    )
  })

const decodeJsonObject = (body: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(body).pipe(
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

      return Predicate.isString(message) && message.trim() !== '' ? message : undefined
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
  const matches = Object.entries(headers).filter(
    ([headerName]) => headerName.toLowerCase() === 'retry-after'
  )

  if (matches.length !== 1 || !/^\d+$/.test(matches[0]?.[1] ?? '')) return undefined
  const milliseconds = Number(matches[0]?.[1]) * 1_000

  return Number.isSafeInteger(milliseconds) ? milliseconds : undefined
}

type MicrosoftProviderFailurePrefixFields = {
  readonly code: string
  readonly message: string
  readonly status: number
  retryAfterMs?: number
}

type MicrosoftProviderFailureInput = {
  readonly code: string
  readonly message: string
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
}

const microsoftProviderFailureFields = (
  input: MicrosoftProviderFailureInput
): MicrosoftProviderFailurePrefixFields => {
  const fields: MicrosoftProviderFailurePrefixFields = {
    code: providerCode(input.code, input.status),
    message: input.message,
    status: input.status
  }

  const retryAfter = retryAfterMs(input.headers)

  if (retryAfter !== undefined) {
    fields.retryAfterMs = retryAfter
  }

  return fields
}

export const microsoftSanitizedProviderFailure = (input: MicrosoftProviderFailureInput) =>
  ActionResult.failure(new ProviderFailure(microsoftProviderFailureFields(input)))

export const microsoftProviderFailure = (
  input: MicrosoftProviderFailureInput & {
    readonly body: string
  }
) =>
  graphErrorDetail(input.body).pipe(
    Effect.map(detail => {
      const fields = microsoftProviderFailureFields(input)

      return ActionResult.failure(
        new ProviderFailure({
          ...fields,
          message: detail === undefined ? fields.message : `${fields.message}: ${detail}`,
          underlying: input.body
        })
      )
    })
  )

export const isMicrosoftSuccessStatus = (status: number) => status >= 200 && status < 300
