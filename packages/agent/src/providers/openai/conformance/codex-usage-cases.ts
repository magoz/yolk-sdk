/**
 * Codex (ChatGPT subscription) usage conformance case for `@yolk-sdk/conformance/runner`.
 *
 * The case calls the public `fetchOpenAiCodexSubscriptionUsage` (default
 * `https://chatgpt.com/backend-api/wham/usage`, ChatGPT OAuth bearer plus `ChatGPT-Account-Id`
 * from the token's `accountId`) from `OpenAiCodexUsageConformanceConfig` and asserts the normalized
 * `ProviderSubscriptionUsageSnapshot` against the raw body it reads at its own `HttpClient`
 * boundary (shared shape: `subscription-usage-cases-internal.ts`). It needs only
 * `HttpClient.HttpClient` and the config service, so it runs against the replayed fixture, the
 * `@yolk-sdk/emulators/codex` usage route, or a host's live `HttpClient`. It is a `read` case, not
 * observed live yet (`observed` absent = unverified).
 */
import { Context, Effect } from 'effect'
import type { HttpClient } from 'effect/unstable/http'
import type { OAuthAccessToken } from '@yolk-sdk/agent/oauth'
import { openAiCodexProviderId } from '../codex.ts'
import {
  fetchOpenAiCodexSubscriptionUsage,
  openAiCodexSubscriptionUsageUrl
} from '../codex-usage.ts'
import { openAiCodexUsageSnapshotFixture } from './codex-usage-snapshot.ts'
import {
  makeSubscriptionUsageConformanceCase,
  wireField,
  wireInstant,
  wirePercent,
  type SubscriptionUsageConformanceCase,
  type SubscriptionUsageExpectedWindow
} from './subscription-usage-cases-internal.ts'

/** The Codex subscription-usage endpoint the case (and the fetcher's default) calls. */
export const openAiCodexUsageConformanceUrl = openAiCodexSubscriptionUsageUrl

export type OpenAiCodexUsageConformanceSettings = {
  /**
   * ChatGPT subscription OAuth access token (provider `openai-codex`) with its `accountId` (sent
   * as `ChatGPT-Account-Id`; the fetcher refuses a token without one). Any values work under
   * replay or an emulator.
   */
  readonly token: OAuthAccessToken
}

/** Host-supplied settings for the Codex subscription-usage conformance case. */
export class OpenAiCodexUsageConformanceConfig extends Context.Service<
  OpenAiCodexUsageConformanceConfig,
  OpenAiCodexUsageConformanceSettings
>()('@yolk-sdk/agent/providers/openai/conformance/OpenAiCodexUsageConformanceConfig') {}

/** What the Codex usage conformance case requires from the host. */
export type OpenAiCodexUsageConformanceRequirements =
  | HttpClient.HttpClient
  | OpenAiCodexUsageConformanceConfig

export type OpenAiCodexUsageConformanceCase =
  SubscriptionUsageConformanceCase<OpenAiCodexUsageConformanceConfig>

const codexWindows = [
  { key: 'primary_window', id: 'primary' },
  { key: 'secondary_window', id: 'secondary' }
] as const

export const openAiCodexUsageSnapshotCase: OpenAiCodexUsageConformanceCase =
  makeSubscriptionUsageConformanceCase({
    id: 'openai.codex.usage.snapshot',
    title: 'Codex subscription usage normalizes the reported windows only',
    docs: 'The ChatGPT usage endpoint (`GET /backend-api/wham/usage`, bearer OAuth token and `ChatGPT-Account-Id`) answers JSON whose `rate_limit` carries `primary_window` and `secondary_window` as `{ used_percent, limit_window_seconds, reset_after_seconds, reset_at }` (`reset_at` in epoch seconds; any may be `null`); the fetcher maps them to `primary` and `secondary`.',
    wire: 'A wire window is reported when its `used_percent` is a number from 0 to 100; its reset instant is `reset_at` (epoch seconds) when readable.',
    providerId: openAiCodexProviderId,
    windowIds: codexWindows.map(window => window.id),
    settings: Effect.service(OpenAiCodexUsageConformanceConfig),
    fetch: settings => fetchOpenAiCodexSubscriptionUsage(settings.token),
    expectedWindows: body =>
      codexWindows.flatMap((window): Array<SubscriptionUsageExpectedWindow> => {
        const wire = wireField(wireField(body, 'rate_limit'), window.key)
        const usedPercent = wirePercent(wireField(wire, 'used_percent'))

        return usedPercent === undefined
          ? []
          : [{ id: window.id, usedPercent, resetsAt: wireInstant(wireField(wire, 'reset_at')) }]
      }),
    fixture: openAiCodexUsageSnapshotFixture.id
  })

/** Every Codex subscription-usage conformance case. */
export const openAiCodexUsageConformanceCases: ReadonlyArray<OpenAiCodexUsageConformanceCase> = [
  openAiCodexUsageSnapshotCase
]
