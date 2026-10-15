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
import { Context, Effect, Predicate } from 'effect'
import type * as Schema from 'effect/Schema'
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

/**
 * Model-scoped weekly limits (`limits[]` entries with `kind: "weekly_scoped"` and a numeric
 * `percent`), keyed by the lowercase model id or else the display name slugged; the first entry per
 * model wins.
 */
const scopedWireWindows = (body: Schema.Json): Array<SubscriptionUsageExpectedWindow> => {
  const limits = wireField(body, 'limits')
  const seen = new Set<string>()

  return (Array.isArray(limits) ? limits : []).flatMap(
    (limit): Array<SubscriptionUsageExpectedWindow> => {
      const usedPercent = wirePercent(wireField(limit, 'percent'))
      const model = wireField(wireField(limit, 'scope'), 'model')
      const id = wireField(model, 'id')
      const name = wireField(model, 'display_name')

      const key =
        Predicate.isString(id) && id.trim() !== ''
          ? id.trim().toLowerCase()
          : Predicate.isString(name)
            ? name
                .trim()
                .toLowerCase()
                .split(/[^a-z0-9]+/)
                .filter(part => part !== '')
                .join('-')
            : ''

      if (
        wireField(limit, 'kind') !== 'weekly_scoped' ||
        usedPercent === undefined ||
        key === '' ||
        seen.has(key)
      ) {
        return []
      }

      seen.add(key)

      return [
        {
          id: `seven-day-${key}`,
          usedPercent,
          resetsAt: wireInstant(wireField(limit, 'resets_at')),
          models: [key]
        }
      ]
    }
  )
}

export const anthropicClaudeUsageSnapshotCase: AnthropicClaudeUsageConformanceCase =
  makeSubscriptionUsageConformanceCase({
    id: 'anthropic.claude.usage.snapshot',
    title: 'Claude subscription usage normalizes the reported windows only',
    docs: 'The Claude OAuth usage endpoint (`GET /api/oauth/usage`, bearer OAuth token and `anthropic-beta: oauth-2025-04-20`) answers JSON with `five_hour` and `seven_day` windows as `{ utilization, resets_at }` (either may be `null`) and model-scoped weekly limits in `limits[]` (`{ kind: "weekly_scoped", percent, resets_at, scope: { model: { id, display_name } } }`); the fetcher maps them to `five-hour`, `seven-day`, and `seven-day-<model>`.',
    wire: 'A wire window is reported when its `utilization` (scoped limits: `percent`) is a number from 0 to 100; its reset instant is `resets_at` when readable. A scoped limit is keyed by its lowercase model id, else its display name slugged, and lists that key as its only model; the first limit per key wins.',
    providerId: anthropicClaudeProviderId,
    windowIds: claudeWindows.map(window => window.id),
    settings: Effect.service(AnthropicClaudeUsageConformanceConfig),
    fetch: settings => fetchAnthropicClaudeSubscriptionUsage(settings.token),
    scopedWindowIdPrefix: 'seven-day-',
    expectedWindows: body => [
      ...claudeWindows.flatMap((window): Array<SubscriptionUsageExpectedWindow> => {
        const wire = wireField(body, window.key)
        const usedPercent = wirePercent(wireField(wire, 'utilization'))

        return usedPercent === undefined
          ? []
          : [{ id: window.id, usedPercent, resetsAt: wireInstant(wireField(wire, 'resets_at')) }]
      }),
      ...scopedWireWindows(body)
    ],
    fixture: anthropicClaudeUsageSnapshotFixture.id
  })

/** Every Claude subscription-usage conformance case. */
export const anthropicClaudeUsageConformanceCases: ReadonlyArray<AnthropicClaudeUsageConformanceCase> =
  [anthropicClaudeUsageSnapshotCase]
