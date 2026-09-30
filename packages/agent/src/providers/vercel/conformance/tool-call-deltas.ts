import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * Streamed tool call whose JSON arguments arrive as `delta.tool_calls` fragments that assemble into one call.
 *
 * Verified recording (2026-09-30). Regenerate with
 * `pnpm conformance:gateway --live --account <label>`.
 */
export const vercelAiGatewayToolCallDeltasFixture: WireFixture = {
  id: 'vercel-ai-gateway.stream.tool-call-deltas.recorded',
  caseId: 'vercel-ai-gateway.stream.tool-call-deltas',
  evidence: 'verified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://ai-gateway.vercel.sh/v1/chat/completions',
  model: 'openai/gpt-4.1-nano',
  note: 'Recorded from the live Vercel AI Gateway by running its conformance case through pnpm conformance:gateway --live. Prompts and outputs are synthetic. clientSessionId redacted after recording.',
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
              content: 'What is the weather in Springfield? Use the tool.'
            }
          ],
          max_tokens: 64,
          stream: true,
          stream_options: {
            include_usage: true
          },
          tools: [
            {
              type: 'function',
              function: {
                name: 'lookup_weather',
                description: 'Look up the current weather for a city.',
                parameters: {
                  type: 'object',
                  properties: {
                    city: {
                      type: 'string'
                    }
                  },
                  required: ['city'],
                  additionalProperties: false
                }
              }
            }
          ],
          parallel_tool_calls: true
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'text/event-stream'
        },
        chunks: [
          'data: {"id":"gen_01M3RJQ4Y5T3YBSZ53M4SXBM1M","object":"chat.completion.chunk","created":1790752561,"model":"openai/gpt-4.1-nano","choices":[{"index":0,"delta":{"role":"assistant"},"logprobs":null,"finish_reason":null}],"system_fingerprint":"fp_d72r0jc07w"}\n\ndata: {"id":"gen_01M3RJQ4Y5T3YBSZ53M4SXBM1M","object":"chat.completion.chunk","created":1790752561,"model":"openai/gpt-4.1-nano","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_PPgIsvVSqOXPm73xqTOTi9Xb","type":"function","function":{"name":"lookup_weather","arguments":""}}]},"logprobs":null,"finish_reason":null}],"system_fingerprint":"fp_d72r0jc07w"}\n\ndata: {"id":"gen_01M3RJQ4Y5T3YBSZ53M4SXBM1M","object":"chat.completion.chunk","created":1790752561,"model":"openai/gpt-4.1-nano","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":\\"Springfield\\"}"}}]},"logprobs":null,"finish_reason":null}],"system_fingerprint":"fp_d72r0jc07w"}\n\n',
          'data: {"id":"gen_01M3RJQ4Y5T3YBSZ53M4SXBM1M","object":"chat.completion.chunk","created":1790752561,"model":"openai/gpt-4.1-nano","choices":[{"index":0,"delta":{"provider_metadata":{"openai":{"responseId":"resp_00dc756baac5ab1c016abcb730379887d1a98f7b7e5454c94b","serviceTier":"default"},"gateway":{"routing":{"originalModelId":"openai/gpt-4.1-nano","resolvedProvider":"openai","fallbacksAvailable":["azure"],"planningReasoning":"System credentials planned for: openai, azure. Total execution order: openai(system) → azure(system)","canonicalSlug":"openai/gpt-4.1-nano","finalProvider":"openai","modelAttemptCount":1,"modelAttempts":[{"canonicalSlug":"openai/gpt-4.1-nano","success":true,"providerAttemptCount":1,"providerAttempts":[{"provider":"openai","credentialType":"system","success":true,"startTime":1790752560100,"endTime":1790752561184,"providerRequestId":"req_c39432217f4d40e295fe39b191367cc8","statusCode":200,"providerResponseId":"resp_00dc756baac5ab1c016abcb730379887d1a98f7b7e5454c94b"}]}],"totalProviderAttemptCount":1,"affinity":{"outcome":"skipped_below_min_prefix"},"clientSessionId":"redacted-client-session","clientSessionIdSource":"fingerprint"},"cost":"0.0000189","marketCost":"0.0000189","surchargeCost":"0","gatewayCost":"0.0000189","inferenceCost":"0.0000189","inputInferenceCost":"0.0000061","outputInferenceCost":"0.0000128","generationId":"gen_01M3RJQ4Y5T3YBSZ53M4SXBM1M"}}},"logprobs":null,"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":61,"completion_tokens":32,"total_tokens":93,"cost":0.0000189,"is_byok":false,"prompt_tokens_details":{"cached_tokens":0,"audio_tokens":0,"video_tokens":0},"cost_details":{"upstream_inference_cost":null,"upstream_inference_prompt_cost":0,"upstream_inference_completions_cost":0},"completion_tokens_details":{"reasoning_tokens":0,"image_tokens":0},"cache_creation_input_tokens":0,"market_cost":0.0000189,"gateway_cost":0.0000189},"system_fingerprint":"fp_d72r0jc07w","service_tier":"default","generationId":"gen_01M3RJQ4Y5T3YBSZ53M4SXBM1M"}\n\ndata: [DONE]\n\n'
        ]
      }
    }
  ]
}
