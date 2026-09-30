import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * OpenCode Go subscription-usage snapshot: `GET /zen/go/v1/usage` answering `usage.rolling`, `usage.weekly`, and `usage.monthly` as `{ percent, resetsAt }`.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it. Regenerate
 * with `pnpm conformance:opencode --live --owner-approved --account <label>` and the model flags.
 */
export const openCodeGoUsageSnapshotFixture: WireFixture = {
  id: 'opencode.go.usage.snapshot.synthetic',
  caseId: 'opencode.go.usage.snapshot',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://opencode.ai/zen/go/v1/usage',
  note: 'Synthetic placeholder shaped like OpenCode Go usage JSON the SDK parser reads. Not recorded from a live service; replace with a verified recording from pnpm conformance:opencode --live --owner-approved --account <label> (with the per-protocol model flags).',
  exchanges: [
    {
      request: {
        method: 'GET',
        url: 'https://opencode.ai/zen/go/v1/usage',
        headers: {
          accept: 'application/json'
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"usage":{"rolling":{"percent":12.5,"resetsAt":"2026-10-01T03:00:00.000Z"},"weekly":{"percent":40,"resetsAt":"2026-10-05T00:00:00.000Z"},"monthly":{"percent":55,"resetsAt":"2026-10-31T00:00:00.000Z"}}}'
      }
    }
  ]
}
