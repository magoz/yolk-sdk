/**
 * Cross-checks: the subscription-usage routes of the Anthropic, Codex, Grok, and OpenCode Go
 * emulators must satisfy the same usage conformance cases the replayed fixtures satisfy, through
 * the real public usage fetchers, both in-process and over a loopback socket; disagreement drills
 * must fail the usage case; and wire faults must map to the fetchers' typed errors (401 auth, 429
 * `retry-after` rate limit, a dropped connection, a truncated body). Tests may import SDK
 * packages; the emulator source never does.
 */
import { Effect, Layer, Redacted } from 'effect'
import { FetchHttpClient, type HttpClient } from 'effect/unstable/http'
import { describe, expect, it } from '@effect/vitest'
import type { ConformanceCase, ConformanceMismatch } from '@yolk-sdk/conformance/case'
import { formatConformanceReport, runConformance } from '@yolk-sdk/conformance/runner'
import type { LLMProviderError } from '@yolk-sdk/agent/loop'
import { OAuthAccessToken } from '@yolk-sdk/agent/oauth'
import {
  AnthropicClaudeUsageConformanceConfig,
  anthropicClaudeUsageConformanceUrl,
  anthropicClaudeUsageSnapshotCase
} from '@yolk-sdk/agent/providers/anthropic/conformance'
import { fetchAnthropicClaudeSubscriptionUsage } from '@yolk-sdk/agent/providers/anthropic/usage'
import {
  OpenAiCodexUsageConformanceConfig,
  openAiCodexUsageConformanceUrl,
  openAiCodexUsageSnapshotCase
} from '@yolk-sdk/agent/providers/openai/conformance'
import { fetchOpenAiCodexSubscriptionUsage } from '@yolk-sdk/agent/providers/openai/codex-usage'
import {
  OpenCodeGoConformanceConfig,
  openCodeGoConformanceDefaultModels,
  openCodeGoConformanceUsageUrl,
  openCodeGoUsageSnapshotCase
} from '@yolk-sdk/agent/providers/opencode/conformance'
import { fetchOpenCodeGoSubscriptionUsage } from '@yolk-sdk/agent/providers/opencode/usage'
import type {
  ProviderSubscriptionUsageError,
  ProviderSubscriptionUsageSnapshot
} from '@yolk-sdk/agent/providers/subscription-usage'
import {
  XAiGrokUsageConformanceConfig,
  xAiGrokUsageConformanceUrl,
  xAiGrokUsageSnapshotCase
} from '@yolk-sdk/agent/providers/xai/conformance'
import { fetchXAiGrokSubscriptionUsage } from '@yolk-sdk/agent/providers/xai/usage'
import { makeAnthropicEmulator } from '../src/anthropic.ts'
import { makeCodexEmulator } from '../src/codex.ts'
import { serveFetchHandler } from '../src/node.ts'
import { makeOpenCodeGoEmulator } from '../src/opencode.ts'
import { EmulatedHttpClient, EmulatorRoute, InProcessHttpClient } from '../src/router.ts'
import type {
  SubscriptionUsageEmulator,
  SubscriptionUsageScriptedTurn
} from '../src/subscription-usage.ts'
import { makeXAiGrokEmulator } from '../src/xai.ts'

const now = new Date('2026-09-30T12:00:00.000Z')

const expiresAt = 4_000_000_000_000

const claudeToken = new OAuthAccessToken({
  provider: 'anthropic-claude',
  accessToken: 'synthetic-claude-oauth-token',
  expiresAt
})

const codexToken = new OAuthAccessToken({
  provider: 'openai-codex',
  accessToken: 'synthetic-codex-oauth-token',
  expiresAt,
  accountId: 'synthetic-account'
})

const grokToken = new OAuthAccessToken({
  provider: 'xai-grok',
  accessToken: 'synthetic-grok-oauth-token',
  expiresAt
})

const goKey = Redacted.make('synthetic-go-key')

/** A fetch handler with its usage part. */
type UsageHost = {
  readonly fetch: (request: Request) => Promise<Response>
  readonly usage: SubscriptionUsageEmulator
}

type Family<Req> = {
  readonly name: string
  readonly origin: string
  readonly make: () => UsageHost
  readonly testCase: ConformanceCase<
    LLMProviderError | ProviderSubscriptionUsageError | ConformanceMismatch,
    HttpClient.HttpClient | Req
  >
  readonly configLayer: Layer.Layer<Req>
  readonly fetch: Effect.Effect<
    ProviderSubscriptionUsageSnapshot,
    ProviderSubscriptionUsageError,
    HttpClient.HttpClient
  >
  /** Window ids of the emulator's default body. */
  readonly windowIds: ReadonlyArray<string>
  /** A body with the recorded shape whose percentages are all out of range. */
  readonly outOfRange: SubscriptionUsageScriptedTurn
  /** How the usage case fails for `outOfRange`. */
  readonly outOfRangeFailure: { readonly tag: string; readonly message?: string }
  /** Non-credential headers the usage ledger records. */
  readonly recorded: Readonly<Record<string, string>>
}

const claude: Family<AnthropicClaudeUsageConformanceConfig> = {
  name: 'Claude',
  origin: new URL(anthropicClaudeUsageConformanceUrl).origin,
  make: makeAnthropicEmulator,
  testCase: anthropicClaudeUsageSnapshotCase,
  configLayer: Layer.succeed(AnthropicClaudeUsageConformanceConfig, { token: claudeToken }),
  fetch: fetchAnthropicClaudeSubscriptionUsage(claudeToken),
  windowIds: ['five-hour', 'seven-day'],
  outOfRange: {
    usage: {
      five_hour: { utilization: 101, resets_at: '2026-10-01T05:00:00.000Z' },
      seven_day: { utilization: 102, resets_at: '2026-10-06T00:00:00.000Z' }
    }
  },
  outOfRangeFailure: { tag: 'ConformanceMismatch', message: 'expected at least one usage window' },
  recorded: { 'anthropic-beta': 'oauth-2025-04-20' }
}

const codex: Family<OpenAiCodexUsageConformanceConfig> = {
  name: 'Codex',
  origin: new URL(openAiCodexUsageConformanceUrl).origin,
  make: makeCodexEmulator,
  testCase: openAiCodexUsageSnapshotCase,
  configLayer: Layer.succeed(OpenAiCodexUsageConformanceConfig, { token: codexToken }),
  fetch: fetchOpenAiCodexSubscriptionUsage(codexToken),
  windowIds: ['primary', 'secondary'],
  outOfRange: {
    usage: {
      rate_limit: {
        primary_window: {
          used_percent: 101,
          limit_window_seconds: 18000,
          reset_after_seconds: 7200,
          reset_at: 1790007200
        },
        secondary_window: {
          used_percent: 102,
          limit_window_seconds: 604800,
          reset_after_seconds: 259200,
          reset_at: 1790259200
        }
      }
    }
  },
  outOfRangeFailure: { tag: 'ConformanceMismatch', message: 'expected at least one usage window' },
  recorded: {}
}

const grok: Family<XAiGrokUsageConformanceConfig> = {
  name: 'Grok',
  origin: new URL(xAiGrokUsageConformanceUrl).origin,
  make: makeXAiGrokEmulator,
  testCase: xAiGrokUsageSnapshotCase,
  configLayer: Layer.succeed(XAiGrokUsageConformanceConfig, {
    token: grokToken,
    xAiUserId: 'synthetic-user',
    clientVersion: '0.0.0-synthetic'
  }),
  fetch: fetchXAiGrokSubscriptionUsage(grokToken, {
    xAiUserId: 'synthetic-user',
    clientVersion: '0.0.0-synthetic'
  }),
  windowIds: ['shared'],
  outOfRange: {
    usage: {
      config: {
        creditUsagePercent: 101,
        currentPeriod: {
          type: 'monthly',
          start: '2026-09-01T00:00:00.000Z',
          end: '2026-10-01T00:00:00.000Z'
        }
      }
    }
  },
  // The Grok parser rejects an out-of-range credit percentage as an invalid response.
  outOfRangeFailure: { tag: 'ProviderSubscriptionUsageResponseError' },
  recorded: { 'x-grok-client-version': '0.0.0-synthetic', 'x-grok-client-mode': 'headless' }
}

const go: Family<OpenCodeGoConformanceConfig> = {
  name: 'OpenCode Go',
  origin: new URL(openCodeGoConformanceUsageUrl).origin,
  make: makeOpenCodeGoEmulator,
  testCase: openCodeGoUsageSnapshotCase,
  configLayer: Layer.succeed(OpenCodeGoConformanceConfig, {
    apiKey: goKey,
    maxOutputTokens: 64,
    models: openCodeGoConformanceDefaultModels
  }),
  fetch: fetchOpenCodeGoSubscriptionUsage(goKey),
  windowIds: ['five-hour', 'seven-day', 'monthly'],
  outOfRange: {
    usage: {
      usage: {
        rolling: { percent: 101, resetsAt: '2026-10-01T03:00:00.000Z' },
        weekly: { percent: 102, resetsAt: '2026-10-05T00:00:00.000Z' },
        monthly: { percent: 103, resetsAt: '2026-10-31T00:00:00.000Z' }
      }
    }
  },
  outOfRangeFailure: { tag: 'ConformanceMismatch', message: 'expected at least one usage window' },
  recorded: {}
}

const describeFamily = <Req>(family: Family<Req>) => {
  const inProcessLayer = (host: UsageHost) =>
    InProcessHttpClient.layer([EmulatorRoute.handler(family.origin, host.fetch)])

  const emulatedLayer = (host: UsageHost) =>
    Layer.unwrap(
      serveFetchHandler(host.fetch).pipe(
        Effect.map(server =>
          EmulatedHttpClient.layer([EmulatorRoute.url(family.origin, server.url)]).pipe(
            Layer.provide(FetchHttpClient.layer)
          )
        )
      )
    )

  const drill = (prepare: (usage: SubscriptionUsageEmulator) => void) =>
    runConformance([family.testCase], {
      target: { kind: 'in-process' },
      now,
      layer: () => {
        const host = family.make()

        prepare(host.usage)

        return Layer.mergeAll(inProcessLayer(host), family.configLayer)
      }
    }).pipe(Effect.map(report => report.results[0]))

  const fetchWith = (prepare: (usage: SubscriptionUsageEmulator) => void) => {
    const host = family.make()

    prepare(host.usage)

    return family.fetch.pipe(Effect.provide(inProcessLayer(host)))
  }

  describe(`${family.name} usage case against the emulator`, () => {
    it.effect('passes in-process', () =>
      Effect.gen(function* () {
        const report = yield* runConformance([family.testCase], {
          target: { kind: 'in-process' },
          now,
          layer: () => Layer.mergeAll(inProcessLayer(family.make()), family.configLayer)
        })

        expect(report.summary, formatConformanceReport(report)).toEqual({
          passed: 1,
          failed: 0,
          skipped: 0
        })
      })
    )

    it.effect('passes over a loopback socket and records the claimed request', () =>
      Effect.gen(function* () {
        const host = family.make()

        const report = yield* runConformance([family.testCase], {
          target: { kind: 'emulated' },
          now,
          layer: () => Layer.mergeAll(emulatedLayer(host), family.configLayer)
        })

        expect(report.summary, formatConformanceReport(report)).toEqual({
          passed: 1,
          failed: 0,
          skipped: 0
        })
        expect(host.usage.ledger.entries()).toMatchObject([
          {
            method: 'GET',
            credentialHeader: 'authorization',
            headers: family.recorded,
            evidence: 'unverified',
            status: 200
          }
        ])
      }).pipe(Effect.scoped)
    )

    it.effect('normalizes the default body into the family windows', () =>
      Effect.gen(function* () {
        const snapshot = yield* fetchWith(() => undefined)

        expect(Array.from(snapshot.windows).map(window => window.id)).toEqual(family.windowIds)
      })
    )
  })

  describe(`${family.name} usage drills and faults (emulator)`, () => {
    it.effect('fails the case for a same-shaped body with out-of-range percentages', () =>
      Effect.gen(function* () {
        expect(
          (yield* drill(usage => usage.script.enqueue(family.outOfRange)))?.failure
        ).toMatchObject(family.outOfRangeFailure)
      })
    )

    it.effect(
      'maps 401, 429 retry-after, a dropped connection, and truncation to typed errors',
      () =>
        Effect.gen(function* () {
          const unauthorized = yield* fetchWith(usage =>
            usage.faults.add({ kind: 'status', status: 401 })
          ).pipe(Effect.flip)

          expect(unauthorized).toMatchObject({
            _tag: 'ProviderSubscriptionUsageAuthError',
            status: 401
          })

          const limited = yield* fetchWith(usage =>
            usage.faults.add({ kind: 'status', status: 429, headers: { 'retry-after': '4' } })
          ).pipe(Effect.flip)

          expect(limited).toMatchObject({
            _tag: 'ProviderSubscriptionUsageRateLimitError',
            retryAfterMs: 4000
          })

          const dropped = yield* fetchWith(usage =>
            usage.faults.add({ kind: 'error-after-chunks', chunks: 0 })
          ).pipe(Effect.flip)

          expect(dropped._tag).toBe('ProviderSubscriptionUsageResponseError')

          const truncated = yield* fetchWith(usage =>
            usage.faults.add({ kind: 'truncate-after-chunks', chunks: 0 })
          ).pipe(Effect.flip)

          expect(truncated).toMatchObject({
            _tag: 'ProviderSubscriptionUsageResponseError',
            category: 'invalid_response'
          })
        })
    )
  })
}

describeFamily(claude)

describeFamily(codex)

describeFamily(grok)

describeFamily(go)
