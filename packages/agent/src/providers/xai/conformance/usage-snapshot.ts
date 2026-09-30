import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * Grok subscription-usage snapshot: `GET /v1/billing?format=credits` on the CLI proxy answering
 * `config.creditUsagePercent` and the `config.currentPeriod` `{ type, start, end }`.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it. Regenerate
 * with
 * `pnpm conformance:usage --family grok --live --owner-approved --account <label> --client-version <version>`.
 */
export const xAiGrokUsageSnapshotFixture: WireFixture = {
  id: 'xai.grok.usage.snapshot.synthetic',
  caseId: 'xai.grok.usage.snapshot',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://cli-chat-proxy.grok.com/v1/billing?format=credits',
  note: 'Synthetic placeholder shaped like the Grok CLI proxy credits billing JSON the SDK parser reads. Not recorded from a live service; replace with a verified recording from pnpm conformance:usage --family grok --live --owner-approved --account <label> --client-version <version>.',
  exchanges: [
    {
      request: {
        method: 'GET',
        url: 'https://cli-chat-proxy.grok.com/v1/billing?format=credits',
        headers: {
          accept: 'application/json'
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"config":{"creditUsagePercent":37.5,"currentPeriod":{"type":"monthly","start":"2026-09-01T00:00:00.000Z","end":"2026-10-01T00:00:00.000Z"}}}'
      }
    }
  ]
}
