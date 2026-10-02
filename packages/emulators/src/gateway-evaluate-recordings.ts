/**
 * AI Gateway classifier (`POST /v1/evaluate`) recordings the `/gateway` evaluate route answers
 * from.
 *
 * Copied as data from the committed (synthetic, unverified) classifier conformance fixtures; never
 * imported. `test/fixture-recordings.test.ts` fails when a fixture changes and this copy does not.
 * Internal; not a package export.
 */
import type { FixtureRecording } from './fixture-route.ts'

const approvalRequestBody = (model: string) => ({
  model,
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
})

const jsonHeaders = {
  accept: 'application/json',
  'content-type': 'application/json'
}

const jsonResponseHeaders = {
  'content-type': 'application/json'
}

export const gatewayEvaluateBooleanRecording: FixtureRecording = {
  fixtureId: 'vercel-ai-gateway.classify.boolean.synthetic',
  caseId: 'vercel-ai-gateway.classify.boolean',
  request: {
    method: 'POST',
    path: '/v1/evaluate',
    query: '',
    headers: jsonHeaders,
    body: approvalRequestBody('typesafe-ai/jev')
  },
  response: {
    status: 200,
    headers: jsonResponseHeaders,
    streamed: false,
    chunks: [
      '{"model":"typesafe-ai/jev","answers":{"approves":{"type":"boolean","probability":0.93}},"usage":{"inputTokens":58,"outputTokens":0},"providerMetadata":{"gateway":{"cost":"0.000002436"}}}'
    ]
  }
}

export const gatewayEvaluateChoiceRecording: FixtureRecording = {
  fixtureId: 'vercel-ai-gateway.classify.choice.synthetic',
  caseId: 'vercel-ai-gateway.classify.choice',
  request: {
    method: 'POST',
    path: '/v1/evaluate',
    query: '',
    headers: jsonHeaders,
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
    headers: jsonResponseHeaders,
    streamed: false,
    chunks: [
      '{"model":"typesafe-ai/jev","answers":{"route":{"type":"choice","choice":"billing","probabilities":{"billing":0.91,"bug":0.06,"other":0.03}}},"usage":{"inputTokens":74,"outputTokens":0},"providerMetadata":{"gateway":{"cost":"0.000003108"},"typesafe":{"confidence":{"route":0.88}}}}'
    ]
  }
}

export const gatewayEvaluateScoreRecording: FixtureRecording = {
  fixtureId: 'vercel-ai-gateway.classify.score.synthetic',
  caseId: 'vercel-ai-gateway.classify.score',
  request: {
    method: 'POST',
    path: '/v1/evaluate',
    query: '',
    headers: jsonHeaders,
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
    headers: jsonResponseHeaders,
    streamed: false,
    chunks: [
      '{"model":"typesafe-ai/jev","answers":{"urgency":{"type":"score","score":2.74,"probabilities":{"0":0.01,"1":0.04,"2":0.15,"3":0.8},"confidence":0.77}},"usage":{"inputTokens":66,"outputTokens":0},"providerMetadata":{"gateway":{"cost":"0.000002772"}}}'
    ]
  }
}

export const gatewayEvaluateErrorEnvelopeRecording: FixtureRecording = {
  fixtureId: 'vercel-ai-gateway.classify.error-envelope.synthetic',
  caseId: 'vercel-ai-gateway.classify.error-envelope',
  request: {
    method: 'POST',
    path: '/v1/evaluate',
    query: '',
    headers: jsonHeaders,
    body: approvalRequestBody('yolk-conformance/model-does-not-exist')
  },
  response: {
    status: 404,
    headers: jsonResponseHeaders,
    streamed: false,
    chunks: [
      '{"message":"Model \'yolk-conformance/model-does-not-exist\' not found","error_type":"model_not_found"}'
    ]
  }
}

/** Every classifier recording, in conformance case order. */
export const gatewayEvaluateRecordings: ReadonlyArray<FixtureRecording> = [
  gatewayEvaluateBooleanRecording,
  gatewayEvaluateChoiceRecording,
  gatewayEvaluateScoreRecording,
  gatewayEvaluateErrorEnvelopeRecording
]
