import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * Codex subscription-usage snapshot: `GET /backend-api/wham/usage` answering `rate_limit` with
 * `primary_window` and `secondary_window` as
 * `{ used_percent, limit_window_seconds, reset_after_seconds, reset_at }`.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it. Regenerate
 * with `pnpm conformance:usage --family codex --live --owner-approved --account <label>`.
 */
export const openAiCodexUsageSnapshotFixture: WireFixture = {
  id: 'openai.codex.usage.snapshot.synthetic',
  caseId: 'openai.codex.usage.snapshot',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://chatgpt.com/backend-api/wham/usage',
  note: 'Synthetic placeholder shaped like the ChatGPT usage JSON the SDK parser reads. Not recorded from a live service; replace with a verified recording from pnpm conformance:usage --family codex --live --owner-approved --account <label>.',
  exchanges: [
    {
      request: {
        method: 'GET',
        url: 'https://chatgpt.com/backend-api/wham/usage',
        headers: {
          accept: 'application/json'
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"rate_limit":{"primary_window":{"used_percent":23,"limit_window_seconds":18000,"reset_after_seconds":7200,"reset_at":1790007200},"secondary_window":{"used_percent":51,"limit_window_seconds":604800,"reset_after_seconds":259200,"reset_at":1790259200}}}'
      }
    }
  ]
}
