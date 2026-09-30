import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * Streamed plain-text answer from OpenAI Chat Completions: text deltas (one event split across
 * two network chunks), a `stop` finish chunk, a usage-only chunk (`stream_options.include_usage`;
 * earlier chunks carry `usage: null`), and `data: [DONE]`.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording
 * replaces it. Regenerate with `pnpm conformance:openai --live --owner-approved --account <label>`.
 */
export const openAiChatPlainTextFixture: WireFixture = {
  id: 'openai.chat.stream.plain-text.synthetic',
  caseId: 'openai.chat.stream.plain-text',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://api.openai.com/v1/chat/completions',
  model: 'gpt-4.1-nano',
  note: 'Synthetic placeholder shaped like OpenAI chat.completion.chunk SSE. Not recorded from a live service; replace with a verified recording from pnpm conformance:openai --live --owner-approved --account <label>.',
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
          model: 'gpt-4.1-nano',
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
          max_completion_tokens: 64,
          stream: true,
          stream_options: {
            include_usage: true
          }
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'text/event-stream; charset=utf-8'
        },
        chunks: [
          'data: {"id":"chatcmpl-synthetic-plain-text","object":"chat.completion.chunk","created":1790000000,"model":"gpt-4.1-nano","service_tier":"default","system_fingerprint":"fp_synthetic","choices":[{"index":0,"delta":{"role":"assistant","content":"","refusal":null},"logprobs":null,"finish_reason":null}],"usage":null}\n\n',
          'data: {"id":"chatcmpl-synthetic-plain-text","object":"chat.completion.chunk","created":1790000000,"model":"gpt-4.1-nano","service_tier":"default","system_fingerprint":"fp_synthetic","choices":[{"index":0,"delta":{"content":"Hello"},"logprobs":null,"finish_reason":null}],"usage":null}\n\n',
          'data: {"id":"chatcmpl-synthetic-plain-text","object":"chat.completion.chunk","created":1790000000,"model":"gpt-4.1-nano","service_tier":"default","system_fingerprint":"fp_synthetic","choices":[{"index":0,"delta":{"content":" from the"},"logprobs":null,"finish_reason":null}],"usage":null}\n\n',
          'data: {"id":"chatcmpl-synthetic-plain-text","object":"chat.completion.chunk","created":1790000000,"model":"gpt-4.1-nano","service_tier":"default",',
          '"system_fingerprint":"fp_synthetic","choices":[{"index":0,"delta":{"content":" synthetic model."},"logprobs":null,"finish_reason":null}],"usage":null}\n\n',
          'data: {"id":"chatcmpl-synthetic-plain-text","object":"chat.completion.chunk","created":1790000000,"model":"gpt-4.1-nano","service_tier":"default","system_fingerprint":"fp_synthetic","choices":[{"index":0,"delta":{},"logprobs":null,"finish_reason":"stop"}],"usage":null}\n\n',
          'data: {"id":"chatcmpl-synthetic-plain-text","object":"chat.completion.chunk","created":1790000000,"model":"gpt-4.1-nano","service_tier":"default","system_fingerprint":"fp_synthetic","choices":[],"usage":{"prompt_tokens":20,"completion_tokens":6,"total_tokens":26,"prompt_tokens_details":{"cached_tokens":0,"audio_tokens":0},"completion_tokens_details":{"reasoning_tokens":0,"audio_tokens":0,"accepted_prediction_tokens":0,"rejected_prediction_tokens":0}}}\n\n',
          'data: [DONE]\n\n'
        ]
      }
    }
  ]
}
