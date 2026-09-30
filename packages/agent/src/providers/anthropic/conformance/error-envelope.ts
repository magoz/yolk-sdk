import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * Non-2xx Anthropic JSON error envelope (`{ type: 'error', error: { type, message } }`) for a
 * request with an unknown model id (404, `not_found_error`).
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording
 * replaces it. Regenerate with `pnpm conformance:anthropic --live --account <label>`.
 */
export const anthropicMessagesErrorEnvelopeFixture: WireFixture = {
  id: 'anthropic.messages.stream.error-envelope.synthetic',
  caseId: 'anthropic.messages.stream.error-envelope',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://api.anthropic.com/v1/messages',
  model: 'yolk-conformance-model-does-not-exist',
  note: 'Synthetic placeholder for a non-2xx Anthropic error envelope returned for an unknown model id. Not recorded from a live service; replace with a verified recording from pnpm conformance:anthropic --live --account <label>.',
  exchanges: [
    {
      request: {
        method: 'POST',
        url: 'https://api.anthropic.com/v1/messages',
        headers: {
          accept: 'text/event-stream',
          'content-type': 'application/json'
        },
        body: {
          model: 'yolk-conformance-model-does-not-exist',
          system: [
            {
              type: 'text',
              text: 'Reply in one short sentence.'
            }
          ],
          messages: [
            {
              role: 'user',
              content: 'Say hello.'
            }
          ],
          max_tokens: 64,
          stream: true
        }
      },
      response: {
        status: 404,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"type":"error","error":{"type":"not_found_error","message":"Synthetic placeholder: model: yolk-conformance-model-does-not-exist"},"request_id":"req_synthetic_error_envelope"}'
      }
    }
  ]
}
