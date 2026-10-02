import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * AI Gateway `POST /v1/evaluate` answering one `choice` question about a JSON object state, with
 * per-option probabilities and the confidence under `providerMetadata.typesafe.confidence` (one of
 * the two plausible confidence placements; the live shape is unverified).
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until an owner-approved live probe replaces it.
 */
export const vercelAiGatewayClassifierChoiceFixture: WireFixture = {
  id: 'vercel-ai-gateway.classify.choice.synthetic',
  caseId: 'vercel-ai-gateway.classify.choice',
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
          state: {
            subject: 'Synthetic invoice question',
            body: 'I was charged twice for the synthetic plan.'
          },
          questions: {
            route: {
              type: 'choice',
              instructions: 'Which team should handle this ticket?',
              criteria: {
                billing: 'Payments, invoices, and refunds.',
                bug: 'Product defects and errors.',
                other: 'Anything else.'
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
        body: '{"model":"typesafe-ai/jev","answers":{"route":{"type":"choice","choice":"billing","probabilities":{"billing":0.91,"bug":0.06,"other":0.03}}},"usage":{"inputTokens":74,"outputTokens":0},"providerMetadata":{"gateway":{"cost":"0.000003108"},"typesafe":{"confidence":{"route":0.88}}}}'
      }
    }
  ]
}
