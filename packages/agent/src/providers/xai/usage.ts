import { Chunk, Clock, Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { HttpClient, HttpClientRequest } from 'effect/unstable/http'
import type { OAuthAccessToken } from '@yolk-sdk/agent/oauth'
import { xAiGrokProviderId } from './grok.ts'
import {
  canonicalSubscriptionUsageInstant,
  defaultProviderSubscriptionUsageTimeoutMs,
  executeAndReadProviderSubscriptionUsageJson,
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

export const xAiGrokSubscriptionUsageUrl =
  'https://cli-chat-proxy.grok.com/v1/billing?format=credits'

export type XAiGrokSubscriptionUsageOptions = {
  readonly xAiUserId: string
  readonly clientVersion: string
  readonly requestTimeoutMs?: number
}

const NullableString = Schema.NullOr(Schema.String)

class XAiGrokSubscriptionUsageCentWire extends Schema.Class<XAiGrokSubscriptionUsageCentWire>(
  'XAiGrokSubscriptionUsageCentWire'
)({
  val: Schema.optional(Schema.Number)
}) {}

class XAiGrokSubscriptionUsagePeriodWire extends Schema.Class<XAiGrokSubscriptionUsagePeriodWire>(
  'XAiGrokSubscriptionUsagePeriodWire'
)({
  type: Schema.optional(NullableString),
  start: Schema.optional(NullableString),
  end: Schema.optional(NullableString)
}) {}

class XAiGrokSubscriptionUsageConfigWire extends Schema.Class<XAiGrokSubscriptionUsageConfigWire>(
  'XAiGrokSubscriptionUsageConfigWire'
)({
  creditUsagePercent: Schema.optional(Schema.Number),
  currentPeriod: Schema.optional(Schema.NullOr(XAiGrokSubscriptionUsagePeriodWire)),
  monthlyLimit: Schema.optional(Schema.NullOr(XAiGrokSubscriptionUsageCentWire)),
  used: Schema.optional(Schema.NullOr(XAiGrokSubscriptionUsageCentWire)),
  billingPeriodStart: Schema.optional(NullableString),
  billingPeriodEnd: Schema.optional(NullableString)
}) {}

class XAiGrokSubscriptionUsageWire extends Schema.Class<XAiGrokSubscriptionUsageWire>(
  'XAiGrokSubscriptionUsageWire'
)({
  config: Schema.optional(Schema.NullOr(XAiGrokSubscriptionUsageConfigWire))
}) {}

type XAiGrokSubscriptionUsagePeriodMetadata = {
  readonly resetsAt: string
  readonly resetsAfterSeconds: number
  readonly windowDurationMinutes: number
}

const currentPeriodMetadata = (
  period: XAiGrokSubscriptionUsagePeriodWire | null | undefined,
  fetchedAt: string
): XAiGrokSubscriptionUsagePeriodMetadata | undefined => {
  const startValue = period?.start === null ? undefined : period?.start
  const endValue = period?.end === null ? undefined : period?.end
  const start = startValue === undefined ? undefined : canonicalSubscriptionUsageInstant(startValue)
  const end = endValue === undefined ? undefined : canonicalSubscriptionUsageInstant(endValue)

  if (start === undefined || end === undefined) {
    return undefined
  }

  const startMs = new Date(start).getTime()
  const endMs = new Date(end).getTime()
  const fetchedAtMs = new Date(fetchedAt).getTime()

  if (endMs <= startMs || fetchedAtMs < startMs || fetchedAtMs >= endMs) {
    return undefined
  }

  return {
    resetsAt: end,
    resetsAfterSeconds: (endMs - fetchedAtMs) / 1_000,
    windowDurationMinutes: (endMs - startMs) / 60_000
  }
}

const makeSharedWindow = (
  usedPercent: number,
  period: XAiGrokSubscriptionUsagePeriodMetadata | undefined
) =>
  ProviderSubscriptionUsageWindow.make({
    id: 'shared',
    usedPercent,
    ...(period === undefined
      ? {}
      : {
          resetsAt: period.resetsAt,
          resetsAfterSeconds: period.resetsAfterSeconds,
          windowDurationMinutes: period.windowDurationMinutes
        })
  })

const invalidResponse = () =>
  ProviderSubscriptionUsageResponseError.make({
    provider: xAiGrokProviderId,
    category: 'invalid_response'
  })

export const parseXAiGrokSubscriptionUsage = (
  value: unknown,
  fetchedAt: string
): Effect.Effect<ProviderSubscriptionUsageSnapshot, ProviderSubscriptionUsageResponseError> => {
  const canonicalFetchedAt = canonicalSubscriptionUsageInstant(fetchedAt)

  if (canonicalFetchedAt === undefined) {
    return Effect.fail(invalidResponse())
  }

  return Schema.decodeUnknownEffect(XAiGrokSubscriptionUsageWire)(value).pipe(
    Effect.flatMap(decoded => {
      const config = decoded.config

      if (config === null || config === undefined) {
        return Effect.succeed(
          ProviderSubscriptionUsageSnapshot.make({
            provider: xAiGrokProviderId,
            fetchedAt: canonicalFetchedAt,
            windows: Chunk.empty()
          })
        )
      }

      const modernPeriod = currentPeriodMetadata(config.currentPeriod, canonicalFetchedAt)
      let window: ProviderSubscriptionUsageWindow | undefined

      if (config.creditUsagePercent !== undefined) {
        if (!validSubscriptionUsagePercent(config.creditUsagePercent)) {
          return Effect.fail(invalidResponse())
        }

        window = makeSharedWindow(config.creditUsagePercent, modernPeriod)
      } else if (modernPeriod !== undefined) {
        window = makeSharedWindow(0, modernPeriod)
      } else {
        const monthlyLimit = config.monthlyLimit
        const used = config.used

        if (
          monthlyLimit !== null &&
          monthlyLimit !== undefined &&
          used !== null &&
          used !== undefined
        ) {
          const limitValue = monthlyLimit.val ?? 0
          const usedValue = used.val ?? 0

          if (
            !Number.isFinite(limitValue) ||
            !Number.isFinite(usedValue) ||
            limitValue < 0 ||
            usedValue < 0
          ) {
            return Effect.fail(invalidResponse())
          }

          if (limitValue > 0) {
            const usedPercent = (usedValue / limitValue) * 100

            if (!validSubscriptionUsagePercent(usedPercent)) {
              return Effect.fail(invalidResponse())
            }

            const legacyPeriod = currentPeriodMetadata(
              XAiGrokSubscriptionUsagePeriodWire.make({
                start: config.billingPeriodStart,
                end: config.billingPeriodEnd
              }),
              canonicalFetchedAt
            )
            window = makeSharedWindow(usedPercent, legacyPeriod)
          }
        }
      }

      return Effect.succeed(
        ProviderSubscriptionUsageSnapshot.make({
          provider: xAiGrokProviderId,
          fetchedAt: canonicalFetchedAt,
          windows: window === undefined ? Chunk.empty() : Chunk.of(window)
        })
      )
    }),
    Effect.mapError(() => invalidResponse()),
    Effect.withSpan('XAiGrokSubscriptionUsage.parse')
  )
}

export const fetchXAiGrokSubscriptionUsage = (
  token: OAuthAccessToken,
  options: XAiGrokSubscriptionUsageOptions
): Effect.Effect<
  ProviderSubscriptionUsageSnapshot,
  ProviderSubscriptionUsageError,
  HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    if (token.provider !== xAiGrokProviderId) {
      return yield* Effect.fail(
        ProviderSubscriptionUsageConfigurationError.make({
          provider: xAiGrokProviderId,
          reason: 'provider_mismatch'
        })
      )
    }

    const xAiUserId = options.xAiUserId.trim()

    if (xAiUserId.length === 0) {
      return yield* Effect.fail(
        ProviderSubscriptionUsageConfigurationError.make({
          provider: xAiGrokProviderId,
          reason: 'missing_xai_user_id'
        })
      )
    }

    const clientVersion = options.clientVersion.trim()

    if (clientVersion.length === 0) {
      return yield* Effect.fail(
        ProviderSubscriptionUsageConfigurationError.make({
          provider: xAiGrokProviderId,
          reason: 'missing_client_version'
        })
      )
    }

    const requestTimeoutMs = options.requestTimeoutMs ?? defaultProviderSubscriptionUsageTimeoutMs

    if (!validProviderSubscriptionUsageTimeout(requestTimeoutMs)) {
      return yield* Effect.fail(
        ProviderSubscriptionUsageConfigurationError.make({
          provider: xAiGrokProviderId,
          reason: 'invalid_request_timeout'
        })
      )
    }

    const client = yield* HttpClient.HttpClient
    const request = HttpClientRequest.get(xAiGrokSubscriptionUsageUrl).pipe(
      HttpClientRequest.setHeaders({
        accept: 'application/json',
        authorization: `Bearer ${token.accessToken}`,
        'X-XAI-Token-Auth': 'xai-grok-cli',
        'x-userid': xAiUserId,
        'x-grok-client-version': clientVersion,
        'x-grok-client-mode': 'headless'
      })
    )
    const json = yield* executeAndReadProviderSubscriptionUsageJson({
      provider: xAiGrokProviderId,
      client,
      request,
      timeoutMs: requestTimeoutMs
    })
    const responseFetchedAt = new Date(yield* Clock.currentTimeMillis).toISOString()

    return yield* parseXAiGrokSubscriptionUsage(json, responseFetchedAt)
  }).pipe(Effect.withSpan('XAiGrokSubscriptionUsage.fetch'))
