import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * Streamed answer from an OpenAI reasoning model asked with `reasoning_effort` and
 * `max_completion_tokens`: text deltas only (Chat Completions returns no reasoning text), a `stop`
 * finish chunk, and a usage-only chunk whose `completion_tokens_details.reasoning_tokens` counts
 * the hidden reasoning (included in `completion_tokens`), then `data: [DONE]`.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording
 * replaces it. Regenerate with `pnpm conformance:openai --live --owner-approved --account <label>`.
 */
export const openAiChatReasoningEffortFixture: WireFixture = {
  id: 'openai.chat.stream.reasoning-effort.synthetic',
  caseId: 'openai.chat.stream.reasoning-effort',
  evidence: 'unverified',
  recordedAt: '2026-11-20',
  account: 'synthetic',
  endpoint: 'https://api.openai.com/v1/chat/completions',
  model: 'gpt-6-luna',
  note: 'Synthetic placeholder shaped like OpenAI chat.completion.chunk SSE from a reasoning model, requested with reasoning_effort medium (the probe default). Not recorded from a live service. Sources (checked 2026-11-20): the reasoning guide (https://developers.openai.com/api/docs/guides/reasoning: reasoning_effort on Chat Completions, raw reasoning tokens not exposed, usage reasoning_tokens) and the Chat Completions request docs in the official SDK (https://github.com/openai/openai-python/blob/main/src/openai/types/chat/completion_create_params.py: max_completion_tokens includes reasoning tokens, reasoning_effort values). Replace with a verified recording from pnpm conformance:openai --live --owner-approved --account <label>.',
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
          reasoning_effort: 'medium',
          model: 'gpt-6-luna',
          messages: [
            {
              role: 'system',
              content: 'Reply in one short sentence.'
            },
            {
              role: 'user',
              content: 'What is 17 times 23? Answer with the number only.'
            }
          ],
          max_completion_tokens: 1024,
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
          'data: {"id":"chatcmpl-synthetic-reasoning-effort","object":"chat.completion.chunk","created":1790000000,"model":"gpt-6-luna","service_tier":"default","system_fingerprint":"fp_synthetic","choices":[{"index":0,"delta":{"role":"assistant","content":"","refusal":null},"logprobs":null,"finish_reason":null}],"usage":null}\n\n',
          'data: {"id":"chatcmpl-synthetic-reasoning-effort","object":"chat.completion.chunk","created":1790000000,"model":"gpt-6-luna","service_tier":"default","system_fingerprint":"fp_synthetic","choices":[{"index":0,"delta":{"content":"391"},"logprobs":null,"finish_reason":null}],"usage":null}\n\n',
          'data: {"id":"chatcmpl-synthetic-reasoning-effort","object":"chat.completion.chunk","created":1790000000,"model":"gpt-6-luna","service_tier":"default","system_fingerprint":"fp_synthetic","choices":[{"index":0,"delta":{},"logprobs":null,"finish_reason":"stop"}],"usage":null}\n\n',
          'data: {"id":"chatcmpl-synthetic-reasoning-effort","object":"chat.completion.chunk","created":1790000000,"model":"gpt-6-luna","service_tier":"default","system_fingerprint":"fp_synthetic","choices":[],"usage":{"prompt_tokens":31,"completion_tokens":66,"total_tokens":97,"prompt_tokens_details":{"cached_tokens":0,"audio_tokens":0},"completion_tokens_details":{"reasoning_tokens":64,"audio_tokens":0,"accepted_prediction_tokens":0,"rejected_prediction_tokens":0}}}\n\n',
          'data: [DONE]\n\n'
        ]
      }
    }
  ]
}
