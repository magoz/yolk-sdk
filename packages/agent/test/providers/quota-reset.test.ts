import { describe, expect, it } from '@effect/vitest'
import { classifyProviderFailure } from '../../src/providers/provider-error.ts'
import {
  anthropicClaudeQuotaResetsAtMs,
  openAiCodexQuotaResetsAtMs
} from '../../src/providers/quota-reset-internal.ts'

const nowMs = Date.parse('2026-10-15T12:00:00.000Z')

const inHours = (hours: number) => nowMs + hours * 3_600_000

const unixSeconds = (ms: number) => String(ms / 1000)

describe('anthropicClaudeQuotaResetsAtMs', () => {
  it('reads the weekly reset when the weekly window is rejected', () => {
    expect(
      anthropicClaudeQuotaResetsAtMs({
        status: 429,
        nowMs,
        headers: {
          'Anthropic-Ratelimit-Unified-Status': 'rejected',
          'Anthropic-Ratelimit-Unified-5h-Status': 'allowed',
          'Anthropic-Ratelimit-Unified-7d-Status': 'rejected',
          'Anthropic-Ratelimit-Unified-5h-Reset': unixSeconds(inHours(2)),
          'Anthropic-Ratelimit-Unified-7d-Reset': unixSeconds(inHours(50)),
          'Anthropic-Ratelimit-Unified-Reset': unixSeconds(inHours(50))
        }
      })
    ).toBe(inHours(50))
  })

  it('takes the latest reset among rejected windows', () => {
    expect(
      anthropicClaudeQuotaResetsAtMs({
        status: 429,
        nowMs,
        headers: {
          'anthropic-ratelimit-unified-5h-status': 'rejected',
          'anthropic-ratelimit-unified-7d-status': 'rejected',
          'anthropic-ratelimit-unified-5h-reset': unixSeconds(inHours(3)),
          'anthropic-ratelimit-unified-7d-reset': unixSeconds(inHours(1))
        }
      })
    ).toBe(inHours(3))
  })

  it('accepts RFC 3339 resets', () => {
    expect(
      anthropicClaudeQuotaResetsAtMs({
        status: 429,
        nowMs,
        headers: {
          'anthropic-ratelimit-unified-status': 'rejected',
          'anthropic-ratelimit-unified-reset': '2026-10-16T12:00:00Z'
        }
      })
    ).toBe(inHours(24))
  })

  it('never locks the account for a model-scoped weekly rejection', () => {
    // Five-hour and Opus weekly both rejected: only the five-hour reset is account-wide.
    expect(
      anthropicClaudeQuotaResetsAtMs({
        status: 429,
        nowMs,
        headers: {
          'anthropic-ratelimit-unified-status': 'rejected',
          'anthropic-ratelimit-unified-5h-status': 'rejected',
          'anthropic-ratelimit-unified-7d_oi-status': 'rejected',
          'anthropic-ratelimit-unified-5h-reset': unixSeconds(inHours(2)),
          'anthropic-ratelimit-unified-7d_oi-reset': unixSeconds(inHours(90)),
          'anthropic-ratelimit-unified-reset': unixSeconds(inHours(90))
        }
      })
    ).toBe(inHours(2))
    // Only the model weekly window rejected: no account-wide reset.
    expect(
      anthropicClaudeQuotaResetsAtMs({
        status: 429,
        nowMs,
        headers: {
          'anthropic-ratelimit-unified-status': 'rejected',
          'anthropic-ratelimit-unified-7d_oi-status': 'rejected',
          'anthropic-ratelimit-unified-7d_oi-reset': unixSeconds(inHours(90)),
          'anthropic-ratelimit-unified-reset': unixSeconds(inHours(90))
        }
      })
    ).toBeUndefined()
  })

  it('ignores resets more than a year ahead', () => {
    expect(
      anthropicClaudeQuotaResetsAtMs({
        status: 429,
        nowMs,
        headers: {
          'anthropic-ratelimit-unified-status': 'rejected',
          'anthropic-ratelimit-unified-reset': '1e13'
        }
      })
    ).toBeUndefined()
  })

  it('ignores resets in the past', () => {
    expect(
      anthropicClaudeQuotaResetsAtMs({
        status: 429,
        nowMs,
        headers: {
          'anthropic-ratelimit-unified-5h-status': 'rejected',
          'anthropic-ratelimit-unified-5h-reset': unixSeconds(inHours(-1))
        }
      })
    ).toBeUndefined()
  })

  it('ignores overage-only rejections while shared windows allow requests', () => {
    expect(
      anthropicClaudeQuotaResetsAtMs({
        status: 429,
        nowMs,
        headers: {
          'anthropic-ratelimit-unified-status': 'rejected',
          'anthropic-ratelimit-unified-5h-status': 'allowed',
          'anthropic-ratelimit-unified-7d-status': 'allowed_warning',
          'anthropic-ratelimit-unified-overage-status': 'rejected',
          'anthropic-ratelimit-unified-reset': unixSeconds(inHours(20))
        }
      })
    ).toBeUndefined()
  })

  it('ignores responses without unified rate-limit headers and non-429 statuses', () => {
    expect(
      anthropicClaudeQuotaResetsAtMs({ status: 429, nowMs, headers: { 'retry-after': '30' } })
    ).toBeUndefined()
    expect(
      anthropicClaudeQuotaResetsAtMs({
        status: 529,
        nowMs,
        headers: {
          'anthropic-ratelimit-unified-status': 'rejected',
          'anthropic-ratelimit-unified-reset': unixSeconds(inHours(2))
        }
      })
    ).toBeUndefined()
  })
})

describe('openAiCodexQuotaResetsAtMs', () => {
  const body = (error: {
    readonly type: string
    readonly resets_at?: number
    readonly resets_in_seconds?: number
  }) => JSON.stringify({ error })

  it('reads resets_at from usage_limit_reached', () => {
    expect(
      openAiCodexQuotaResetsAtMs({
        status: 429,
        nowMs,
        body: body({
          type: 'usage_limit_reached',
          resets_at: inHours(30) / 1000,
          resets_in_seconds: 60
        })
      })
    ).toBe(inHours(30))
  })

  it('ignores implausible resets_at and falls back to resets_in_seconds', () => {
    expect(
      openAiCodexQuotaResetsAtMs({
        status: 429,
        nowMs,
        body: body({ type: 'usage_limit_reached', resets_at: 1e13, resets_in_seconds: 3600 })
      })
    ).toBe(inHours(1))
    expect(
      openAiCodexQuotaResetsAtMs({
        status: 429,
        nowMs,
        body: body({ type: 'usage_limit_reached', resets_in_seconds: 1e10 })
      })
    ).toBeUndefined()
  })

  it('falls back to resets_in_seconds', () => {
    expect(
      openAiCodexQuotaResetsAtMs({
        status: 429,
        nowMs,
        body: body({ type: 'usage_limit_reached', resets_in_seconds: 7200 })
      })
    ).toBe(inHours(2))
  })

  it('reads a top-level usage limit body', () => {
    expect(
      openAiCodexQuotaResetsAtMs({
        status: 429,
        nowMs,
        body: JSON.stringify({ type: 'usage_limit_reached', resets_in_seconds: 3600 })
      })
    ).toBe(inHours(1))
  })

  it('ignores transient rate limits, other statuses, and malformed bodies', () => {
    expect(
      openAiCodexQuotaResetsAtMs({
        status: 429,
        nowMs,
        body: body({ type: 'rate_limit_exceeded', resets_in_seconds: 20 })
      })
    ).toBeUndefined()
    expect(
      openAiCodexQuotaResetsAtMs({
        status: 400,
        nowMs,
        body: body({ type: 'usage_limit_reached', resets_in_seconds: 20 })
      })
    ).toBeUndefined()
    expect(openAiCodexQuotaResetsAtMs({ status: 429, nowMs, body: 'not json' })).toBeUndefined()
    expect(
      openAiCodexQuotaResetsAtMs({
        status: 429,
        nowMs,
        body: body({ type: 'usage_limit_reached' })
      })
    ).toBeUndefined()
  })
})

describe('classifyProviderFailure quota reset', () => {
  it('keeps quotaResetsAtMs on rate limits after retryAfterMs', () => {
    const info = classifyProviderFailure({
      provider: 'anthropic_claude',
      status: 429,
      headers: { 'retry-after': '60' },
      quotaResetsAtMs: inHours(5)
    })

    expect(Object.keys(info)).toEqual([
      'provider',
      'kind',
      'status',
      'retryAfterMs',
      'quotaResetsAtMs'
    ])
    expect(info.quotaResetsAtMs).toBe(inHours(5))
  })

  it('drops quotaResetsAtMs when the failure is not a rate limit', () => {
    const info = classifyProviderFailure({
      provider: 'anthropic_claude',
      status: 400,
      body: 'prompt is too long',
      quotaResetsAtMs: inHours(5)
    })

    expect(info.kind).toBe('context_overflow')
    expect(Object.hasOwn(info, 'quotaResetsAtMs')).toBe(false)
  })
})
