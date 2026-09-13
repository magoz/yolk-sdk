import { Effect, Match, Predicate, Result } from 'effect'
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

    const invalidCredential = () =>
      Effect.fail(
        new ConnectorError({
          cause: 'credential_invalid',
          message: 'Google connector requires an OAuth or bearer token credential',
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

        if (Predicate.isString(value) && value.trim() !== '') return value
      }

      const error = parsed.error

      if (!isJsonObject(error)) return undefined
      const message = error.message

      return Predicate.isString(message) && message.trim() !== '' ? message : undefined
    })
  )

const providerMessage = (fallback: string, body: string) =>
  jsonMessageField(body, ['message', 'error_description', 'error']).pipe(
    Effect.map(detail => (detail === undefined ? fallback : `${fallback}: ${detail}`))
  )

const googleErrorReasons = (body: string) =>
  decodeJsonObject(body).pipe(
    Effect.map(parsed => {
      if (parsed === undefined) return []
      const error = parsed.error

      if (!isJsonObject(error) || !Array.isArray(error.errors)) return []

      return error.errors.flatMap(item => {
        if (!isJsonObject(item)) return []
        const reason = item.reason

        return Predicate.isString(reason) ? [reason] : []
      })
    })
  )

const googleRateLimitReasons = new Set([
  'dailyLimitExceeded',
  'rateLimitExceeded',
  'sharingRateLimitExceeded',
  'userRateLimitExceeded'
])

const providerCode = (fallback: string, status: number, reasons: ReadonlyArray<string>) => {
  switch (status) {
    case 401:
      return 'google_unauthorized'
    case 403:
      return reasons.some(reason => googleRateLimitReasons.has(reason))
        ? 'google_rate_limited'
        : 'google_unauthorized'
    case 404:
      return 'google_not_found'
    case 429:
      return 'google_rate_limited'
    default:
      return fallback
  }
}

const retryAfterMs = (headers: Readonly<Record<string, string>> | undefined) => {
  const retryAfter = Object.entries(headers ?? {}).find(
    ([name]) => name.toLowerCase() === 'retry-after'
  )?.[1]

  if (retryAfter === undefined) return undefined
  const seconds = Number(retryAfter)

  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined
}

type GoogleProviderFailureFields = {
  readonly code: string
  readonly message: string
  readonly status: number
  readonly underlying: string
  retryAfterMs?: number
}

export const providerFailureFromResponse = (input: {
  readonly code: string
  readonly message: string
  readonly status: number
  readonly headers?: Readonly<Record<string, string>>
  readonly body: string
}) =>
  Effect.gen(function* () {
    const message = yield* providerMessage(input.message, input.body)
    const reasons = yield* googleErrorReasons(input.body)
    const retry = retryAfterMs(input.headers)

    return ActionResult.failure(
      new ProviderFailure(
        (() => {
          const fields: GoogleProviderFailureFields = {
            code: providerCode(input.code, input.status, reasons),
            message,
            status: input.status,
            underlying: input.body
          }

          if (retry !== undefined) {
            fields.retryAfterMs = retry
          }

          return fields
        })()
      )
    )
  })

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
