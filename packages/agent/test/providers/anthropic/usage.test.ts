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
  anthropicClaudeSubscriptionUsageUrl,
  fetchAnthropicClaudeSubscriptionUsage,
  parseAnthropicClaudeSubscriptionUsage
} from '../../../src/providers/anthropic/usage.ts'

const fetchedAt = '2026-08-11T08:00:00.000Z'
const tokenExpiresAt = 1_800_000_000_000
const token = OAuthAccessToken.make({
  provider: 'anthropic-claude',
  accessToken: 'anthropic-secret',
  expiresAt: tokenExpiresAt
})

describe('Anthropic Claude subscription usage', () => {
  it.effect('normalizes named windows, ignores unknown fields, and preserves resetless usage', () =>
    Effect.gen(function* () {
      const snapshot = yield* parseAnthropicClaudeSubscriptionUsage(
        {
          five_hour: {
            utilization: 72,
            resets_at: '2026-08-11T10:00:00+02:00',
            extra: true
          },
          seven_day: { utilization: 48.5 },
          unknown_limit: { utilization: 99 }
        },
        fetchedAt
      )

      expect(snapshot).toMatchObject({
        provider: 'anthropic-claude',
        fetchedAt
      })
      expect(Array.from(snapshot.windows)).toMatchObject([
        {
          id: 'five-hour',
          usedPercent: 72,
          resetsAt: '2026-08-11T08:00:00.000Z'
        },
        { id: 'seven-day', usedPercent: 48.5 }
      ])
    })
  )

  it.effect('uses the fixed endpoint and exact subscription authorization headers', () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    const client = HttpClient.make(request => {
      requests.push(request)

      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({
            five_hour: { utilization: 1, resets_at: '2027-01-01T00:00:00Z' }
          })
        )
      )
    })

    return Effect.gen(function* () {
      yield* fetchAnthropicClaudeSubscriptionUsage(token).pipe(
        Effect.provideService(HttpClient.HttpClient, client)
      )

      expect(requests.map(request => [request.method, request.url])).toEqual([
        ['GET', anthropicClaudeSubscriptionUsageUrl]
      ])
      expect(requests[0]?.headers.authorization).toBe('Bearer anthropic-secret')
      expect(requests[0]?.headers['anthropic-beta']).toBe('oauth-2025-04-20')
    })
  })

  it.effect('rejects mismatched tokens before making an HTTP request', () => {
    let called = false
    const client = HttpClient.make(request => {
      called = true
      return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({})))
    })

    return Effect.gen(function* () {
      const result = yield* fetchAnthropicClaudeSubscriptionUsage(
        OAuthAccessToken.make({
          provider: 'openai-codex',
          accessToken: 'wrong-provider-secret',
          expiresAt: tokenExpiresAt
        })
      ).pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.result)

      expect(Result.isFailure(result) && result.failure).toMatchObject({
        _tag: 'ProviderSubscriptionUsageConfigurationError',
        reason: 'provider_mismatch'
      })
      expect(called).toBe(false)
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
      const networkResult = yield* fetchAnthropicClaudeSubscriptionUsage(token).pipe(
        Effect.provideService(HttpClient.HttpClient, networkClient),
        Effect.result
      )

      const timeoutClient = HttpClient.make(() => Effect.never)
      const timeoutFiber = yield* Effect.forkChild(
        fetchAnthropicClaudeSubscriptionUsage(token, { requestTimeoutMs: 1_000 }).pipe(
          Effect.provideService(HttpClient.HttpClient, timeoutClient),
          Effect.result
        )
      )
      yield* TestClock.adjust(Duration.seconds(1))
      const timeoutResult = yield* Fiber.join(timeoutFiber)

      expect(Result.isFailure(networkResult) && networkResult.failure).toMatchObject({
        category: 'network',
        provider: 'anthropic-claude'
      })
      expect(Result.isFailure(timeoutResult) && timeoutResult.failure).toMatchObject({
        category: 'timeout',
        provider: 'anthropic-claude'
      })
      expect(JSON.stringify([networkResult, timeoutResult])).not.toContain('private')
      expect(JSON.stringify([networkResult, timeoutResult])).not.toContain('secret')
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
      const result = yield* fetchAnthropicClaudeSubscriptionUsage(token).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
        Effect.result
      )

      expect(redirectModes).toEqual(['manual'])
      expect(Result.isFailure(result) && result.failure).toMatchObject({
        category: 'redirect',
        provider: 'anthropic-claude',
        status: 302
      })
      expect(JSON.stringify(result)).not.toContain('evil.example')
    })
  })

  it.effect('suppresses credential-bearing HTTP spans', () => {
    const spans: Array<Tracer.Span> = []
    const tracer = Tracer.make({
      span: options => {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      }
    })
    const client = HttpClient.make(request =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({
            five_hour: { utilization: 1, resets_at: '2027-01-01T00:00:00Z' }
          })
        )
      )
    )

    return Effect.gen(function* () {
      yield* fetchAnthropicClaudeSubscriptionUsage(token).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provideService(Tracer.Tracer, tracer)
      )

      const trace = JSON.stringify(
        spans.map(span => ({ name: span.name, attributes: [...span.attributes.entries()] }))
      )
      expect(spans.map(span => span.name)).toEqual([
        'AnthropicClaudeSubscriptionUsage.fetch',
        'AnthropicClaudeSubscriptionUsage.parse'
      ])
      expect(trace).not.toContain('anthropic-secret')
      expect(trace).not.toContain(anthropicClaudeSubscriptionUsageUrl)
    })
  })
})
