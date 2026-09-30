import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * Non-2xx JSON error envelope (`{ error: { message, type, param, code } }`, 400 `model_not_found`) from the ChatGPT Codex Responses endpoint for a request with an unknown model id.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording
 * replaces it. Regenerate with `pnpm conformance:codex --live --account <label>`.
 */
export const openAiCodexErrorEnvelopeFixture: WireFixture = {
  id: 'openai.codex.stream.error-envelope.synthetic',
  caseId: 'openai.codex.stream.error-envelope',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://chatgpt.com/backend-api/codex/responses',
  model: 'yolk-conformance-model-does-not-exist',
  note: 'Synthetic placeholder for a non-2xx error envelope returned by the ChatGPT Codex Responses endpoint for an unknown model id. Not recorded from a live service; replace with a verified recording from pnpm conformance:codex --live --account <label>.',
  exchanges: [
    {
      request: {
        method: 'POST',
        url: 'https://chatgpt.com/backend-api/codex/responses',
        headers: {
          accept: 'text/event-stream',
          'content-type': 'application/json'
        },
        body: {
          model: 'yolk-conformance-model-does-not-exist',
          instructions: 'Reply in one short sentence.',
          input: [
            {
              role: 'user',
              content: 'Say hello.'
            }
          ],
          store: false,
          stream: true,
          reasoning: {
            effort: 'low',
            summary: 'auto'
          }
        }
      },
      response: {
        status: 400,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"error":{"message":"Synthetic placeholder: the requested model yolk-conformance-model-does-not-exist is not supported.","type":"invalid_request_error","param":"model","code":"model_not_found"}}'
      }
    }
  ]
}
