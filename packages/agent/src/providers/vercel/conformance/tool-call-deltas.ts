import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * Streamed tool call whose JSON arguments arrive as `delta.tool_calls` fragments that assemble
 * into one call (this placeholder splits them across several chunks), finishing with
 * `tool_calls`, a usage chunk, and `data: [DONE]`.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording
 * replaces it. Regenerate with `pnpm conformance:gateway --live --account <label>`.
 */
export const vercelAiGatewayToolCallDeltasFixture: WireFixture = {
  id: 'vercel-ai-gateway.stream.tool-call-deltas.synthetic',
  caseId: 'vercel-ai-gateway.stream.tool-call-deltas',
  evidence: 'unverified',
  recordedAt: '2026-09-29',
  account: 'synthetic',
  endpoint: 'https://ai-gateway.vercel.sh/v1/chat/completions',
  model: 'openai/gpt-4.1-nano',
  note: 'Synthetic placeholder shaped like OpenAI-compatible Gateway chat.completion.chunk SSE. Not recorded from a live service; replace with a verified recording from pnpm conformance:gateway --live --account <label>.',
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
          'data: {"id":"gen-synthetic-tool-call","object":"chat.completion.chunk","created":1790000000,"model":"openai/gpt-4.1-nano","choices":[{"index":0,"delta":{"role":"assistant","content":null,"tool_calls":[{"index":0,"id":"call_synthetic_weather","type":"function","function":{"name":"lookup_weather","arguments":""}}]},"finish_reason":null}]}\n\n',
          'data: {"id":"gen-synthetic-tool-call","object":"chat.completion.chunk","created":1790000000,"model":"openai/gpt-4.1-nano","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"ci"}}]},"finish_reason":null}]}\n\n',
          'data: {"id":"gen-synthetic-tool-call","object":"chat.completion.chunk","created":1790000000,"model":"openai/gpt-4.1-nano","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ty\\":\\"Spri"}}]},"finish_reason":null}]}\n\n',
          'data: {"id":"gen-synthetic-tool-call","object":"chat.completion.chunk","created":1790000000,"model":"openai/gpt-4.1-nano","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ngfield\\"}"}}]},"finish_reason":null}]}\n\n',
          'data: {"id":"gen-synthetic-tool-call","object":"chat.completion.chunk","created":1790000000,"model":"openai/gpt-4.1-nano","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
          'data: {"id":"gen-synthetic-tool-call","object":"chat.completion.chunk","created":1790000000,"model":"openai/gpt-4.1-nano","choices":[],"usage":{"prompt_tokens":48,"completion_tokens":9,"total_tokens":57}}\n\n',
          'data: [DONE]\n\n'
        ]
      }
    }
  ]
}
