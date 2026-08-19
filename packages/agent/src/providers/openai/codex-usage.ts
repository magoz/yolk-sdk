import { Chunk, Clock, Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { HttpClient, HttpClientRequest } from 'effect/unstable/http'
import type { OAuthAccessToken } from '@yolk-sdk/agent/oauth'
import { openAiCodexProviderId } from './codex.ts'
import {
  canonicalSubscriptionUsageInstant,
  defaultProviderSubscriptionUsageTimeoutMs,
  executeAndReadProviderSubscriptionUsageJson,
  positiveSubscriptionUsageNumber,
  validProviderSubscriptionUsageTimeout,
  validSubscriptionUsagePercent
} from '../subscription-usage-internal.ts'
import {
  ProviderSubscriptionUsageConfigurationError,
  type ProviderSubscriptionUsageError,
  ProviderSubscriptionUsageResponseError,
  ProviderSubscriptionUsageSnapshot,
  ProviderSubscriptionUsageWindow
} from '../subscription-usage.ts'

export const openAiCodexSubscriptionUsageUrl = 'https://chatgpt.com/backend-api/wham/usage'

export type OpenAiCodexSubscriptionUsageOptions = {
  readonly requestTimeoutMs?: number
}

const NullableNumber = Schema.NullOr(Schema.Number)

class OpenAiCodexSubscriptionUsageWindowWire extends Schema.Class<OpenAiCodexSubscriptionUsageWindowWire>(
  'OpenAiCodexSubscriptionUsageWindowWire'
)({
  used_percent: Schema.optional(NullableNumber),
  limit_window_seconds: Schema.optional(NullableNumber),
  reset_after_seconds: Schema.optional(NullableNumber),
  reset_at: Schema.optional(NullableNumber)
}) {}

class OpenAiCodexSubscriptionRateLimitWire extends Schema.Class<OpenAiCodexSubscriptionRateLimitWire>(
  'OpenAiCodexSubscriptionRateLimitWire'
)({
  primary_window: Schema.optional(Schema.NullOr(OpenAiCodexSubscriptionUsageWindowWire)),
  secondary_window: Schema.optional(Schema.NullOr(OpenAiCodexSubscriptionUsageWindowWire))
}) {}

class OpenAiCodexSubscriptionUsageWire extends Schema.Class<OpenAiCodexSubscriptionUsageWire>(
  'OpenAiCodexSubscriptionUsageWire'
)({
  rate_limit: Schema.optional(Schema.NullOr(OpenAiCodexSubscriptionRateLimitWire))
}) {}

export const parseOpenAiCodexSubscriptionUsage = (
  value: unknown,
  fetchedAt: string
): Effect.Effect<ProviderSubscriptionUsageSnapshot, ProviderSubscriptionUsageResponseError> => {
  const canonicalFetchedAt = canonicalSubscriptionUsageInstant(fetchedAt)

  if (canonicalFetchedAt === undefined) {
    return Effect.fail(
      ProviderSubscriptionUsageResponseError.make({
        provider: openAiCodexProviderId,
        category: 'invalid_response'
      })
    )
  }

  return Schema.decodeUnknownEffect(OpenAiCodexSubscriptionUsageWire)(value).pipe(
    Effect.map(decoded => {
      const windows: Array<ProviderSubscriptionUsageWindow> = []
      const append = (
        wire: OpenAiCodexSubscriptionUsageWindowWire | null | undefined,
        id: 'primary' | 'secondary'
      ) => {
        if (!validSubscriptionUsagePercent(wire?.used_percent)) {
          return
        }

        const resetAt = wire.reset_at
        const resetsAt =
          resetAt === null || resetAt === undefined
            ? undefined
            : canonicalSubscriptionUsageInstant(resetAt)
        const resetsAfterSeconds = positiveSubscriptionUsageNumber(wire.reset_after_seconds)
          ? wire.reset_after_seconds
          : undefined
        const windowDurationMinutes = positiveSubscriptionUsageNumber(wire.limit_window_seconds)
          ? wire.limit_window_seconds / 60
          : undefined

        windows.push(
          ProviderSubscriptionUsageWindow.make({
            id,
            usedPercent: wire.used_percent,
            ...(resetsAt === undefined ? {} : { resetsAt }),
            ...(resetsAfterSeconds === undefined ? {} : { resetsAfterSeconds }),
            ...(windowDurationMinutes === undefined ? {} : { windowDurationMinutes })
          })
        )
      }

      append(decoded.rate_limit?.primary_window, 'primary')
      append(decoded.rate_limit?.secondary_window, 'secondary')

      return ProviderSubscriptionUsageSnapshot.make({
        provider: openAiCodexProviderId,
        fetchedAt: canonicalFetchedAt,
        windows: Chunk.fromIterable(windows)
      })
    }),
    Effect.mapError(() =>
      ProviderSubscriptionUsageResponseError.make({
        provider: openAiCodexProviderId,
        category: 'invalid_response'
      })
    ),
    Effect.withSpan('OpenAiCodexSubscriptionUsage.parse')
  )
}

export const fetchOpenAiCodexSubscriptionUsage = (
  token: OAuthAccessToken,
  options: OpenAiCodexSubscriptionUsageOptions = {}
): Effect.Effect<
  ProviderSubscriptionUsageSnapshot,
  ProviderSubscriptionUsageError,
  HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    if (token.provider !== openAiCodexProviderId) {
      return yield* Effect.fail(
        ProviderSubscriptionUsageConfigurationError.make({
          provider: openAiCodexProviderId,
          reason: 'provider_mismatch'
        })
      )
    }

    const accountId = token.accountId?.trim()

    if (accountId === undefined || accountId.length === 0) {
      return yield* Effect.fail(
        ProviderSubscriptionUsageConfigurationError.make({
          provider: openAiCodexProviderId,
          reason: 'missing_account_id'
        })
      )
    }

    const requestTimeoutMs = options.requestTimeoutMs ?? defaultProviderSubscriptionUsageTimeoutMs

    if (!validProviderSubscriptionUsageTimeout(requestTimeoutMs)) {
      return yield* Effect.fail(
        ProviderSubscriptionUsageConfigurationError.make({
          provider: openAiCodexProviderId,
          reason: 'invalid_request_timeout'
        })
      )
    }

    const client = yield* HttpClient.HttpClient
    const request = HttpClientRequest.get(openAiCodexSubscriptionUsageUrl).pipe(
      HttpClientRequest.setHeaders({
        accept: 'application/json',
        authorization: `Bearer ${token.accessToken}`,
        'chatgpt-account-id': accountId
      })
    )
    const json = yield* executeAndReadProviderSubscriptionUsageJson({
      provider: openAiCodexProviderId,
      client,
      request,
      timeoutMs: requestTimeoutMs
    })
    const fetchedAt = new Date(yield* Clock.currentTimeMillis).toISOString()

    return yield* parseOpenAiCodexSubscriptionUsage(json, fetchedAt)
  }).pipe(Effect.withSpan('OpenAiCodexSubscriptionUsage.fetch'))
