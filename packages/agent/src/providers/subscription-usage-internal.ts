import { Duration, Effect } from 'effect'
import * as Schema from 'effect/Schema'
import {
  FetchHttpClient,
  HttpClientResponse,
  type HttpClient,
  type HttpClientRequest
} from 'effect/unstable/http'
import { retryAfterMsFromHeaders } from './provider-error.ts'
import {
  ProviderSubscriptionUsageAuthError,
  type ProviderSubscriptionUsageError,
  ProviderSubscriptionUsageRateLimitError,
  ProviderSubscriptionUsageRequestError,
  ProviderSubscriptionUsageResponseError
} from './subscription-usage.ts'

export const defaultProviderSubscriptionUsageTimeoutMs = 10_000

export const canonicalSubscriptionUsageInstant = (value: string | number): string | undefined => {
  const date = new Date(typeof value === 'number' ? value * 1000 : value)

  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined
}

export const validSubscriptionUsagePercent = (value: number | null | undefined): value is number =>
  value !== null && value !== undefined && Number.isFinite(value) && value >= 0 && value <= 100

export const positiveSubscriptionUsageNumber = (
  value: number | null | undefined
): value is number => value !== null && value !== undefined && Number.isFinite(value) && value > 0

export const validProviderSubscriptionUsageTimeout = (value: number) =>
  Number.isFinite(value) && value > 0

const responseError = (provider: string, status: number): ProviderSubscriptionUsageError => {
  if (status === 401 || status === 403) {
    return ProviderSubscriptionUsageAuthError.make({ provider, status })
  }

  return ProviderSubscriptionUsageResponseError.make({
    provider,
    category: status >= 300 && status < 400 ? 'redirect' : 'http',
    status
  })
}

export const executeProviderSubscriptionUsageRequest = (input: {
  readonly provider: string
  readonly client: HttpClient.HttpClient
  readonly request: HttpClientRequest.HttpClientRequest
  readonly timeoutMs: number
}) =>
  Effect.gen(function* () {
    const response = yield* input.client.execute(input.request).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: 'manual' }),
      Effect.withTracerEnabled(false),
      Effect.mapError(() =>
        ProviderSubscriptionUsageRequestError.make({
          provider: input.provider,
          category: 'network'
        })
      ),
      Effect.timeoutOrElse({
        duration: Duration.millis(input.timeoutMs),
        orElse: () =>
          Effect.fail(
            ProviderSubscriptionUsageRequestError.make({
              provider: input.provider,
              category: 'timeout'
            })
          )
      })
    )

    if (response.status === 429) {
      return yield* Effect.fail(
        ProviderSubscriptionUsageRateLimitError.make({
          provider: input.provider,
          retryAfterMs: retryAfterMsFromHeaders(response.headers)
        })
      )
    }

    if (response.status < 200 || response.status >= 300) {
      return yield* Effect.fail(responseError(input.provider, response.status))
    }

    return response
  })

export const readProviderSubscriptionUsageJson = (
  provider: string,
  response: HttpClientResponse.HttpClientResponse
) =>
  HttpClientResponse.schemaBodyJson(Schema.Unknown)(response).pipe(
    Effect.withTracerEnabled(false),
    Effect.mapError(() =>
      ProviderSubscriptionUsageResponseError.make({
        provider,
        category: 'invalid_response',
        status: response.status
      })
    )
  )

export const executeAndReadProviderSubscriptionUsageJson = (input: {
  readonly provider: string
  readonly client: HttpClient.HttpClient
  readonly request: HttpClientRequest.HttpClientRequest
  readonly timeoutMs: number
}) =>
  Effect.gen(function* () {
    const response = yield* executeProviderSubscriptionUsageRequest(input)
    return yield* readProviderSubscriptionUsageJson(input.provider, response)
  }).pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(input.timeoutMs),
      orElse: () =>
        Effect.fail(
          ProviderSubscriptionUsageRequestError.make({
            provider: input.provider,
            category: 'timeout'
          })
        )
    })
  )
