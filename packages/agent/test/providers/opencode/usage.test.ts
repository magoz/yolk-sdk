import { Duration, Effect, Fiber, Redacted, Tracer } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import * as TestClock from 'effect/testing/TestClock'
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientResponse,
  type HttpClientRequest
} from 'effect/unstable/http'
import {
  fetchOpenCodeGoSubscriptionUsage,
  openCodeGoSubscriptionUsageUrl,
  parseOpenCodeGoSubscriptionUsage
} from '@yolk-sdk/agent/providers/opencode/usage'

const apiKey = Redacted.make('go-secret')

const fetchedAt = '2026-09-15T12:00:00.000Z'

const wire = {
  usage: {
    rolling: { status: 'ok', percent: 25, resetsAt: '2026-09-15T14:00:00Z' },
    weekly: { status: 'ok', percent: 40.5, resetsAt: '2026-09-21T00:00:00Z' },
    monthly: { status: 'rate-limited', percent: 100, resetsAt: '2026-10-11T12:34:56Z' }
  }
}

const clientFor = (response: Response) =>
  HttpClient.make(request => Effect.succeed(HttpClientResponse.fromWeb(request, response)))

describe('OpenCode Go subscription usage', () => {
  it.effect('normalizes all three used-percentage windows and provider reset instants', () =>
    Effect.gen(function* () {
      const snapshot = yield* parseOpenCodeGoSubscriptionUsage(wire, fetchedAt)
      expect(snapshot.provider).toBe('opencode_go')
      expect(snapshot.fetchedAt).toBe(fetchedAt)
      expect(Array.from(snapshot.windows)).toMatchObject([
        { id: 'five-hour', usedPercent: 25, resetsAt: '2026-09-15T14:00:00.000Z' },
        { id: 'seven-day', usedPercent: 40.5, resetsAt: '2026-09-21T00:00:00.000Z' },
        { id: 'monthly', usedPercent: 100, resetsAt: '2026-10-11T12:34:56.000Z' }
      ])
      expect(
        Array.from(snapshot.windows).every(window => window.windowDurationMinutes === undefined)
      ).toBe(true)
    })
  )

  it.effect('omits absent or invalid usage, never fabricates zero or reset dates', () =>
    Effect.gen(function* () {
      const snapshot = yield* parseOpenCodeGoSubscriptionUsage(
        {
          usage: {
            rolling: { percent: 0, resetsAt: 'bad-date' },
            weekly: null,
            monthly: { percent: 101 },
            extra: { percent: 99 }
          }
        },
        fetchedAt
      )

      expect(Array.from(snapshot.windows)).toMatchObject([{ id: 'five-hour', usedPercent: 0 }])
      expect(Array.from(snapshot.windows)[0]?.resetsAt).toBeUndefined()

      for (const percent of [null, undefined, -1, 101, NaN, Infinity]) {
        const parsed = yield* parseOpenCodeGoSubscriptionUsage(
          { usage: { rolling: { percent } } },
          fetchedAt
        )

        expect(Array.from(parsed.windows)).toHaveLength(0)
      }

      const empty = yield* parseOpenCodeGoSubscriptionUsage({ usage: {} }, fetchedAt)
      expect(Array.from(empty.windows)).toHaveLength(0)
    })
  )

  it.effect('rejects malformed wire values and invalid fetchedAt', () =>
    Effect.gen(function* () {
      for (const value of [
        null,
        [],
        {},
        { usage: null },
        { usage: { rolling: { percent: '25' } } }
      ]) {
        const error = yield* parseOpenCodeGoSubscriptionUsage(value, fetchedAt).pipe(Effect.flip)
        expect(error).toMatchObject({ category: 'invalid_response', provider: 'opencode_go' })
      }

      const error = yield* parseOpenCodeGoSubscriptionUsage(wire, 'bad-date').pipe(Effect.flip)
      expect(error.category).toBe('invalid_response')
    })
  )

  it.effect(
    'uses the fixed GET endpoint and Bearer API key without OAuth or workspace headers',
    () =>
      Effect.gen(function* () {
        const requests: Array<HttpClientRequest.HttpClientRequest> = []

        const client = HttpClient.make(request => {
          requests.push(request)

          return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(wire)))
        })

        const snapshot = yield* fetchOpenCodeGoSubscriptionUsage(apiKey).pipe(
          Effect.provideService(HttpClient.HttpClient, client)
        )

        expect(requests.map(request => [request.method, request.url])).toEqual([
          ['GET', openCodeGoSubscriptionUsageUrl]
        ])
        expect(requests[0]?.headers).toMatchObject({
          accept: 'application/json',
          authorization: 'Bearer go-secret'
        })
        expect(requests[0]?.headers).not.toHaveProperty('cookie')
        expect(requests[0]?.headers).not.toHaveProperty('chatgpt-account-id')
        expect(Array.from(snapshot.windows)).toHaveLength(3)
      })
  )

  it.effect('validates key and timeout before HTTP', () =>
    Effect.gen(function* () {
      let called = false

      const client = HttpClient.make(request => {
        called = true

        return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(wire)))
      })

      const keyError = yield* fetchOpenCodeGoSubscriptionUsage(Redacted.make(' ')).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.flip
      )

      expect(keyError).toMatchObject({ reason: 'missing_api_key' })

      for (const requestTimeoutMs of [0, -1, NaN, Infinity]) {
        const error = yield* fetchOpenCodeGoSubscriptionUsage(apiKey, { requestTimeoutMs }).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.flip
        )

        expect(error).toMatchObject({ reason: 'invalid_request_timeout' })
      }

      expect(called).toBe(false)
    })
  )

  for (const status of [401, 403, 429, 500]) {
    it.effect(`classifies HTTP ${status} without retaining response secrets`, () =>
      Effect.gen(function* () {
        const error = yield* fetchOpenCodeGoSubscriptionUsage(apiKey).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            clientFor(
              new Response('private go-secret', { status, headers: { 'retry-after': '2' } })
            )
          ),
          Effect.flip
        )

        expect(error.provider).toBe('opencode_go')

        if (status === 401 || status === 403) {
          expect(error).toMatchObject({ _tag: 'ProviderSubscriptionUsageAuthError', status })
        } else if (status === 429) {
          expect(error).toMatchObject({
            _tag: 'ProviderSubscriptionUsageRateLimitError',
            retryAfterMs: 2000
          })
        } else {
          expect(error).toMatchObject({
            _tag: 'ProviderSubscriptionUsageResponseError',
            category: 'http',
            status
          })
        }

        expect(JSON.stringify(error)).not.toContain('private')
        expect(JSON.stringify(error)).not.toContain('go-secret')
      })
    )
  }

  it.effect('forces manual redirects and never forwards credentials to a redirected origin', () =>
    Effect.gen(function* () {
      const modes: Array<RequestRedirect | undefined> = []

      const fetch = (_input: RequestInfo | URL, init?: RequestInit) => {
        modes.push(init?.redirect)

        return Promise.resolve(
          new Response('', { status: 302, headers: { location: 'https://evil.example' } })
        )
      }

      const error = yield* fetchOpenCodeGoSubscriptionUsage(apiKey).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
        Effect.flip
      )

      expect(modes).toEqual(['manual'])
      expect(error).toMatchObject({ category: 'redirect', status: 302 })
      expect(JSON.stringify(error)).not.toContain('evil.example')
    })
  )

  it.effect('sanitizes network and JSON errors, and times out stalled requests', () =>
    Effect.gen(function* () {
      const client = HttpClient.make(request =>
        Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              cause: new Error('private go-secret')
            })
          })
        )
      )

      const error = yield* fetchOpenCodeGoSubscriptionUsage(apiKey).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.flip
      )

      expect(error).toMatchObject({ category: 'network' })
      expect(JSON.stringify(error)).not.toContain('go-secret')

      const invalid = yield* fetchOpenCodeGoSubscriptionUsage(apiKey).pipe(
        Effect.provideService(HttpClient.HttpClient, clientFor(new Response('private go-secret'))),
        Effect.flip
      )

      expect(invalid).toMatchObject({ category: 'invalid_response' })
      expect(JSON.stringify(invalid)).not.toContain('go-secret')

      const fiber = yield* Effect.forkChild(
        fetchOpenCodeGoSubscriptionUsage(apiKey, { requestTimeoutMs: 1000 }).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.never)
          ),
          Effect.flip
        )
      )

      yield* TestClock.adjust(Duration.seconds(1))
      expect(yield* Fiber.join(fiber)).toMatchObject({ category: 'timeout' })
    })
  )

  it.effect('suppresses credential-bearing HTTP spans', () =>
    Effect.gen(function* () {
      const spans: Array<Tracer.Span> = []

      const tracer = Tracer.make({
        span: options => {
          const span = new Tracer.NativeSpan(options)
          spans.push(span)

          return span
        }
      })

      yield* fetchOpenCodeGoSubscriptionUsage(apiKey).pipe(
        Effect.provideService(HttpClient.HttpClient, clientFor(Response.json(wire))),
        Effect.provideService(Tracer.Tracer, tracer)
      )

      const trace = JSON.stringify(
        spans.map(span => ({ name: span.name, attributes: Array.from(span.attributes) }))
      )

      expect(trace).not.toContain('go-secret')
      expect(trace).not.toContain('authorization')
    })
  )
})
