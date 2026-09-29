import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * Streamed plain-text answer: text deltas (one event split across two network chunks), a `stop`
 * finish chunk, a usage-only chunk, and `data: [DONE]`.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording
 * replaces it. Regenerate with `scripts/record-gateway-fixtures.ts --live`.
 */
export const vercelAiGatewayPlainTextFixture: WireFixture = {
  id: 'vercel-ai-gateway.stream.plain-text.synthetic',
  caseId: 'vercel-ai-gateway.stream.plain-text',
  evidence: 'unverified',
  recordedAt: '2026-09-29',
  account: 'synthetic',
  endpoint: 'https://ai-gateway.vercel.sh/v1/chat/completions',
  model: 'openai/gpt-4.1-nano',
  note: 'Synthetic placeholder shaped like OpenAI-compatible Gateway chat.completion.chunk SSE. Not recorded from a live service; replace with a verified recording from scripts/record-gateway-fixtures.ts --live.',
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
          'data: {"id":"gen-synthetic-plain-text","object":"chat.completion.chunk","created":1790000000,"model":"openai/gpt-4.1-nano","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n',
          'data: {"id":"gen-synthetic-plain-text","object":"chat.completion.chunk","created":1790000000,"model":"openai/gpt-4.1-nano","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n\n',
          'data: {"id":"gen-synthetic-plain-text","object":"chat.completion.chunk","created":1790000000,"model":"openai/gpt-4.1-nano","choices":[{"index":0,"delta":{"content":" from the"},"finish_reason":null}]}\n\n',
          'data: {"id":"gen-synthetic-plain-text","',
          'object":"chat.completion.chunk","created":1790000000,"model":"openai/gpt-4.1-nano","choices":[{"index":0,"delta":{"content":" synthetic gateway."},"finish_reason":null}]}\n\n',
          'data: {"id":"gen-synthetic-plain-text","object":"chat.completion.chunk","created":1790000000,"model":"openai/gpt-4.1-nano","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
          'data: {"id":"gen-synthetic-plain-text","object":"chat.completion.chunk","created":1790000000,"model":"openai/gpt-4.1-nano","choices":[],"usage":{"prompt_tokens":14,"completion_tokens":6,"total_tokens":20}}\n\n',
          'data: [DONE]\n\n'
        ]
      }
    }
  ]
}
