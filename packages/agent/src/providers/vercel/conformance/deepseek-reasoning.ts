import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * DeepSeek-style streamed reasoning (`delta.reasoning_content`, or the Gateway-normalized
 * `delta.reasoning`) before the answer text, then `stop`, a usage chunk with reasoning tokens, and
 * `data: [DONE]`. Requested with `reasoning_effort` and a `thinking` toggle. This placeholder uses
 * `delta.reasoning_content`; the case asserts on provider reasoning events, so either field works.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording
 * replaces it. Regenerate with `pnpm conformance:gateway --live --account <label>`.
 */
export const vercelAiGatewayDeepSeekReasoningFixture: WireFixture = {
  id: 'vercel-ai-gateway.stream.deepseek-reasoning.synthetic',
  caseId: 'vercel-ai-gateway.stream.deepseek-reasoning',
  evidence: 'unverified',
  recordedAt: '2026-09-29',
  account: 'synthetic',
  endpoint: 'https://ai-gateway.vercel.sh/v1/chat/completions',
  model: 'deepseek/deepseek-v3.2',
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
          thinking: {
            type: 'enabled'
          },
          reasoning_effort: 'high',
          model: 'deepseek/deepseek-v3.2',
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
          'data: {"id":"gen-synthetic-deepseek-reasoning","object":"chat.completion.chunk","created":1790000000,"model":"deepseek/deepseek-v3.2","choices":[{"index":0,"delta":{"role":"assistant","content":"","reasoning_content":""},"finish_reason":null}]}\n\n',
          'data: {"id":"gen-synthetic-deepseek-reasoning","object":"chat.completion.chunk","created":1790000000,"model":"deepseek/deepseek-v3.2","choices":[{"index":0,"delta":{"content":"","reasoning_content":"The user wants a greeting."},"finish_reason":null}]}\n\n',
          'data: {"id":"gen-synthetic-deepseek-reasoning","object":"chat.completion.chunk","created":1790000000,"model":"deepseek/deepseek-v3.2","choices":[{"index":0,"delta":{"content":"","reasoning_content":" Keep it short."},"finish_reason":null}]}\n\n',
          'data: {"id":"gen-synthetic-deepseek-reasoning","object":"chat.completion.chunk","created":1790000000,"model":"deepseek/deepseek-v3.2","choices":[{"index":0,"delta":{"content":"Hello","reasoning_content":null},"finish_reason":null}]}\n\n',
          'data: {"id":"gen-synthetic-deepseek-reasoning","object":"chat.completion.chunk","created":1790000000,"model":"deepseek/deepseek-v3.2","choices":[{"index":0,"delta":{"content":" there!","reasoning_content":null},"finish_reason":null}]}\n\n',
          'data: {"id":"gen-synthetic-deepseek-reasoning","object":"chat.completion.chunk","created":1790000000,"model":"deepseek/deepseek-v3.2","choices":[{"index":0,"delta":{"content":""},"finish_reason":"stop"}]}\n\n',
          'data: {"id":"gen-synthetic-deepseek-reasoning","object":"chat.completion.chunk","created":1790000000,"model":"deepseek/deepseek-v3.2","choices":[],"usage":{"prompt_tokens":15,"completion_tokens":12,"total_tokens":27,"completion_tokens_details":{"reasoning_tokens":8}}}\n\n',
          'data: [DONE]\n\n'
        ]
      }
    }
  ]
}
