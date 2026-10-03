/**
 * Subscription-usage conformance cases for Claude (`providers/anthropic/conformance`), Codex
 * (`providers/openai/conformance`), Grok (`providers/xai/conformance`), and OpenCode Go
 * (`providers/opencode/conformance`): replay, request claims through the replay ledger, and
 * structural drills over the parsed fixture bodies, plus fabrication drills that prove the
 * shared claim catches a snapshot that disagrees with the wire.
 */
import { Chunk, Effect, Layer, Predicate, Redacted, Ref } from 'effect'
import type * as Schema from 'effect/Schema'
import { HttpClient } from 'effect/http'
import { describe, expect, it } from '@effect/vitest'
import {
  decodeWireFixture,
  scanFixtureForSecrets,
  type WireFixture
} from '@yolk-sdk/conformance/fixture'
import {
  makeReplayHttpClient,
  ReplayHttpClient,
  type ReplayLedgerApi
} from '@yolk-sdk/conformance/replay'
import { formatConformanceReport, runConformance } from '@yolk-sdk/conformance/runner'
import type { ConformanceCase, ConformanceMismatch } from '@yolk-sdk/conformance/case'
import type { LLMProviderError } from '@yolk-sdk/agent/loop'
import { OAuthAccessToken } from '@yolk-sdk/agent/oauth'
import {
  ProviderSubscriptionUsageSnapshot,
  ProviderSubscriptionUsageWindow,
  type ProviderSubscriptionUsageError
} from '@yolk-sdk/agent/providers/subscription-usage'
import {
  AnthropicClaudeUsageConformanceConfig,
  anthropicClaudeUsageConformanceCases,
  anthropicClaudeUsageConformanceFixtures,
  anthropicClaudeUsageConformanceUrl,
  anthropicClaudeUsageSnapshotCase,
  anthropicClaudeUsageSnapshotFixture
} from '../../src/providers/anthropic/conformance/index.ts'
import {
  fetchAnthropicClaudeSubscriptionUsage,
  parseAnthropicClaudeSubscriptionUsage
} from '../../src/providers/anthropic/usage.ts'
import { parseOpenAiCodexSubscriptionUsage } from '../../src/providers/openai/codex-usage.ts'
import { parseOpenCodeGoSubscriptionUsage } from '../../src/providers/opencode/usage.ts'
import { parseXAiGrokSubscriptionUsage } from '../../src/providers/xai/usage.ts'
import {
  OpenAiCodexUsageConformanceConfig,
  openAiCodexUsageConformanceCases,
  openAiCodexUsageConformanceFixtures,
  openAiCodexUsageConformanceUrl,
  openAiCodexUsageSnapshotCase,
  openAiCodexUsageSnapshotFixture
} from '../../src/providers/openai/conformance/index.ts'
import {
  makeSubscriptionUsageConformanceCase,
  wireField,
  wireInstant,
  wirePercent
} from '../../src/providers/openai/conformance/subscription-usage-cases-internal.ts'
import {
  OpenCodeGoConformanceConfig,
  openCodeGoConformanceDefaultModels,
  openCodeGoConformanceUsageUrl,
  openCodeGoUsageSnapshotCase,
  openCodeGoUsageSnapshotFixture
} from '../../src/providers/opencode/conformance/index.ts'
import {
  XAiGrokUsageConformanceConfig,
  xAiGrokUsageConformanceCases,
  xAiGrokUsageConformanceFixtures,
  xAiGrokUsageConformanceUrl,
  xAiGrokUsageSnapshotCase,
  xAiGrokUsageSnapshotFixture
} from '../../src/providers/xai/conformance/index.ts'

const now = new Date('2026-09-30T12:00:00.000Z')

// Far in the future so token expiry checks pass on any clock.
const expiresAt = 4_000_000_000_000

type UsageCase<Req> = ConformanceCase<
  LLMProviderError | ProviderSubscriptionUsageError | ConformanceMismatch,
  HttpClient.HttpClient | Req
>

type Family<Req> = {
  readonly name: string
  readonly testCase: UsageCase<Req>
  readonly fixture: WireFixture
  readonly url: string
  readonly configLayer: Layer.Layer<Req>
  /** Headers the fetcher sends besides `accept` and the redacted bearer. */
  readonly headers: Readonly<Record<string, string>>
  /** Window ids of the committed fixture. */
  readonly windowIds: ReadonlyArray<string>
  /** The public parser of the family's usage body. */
  readonly parse: (
    value: unknown,
    fetchedAt: string
  ) => Effect.Effect<ProviderSubscriptionUsageSnapshot, ProviderSubscriptionUsageError>
  /** A body in the family's shape that reports no window. */
  readonly withoutWindows: Schema.Json
  /** A body in the family's shape that reports exactly one window. */
  readonly oneWindow?: Schema.Json
}

const claudeOneWindow: Schema.Json = {
  five_hour: { utilization: 18, resets_at: '2026-10-01T05:00:00.000Z' },
  seven_day: null
}

const claude: Family<AnthropicClaudeUsageConformanceConfig> = {
  name: 'Claude',
  testCase: anthropicClaudeUsageSnapshotCase,
  fixture: anthropicClaudeUsageSnapshotFixture,
  url: anthropicClaudeUsageConformanceUrl,
  configLayer: Layer.succeed(AnthropicClaudeUsageConformanceConfig, {
    token: new OAuthAccessToken({
      provider: 'anthropic-claude',
      accessToken: 'synthetic-claude-oauth-token',
      expiresAt
    })
  }),
  headers: { 'anthropic-beta': 'oauth-2025-04-20' },
  windowIds: ['five-hour', 'seven-day'],
  parse: parseAnthropicClaudeSubscriptionUsage,
  withoutWindows: { five_hour: null, seven_day: { utilization: null } },
  oneWindow: claudeOneWindow
}

const codex: Family<OpenAiCodexUsageConformanceConfig> = {
  name: 'Codex',
  testCase: openAiCodexUsageSnapshotCase,
  fixture: openAiCodexUsageSnapshotFixture,
  url: openAiCodexUsageConformanceUrl,
  configLayer: Layer.succeed(OpenAiCodexUsageConformanceConfig, {
    token: new OAuthAccessToken({
      provider: 'openai-codex',
      accessToken: 'synthetic-codex-oauth-token',
      expiresAt,
      accountId: 'synthetic-account'
    })
  }),
  headers: { 'chatgpt-account-id': 'synthetic-account' },
  windowIds: ['primary', 'secondary'],
  parse: parseOpenAiCodexSubscriptionUsage,
  withoutWindows: { rate_limit: null },
  oneWindow: {
    rate_limit: {
      primary_window: { used_percent: 23, reset_at: 1790007200 },
      secondary_window: null
    }
  }
}

const grok: Family<XAiGrokUsageConformanceConfig> = {
  name: 'Grok',
  testCase: xAiGrokUsageSnapshotCase,
  fixture: xAiGrokUsageSnapshotFixture,
  url: xAiGrokUsageConformanceUrl,
  configLayer: Layer.succeed(XAiGrokUsageConformanceConfig, {
    token: new OAuthAccessToken({
      provider: 'xai-grok',
      accessToken: 'synthetic-grok-oauth-token',
      expiresAt
    }),
    xAiUserId: 'synthetic-user',
    clientVersion: '0.0.0-synthetic'
  }),
  headers: {
    'x-userid': 'synthetic-user',
    'x-grok-client-version': '0.0.0-synthetic',
    'x-grok-client-mode': 'headless'
  },
  windowIds: ['shared'],
  parse: parseXAiGrokSubscriptionUsage,
  withoutWindows: { config: null }
}

const go: Family<OpenCodeGoConformanceConfig> = {
  name: 'OpenCode Go',
  testCase: openCodeGoUsageSnapshotCase,
  fixture: openCodeGoUsageSnapshotFixture,
  url: openCodeGoConformanceUsageUrl,
  configLayer: Layer.succeed(OpenCodeGoConformanceConfig, {
    apiKey: Redacted.make('synthetic-go-key'),
    maxOutputTokens: 64,
    models: openCodeGoConformanceDefaultModels
  }),
  headers: {},
  windowIds: ['five-hour', 'seven-day', 'monthly'],
  parse: parseOpenCodeGoSubscriptionUsage,
  withoutWindows: { usage: { rolling: null, weekly: { percent: 101 } } },
  oneWindow: { usage: { rolling: { percent: 12.5, resetsAt: '2026-10-01T03:00:00.000Z' } } }
}

const withResponse = (
  fixture: WireFixture,
  suffix: string,
  status: number,
  body: string
): WireFixture => ({
  ...fixture,
  id: `${fixture.id}.${suffix}`,
  exchanges: [
    {
      request: fixture.exchanges[0].request,
      response: { status, headers: { 'content-type': 'application/json' }, body }
    }
  ]
})

const mismatch = (message: string) => ({ kind: 'failure', tag: 'ConformanceMismatch', message })

const describeFamily = <Req>(family: Family<Req>) => {
  const drill = (fixture: WireFixture, testCase: UsageCase<Req> = family.testCase) =>
    runConformance([testCase], {
      target: { kind: 'replay' },
      now,
      layer: () => Layer.mergeAll(ReplayHttpClient.layer([fixture]), family.configLayer)
    }).pipe(Effect.map(report => report.results[0]))

  const failedDrill = (fixture: WireFixture, testCase?: UsageCase<Req>) =>
    drill(fixture, testCase).pipe(
      Effect.map(result => {
        expect(result?.status, fixture.id).toBe('failed')

        return result?.failure
      })
    )

  describe(`${family.name} subscription-usage conformance case`, () => {
    it('is read-only, unverified, and backed by one synthetic fixture', () => {
      expect(family.testCase.safety).toBe('read')
      expect(family.testCase.observed).toBeUndefined()
      expect(family.testCase.fixtures).toEqual([family.fixture.id])
      expect(family.fixture).toMatchObject({
        caseId: family.testCase.id,
        evidence: 'unverified',
        account: 'synthetic',
        endpoint: family.url
      })
      expect(family.fixture.exchanges[0].request).toMatchObject({ method: 'GET', url: family.url })
    })

    it.effect('decodes and passes the secret scan', () =>
      Effect.gen(function* () {
        expect((yield* decodeWireFixture(family.fixture)).id).toBe(family.fixture.id)
        expect(scanFixtureForSecrets(family.fixture)).toEqual([])
      })
    )

    it.effect('passes on replay with unverified warnings, and on a live-target replay', () =>
      Effect.gen(function* () {
        for (const target of [
          { kind: 'replay' as const },
          { kind: 'live' as const, account: 'synthetic' }
        ]) {
          const report = yield* runConformance([family.testCase], {
            target,
            now,
            fixtures: [family.fixture],
            layer: () =>
              Layer.mergeAll(ReplayHttpClient.layer([family.fixture]), family.configLayer)
          })

          expect(report.summary, formatConformanceReport(report)).toEqual({
            passed: 1,
            failed: 0,
            skipped: 0
          })
          expect(report.results[0]?.warnings).toEqual(
            target.kind === 'live'
              ? [{ kind: 'unverified-case' }]
              : [
                  { kind: 'unverified-case' },
                  { kind: 'unverified-fixture', fixtureId: family.fixture.id }
                ]
          )
        }
      })
    )

    it.effect('sends the claimed request (asserted through the replay ledger)', () =>
      Effect.gen(function* () {
        const ledgerRef = yield* Ref.make<ReplayLedgerApi | undefined>(undefined)

        const report = yield* runConformance([family.testCase], {
          target: { kind: 'replay' },
          now,
          layer: () =>
            Layer.mergeAll(
              Layer.unwrap(
                makeReplayHttpClient([family.fixture]).pipe(
                  Effect.tap(({ ledger }) => Ref.set(ledgerRef, ledger)),
                  Effect.map(({ client }) => Layer.succeed(HttpClient.HttpClient, client))
                )
              ),
              family.configLayer
            )
        })

        expect(report.summary.passed).toBe(1)

        const ledger = (yield* Ref.get(ledgerRef)) ?? expect.fail('no ledger')
        const entries = yield* ledger.entries

        expect(yield* ledger.remaining).toEqual([])
        expect(entries).toHaveLength(1)
        expect(entries[0]).toMatchObject({
          method: 'GET',
          url: family.url,
          match: { outcome: 'matched' },
          headers: { authorization: '<redacted>', accept: 'application/json', ...family.headers }
        })
        expect(entries[0]?.bodyText ?? '').toBe('')
      })
    )

    it.effect('records a fixture body that parses into every window id of the family', () =>
      Effect.gen(function* () {
        const response = family.fixture.exchanges[0].response
        const text = 'body' in response && Predicate.isString(response.body) ? response.body : ''

        const snapshot = yield* family.parse(JSON.parse(text), '2026-09-15T12:00:00.000Z')

        expect(Array.from(snapshot.windows).map(window => window.id)).toEqual(family.windowIds)
        expect(family.testCase.wire).toContain(family.windowIds.map(id => `\`${id}\``).join(', '))
      })
    )
  })

  describe(`${family.name} subscription-usage disagreement drills`, () => {
    it.effect('fails when the body reports no window', () =>
      Effect.gen(function* () {
        expect(
          yield* failedDrill(
            withResponse(family.fixture, 'no-windows', 200, JSON.stringify(family.withoutWindows))
          )
        ).toEqual(mismatch('expected at least one usage window'))
      })
    )

    if (family.oneWindow !== undefined) {
      const oneWindow = family.oneWindow

      it.effect('passes with fewer windows: absent windows are never fabricated', () =>
        Effect.gen(function* () {
          const result = yield* drill(
            withResponse(family.fixture, 'one-window', 200, JSON.stringify(oneWindow))
          )

          expect(result?.status).toBe('passed')
        })
      )
    }

    it.effect('reports fetcher failures (auth, rate limit, invalid JSON) as typed failures', () =>
      Effect.gen(function* () {
        for (const [status, body, tag] of [
          [401, '{"error":{"message":"synthetic"}}', 'ProviderSubscriptionUsageAuthError'],
          [429, '{"error":{"message":"synthetic"}}', 'ProviderSubscriptionUsageRateLimitError'],
          [200, 'not json', 'ProviderSubscriptionUsageResponseError']
        ] as const) {
          const failure = yield* failedDrill(
            withResponse(family.fixture, `status-${status}`, status, body)
          )

          expect(failure?.tag, `${status}`).toBe(tag)
        }
      })
    )
  })
}

describeFamily(claude)

describeFamily(codex)

describeFamily(grok)

describeFamily(go)

describe('subscription-usage case exports', () => {
  it('keep usage cases and fixtures apart from the model-route suites', () => {
    expect(anthropicClaudeUsageConformanceCases).toEqual([anthropicClaudeUsageSnapshotCase])
    expect(openAiCodexUsageConformanceCases).toEqual([openAiCodexUsageSnapshotCase])
    expect(xAiGrokUsageConformanceCases).toEqual([xAiGrokUsageSnapshotCase])
    expect(anthropicClaudeUsageConformanceFixtures).toEqual([anthropicClaudeUsageSnapshotFixture])
    expect(openAiCodexUsageConformanceFixtures).toEqual([openAiCodexUsageSnapshotFixture])
    expect(xAiGrokUsageConformanceFixtures).toEqual([xAiGrokUsageSnapshotFixture])
  })
})

describe('the shared usage claim catches a snapshot that disagrees with the wire', () => {
  const claudeToken = new OAuthAccessToken({
    provider: 'anthropic-claude',
    accessToken: 'synthetic-claude-oauth-token',
    expiresAt
  })

  /** The real Claude case with the snapshot tampered with after the real fetcher ran. */
  const tamperedCase = (
    tamper: (snapshot: ProviderSubscriptionUsageSnapshot) => ProviderSubscriptionUsageSnapshot
  ) =>
    makeSubscriptionUsageConformanceCase({
      id: 'drill.claude.usage.tampered',
      title: 'Tampered Claude usage',
      docs: 'Drill.',
      wire: 'Drill.',
      providerId: 'anthropic-claude',
      windowIds: ['five-hour', 'seven-day'],
      settings: Effect.succeed({ token: claudeToken }),
      fetch: settings =>
        fetchAnthropicClaudeSubscriptionUsage(settings.token).pipe(Effect.map(tamper)),
      expectedWindows: body =>
        [
          ['five_hour', 'five-hour'],
          ['seven_day', 'seven-day']
        ].flatMap(([key, id]) => {
          const wire = wireField(body, key ?? '')
          const usedPercent = wirePercent(wireField(wire, 'utilization'))

          return usedPercent === undefined || id === undefined
            ? []
            : [{ id, usedPercent, resetsAt: wireInstant(wireField(wire, 'resets_at')) }]
        }),
      fixture: anthropicClaudeUsageSnapshotFixture.id
    })

  const withWindows = (
    snapshot: ProviderSubscriptionUsageSnapshot,
    windows: ReadonlyArray<ProviderSubscriptionUsageWindow>
  ) =>
    ProviderSubscriptionUsageSnapshot.make({
      provider: snapshot.provider,
      fetchedAt: snapshot.fetchedAt,
      windows: Chunk.fromIterable(windows)
    })

  const run = (testCase: ReturnType<typeof tamperedCase>, fixture: WireFixture) =>
    runConformance([testCase], {
      target: { kind: 'replay' },
      now,
      layer: () => ReplayHttpClient.layer([fixture])
    }).pipe(Effect.map(report => report.results[0]))

  it.effect('passes untampered, fails a fabricated, dropped, or altered window', () =>
    Effect.gen(function* () {
      const oneWindowFixture = withResponse(
        anthropicClaudeUsageSnapshotFixture,
        'one-window',
        200,
        JSON.stringify(claudeOneWindow)
      )

      expect(
        (yield* run(
          tamperedCase(snapshot => snapshot),
          anthropicClaudeUsageSnapshotFixture
        ))?.status
      ).toBe('passed')

      const fabricated = tamperedCase(snapshot =>
        withWindows(snapshot, [
          ...Array.from(snapshot.windows),
          ProviderSubscriptionUsageWindow.make({ id: 'seven-day', usedPercent: 0 })
        ])
      )

      expect((yield* run(fabricated, oneWindowFixture))?.failure).toEqual(
        mismatch('expected one window per reported wire window (none fabricated, none dropped)')
      )

      const dropped = tamperedCase(snapshot =>
        withWindows(snapshot, Array.from(snapshot.windows).slice(0, 1))
      )

      expect((yield* run(dropped, anthropicClaudeUsageSnapshotFixture))?.failure).toEqual(
        mismatch('expected one window per reported wire window (none fabricated, none dropped)')
      )

      const altered = tamperedCase(snapshot =>
        withWindows(
          snapshot,
          Array.from(snapshot.windows).map(window =>
            ProviderSubscriptionUsageWindow.make({ id: window.id, usedPercent: 0 })
          )
        )
      )

      expect((yield* run(altered, anthropicClaudeUsageSnapshotFixture))?.failure).toEqual(
        mismatch('expected each window to carry the wire used percentage and reset instant')
      )

      const reordered = tamperedCase(snapshot =>
        withWindows(snapshot, Array.from(snapshot.windows).reverse())
      )

      expect((yield* run(reordered, anthropicClaudeUsageSnapshotFixture))?.failure).toEqual(
        mismatch('expected windows in the vendor order')
      )
    })
  )
})
