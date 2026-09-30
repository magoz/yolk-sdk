import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * Non-2xx OpenAI JSON error envelope (`{ error: { message, type, param, code } }`) for a request
 * with an unknown model id (404, `model_not_found`).
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording
 * replaces it. Regenerate with `pnpm conformance:openai --live --owner-approved --account <label>`.
 */
export const openAiChatErrorEnvelopeFixture: WireFixture = {
  id: 'openai.chat.stream.error-envelope.synthetic',
  caseId: 'openai.chat.stream.error-envelope',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://api.openai.com/v1/chat/completions',
  model: 'yolk-conformance-model-does-not-exist',
  note: 'Synthetic placeholder for a non-2xx OpenAI error envelope returned for an unknown model id. Not recorded from a live service; replace with a verified recording from pnpm conformance:openai --live --owner-approved --account <label>.',
  exchanges: [
    {
      request: {
        method: 'POST',
        url: 'https://api.openai.com/v1/chat/completions',
        headers: {
          accept: 'text/event-stream',
          'content-type': 'application/json'
        },
        body: {
          model: 'yolk-conformance-model-does-not-exist',
          messages: [
            {
              role: 'system',
              content: 'Reply in one short sentence.'
            },
            {
              role: 'user',
              content: 'Say hello.'
            }
          ],
          max_completion_tokens: 64,
          stream: true,
          stream_options: {
            include_usage: true
          }
        }
      },
      response: {
        status: 404,
        headers: {
          'content-type': 'application/json; charset=utf-8'
        },
        body: '{"error":{"message":"Synthetic placeholder: the requested model does not exist.","type":"invalid_request_error","param":null,"code":"model_not_found"}}'
      }
    }
  ]
}
