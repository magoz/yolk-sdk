import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * AI Gateway `POST /v1/evaluate` rejecting an unknown model id with the Gateway error envelope
 * `{ message, error_type }`.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until an owner-approved live probe replaces it.
 */
export const vercelAiGatewayClassifierErrorEnvelopeFixture: WireFixture = {
  id: 'vercel-ai-gateway.classify.error-envelope.synthetic',
  caseId: 'vercel-ai-gateway.classify.error-envelope',
  evidence: 'unverified',
  recordedAt: '2026-10-02',
  account: 'synthetic',
  endpoint: 'https://ai-gateway.vercel.sh/v1/evaluate',
  model: 'yolk-conformance/model-does-not-exist',
  note: 'Synthetic placeholder shaped like the documented AI Gateway error envelope the SDK parser reads. Not recorded from a live service; replace with a verified recording from an owner-approved live probe.',
  exchanges: [
    {
      request: {
        method: 'POST',
        url: 'https://ai-gateway.vercel.sh/v1/evaluate',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json'
        },
        body: {
          model: 'yolk-conformance/model-does-not-exist',
          state: 'Synthetic reply: thanks, the fix works on my side.',
          questions: {
            approves: {
              type: 'boolean',
              instructions: 'Does the reply approve the delivered result?',
              criteria: {
                true: 'The reply accepts or approves the result.',
                false: 'The reply rejects or questions the result.'
              }
            }
          }
        }
      },
      response: {
        status: 404,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"message":"Model \'yolk-conformance/model-does-not-exist\' not found","error_type":"model_not_found"}'
      }
    }
  ]
}
