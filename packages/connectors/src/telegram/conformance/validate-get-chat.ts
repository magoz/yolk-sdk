import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * `telegram.validate` for the seeded chat: one POST `getChat`, answered with `{ ok: true, result }`.
 * The URL carries the synthetic replay bot token, never a real one.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:telegram --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const telegramValidateGetChatFixture: WireFixture = {
  id: 'telegram.validate.get-chat.synthetic',
  caseId: 'telegram.validate.get-chat',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://api.telegram.org',
  note: 'A getChat call for the seeded practice chat, answered ok. Synthetic placeholder shaped like the Telegram Bot API wire; not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'POST',
        url: 'https://api.telegram.org/bot123456789:yolk-synthetic-replay-token/getChat',
        headers: { 'content-type': 'application/json' },
        body: { chat_id: '-1001000000001' }
      },
      response: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ok: true,
          result: {
            id: -1001000000001,
            title: 'Synthetic practice group',
            type: 'supergroup',
            permissions: { can_send_messages: true },
            accent_color_id: 0,
            max_reaction_count: 11
          }
        })
      }
    }
  ]
}
