import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * `telegram.send_message` of the synthetic run-scoped text to the seeded chat: one POST
 * `sendMessage`, answered with `{ ok: true, result }`. The URL carries the synthetic replay bot
 * token, never a real one.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:telegram --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const telegramSendMessageFixture: WireFixture = {
  id: 'telegram.messages.send-message.synthetic',
  caseId: 'telegram.messages.send-message',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://api.telegram.org',
  note: 'One sendMessage call to the seeded practice chat, answered ok with the sent message. Synthetic placeholder shaped like the Telegram Bot API wire; not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'POST',
        url: 'https://api.telegram.org/bot123456789:yolk-synthetic-replay-token/sendMessage',
        headers: { 'content-type': 'application/json' },
        body: {
          chat_id: '-1001000000001',
          text: 'yolk-conformance run-synthetic: synthetic conformance message, safe to ignore',
          disable_web_page_preview: true
        }
      },
      response: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ok: true,
          result: {
            message_id: 101,
            from: {
              id: 123456789,
              is_bot: true,
              first_name: 'Synthetic Practice Bot',
              username: 'yolk_synthetic_bot'
            },
            chat: { id: -1001000000001, title: 'Synthetic practice group', type: 'supergroup' },
            date: 1790000000,
            text: 'yolk-conformance run-synthetic: synthetic conformance message, safe to ignore'
          }
        })
      }
    }
  ]
}
