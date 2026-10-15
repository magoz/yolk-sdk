import { Chunk, Clock, Effect, Option, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import { HttpClient, HttpClientRequest } from 'effect/http'
import type { OAuthAccessToken } from '@yolk-sdk/agent/oauth'
import { anthropicClaudeAuthorizationHeaders, anthropicClaudeProviderId } from './claude.ts'
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

export const anthropicClaudeSubscriptionUsageUrl = 'https://api.anthropic.com/api/oauth/usage'

export type AnthropicClaudeSubscriptionUsageOptions = {
  readonly requestTimeoutMs?: number
  /**
   * Endpoint override. Defaults to `anthropicClaudeSubscriptionUsageUrl`. Override only with a trusted
   * proxy or a local emulator: the credential is sent to this URL. Redirects stay
   * manual and non-2xx redirects are still rejected.
   */
  readonly url?: string
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
  seven_day: Schema.optional(Schema.NullOr(AnthropicClaudeSubscriptionUsageWindowWire)),
  limits: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown)))
}) {}

/** A model-scoped weekly limit from `limits[]` (`kind: "weekly_scoped"`). */
const AnthropicClaudeScopedLimitWire = Schema.Struct({
  kind: Schema.Literal('weekly_scoped'),
  percent: Schema.Number,
  resets_at: Schema.optional(Schema.Unknown),
  scope: Schema.Struct({
    model: Schema.Struct({
      id: Schema.optional(Schema.Unknown),
      display_name: Schema.optional(Schema.Unknown)
    })
  })
})

const decodeScopedLimit = Schema.decodeUnknownOption(AnthropicClaudeScopedLimitWire)

const fiveHourMinutes = 300

const sevenDayMinutes = 10_080

/** Window id prefix of model-scoped weekly limits: `seven-day-<model>`. */
export const anthropicClaudeScopedWindowIdPrefix = 'seven-day-'

/**
 * The lowercase model substring a scoped limit applies to: the model id when present, else the
 * display name slugged (`Opus` → `opus`).
 */
const scopedLimitModel = (model: { readonly id?: unknown; readonly display_name?: unknown }) => {
  const id = Predicate.isString(model.id) ? model.id.trim().toLowerCase() : ''

  if (id !== '') {
    return id
  }

  const slug = (Predicate.isString(model.display_name) ? model.display_name : '')
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')

  return slug === '' ? undefined : slug
}

export const parseAnthropicClaudeSubscriptionUsage = (
  value: unknown,
  fetchedAt: string
): Effect.Effect<ProviderSubscriptionUsageSnapshot, ProviderSubscriptionUsageResponseError> => {
  const canonicalFetchedAt = canonicalSubscriptionUsageInstant(fetchedAt)

  if (canonicalFetchedAt === undefined) {
    return Effect.fail(
      ProviderSubscriptionUsageResponseError.make({
        provider: anthropicClaudeProviderId,
        category: 'invalid_response'
      })
    )
  }

  return Schema.decodeUnknownEffect(AnthropicClaudeSubscriptionUsageWire)(value).pipe(
    Effect.map(decoded => {
      const windows: Array<ProviderSubscriptionUsageWindow> = []

      type AnthropicUsageWindowFields = {
        id: string
        usedPercent: number
        resetsAt?: string
        windowDurationMinutes: number
        models?: ReadonlyArray<string>
      }

      const pushWindow = (input: {
        readonly id: string
        readonly usedPercent: number
        readonly resetsAt: unknown
        readonly windowDurationMinutes: number
        readonly models?: ReadonlyArray<string>
      }) => {
        const resetsAt =
          Predicate.isString(input.resetsAt) || Predicate.isNumber(input.resetsAt)
            ? canonicalSubscriptionUsageInstant(input.resetsAt)
            : undefined

        const fields: AnthropicUsageWindowFields =
          resetsAt === undefined
            ? {
                id: input.id,
                usedPercent: input.usedPercent,
                windowDurationMinutes: input.windowDurationMinutes
              }
            : {
                id: input.id,
                usedPercent: input.usedPercent,
                resetsAt,
                windowDurationMinutes: input.windowDurationMinutes
              }

        if (input.models !== undefined) {
          fields.models = input.models
        }

        windows.push(ProviderSubscriptionUsageWindow.make(fields))
      }

      const append = (
        wire: AnthropicClaudeSubscriptionUsageWindowWire | null | undefined,
        id: 'five-hour' | 'seven-day',
        windowDurationMinutes: number
      ) => {
        if (!validSubscriptionUsagePercent(wire?.utilization)) {
          return
        }

        pushWindow({
          id,
          usedPercent: wire.utilization,
          resetsAt: wire.resets_at,
          windowDurationMinutes
        })
      }

      append(decoded.five_hour, 'five-hour', fiveHourMinutes)
      append(decoded.seven_day, 'seven-day', sevenDayMinutes)

      const scopedIds = new Set<string>()

      for (const raw of decoded.limits ?? []) {
        const limit = decodeScopedLimit(raw)

        if (Option.isNone(limit) || !validSubscriptionUsagePercent(limit.value.percent)) {
          continue
        }

        const model = scopedLimitModel(limit.value.scope.model)

        if (model === undefined) {
          continue
        }

        const id = `${anthropicClaudeScopedWindowIdPrefix}${model}`

        if (scopedIds.has(id)) {
          continue
        }

        scopedIds.add(id)
        pushWindow({
          id,
          usedPercent: limit.value.percent,
          resetsAt: limit.value.resets_at,
          windowDurationMinutes: sevenDayMinutes,
          models: [model]
        })
      }

      return ProviderSubscriptionUsageSnapshot.make({
        provider: anthropicClaudeProviderId,
        fetchedAt: canonicalFetchedAt,
        windows: Chunk.fromIterable(windows)
      })
    }),
    Effect.mapError(() =>
      ProviderSubscriptionUsageResponseError.make({
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
        ProviderSubscriptionUsageConfigurationError.make({
          provider: anthropicClaudeProviderId,
          reason: 'provider_mismatch'
        })
      )
    }

    const requestTimeoutMs = options.requestTimeoutMs ?? defaultProviderSubscriptionUsageTimeoutMs

    if (!validProviderSubscriptionUsageTimeout(requestTimeoutMs)) {
      return yield* Effect.fail(
        ProviderSubscriptionUsageConfigurationError.make({
          provider: anthropicClaudeProviderId,
          reason: 'invalid_request_timeout'
        })
      )
    }

    const client = yield* HttpClient.HttpClient

    const request = HttpClientRequest.get(options.url ?? anthropicClaudeSubscriptionUsageUrl).pipe(
      HttpClientRequest.setHeaders({
        accept: 'application/json',
        ...anthropicClaudeAuthorizationHeaders(token),
        'anthropic-beta': 'oauth-2025-04-20'
      })
    )

    const json = yield* executeAndReadProviderSubscriptionUsageJson({
      provider: anthropicClaudeProviderId,
      client,
      request,
      timeoutMs: requestTimeoutMs
    })

    const fetchedAt = new Date(yield* Clock.currentTimeMillis).toISOString()

    return yield* parseAnthropicClaudeSubscriptionUsage(json, fetchedAt)
  }).pipe(Effect.withSpan('AnthropicClaudeSubscriptionUsage.fetch'))
