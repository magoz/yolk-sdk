import { Effect, Result } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/unstable/http'
import type { HttpClientRequest } from 'effect/unstable/http'
import { describe, expect, it } from '@effect/vitest'
import { OAuthAccessToken } from '@yolk-sdk/agent/oauth'
import {
  fetchOpenAiCodexSubscriptionUsage,
  openAiCodexSubscriptionUsageUrl,
  parseOpenAiCodexSubscriptionUsage
} from '../../../src/providers/openai/codex-usage.ts'

const fetchedAt = '2026-08-11T08:00:00.000Z'
const token = OAuthAccessToken.make({
  provider: 'openai-codex',
  accessToken: 'codex-secret',
  expiresAt: Date.now() + 60_000,
  accountId: 'redacted-account'
})

describe('OpenAI Codex subscription usage', () => {
  it.effect('normalizes windows without hardcoding labels or durations', () =>
    Effect.gen(function* () {
      const snapshot = yield* parseOpenAiCodexSubscriptionUsage(
        {
          rate_limit: {
            primary_window: {
              used_percent: 80,
              limit_window_seconds: 10_800,
              reset_after_seconds: 100,
              reset_at: 1_786_435_200
            },
            secondary_window: {
              used_percent: 55,
              limit_window_seconds: 604_800,
              reset_after_seconds: 300
            }
          },
          credits: { balance: 'ignored' }
        },
        fetchedAt
      )

      expect(snapshot).toMatchObject({
        provider: 'openai-codex',
        fetchedAt,
        windows: [
          {
            id: 'primary',
            usedPercent: 80,
            windowDurationMinutes: 180,
            resetsAfterSeconds: 100,
            resetsAt: '2026-08-11T08:00:00.000Z'
          },
          {
            id: 'secondary',
            usedPercent: 55,
            windowDurationMinutes: 10_080,
            resetsAfterSeconds: 300
          }
        ]
      })
    })
  )

  it.effect('uses the fixed endpoint and required account header', () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    const client = HttpClient.make(request => {
      requests.push(request)

      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({
            rate_limit: {
              primary_window: { used_percent: 2, reset_at: 1_798_761_600 }
            }
          })
        )
      )
    })

    return Effect.gen(function* () {
      yield* fetchOpenAiCodexSubscriptionUsage(token).pipe(
        Effect.provideService(HttpClient.HttpClient, client)
      )

      expect(requests.map(request => [request.method, request.url])).toEqual([
        ['GET', openAiCodexSubscriptionUsageUrl]
      ])
      expect(requests[0]?.headers.authorization).toBe('Bearer codex-secret')
      expect(requests[0]?.headers['chatgpt-account-id']).toBe('redacted-account')
    })
  })

  it.effect('fails before HTTP when the account id is missing or blank', () => {
    let called = false
    const client = HttpClient.make(request => {
      called = true
      return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({})))
    })

    return Effect.gen(function* () {
      const results = yield* Effect.forEach([undefined, '   '], accountId =>
        fetchOpenAiCodexSubscriptionUsage(
          OAuthAccessToken.make({
            provider: 'openai-codex',
            accessToken: 'secret',
            expiresAt: Date.now() + 60_000,
            ...(accountId === undefined ? {} : { accountId })
          })
        ).pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.result)
      )

      expect(results.map(result => Result.isFailure(result) && result.failure)).toEqual([
        expect.objectContaining({
          _tag: 'ProviderSubscriptionUsageConfigurationError',
          reason: 'missing_account_id'
        }),
        expect.objectContaining({
          _tag: 'ProviderSubscriptionUsageConfigurationError',
          reason: 'missing_account_id'
        })
      ])
      expect(called).toBe(false)
    })
  })

  it.effect('rejects invalid request timeouts before HTTP', () => {
    let called = false
    const client = HttpClient.make(request => {
      called = true
      return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({})))
    })

    return Effect.gen(function* () {
      const result = yield* fetchOpenAiCodexSubscriptionUsage(token, {
        requestTimeoutMs: 0
      }).pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.result)

      expect(Result.isFailure(result) && result.failure).toMatchObject({
        _tag: 'ProviderSubscriptionUsageConfigurationError',
        reason: 'invalid_request_timeout'
      })
      expect(called).toBe(false)
    })
  })

  it.effect('classifies safe HTTP failures without retaining response bodies', () => {
    const responses = [
      new Response('private auth body', { status: 401 }),
      new Response('private rate body', { status: 429, headers: { 'Retry-After': '120' } }),
      new Response('', { status: 302, headers: { Location: 'https://evil.example/token' } }),
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
      const results = yield* Effect.forEach([0, 1, 2, 3], () =>
        fetchOpenAiCodexSubscriptionUsage(token).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.result
        )
      )

      expect(results.map(result => Result.isFailure(result) && result.failure._tag)).toEqual([
        'ProviderSubscriptionUsageAuthError',
        'ProviderSubscriptionUsageRateLimitError',
        'ProviderSubscriptionUsageResponseError',
        'ProviderSubscriptionUsageResponseError'
      ])
      const rateLimitResult = results.at(1)
      expect(
        rateLimitResult !== undefined &&
          Result.isFailure(rateLimitResult) &&
          rateLimitResult.failure
      ).toMatchObject({
        retryAfterMs: 120_000
      })
      expect(JSON.stringify(results)).not.toContain('private')
      expect(JSON.stringify(results)).not.toContain('evil.example')
    })
  })

  it.effect('rejects malformed wire types without exposing the provider payload', () =>
    Effect.gen(function* () {
      const result = yield* parseOpenAiCodexSubscriptionUsage(
        {
          rate_limit: {
            primary_window: { used_percent: 'private malformed value' }
          }
        },
        fetchedAt
      ).pipe(Effect.result)

      expect(Result.isFailure(result) && result.failure).toMatchObject({
        category: 'invalid_response',
        provider: 'openai-codex'
      })
      expect(JSON.stringify(result)).not.toContain('private malformed value')
    })
  )

  it.effect('rejects a non-instant fetchedAt value', () =>
    Effect.gen(function* () {
      const result = yield* parseOpenAiCodexSubscriptionUsage({}, 'not-an-instant').pipe(
        Effect.result
      )

      expect(Result.isFailure(result) && result.failure).toMatchObject({
        category: 'invalid_response',
        provider: 'openai-codex'
      })
    })
  )
})
