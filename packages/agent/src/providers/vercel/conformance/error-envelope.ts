import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * Non-2xx JSON error envelope for a request with an invalid model id.
 *
 * Verified recording (2026-09-30). Regenerate with
 * `pnpm conformance:gateway --live --account <label>`.
 */
export const vercelAiGatewayErrorEnvelopeFixture: WireFixture = {
  id: 'vercel-ai-gateway.stream.error-envelope.recorded',
  caseId: 'vercel-ai-gateway.stream.error-envelope',
  evidence: 'verified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://ai-gateway.vercel.sh/v1/chat/completions',
  model: 'yolk-conformance/model-does-not-exist',
  note: 'Recorded from the live Vercel AI Gateway by running its conformance case through pnpm conformance:gateway --live. Prompts and outputs are synthetic.',
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
        status: 404,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"error":{"message":"Model \'yolk-conformance/model-does-not-exist\' not found","type":"model_not_found","param":{"modelId":"yolk-conformance/model-does-not-exist"}}}'
      }
    }
  ]
}
