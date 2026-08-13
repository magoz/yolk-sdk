import { Clock, Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { HttpClient, HttpClientRequest } from 'effect/unstable/http'
import type { OAuthAccessToken } from '@yolk-sdk/agent/oauth'
import { anthropicClaudeAuthorizationHeaders, anthropicClaudeProviderId } from './claude.ts'
import {
  canonicalSubscriptionUsageInstant,
  defaultProviderSubscriptionUsageTimeoutMs,
  executeProviderSubscriptionUsageRequest,
  readProviderSubscriptionUsageJson,
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

export const anthropicClaudeSubscriptionUsageUrl = 'https://api.anthropic.com/api/oauth/usage'

export type AnthropicClaudeSubscriptionUsageOptions = {
  readonly requestTimeoutMs?: number
}

const NullableNumber = Schema.NullOr(Schema.Number)
const NullableString = Schema.NullOr(Schema.String)

class AnthropicClaudeSubscriptionUsageWindowWire extends Schema.Class<AnthropicClaudeSubscriptionUsageWindowWire>(
  'AnthropicClaudeSubscriptionUsageWindowWire'
)({
  utilization: Schema.optional(NullableNumber),
  resets_at: Schema.optional(NullableString)
}) {}

class AnthropicClaudeSubscriptionUsageWire extends Schema.Class<AnthropicClaudeSubscriptionUsageWire>(
  'AnthropicClaudeSubscriptionUsageWire'
)({
  five_hour: Schema.optional(Schema.NullOr(AnthropicClaudeSubscriptionUsageWindowWire)),
  seven_day: Schema.optional(Schema.NullOr(AnthropicClaudeSubscriptionUsageWindowWire))
}) {}

export const parseAnthropicClaudeSubscriptionUsage = (
  value: unknown,
  fetchedAt: string
): Effect.Effect<ProviderSubscriptionUsageSnapshot, ProviderSubscriptionUsageResponseError> => {
  const canonicalFetchedAt = canonicalSubscriptionUsageInstant(fetchedAt)

  if (canonicalFetchedAt === undefined) {
    return Effect.fail(
      new ProviderSubscriptionUsageResponseError({
        provider: anthropicClaudeProviderId,
        category: 'invalid_response'
      })
    )
  }

  return Schema.decodeUnknownEffect(AnthropicClaudeSubscriptionUsageWire)(value).pipe(
    Effect.map(decoded => {
      const windows: Array<ProviderSubscriptionUsageWindow> = []
      const append = (
        wire: AnthropicClaudeSubscriptionUsageWindowWire | null | undefined,
        id: 'five-hour' | 'seven-day'
      ) => {
        if (!validSubscriptionUsagePercent(wire?.utilization)) {
          return
        }

        const resetValue = wire.resets_at === null ? undefined : wire.resets_at
        const resetsAt =
          resetValue === undefined ? undefined : canonicalSubscriptionUsageInstant(resetValue)

        windows.push(
          ProviderSubscriptionUsageWindow.make({
            id,
            usedPercent: wire.utilization,
            ...(resetsAt === undefined ? {} : { resetsAt })
          })
        )
      }

      append(decoded.five_hour, 'five-hour')
      append(decoded.seven_day, 'seven-day')

      return ProviderSubscriptionUsageSnapshot.make({
        provider: anthropicClaudeProviderId,
        fetchedAt: canonicalFetchedAt,
        windows
      })
    }),
    Effect.mapError(
      () =>
        new ProviderSubscriptionUsageResponseError({
          provider: anthropicClaudeProviderId,
          category: 'invalid_response'
        })
    ),
    Effect.withSpan('AnthropicClaudeSubscriptionUsage.parse')
  )
}

export const fetchAnthropicClaudeSubscriptionUsage = (
  token: OAuthAccessToken,
  options: AnthropicClaudeSubscriptionUsageOptions = {}
): Effect.Effect<
  ProviderSubscriptionUsageSnapshot,
  ProviderSubscriptionUsageError,
  HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    if (token.provider !== anthropicClaudeProviderId) {
      return yield* Effect.fail(
        new ProviderSubscriptionUsageConfigurationError({
          provider: anthropicClaudeProviderId,
          reason: 'provider_mismatch'
        })
      )
    }

    const requestTimeoutMs = options.requestTimeoutMs ?? defaultProviderSubscriptionUsageTimeoutMs

    if (!validProviderSubscriptionUsageTimeout(requestTimeoutMs)) {
      return yield* Effect.fail(
        new ProviderSubscriptionUsageConfigurationError({
          provider: anthropicClaudeProviderId,
          reason: 'invalid_request_timeout'
        })
      )
    }

    const client = yield* HttpClient.HttpClient
    const request = HttpClientRequest.get(anthropicClaudeSubscriptionUsageUrl).pipe(
      HttpClientRequest.setHeaders({
        accept: 'application/json',
        ...anthropicClaudeAuthorizationHeaders(token),
        'anthropic-beta': 'oauth-2025-04-20'
      })
    )
    const response = yield* executeProviderSubscriptionUsageRequest({
      provider: anthropicClaudeProviderId,
      client,
      request,
      timeoutMs: requestTimeoutMs
    })
    const json = yield* readProviderSubscriptionUsageJson(anthropicClaudeProviderId, response)
    const fetchedAt = new Date(yield* Clock.currentTimeMillis).toISOString()

    return yield* parseAnthropicClaudeSubscriptionUsage(json, fetchedAt)
  }).pipe(Effect.withSpan('AnthropicClaudeSubscriptionUsage.fetch'))
