import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * Claude subscription-usage snapshot: `GET /api/oauth/usage` answering `five_hour` and
 * `seven_day` windows as `{ utilization, resets_at }`.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it. Regenerate
 * with `pnpm conformance:usage --family claude --live --owner-approved --account <label>`.
 */
export const anthropicClaudeUsageSnapshotFixture: WireFixture = {
  id: 'anthropic.claude.usage.snapshot.synthetic',
  caseId: 'anthropic.claude.usage.snapshot',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://api.anthropic.com/api/oauth/usage',
  note: 'Synthetic placeholder shaped like the Claude OAuth usage JSON the SDK parser reads. Not recorded from a live service; replace with a verified recording from pnpm conformance:usage --family claude --live --owner-approved --account <label>.',
  exchanges: [
    {
      request: {
        method: 'GET',
        url: 'https://api.anthropic.com/api/oauth/usage',
        headers: {
          accept: 'application/json'
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"five_hour":{"utilization":18,"resets_at":"2026-10-01T05:00:00.000Z"},"seven_day":{"utilization":42,"resets_at":"2026-10-06T00:00:00.000Z"}}'
      }
    }
  ]
}
