import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * AI Gateway `POST /v1/evaluate` answering one `score` question about a JSON array state, with
 * per-level probabilities and the confidence on the answer. The live Gateway (probe 2026-10-02)
 * sends confidence both on the answer and in `providerMetadata.typesafe.confidence`, and `score` is
 * the probability-weighted, zero-based level index.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until it is re-recorded through the
 * replay-verified write gate.
 */
export const vercelAiGatewayClassifierScoreFixture: WireFixture = {
  id: 'vercel-ai-gateway.classify.score.synthetic',
  caseId: 'vercel-ai-gateway.classify.score',
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
          state: [
            {
              author: 'synthetic-user',
              text: 'The synthetic dashboard is down for everyone.'
            }
          ],
          questions: {
            urgency: {
              type: 'score',
              instructions: 'How urgent is this report?',
              criteria: ['Not urgent.', 'Somewhat urgent.', 'Urgent.', 'Critical outage.']
            }
          }
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"model":"typesafe-ai/jev","answers":{"urgency":{"type":"score","score":3,"probabilities":{"0":0.01,"1":0.04,"2":0.15,"3":0.8},"confidence":0.77}},"usage":{"inputTokens":66,"outputTokens":0},"providerMetadata":{"gateway":{"cost":"0.000002772"}}}'
      }
    }
  ]
}
