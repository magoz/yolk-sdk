import { Chunk, Clock, Effect, Redacted } from 'effect'
import * as Schema from 'effect/Schema'
import { HttpClient, HttpClientRequest } from 'effect/unstable/http'
import { openCodeGoProviderId } from './go-provider.ts'
import {
  canonicalSubscriptionUsageInstant,
  defaultProviderSubscriptionUsageTimeoutMs,
  executeAndReadProviderSubscriptionUsageJson,
  validProviderSubscriptionUsageTimeout,
  validSubscriptionUsagePercent
} from '../subscription-usage-internal.ts'
import {
  ProviderSubscriptionUsageConfigurationError,
  ProviderSubscriptionUsageResponseError,
  ProviderSubscriptionUsageSnapshot,
  ProviderSubscriptionUsageWindow,
  type ProviderSubscriptionUsageError
} from '../subscription-usage.ts'

export const openCodeGoSubscriptionUsageUrl = 'https://opencode.ai/zen/go/v1/usage'

export type OpenCodeGoSubscriptionUsageOptions = {
  readonly requestTimeoutMs?: number
}

class OpenCodeGoUsageWindowWire extends Schema.Class<OpenCodeGoUsageWindowWire>(
  'OpenCodeGoUsageWindowWire'
)({
  percent: Schema.optional(Schema.NullOr(Schema.Number)),
  resetsAt: Schema.optional(Schema.NullOr(Schema.String))
}) {}

class OpenCodeGoUsageWindowsWire extends Schema.Class<OpenCodeGoUsageWindowsWire>(
  'OpenCodeGoUsageWindowsWire'
)({
  rolling: Schema.optional(Schema.NullOr(OpenCodeGoUsageWindowWire)),
  weekly: Schema.optional(Schema.NullOr(OpenCodeGoUsageWindowWire)),
  monthly: Schema.optional(Schema.NullOr(OpenCodeGoUsageWindowWire))
}) {}

class OpenCodeGoUsageWire extends Schema.Class<OpenCodeGoUsageWire>('OpenCodeGoUsageWire')({
  usage: OpenCodeGoUsageWindowsWire
}) {}

type OpenCodeGoUsageWindowFields = {
  id: string
  usedPercent: number
  resetsAt?: string
}

/** Normalize provider-reported allowance, never infer it from per-request token usage. */
export const parseOpenCodeGoSubscriptionUsage = (
  value: unknown,
  fetchedAt: string
): Effect.Effect<ProviderSubscriptionUsageSnapshot, ProviderSubscriptionUsageResponseError> => {
  const canonicalFetchedAt = canonicalSubscriptionUsageInstant(fetchedAt)

  if (canonicalFetchedAt === undefined) {
    return Effect.fail(
      ProviderSubscriptionUsageResponseError.make({
        provider: openCodeGoProviderId,
        category: 'invalid_response'
      })
    )
  }

  return Schema.decodeUnknownEffect(OpenCodeGoUsageWire)(value).pipe(
    Effect.map(decoded => {
      const windows: Array<ProviderSubscriptionUsageWindow> = []

      const append = (wire: OpenCodeGoUsageWindowWire | null | undefined, id: string) => {
        if (!validSubscriptionUsagePercent(wire?.percent)) return

        const fields: OpenCodeGoUsageWindowFields = { id, usedPercent: wire.percent }

        const resetsAt =
          wire.resetsAt == null ? undefined : canonicalSubscriptionUsageInstant(wire.resetsAt)

        if (resetsAt !== undefined) fields.resetsAt = resetsAt

        windows.push(ProviderSubscriptionUsageWindow.make(fields))
      }

      append(decoded.usage.rolling, 'five-hour')
      append(decoded.usage.weekly, 'seven-day')
      append(decoded.usage.monthly, 'monthly')

      return ProviderSubscriptionUsageSnapshot.make({
        provider: openCodeGoProviderId,
        fetchedAt: canonicalFetchedAt,
        windows: Chunk.fromIterable(windows)
      })
    }),
    Effect.mapError(() =>
      ProviderSubscriptionUsageResponseError.make({
        provider: openCodeGoProviderId,
        category: 'invalid_response'
      })
    ),
    Effect.withSpan('OpenCodeGoSubscriptionUsage.parse')
  )
}

/** Fixed best-effort endpoint; API key belongs to the Go subscription's user/workspace. */
export const fetchOpenCodeGoSubscriptionUsage = (
  apiKey: Redacted.Redacted<string>,
  options: OpenCodeGoSubscriptionUsageOptions = {}
): Effect.Effect<
  ProviderSubscriptionUsageSnapshot,
  ProviderSubscriptionUsageError,
  HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    if (Redacted.value(apiKey).trim().length === 0) {
      return yield* Effect.fail(
        ProviderSubscriptionUsageConfigurationError.make({
          provider: openCodeGoProviderId,
          reason: 'missing_api_key'
        })
      )
    }

    const requestTimeoutMs = options.requestTimeoutMs ?? defaultProviderSubscriptionUsageTimeoutMs

    if (!validProviderSubscriptionUsageTimeout(requestTimeoutMs)) {
      return yield* Effect.fail(
        ProviderSubscriptionUsageConfigurationError.make({
          provider: openCodeGoProviderId,
          reason: 'invalid_request_timeout'
        })
      )
    }

    const client = yield* HttpClient.HttpClient

    const request = HttpClientRequest.get(openCodeGoSubscriptionUsageUrl).pipe(
      HttpClientRequest.setHeaders({
        accept: 'application/json',
        authorization: `Bearer ${Redacted.value(apiKey)}`
      })
    )

    const json = yield* executeAndReadProviderSubscriptionUsageJson({
      provider: openCodeGoProviderId,
      client,
      request,
      timeoutMs: requestTimeoutMs
    })

    const fetchedAt = new Date(yield* Clock.currentTimeMillis).toISOString()

    return yield* parseOpenCodeGoSubscriptionUsage(json, fetchedAt)
  }).pipe(Effect.withSpan('OpenCodeGoSubscriptionUsage.fetch'))
