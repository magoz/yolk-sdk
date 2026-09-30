import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * Streamed plain-text answer: text deltas, a `stop` finish with usage (`stream_options.include_usage`), and `data: [DONE]`.
 *
 * Verified recording (2026-09-30). Regenerate with
 * `pnpm conformance:gateway --live --account <label>`.
 */
export const vercelAiGatewayPlainTextFixture: WireFixture = {
  id: 'vercel-ai-gateway.stream.plain-text.recorded',
  caseId: 'vercel-ai-gateway.stream.plain-text',
  evidence: 'verified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://ai-gateway.vercel.sh/v1/chat/completions',
  model: 'openai/gpt-4.1-nano',
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
          model: 'openai/gpt-4.1-nano',
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
        status: 200,
        headers: {
          'content-type': 'text/event-stream'
        },
        chunks: [
          'data: {"id":"gen_01M3RJQ2GXYP8F188NH5K17ED5","object":"chat.completion.chunk","created":1790752558,"model":"openai/gpt-4.1-nano","choices":[{"index":0,"delta":{"role":"assistant"},"logprobs":null,"finish_reason":null}],"system_fingerprint":"fp_w2ojz1490e"}\n\ndata: {"id":"gen_01M3RJQ2GXYP8F188NH5K17ED5","object":"chat.completion.chunk","created":1790752558,"model":"openai/gpt-4.1-nano","choices":[{"index":0,"delta":{"content":"Hello"},"logprobs":null,"finish_reason":null}],"system_fingerprint":"fp_w2ojz1490e"}\n\n',
          'data: {"id":"gen_01M3RJQ2GXYP8F188NH5K17ED5","object":"chat.completion.chunk","created":1790752558,"model":"openai/gpt-4.1-nano","choices":[{"index":0,"delta":{"content":"!"},"logprobs":null,"finish_reason":null}],"system_fingerprint":"fp_w2ojz1490e"}\n\n',
          'data: {"id":"gen_01M3RJQ2GXYP8F188NH5K17ED5","object":"chat.completion.chunk","created":1790752558,"model":"openai/gpt-4.1-nano","choices":[{"index":0,"delta":{"provider_metadata":{"openai":{"responseId":"resp_0a42212b1a39dc62016abcb72e395c87d1b8d81311c4934377","serviceTier":"default"},"gateway":{"routing":{"originalModelId":"openai/gpt-4.1-nano","resolvedProvider":"openai","fallbacksAvailable":["azure"],"planningReasoning":"System credentials planned for: openai, azure. Total execution order: openai(system) → azure(system)","canonicalSlug":"openai/gpt-4.1-nano","finalProvider":"openai","modelAttemptCount":1,"modelAttempts":[{"canonicalSlug":"openai/gpt-4.1-nano","success":true,"providerAttemptCount":1,"providerAttempts":[{"provider":"openai","credentialType":"system","success":true,"startTime":1790752558092,"endTime":1790752558944,"providerRequestId":"req_76c551ce4d4542c58ce7a0a0e5433ded","statusCode":200,"providerResponseId":"resp_0a42212b1a39dc62016abcb72e395c87d1b8d81311c4934377"}]}],"totalProviderAttemptCount":1,"affinity":{"outcome":"skipped_below_min_prefix"},"clientSessionId":"a6f93ad2a7aaf9e138e071a96004c57e","clientSessionIdSource":"fingerprint"},"cost":"0.0000032","marketCost":"0.0000032","surchargeCost":"0","gatewayCost":"0.0000032","inferenceCost":"0.0000032","inputInferenceCost":"0.000002","outputInferenceCost":"0.0000012","generationId":"gen_01M3RJQ2GXYP8F188NH5K17ED5"}}},"logprobs":null,"finish_reason":"stop"}],"usage":{"prompt_tokens":20,"completion_tokens":3,"total_tokens":23,"cost":0.0000032,"is_byok":false,"prompt_tokens_details":{"cached_tokens":0,"audio_tokens":0,"video_tokens":0},"cost_details":{"upstream_inference_cost":null,"upstream_inference_prompt_cost":0,"upstream_inference_completions_cost":0},"completion_tokens_details":{"reasoning_tokens":0,"image_tokens":0},"cache_creation_input_tokens":0,"market_cost":0.0000032,"gateway_cost":0.0000032},"system_fingerprint":"fp_w2ojz1490e","service_tier":"default","generationId":"gen_01M3RJQ2GXYP8F188NH5K17ED5"}\n\ndata: [DONE]\n\n'
        ]
      }
    }
  ]
}
