/**
 * Claude subscription-usage conformance case for `@yolk-sdk/conformance/runner`.
 *
 * The case calls the public `fetchAnthropicClaudeSubscriptionUsage` (default
 * `https://api.anthropic.com/api/oauth/usage`, Claude OAuth bearer plus `anthropic-beta:
 * oauth-2025-04-20`) from `AnthropicClaudeUsageConformanceConfig` and asserts the normalized
 * `ProviderSubscriptionUsageSnapshot` against the raw body it reads at its own `HttpClient`
 * boundary (shared shape: `openai/conformance/subscription-usage-cases-internal.ts`). It needs only
 * `HttpClient.HttpClient` and the config service, so it runs against the replayed fixture
 * (`ReplayHttpClient`), the `@yolk-sdk/emulators/anthropic` usage route, or a host's live
 * `HttpClient`. It is a `read` case, not observed live yet (`observed` absent = unverified).
 */
import { Context, Effect } from 'effect'
import type { HttpClient } from 'effect/http'
import type { OAuthAccessToken } from '@yolk-sdk/agent/oauth'
import {
  makeSubscriptionUsageConformanceCase,
  wireField,
  wireInstant,
  wirePercent,
  type SubscriptionUsageConformanceCase,
  type SubscriptionUsageExpectedWindow
} from '../../openai/conformance/subscription-usage-cases-internal.ts'
import { anthropicClaudeProviderId } from '../claude.ts'
import {
  anthropicClaudeSubscriptionUsageUrl,
  fetchAnthropicClaudeSubscriptionUsage
} from '../usage.ts'
import { anthropicClaudeUsageSnapshotFixture } from './claude-usage-snapshot.ts'

/** The Claude subscription-usage endpoint the case (and the fetcher's default) calls. */
export const anthropicClaudeUsageConformanceUrl = anthropicClaudeSubscriptionUsageUrl

export type AnthropicClaudeUsageConformanceSettings = {
  /**
   * Claude subscription OAuth access token (provider `anthropic-claude`), sent as `Authorization:
   * Bearer`. Any value works under replay or an emulator.
   */
  readonly token: OAuthAccessToken
}

/** Host-supplied settings for the Claude subscription-usage conformance case. */
export class AnthropicClaudeUsageConformanceConfig extends Context.Service<
  AnthropicClaudeUsageConformanceConfig,
  AnthropicClaudeUsageConformanceSettings
>()('@yolk-sdk/agent/providers/anthropic/conformance/AnthropicClaudeUsageConformanceConfig') {}

/** What the Claude usage conformance case requires from the host. */
export type AnthropicClaudeUsageConformanceRequirements =
  | HttpClient.HttpClient
  | AnthropicClaudeUsageConformanceConfig

export type AnthropicClaudeUsageConformanceCase =
  SubscriptionUsageConformanceCase<AnthropicClaudeUsageConformanceConfig>

const claudeWindows = [
  { key: 'five_hour', id: 'five-hour' },
  { key: 'seven_day', id: 'seven-day' }
] as const

export const anthropicClaudeUsageSnapshotCase: AnthropicClaudeUsageConformanceCase =
  makeSubscriptionUsageConformanceCase({
    id: 'anthropic.claude.usage.snapshot',
    title: 'Claude subscription usage normalizes the reported windows only',
    docs: 'The Claude OAuth usage endpoint (`GET /api/oauth/usage`, bearer OAuth token and `anthropic-beta: oauth-2025-04-20`) answers JSON with `five_hour` and `seven_day` windows as `{ utilization, resets_at }` (either may be `null`); the fetcher maps them to `five-hour` and `seven-day`.',
    wire: 'A wire window is reported when its `utilization` is a number from 0 to 100; its reset instant is `resets_at` when readable.',
    providerId: anthropicClaudeProviderId,
    windowIds: claudeWindows.map(window => window.id),
    settings: Effect.service(AnthropicClaudeUsageConformanceConfig),
    fetch: settings => fetchAnthropicClaudeSubscriptionUsage(settings.token),
    expectedWindows: body =>
      claudeWindows.flatMap((window): Array<SubscriptionUsageExpectedWindow> => {
        const wire = wireField(body, window.key)
        const usedPercent = wirePercent(wireField(wire, 'utilization'))

        return usedPercent === undefined
          ? []
          : [{ id: window.id, usedPercent, resetsAt: wireInstant(wireField(wire, 'resets_at')) }]
      }),
    fixture: anthropicClaudeUsageSnapshotFixture.id
  })

/** Every Claude subscription-usage conformance case. */
export const anthropicClaudeUsageConformanceCases: ReadonlyArray<AnthropicClaudeUsageConformanceCase> =
  [anthropicClaudeUsageSnapshotCase]
