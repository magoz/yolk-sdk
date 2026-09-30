import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * DeepSeek-style streamed reasoning (the Gateway-normalized `delta.reasoning`, or `delta.reasoning_content`) before the answer text, requested with `reasoning_effort` and a `thinking` toggle.
 *
 * Verified recording (2026-09-30). Regenerate with
 * `pnpm conformance:gateway --live --owner-approved --account <label>`.
 */
export const vercelAiGatewayDeepSeekReasoningFixture: WireFixture = {
  id: 'vercel-ai-gateway.stream.deepseek-reasoning.recorded',
  caseId: 'vercel-ai-gateway.stream.deepseek-reasoning',
  evidence: 'verified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://ai-gateway.vercel.sh/v1/chat/completions',
  model: 'deepseek/deepseek-v4.1-flash',
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
          thinking: {
            type: 'enabled'
          },
          reasoning_effort: 'low',
          model: 'deepseek/deepseek-v4.1-flash',
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
          max_tokens: 512,
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
          'data: {"id":"gen_01M3RJQ3Y1VK4ZCZKVPP064XG8","object":"chat.completion.chunk","created":1790752559,"model":"deepseek/deepseek-v4.1-flash","choices":[{"index":0,"delta":{"role":"assistant"},"logprobs":null,"finish_reason":null}],"system_fingerprint":"fp_5wr68oag7j"}\n\n',
          'data: {"id":"gen_01M3RJQ3Y1VK4ZCZKVPP064XG8","object":"chat.completion.chunk","created":1790752559,"model":"deepseek/deepseek-v4.1-flash","choices":[{"index":0,"delta":{"reasoning":"We","reasoning_details":[{"type":"reasoning.text","text":"We","format":"unknown","index":0}]},"logprobs":null,"finish_reason":null}],"system_fingerprint":"fp_5wr68oag7j"}\n\n',
          'data: {"id":"gen_01M3RJQ3Y1VK4ZCZKVPP064XG8","object":"chat.completion.chunk","created":1790752559,"model":"deepseek/deepseek-v4.1-flash","choices":[{"index":0,"delta":{"reasoning":" need answer user","reasoning_details":[{"type":"reasoning.text","text":" need answer user","format":"unknown","index":0}]},"logprobs":null,"finish_reason":null}],"system_fingerprint":"fp_5wr68oag7j"}\n\n',
          'data: {"id":"gen_01M3RJQ3Y1VK4ZCZKVPP064XG8","object":"chat.completion.chunk","created":1790752559,"model":"deepseek/deepseek-v4.1-flash","choices":[{"index":0,"delta":{"reasoning":":","reasoning_details":[{"type":"reasoning.text","text":":","format":"unknown","index":0}]},"logprobs":null,"finish_reason":null}],"system_fingerprint":"fp_5wr68oag7j"}\n\n',
          'data: {"id":"gen_01M3RJQ3Y1VK4ZCZKVPP064XG8","object":"chat.completion.chunk","created":1790752559,"model":"deepseek/deepseek-v4.1-flash","choices":[{"index":0,"delta":{"reasoning":" \\"Reply","reasoning_details":[{"type":"reasoning.text","text":" \\"Reply","format":"unknown","index":0}]},"logprobs":null,"finish_reason":null}],"system_fingerprint":"fp_5wr68oag7j"}\n\n',
          'data: {"id":"gen_01M3RJQ3Y1VK4ZCZKVPP064XG8","object":"chat.completion.chunk","created":1790752559,"model":"deepseek/deepseek-v4.1-flash","choices":[{"index":0,"delta":{"reasoning":" in one short sentence","reasoning_details":[{"type":"reasoning.text","text":" in one short sentence","format":"unknown","index":0}]},"logprobs":null,"finish_reason":null}],"system_fingerprint":"fp_5wr68oag7j"}\n\n',
          'data: {"id":"gen_01M3RJQ3Y1VK4ZCZKVPP064XG8","object":"chat.completion.chunk","created":1790752559,"model":"deepseek/deepseek-v4.1-flash","choices":[{"index":0,"delta":{"reasoning":". Say hello","reasoning_details":[{"type":"reasoning.text","text":". Say hello","format":"unknown","index":0}]},"logprobs":null,"finish_reason":null}],"system_fingerprint":"fp_5wr68oag7j"}\n\n',
          'data: {"id":"gen_01M3RJQ3Y1VK4ZCZKVPP064XG8","object":"chat.completion.chunk","created":1790752559,"model":"deepseek/deepseek-v4.1-flash","choices":[{"index":0,"delta":{"reasoning":".\\" We","reasoning_details":[{"type":"reasoning.text","text":".\\" We","format":"unknown","index":0}]},"logprobs":null,"finish_reason":null}],"system_fingerprint":"fp_5wr68oag7j"}\n\n',
          'data: {"id":"gen_01M3RJQ3Y1VK4ZCZKVPP064XG8","object":"chat.completion.chunk","created":1790752559,"model":"deepseek/deepseek-v4.1-flash","choices":[{"index":0,"delta":{"reasoning":" need comply","reasoning_details":[{"type":"reasoning.text","text":" need comply","format":"unknown","index":0}]},"logprobs":null,"finish_reason":null}],"system_fingerprint":"fp_5wr68oag7j"}\n\n',
          'data: {"id":"gen_01M3RJQ3Y1VK4ZCZKVPP064XG8","object":"chat.completion.chunk","created":1790752559,"model":"deepseek/deepseek-v4.1-flash","choices":[{"index":0,"delta":{"reasoning":". Must be one short sentence","reasoning_details":[{"type":"reasoning.text","text":". Must be one short sentence","format":"unknown","index":0}]},"logprobs":null,"finish_reason":null}],"system_fingerprint":"fp_5wr68oag7j"}\n\ndata: {"id":"gen_01M3RJQ3Y1VK4ZCZKVPP064XG8","object":"chat.completion.chunk","created":1790752559,"model":"deepseek/deepseek-v4.1-flash","choices":[{"index":0,"delta":{"reasoning":". Say hello","reasoning_details":[{"type":"reasoning.text","text":". Say hello","format":"unknown","index":0}]},"logprobs":null,"finish_reason":null}],"system_fingerprint":"fp_5wr68oag7j"}\n\ndata: {"id":"gen_01M3RJQ3Y1VK4ZCZKVPP064XG8","object":"chat.completion.chunk","created":1790752559,"model":"deepseek/deepseek-v4.1-flash","choices":[{"index":0,"delta":{"reasoning":". Maybe \\"Hello!\\"","reasoning_details":[{"type":"reasoning.text","text":". Maybe \\"Hello!\\"","format":"unknown","index":0}]},"logprobs":null,"finish_reason":null}],"system_fingerprint":"fp_5wr68oag7j"}\n\ndata: {"id":"gen_01M3RJQ3Y1VK4ZCZKVPP064XG8","object":"chat.completion.chunk","created":1790752559,"model":"deepseek/deepseek-v4.1-flash","choices":[{"index":0,"delta":{"reasoning":" That\'s one short","reasoning_details":[{"type":"reasoning.text","text":" That\'s one short","format":"unknown","index":0}]},"logprobs":null,"finish_reason":null}],"system_fingerprint":"fp_5wr68oag7j"}\n\n',
          'data: {"id":"gen_01M3RJQ3Y1VK4ZCZKVPP064XG8","object":"chat.completion.chunk","created":1790752559,"model":"deepseek/deepseek-v4.1-flash","choices":[{"index":0,"delta":{"reasoning":" sentence. Ensure no","reasoning_details":[{"type":"reasoning.text","text":" sentence. Ensure no","format":"unknown","index":0}]},"logprobs":null,"finish_reason":null}],"system_fingerprint":"fp_5wr68oag7j"}\n\n',
          'data: {"id":"gen_01M3RJQ3Y1VK4ZCZKVPP064XG8","object":"chat.completion.chunk","created":1790752559,"model":"deepseek/deepseek-v4.1-flash","choices":[{"index":0,"delta":{"reasoning":" extra.","reasoning_details":[{"type":"reasoning.text","text":" extra.","format":"unknown","index":0}]},"logprobs":null,"finish_reason":null}],"system_fingerprint":"fp_5wr68oag7j"}\n\ndata: {"id":"gen_01M3RJQ3Y1VK4ZCZKVPP064XG8","object":"chat.completion.chunk","created":1790752559,"model":"deepseek/deepseek-v4.1-flash","choices":[{"index":0,"delta":{"content":"Hello!"},"logprobs":null,"finish_reason":null}],"system_fingerprint":"fp_5wr68oag7j"}\n\ndata: {"id":"gen_01M3RJQ3Y1VK4ZCZKVPP064XG8","object":"chat.completion.chunk","created":1790752559,"model":"deepseek/deepseek-v4.1-flash","choices":[{"index":0,"delta":{"provider_metadata":{"baseten":{"acceptedPredictionTokens":31,"rejectedPredictionTokens":44},"gateway":{"routing":{"originalModelId":"deepseek/deepseek-v4.1-flash","resolvedProvider":"baseten","fallbacksAvailable":["fireworks","alibaba","runware","relace","particle","novita","togetherai","deepinfra","wafer","parasail","gmicloud","modal","morph","deepseek","runinfra","boundless"],"planningReasoning":"System credentials planned for: baseten, fireworks, alibaba, runware, relace, particle, novita, togetherai, deepinfra, wafer, parasail, gmicloud, modal, morph, deepseek, runinfra, boundless. Total execution order: baseten(system) → fireworks(system) → alibaba(system) → runware(system) → relace(system) → particle(system) → novita(system) → togetherai(system) → deepinfra(system) → wafer(system) → parasail(system) → gmicloud(system) → modal(system) → morph(system) → deepseek(system) → runinfra(system) → boundless(system)","canonicalSlug":"deepseek/deepseek-v4.1-flash","finalProvider":"baseten","modelAttemptCount":1,"modelAttempts":[{"canonicalSlug":"deepseek/deepseek-v4.1-flash","success":true,"providerAttemptCount":1,"providerAttempts":[{"provider":"baseten","credentialType":"system","success":true,"startTime":1790752559087,"endTime":1790752560001,"providerRequestId":"54ca701a0f12b90297b22b02b4a41a88c4060","statusCode":200,"providerResponseId":"chatcmpl-bb148a15bb5c413e9bbf55e283f8821b"}]}],"totalProviderAttemptCount":1,"affinity":{"outcome":"skipped_below_min_prefix"},"clientSessionId":"redacted-client-session","clientSessionIdSource":"fingerprint"},"cost":"0.0000672","marketCost":"0.0000672","surchargeCost":"0","gatewayCost":"0.0000672","inferenceCost":"0.0000672","inputInferenceCost":"0.000012","outputInferenceCost":"0.0000552","generationId":"gen_01M3RJQ3Y1VK4ZCZKVPP064XG8"}}},"logprobs":null,"finish_reason":"stop"}],"usage":{"prompt_tokens":40,"completion_tokens":46,"total_tokens":86,"cost":0.0000672,"is_byok":false,"prompt_tokens_details":{"cached_tokens":0,"audio_tokens":0,"video_tokens":0},"cost_details":{"upstream_inference_cost":null,"upstream_inference_prompt_cost":0,"upstream_inference_completions_cost":0},"completion_tokens_details":{"reasoning_tokens":42,"image_tokens":0},"cache_creation_input_tokens":0,"market_cost":0.0000672,"gateway_cost":0.0000672},"system_fingerprint":"fp_5wr68oag7j","generationId":"gen_01M3RJQ3Y1VK4ZCZKVPP064XG8"}\n\ndata: [DONE]\n\n'
        ]
      }
    }
  ]
}
