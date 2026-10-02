import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * AI Gateway `POST /v1/evaluate` answering one `boolean` question with a probability, token usage,
 * and `providerMetadata.gateway.cost`.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until an owner-approved live probe replaces it.
 */
export const vercelAiGatewayClassifierBooleanFixture: WireFixture = {
  id: 'vercel-ai-gateway.classify.boolean.synthetic',
  caseId: 'vercel-ai-gateway.classify.boolean',
  evidence: 'unverified',
  recordedAt: '2026-10-02',
  account: 'synthetic',
  endpoint: 'https://ai-gateway.vercel.sh/v1/evaluate',
  model: 'typesafe-ai/jev',
  note: 'Synthetic placeholder shaped like the documented AI Gateway evaluation response the SDK parser reads. Not recorded from a live service; replace with a verified recording from an owner-approved live probe.',
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
          model: 'typesafe-ai/jev',
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
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"model":"typesafe-ai/jev","answers":{"approves":{"type":"boolean","probability":0.93}},"usage":{"inputTokens":58,"outputTokens":0},"providerMetadata":{"gateway":{"cost":"0.000002436"}}}'
      }
    }
  ]
}
