import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * Streamed OpenAI tool call, forced with `tool_choice`, whose JSON arguments arrive as
 * `delta.tool_calls` fragments that assemble into one call (this placeholder splits them across
 * several chunks), finishing with `tool_calls`, a usage chunk, and `data: [DONE]`.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording
 * replaces it. Regenerate with `pnpm conformance:openai --live --account <label>`.
 */
export const openAiChatToolCallDeltasFixture: WireFixture = {
  id: 'openai.chat.stream.tool-call-deltas.synthetic',
  caseId: 'openai.chat.stream.tool-call-deltas',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://api.openai.com/v1/chat/completions',
  model: 'gpt-4.1-nano',
  note: 'Synthetic placeholder shaped like OpenAI chat.completion.chunk SSE. Not recorded from a live service; replace with a verified recording from pnpm conformance:openai --live --account <label>.',
  exchanges: [
    {
      request: {
        method: 'POST',
        url: 'https://api.openai.com/v1/chat/completions',
        headers: {
          accept: 'text/event-stream',
          'content-type': 'application/json'
        },
        body: {
          tool_choice: {
            type: 'function',
            function: {
              name: 'lookup_weather'
            }
          },
          model: 'gpt-4.1-nano',
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
          max_completion_tokens: 64,
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
          'content-type': 'text/event-stream; charset=utf-8'
        },
        chunks: [
          'data: {"id":"chatcmpl-synthetic-tool-call","object":"chat.completion.chunk","created":1790000000,"model":"gpt-4.1-nano","service_tier":"default","system_fingerprint":"fp_synthetic","choices":[{"index":0,"delta":{"role":"assistant","content":null,"tool_calls":[{"index":0,"id":"call_synthetic_weather","type":"function","function":{"name":"lookup_weather","arguments":""}}],"refusal":null},"logprobs":null,"finish_reason":null}],"usage":null}\n\n',
          'data: {"id":"chatcmpl-synthetic-tool-call","object":"chat.completion.chunk","created":1790000000,"model":"gpt-4.1-nano","service_tier":"default","system_fingerprint":"fp_synthetic","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"ci"}}]},"logprobs":null,"finish_reason":null}],"usage":null}\n\n',
          'data: {"id":"chatcmpl-synthetic-tool-call","object":"chat.completion.chunk","created":1790000000,"model":"gpt-4.1-nano","service_tier":"default","system_fingerprint":"fp_synthetic","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ty\\":\\"Spri"}}]},"logprobs":null,"finish_reason":null}],"usage":null}\n\n',
          'data: {"id":"chatcmpl-synthetic-tool-call","object":"chat.completion.chunk","created":1790000000,"model":"gpt-4.1-nano","service_tier":"default","system_fingerprint":"fp_synthetic","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ngfield\\"}"}}]},"logprobs":null,"finish_reason":null}],"usage":null}\n\n',
          'data: {"id":"chatcmpl-synthetic-tool-call","object":"chat.completion.chunk","created":1790000000,"model":"gpt-4.1-nano","service_tier":"default","system_fingerprint":"fp_synthetic","choices":[{"index":0,"delta":{},"logprobs":null,"finish_reason":"tool_calls"}],"usage":null}\n\n',
          'data: {"id":"chatcmpl-synthetic-tool-call","object":"chat.completion.chunk","created":1790000000,"model":"gpt-4.1-nano","service_tier":"default","system_fingerprint":"fp_synthetic","choices":[],"usage":{"prompt_tokens":52,"completion_tokens":9,"total_tokens":61,"prompt_tokens_details":{"cached_tokens":0,"audio_tokens":0},"completion_tokens_details":{"reasoning_tokens":0,"audio_tokens":0,"accepted_prediction_tokens":0,"rejected_prediction_tokens":0}}}\n\n',
          'data: [DONE]\n\n'
        ]
      }
    }
  ]
}
