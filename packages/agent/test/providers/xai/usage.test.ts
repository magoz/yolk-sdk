import { Duration, Effect, Fiber, Result, Tracer } from 'effect'
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientResponse
} from 'effect/unstable/http'
import type { HttpClientRequest } from 'effect/unstable/http'
import { describe, expect, it } from '@effect/vitest'
import * as TestClock from 'effect/testing/TestClock'
import { OAuthAccessToken } from '@yolk-sdk/agent/oauth'
import {
  fetchXAiGrokSubscriptionUsage,
  parseXAiGrokSubscriptionUsage,
  xAiGrokSubscriptionUsageUrl
} from '../../../src/providers/xai/usage.ts'

const fetchedAt = '2026-06-03T00:00:00.000Z'
const tokenExpiresAt = 1_800_000_000_000
const token = OAuthAccessToken.make({
  provider: 'xai-grok',
  accessToken: 'grok-secret',
  expiresAt: tokenExpiresAt,
  accountId: 'must-not-be-used-as-xai-user-id'
})
const options = {
  xAiUserId: 'xai-user-123',
  clientVersion: '2.4.0'
}

const modernUsage = (creditUsagePercent = 42.5) => ({
  config: {
    creditUsagePercent,
    currentPeriod: {
      type: 'USAGE_PERIOD_TYPE_WEEKLY',
      start: '2026-06-01T00:00:00Z',
      end: '2026-06-08T00:00:00Z'
    }
  }
})

describe('xAI Grok subscription usage', () => {
  it.effect('normalizes the modern shared weekly allowance and ignores billing-only fields', () =>
    Effect.gen(function* () {
      const snapshot = yield* parseXAiGrokSubscriptionUsage(
        {
          config: {
            ...modernUsage().config,
            productUsage: [{ product: 'PRODUCT_GROK_BUILD', usagePercent: 61.2 }],
            onDemandCap: { val: 5_000 },
            onDemandUsed: { val: 300 },
            prepaidBalance: { val: 1_250 },
            history: [{ private: true }]
          },
          subscriptionTier: 'ignored-plan'
        },
        fetchedAt
      )

      expect(snapshot).toMatchObject({ provider: 'xai-grok', fetchedAt })
      expect(Array.from(snapshot.windows)).toEqual([
        expect.objectContaining({
          id: 'shared',
          usedPercent: 42.5,
          resetsAt: '2026-06-08T00:00:00.000Z',
          resetsAfterSeconds: 432_000,
          windowDurationMinutes: 10_080
        })
      ])
      expect(JSON.stringify(snapshot)).not.toContain('PRODUCT_GROK_BUILD')
      expect(JSON.stringify(snapshot)).not.toContain('ignored-plan')
    })
  )

  it.effect('treats an omitted modern percentage as zero only for a valid current period', () =>
    Effect.gen(function* () {
      const weekly = yield* parseXAiGrokSubscriptionUsage(
        {
          config: {
            currentPeriod: {
              type: 'USAGE_PERIOD_TYPE_WEEKLY',
              start: '2026-06-01T00:00:00Z',
              end: '2026-06-08T00:00:00Z'
            }
          }
        },
        fetchedAt
      )
      const daily = yield* parseXAiGrokSubscriptionUsage(
        {
          config: {
            currentPeriod: {
              type: 'USAGE_PERIOD_TYPE_DAILY',
              start: '2026-06-03T00:00:00Z',
              end: '2026-06-04T00:00:00Z'
            }
          }
        },
        fetchedAt
      )
      const unavailable = yield* parseXAiGrokSubscriptionUsage(
        {
          config: {
            currentPeriod: {
              type: 'USAGE_PERIOD_TYPE_MONTHLY',
              start: 'not-an-instant',
              end: '2026-07-01T00:00:00Z'
            }
          }
        },
        fetchedAt
      )

      expect(Array.from(weekly.windows)[0]).toMatchObject({ usedPercent: 0 })
      expect(Array.from(daily.windows)[0]).toMatchObject({
        usedPercent: 0,
        windowDurationMinutes: 1_440
      })
      expect(Array.from(unavailable.windows)).toEqual([])
    })
  )

  it.effect('prefers modern fields and falls back to a safe legacy allowance', () =>
    Effect.gen(function* () {
      const legacy = yield* parseXAiGrokSubscriptionUsage(
        {
          config: {
            monthlyLimit: { val: 2_000 },
            used: { val: 500 },
            billingPeriodStart: '2026-06-01T00:00:00Z',
            billingPeriodEnd: '2026-07-01T00:00:00Z'
          }
        },
        fetchedAt
      )
      const legacyProtoZero = yield* parseXAiGrokSubscriptionUsage(
        {
          config: {
            monthlyLimit: { val: 2_000 },
            used: {},
            billingPeriodStart: '2026-06-01T00:00:00Z',
            billingPeriodEnd: '2026-07-01T00:00:00Z'
          }
        },
        fetchedAt
      )
      const modern = yield* parseXAiGrokSubscriptionUsage(
        {
          config: {
            ...modernUsage(10).config,
            monthlyLimit: { val: 2_000 },
            used: { val: 1_500 }
          }
        },
        fetchedAt
      )

      expect(Array.from(legacy.windows)[0]).toMatchObject({
        id: 'shared',
        usedPercent: 25,
        resetsAt: '2026-07-01T00:00:00.000Z',
        windowDurationMinutes: 43_200
      })
      expect(Array.from(legacyProtoZero.windows)[0]).toMatchObject({ usedPercent: 0 })
      expect(Array.from(modern.windows)[0]).toMatchObject({ usedPercent: 10 })
    })
  )

  it.effect('fails safely for malformed, non-finite, and out-of-range percentages', () =>
    Effect.gen(function* () {
      const values: ReadonlyArray<unknown> = ['private malformed percent', Number.NaN, -1, 101]
      const results = yield* Effect.forEach(values, creditUsagePercent =>
        parseXAiGrokSubscriptionUsage(
          { config: { ...modernUsage().config, creditUsagePercent } },
          fetchedAt
        ).pipe(Effect.result)
      )

      expect(results.map(result => Result.isFailure(result) && result.failure.category)).toEqual([
        'invalid_response',
        'invalid_response',
        'invalid_response',
        'invalid_response'
      ])
      expect(JSON.stringify(results)).not.toContain('private malformed percent')
    })
  )

  it.effect('omits malformed period metadata when a valid modern percentage remains usable', () =>
    Effect.gen(function* () {
      const snapshot = yield* parseXAiGrokSubscriptionUsage(
        {
          config: {
            creditUsagePercent: 12,
            currentPeriod: {
              type: 'USAGE_PERIOD_TYPE_WEEKLY',
              start: 'invalid-start',
              end: '2026-06-08T00:00:00Z'
            }
          }
        },
        fetchedAt
      )

      expect(Array.from(snapshot.windows)).toEqual([
        expect.objectContaining({ id: 'shared', usedPercent: 12 })
      ])
      expect(Array.from(snapshot.windows)[0]).not.toHaveProperty('resetsAt')
      expect(Array.from(snapshot.windows)[0]).not.toHaveProperty('windowDurationMinutes')
    })
  )

  it.effect('fails safely for unsafe legacy values and invalid fetched timestamps', () =>
    Effect.gen(function* () {
      const legacyResult = yield* parseXAiGrokSubscriptionUsage(
        {
          config: {
            monthlyLimit: { val: 100 },
            used: { val: 101 }
          }
        },
        fetchedAt
      ).pipe(Effect.result)
      const fetchedAtResult = yield* parseXAiGrokSubscriptionUsage({}, 'not-an-instant').pipe(
        Effect.result
      )

      expect(Result.isFailure(legacyResult) && legacyResult.failure).toMatchObject({
        category: 'invalid_response',
        provider: 'xai-grok'
      })
      expect(Result.isFailure(fetchedAtResult) && fetchedAtResult.failure).toMatchObject({
        category: 'invalid_response',
        provider: 'xai-grok'
      })
    })
  )

  it.effect(
    'uses the fixed endpoint and exact conservative headers without a model override',
    () => {
      const requests: Array<HttpClientRequest.HttpClientRequest> = []
      const sentHeaders: Array<Record<string, string | undefined>> = []
      const client = HttpClient.make(request => {
        requests.push(request)
        sentHeaders.push({
          accept: request.headers.accept,
          authorization: request.headers.authorization,
          'x-xai-token-auth': request.headers['x-xai-token-auth'],
          'x-userid': request.headers['x-userid'],
          'x-grok-client-version': request.headers['x-grok-client-version'],
          'x-grok-client-mode': request.headers['x-grok-client-mode'],
          'x-grok-model-override': request.headers['x-grok-model-override']
        })
        return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(modernUsage(1))))
      })

      return Effect.gen(function* () {
        yield* fetchXAiGrokSubscriptionUsage(token, options).pipe(
          Effect.provideService(HttpClient.HttpClient, client)
        )

        expect(requests.map(request => [request.method, request.url])).toEqual([
          ['GET', xAiGrokSubscriptionUsageUrl]
        ])
        expect(sentHeaders).toEqual([
          {
            accept: 'application/json',
            authorization: 'Bearer grok-secret',
            'x-xai-token-auth': 'xai-grok-cli',
            'x-userid': 'xai-user-123',
            'x-grok-client-version': '2.4.0',
            'x-grok-client-mode': 'headless',
            'x-grok-model-override': undefined
          }
        ])
        expect(sentHeaders[0]?.['x-userid']).not.toBe(token.accountId)
      })
    }
  )

  it.effect(
    'rejects provider, identity, client-version, and timeout configuration before HTTP',
    () => {
      let called = false
      const client = HttpClient.make(request => {
        called = true
        return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({})))
      })

      return Effect.gen(function* () {
        const results = yield* Effect.all([
          fetchXAiGrokSubscriptionUsage(
            OAuthAccessToken.make({
              provider: 'openai-codex',
              accessToken: 'wrong-provider-secret',
              expiresAt: tokenExpiresAt
            }),
            options
          ).pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.result),
          fetchXAiGrokSubscriptionUsage(token, { ...options, xAiUserId: '   ' }).pipe(
            Effect.provideService(HttpClient.HttpClient, client),
            Effect.result
          ),
          fetchXAiGrokSubscriptionUsage(token, { ...options, clientVersion: '   ' }).pipe(
            Effect.provideService(HttpClient.HttpClient, client),
            Effect.result
          ),
          fetchXAiGrokSubscriptionUsage(token, { ...options, requestTimeoutMs: 0 }).pipe(
            Effect.provideService(HttpClient.HttpClient, client),
            Effect.result
          )
        ])

        expect(
          results.map(result =>
            Result.isFailure(result) &&
            result.failure._tag === 'ProviderSubscriptionUsageConfigurationError'
              ? result.failure.reason
              : undefined
          )
        ).toEqual([
          'provider_mismatch',
          'missing_xai_user_id',
          'missing_client_version',
          'invalid_request_timeout'
        ])
        expect(called).toBe(false)
      })
    }
  )

  it.effect('classifies sanitized auth, precondition, rate-limit, and response failures', () => {
    const responses = [
      new Response('private auth body', { status: 401 }),
      new Response('private forbidden body', { status: 403 }),
      new Response('{"error":"No personal team."}', { status: 412 }),
      new Response('private rate body', { status: 429, headers: { 'Retry-After': '120' } }),
      new Response('private malformed body', {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    ]
    let call = 0
    const client = HttpClient.make(request =>
      Effect.succeed(HttpClientResponse.fromWeb(request, responses[call++] ?? new Response()))
    )

    return Effect.gen(function* () {
      const results = yield* Effect.forEach([0, 1, 2, 3, 4], () =>
        fetchXAiGrokSubscriptionUsage(token, options).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.result
        )
      )

      expect(results.map(result => Result.isFailure(result) && result.failure._tag)).toEqual([
        'ProviderSubscriptionUsageAuthError',
        'ProviderSubscriptionUsageAuthError',
        'ProviderSubscriptionUsageResponseError',
        'ProviderSubscriptionUsageRateLimitError',
        'ProviderSubscriptionUsageResponseError'
      ])
      expect(Result.isFailure(results[2]) && results[2].failure).toMatchObject({
        category: 'http',
        status: 412
      })
      expect(Result.isFailure(results[3]) && results[3].failure).toMatchObject({
        retryAfterMs: 120_000
      })
      expect(JSON.stringify(results)).not.toContain('private')
      expect(JSON.stringify(results)).not.toContain('No personal team')
    })
  })

  it.effect('sanitizes network failures and configurable timeouts', () =>
    Effect.gen(function* () {
      const networkClient = HttpClient.make(request =>
        Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              cause: new Error('private network cause token=secret')
            })
          })
        )
      )
      const networkResult = yield* fetchXAiGrokSubscriptionUsage(token, options).pipe(
        Effect.provideService(HttpClient.HttpClient, networkClient),
        Effect.result
      )

      const timeoutClient = HttpClient.make(() => Effect.never)
      const timeoutFiber = yield* Effect.forkChild(
        fetchXAiGrokSubscriptionUsage(token, { ...options, requestTimeoutMs: 1_000 }).pipe(
          Effect.provideService(HttpClient.HttpClient, timeoutClient),
          Effect.result
        )
      )
      yield* TestClock.adjust(Duration.seconds(1))
      const timeoutResult = yield* Fiber.join(timeoutFiber)

      const stalledBodyClient = HttpClient.make(request =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(new ReadableStream<Uint8Array>({ start: () => undefined }), {
              headers: { 'Content-Type': 'application/json' }
            })
          )
        )
      )
      const bodyTimeoutFiber = yield* Effect.forkChild(
        fetchXAiGrokSubscriptionUsage(token, { ...options, requestTimeoutMs: 1_000 }).pipe(
          Effect.provideService(HttpClient.HttpClient, stalledBodyClient),
          Effect.result
        )
      )
      yield* TestClock.adjust(Duration.seconds(1))
      const bodyTimeoutResult = yield* Fiber.join(bodyTimeoutFiber)

      expect(Result.isFailure(networkResult) && networkResult.failure).toMatchObject({
        category: 'network',
        provider: 'xai-grok'
      })
      expect(Result.isFailure(timeoutResult) && timeoutResult.failure).toMatchObject({
        category: 'timeout',
        provider: 'xai-grok'
      })
      expect(Result.isFailure(bodyTimeoutResult) && bodyTimeoutResult.failure).toMatchObject({
        category: 'timeout',
        provider: 'xai-grok'
      })
      expect(JSON.stringify([networkResult, timeoutResult, bodyTimeoutResult])).not.toContain(
        'private'
      )
      expect(JSON.stringify([networkResult, timeoutResult, bodyTimeoutResult])).not.toContain(
        'secret'
      )
    })
  )

  it.effect('forces Fetch redirect handling to manual before sending credentials', () => {
    const redirectModes: Array<RequestRedirect | undefined> = []
    const fetch = (_input: RequestInfo | URL, init?: RequestInit) => {
      redirectModes.push(init?.redirect)
      return Promise.resolve(
        new Response('', {
          status: 302,
          headers: { location: 'https://evil.example/credential-target' }
        })
      )
    }

    return Effect.gen(function* () {
      const result = yield* fetchXAiGrokSubscriptionUsage(token, options).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
        Effect.result
      )

      expect(redirectModes).toEqual(['manual'])
      expect(Result.isFailure(result) && result.failure).toMatchObject({
        category: 'redirect',
        provider: 'xai-grok',
        status: 302
      })
      expect(JSON.stringify(result)).not.toContain('evil.example')
    })
  })

  it.effect('suppresses credential-bearing HTTP spans', () => {
    const spans: Array<Tracer.Span> = []
    const tracer = Tracer.make({
      span: spanOptions => {
        const span = new Tracer.NativeSpan(spanOptions)
        spans.push(span)
        return span
      }
    })
    const client = HttpClient.make(request =>
      Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(modernUsage(1))))
    )

    return Effect.gen(function* () {
      yield* fetchXAiGrokSubscriptionUsage(token, options).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provideService(Tracer.Tracer, tracer)
      )

      const trace = JSON.stringify(
        spans.map(span => ({ name: span.name, attributes: [...span.attributes.entries()] }))
      )
      expect(spans.map(span => span.name)).toEqual([
        'XAiGrokSubscriptionUsage.fetch',
        'XAiGrokSubscriptionUsage.parse'
      ])
      expect(trace).not.toContain('grok-secret')
      expect(trace).not.toContain('xai-user-123')
      expect(trace).not.toContain(xAiGrokSubscriptionUsageUrl)
    })
  })
})
