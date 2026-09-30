import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * `telegram.validate` for a chat the bot is not a member of (HTTP 400), then for the seeded chat
 * with a bot token that names no bot (HTTP 401), both answered with the Bot API error envelope. The
 * first URL carries the synthetic replay bot token; the second the case's synthetic invalid one.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:telegram --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const telegramErrorEnvelopeFixture: WireFixture = {
  id: 'telegram.errors.error-envelope.synthetic',
  caseId: 'telegram.errors.error-envelope',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://api.telegram.org',
  note: 'getChat for an absent chat and with an invalid bot token, both answered with { ok: false, error_code, description }. Synthetic placeholder shaped like the Telegram Bot API wire; not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'POST',
        url: 'https://api.telegram.org/bot123456789:yolk-synthetic-replay-token/getChat',
        headers: { 'content-type': 'application/json' },
        body: { chat_id: '-1009999999999' }
      },
      response: {
        status: 400,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ok: false,
          error_code: 400,
          description: 'Bad Request: chat not found'
        })
      }
    },
    {
      request: {
        method: 'POST',
        url: 'https://api.telegram.org/bot0:yolk-conformance-invalid-token/getChat',
        headers: { 'content-type': 'application/json' },
        body: { chat_id: '-1001000000001' }
      },
      response: {
        status: 401,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' })
      }
    }
  ]
}
