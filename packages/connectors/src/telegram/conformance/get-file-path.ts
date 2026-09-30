import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * `downloadTelegramFile` of the seeded file id: `getFile` answering `file_id`, `file_path`, and
 * `file_size`, then the file URL answering exactly that many bytes. Both URLs carry the synthetic
 * replay bot token, never a real one.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:telegram --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const telegramGetFilePathFixture: WireFixture = {
  id: 'telegram.files.get-file-path.synthetic',
  caseId: 'telegram.files.get-file-path',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://api.telegram.org',
  note: 'getFile for the seeded file id, then the hosted file download (32 bytes of synthetic text). Synthetic placeholder shaped like the Telegram Bot API wire; not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'GET',
        url: 'https://api.telegram.org/bot123456789:yolk-synthetic-replay-token/getFile?file_id=BQACAgIAAxkDAAIC-yolk_synthetic_file_0001'
      },
      response: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ok: true,
          result: {
            file_id: 'BQACAgIAAxkDAAIC-yolk_synthetic_file_0001',
            file_unique_id: 'AgADyolkSynthetic01',
            file_size: 32,
            file_path: 'documents/file_0.txt'
          }
        })
      }
    },
    {
      request: {
        method: 'GET',
        url: 'https://api.telegram.org/file/bot123456789:yolk-synthetic-replay-token/documents/file_0.txt'
      },
      response: {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
        body: 'yolk-conformance synthetic file\n'
      }
    }
  ]
}
