import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * Streamed plain-text answer from OpenCode Go Chat Completions: an opening delta, text deltas (one event split across two network chunks), a `stop` finish chunk, a usage-only chunk (`stream_options.include_usage`), and `data: [DONE]`.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it. Regenerate
 * with `pnpm conformance:opencode --live --owner-approved --account <label>` and the model flags.
 */
export const openCodeGoChatPlainTextFixture: WireFixture = {
  id: 'opencode.go.chat.stream.plain-text.synthetic',
  caseId: 'opencode.go.chat.stream.plain-text',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://opencode.ai/zen/go/v1/chat/completions',
  model: 'synthetic-go-chat',
  note: 'Synthetic placeholder shaped like OpenAI-compatible chat.completion.chunk SSE from OpenCode Go. Not recorded from a live service; replace with a verified recording from pnpm conformance:opencode --live --owner-approved --account <label> (with the per-protocol model flags).',
  exchanges: [
    {
      request: {
        method: 'POST',
        url: 'https://opencode.ai/zen/go/v1/chat/completions',
        headers: {
          accept: 'text/event-stream',
          'content-type': 'application/json'
        },
        body: {
          model: 'synthetic-go-chat',
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
          'data: {"id":"chatcmpl-synthetic-go-1","object":"chat.completion.chunk","created":1790000000,"model":"synthetic-go-chat","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n',
          'data: {"id":"chatcmpl-synthetic-go-1","object":"chat.completion.chunk","created":1790000000,"model":"synthetic-go-chat","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n\n',
          'data: {"id":"chatcmpl-synthetic-go-1","object":"chat.completion.chunk","created":1790000000,"model":"synthetic-go-chat","choices":[{"index":0,',
          '"delta":{"content":" from the"},"finish_reason":null}]}\n\n',
          'data: {"id":"chatcmpl-synthetic-go-1","object":"chat.completion.chunk","created":1790000000,"model":"synthetic-go-chat","choices":[{"index":0,"delta":{"content":" synthetic model."},"finish_reason":null}]}\n\n',
          'data: {"id":"chatcmpl-synthetic-go-1","object":"chat.completion.chunk","created":1790000000,"model":"synthetic-go-chat","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
          'data: {"id":"chatcmpl-synthetic-go-1","object":"chat.completion.chunk","created":1790000000,"model":"synthetic-go-chat","choices":[],"usage":{"prompt_tokens":53,"completion_tokens":12,"total_tokens":65}}\n\n',
          'data: [DONE]\n\n'
        ]
      }
    }
  ]
}
