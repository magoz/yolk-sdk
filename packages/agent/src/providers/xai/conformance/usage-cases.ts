/**
 * xAI Grok subscription-usage conformance case for `@yolk-sdk/conformance/runner`.
 *
 * The case calls the public `fetchXAiGrokSubscriptionUsage` (default
 * `https://cli-chat-proxy.grok.com/v1/billing?format=credits`: Grok OAuth bearer,
 * `X-XAI-Token-Auth`, the authenticated `x-userid`, the host's truthful `x-grok-client-version`,
 * and `x-grok-client-mode: headless`) from `XAiGrokUsageConformanceConfig` and asserts the
 * normalized `ProviderSubscriptionUsageSnapshot` against the raw body it reads at its own
 * `HttpClient` boundary (shared shape: `openai/conformance/subscription-usage-cases-internal.ts`).
 * It needs only `HttpClient.HttpClient` and the config service, so it runs against the replayed
 * fixture, the `@yolk-sdk/emulators/xai` usage route, or a host's live `HttpClient`. It is a
 * `read` case, not observed live yet (`observed` absent = unverified).
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
import { xAiGrokProviderId } from '../grok.ts'
import { fetchXAiGrokSubscriptionUsage, xAiGrokSubscriptionUsageUrl } from '../usage.ts'
import { xAiGrokUsageSnapshotFixture } from './usage-snapshot.ts'

/** The Grok subscription-usage endpoint the case (and the fetcher's default) calls. */
export const xAiGrokUsageConformanceUrl = xAiGrokSubscriptionUsageUrl

export type XAiGrokUsageConformanceSettings = {
  /**
   * Grok subscription OAuth access token (provider `xai-grok`), sent as `Authorization: Bearer`.
   * Any value works under replay or an emulator.
   */
  readonly token: OAuthAccessToken
  /** The actual authenticated xAI user id, sent as `x-userid` (never inferred). */
  readonly xAiUserId: string
  /** Truthful host client version sent as `x-grok-client-version`. */
  readonly clientVersion: string
}

/** Host-supplied settings for the Grok subscription-usage conformance case. */
export class XAiGrokUsageConformanceConfig extends Context.Service<
  XAiGrokUsageConformanceConfig,
  XAiGrokUsageConformanceSettings
>()('@yolk-sdk/agent/providers/xai/conformance/XAiGrokUsageConformanceConfig') {}

/** What the Grok usage conformance case requires from the host. */
export type XAiGrokUsageConformanceRequirements =
  | HttpClient.HttpClient
  | XAiGrokUsageConformanceConfig

export type XAiGrokUsageConformanceCase =
  SubscriptionUsageConformanceCase<XAiGrokUsageConformanceConfig>

/** The period end, when the period is well formed and contains `fetchedAt`. */
const periodEnd = (
  start: Schema.Json | undefined,
  end: Schema.Json | undefined,
  fetchedAt: string
): string | undefined => {
  const startAt = Predicate.isString(start) ? wireInstant(start) : undefined
  const endAt = Predicate.isString(end) ? wireInstant(end) : undefined

  if (startAt === undefined || endAt === undefined) return undefined

  const startMs = new Date(startAt).getTime()
  const endMs = new Date(endAt).getTime()
  const fetchedMs = new Date(fetchedAt).getTime()

  return endMs > startMs && fetchedMs >= startMs && fetchedMs < endMs ? endAt : undefined
}

const shared = (
  usedPercent: number,
  resetsAt: string | undefined
): ReadonlyArray<SubscriptionUsageExpectedWindow> => [{ id: 'shared', usedPercent, resetsAt }]

/**
 * The one `shared` window the credits body reports: `creditUsagePercent` with the current
 * period's end; else 0% for a current period alone; else the legacy `used / monthlyLimit` cents
 * with the legacy billing period's end. Reset instants only when the period contains the fetch
 * time.
 */
const grokWindows = (
  body: Schema.Json,
  fetchedAt: string
): ReadonlyArray<SubscriptionUsageExpectedWindow> => {
  const config = wireField(body, 'config')
  const period = wireField(config, 'currentPeriod')
  const currentEnd = periodEnd(wireField(period, 'start'), wireField(period, 'end'), fetchedAt)
  const credit = wireField(config, 'creditUsagePercent')

  if (credit !== undefined) {
    const usedPercent = wirePercent(credit)

    return usedPercent === undefined ? [] : shared(usedPercent, currentEnd)
  }

  if (currentEnd !== undefined) return shared(0, currentEnd)

  const limit = wireField(wireField(config, 'monthlyLimit'), 'val')
  const used = wireField(wireField(config, 'used'), 'val')

  if (!Predicate.isNumber(limit) || !Predicate.isNumber(used) || limit <= 0) return []

  const usedPercent = wirePercent((used / limit) * 100)

  return usedPercent === undefined
    ? []
    : shared(
        usedPercent,
        periodEnd(
          wireField(config, 'billingPeriodStart'),
          wireField(config, 'billingPeriodEnd'),
          fetchedAt
        )
      )
}

export const xAiGrokUsageSnapshotCase: XAiGrokUsageConformanceCase =
  makeSubscriptionUsageConformanceCase({
    id: 'xai.grok.usage.snapshot',
    title: 'Grok subscription usage normalizes the reported credit window only',
    docs: 'The Grok CLI proxy billing endpoint (`GET /v1/billing?format=credits`, bearer OAuth token, `X-XAI-Token-Auth`, `x-userid`, `x-grok-client-version`, and `x-grok-client-mode`) answers JSON whose `config` carries `creditUsagePercent` and the `currentPeriod` `{ type, start, end }` (older bodies: `monthlyLimit` / `used` cents and `billingPeriodStart` / `billingPeriodEnd`); the fetcher reports one `shared` window.',
    wire: 'The wire reports one `shared` window: `creditUsagePercent` (0 to 100) when present, else 0% for a current period alone, else the legacy used share of a positive monthly limit; its reset instant is the period end when the period contains the fetch time.',
    providerId: xAiGrokProviderId,
    windowIds: ['shared'],
    settings: Effect.service(XAiGrokUsageConformanceConfig),
    fetch: settings =>
      fetchXAiGrokSubscriptionUsage(settings.token, {
        xAiUserId: settings.xAiUserId,
        clientVersion: settings.clientVersion
      }),
    expectedWindows: grokWindows,
    fixture: xAiGrokUsageSnapshotFixture.id
  })

/** Every Grok subscription-usage conformance case. */
export const xAiGrokUsageConformanceCases: ReadonlyArray<XAiGrokUsageConformanceCase> = [
  xAiGrokUsageSnapshotCase
]
