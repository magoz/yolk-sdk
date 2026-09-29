import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * Non-2xx JSON error envelope (`{ error: { message, type, code } }`) for a request with an
 * invalid model id.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording
 * replaces it. Regenerate with `pnpm conformance:gateway --live --account <label>`.
 */
export const vercelAiGatewayErrorEnvelopeFixture: WireFixture = {
  id: 'vercel-ai-gateway.stream.error-envelope.synthetic',
  caseId: 'vercel-ai-gateway.stream.error-envelope',
  evidence: 'unverified',
  recordedAt: '2026-09-29',
  account: 'synthetic',
  endpoint: 'https://ai-gateway.vercel.sh/v1/chat/completions',
  model: 'yolk-conformance/model-does-not-exist',
  note: 'Synthetic placeholder for a non-2xx OpenAI-compatible error envelope returned for an unknown model id. Not recorded from a live service; replace with a verified recording from pnpm conformance:gateway --live --account <label>.',
  exchanges: [
    {
      request: {
        method: 'POST',
        url: 'https://ai-gateway.vercel.sh/v1/chat/completions',
        headers: {
          accept: 'text/event-stream',
          'content-type': 'application/json'
        },
        body: {
          model: 'yolk-conformance/model-does-not-exist',
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
          max_tokens: 64,
          stream: true,
          stream_options: {
            include_usage: true
          }
        }
      },
      response: {
        status: 400,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"error":{"message":"Synthetic placeholder: the requested model is not available.","type":"invalid_request_error","code":"model_not_found"}}'
      }
    }
  ]
}
