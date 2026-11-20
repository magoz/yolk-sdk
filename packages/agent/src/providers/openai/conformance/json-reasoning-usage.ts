import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * Non-streamed answer from an OpenAI reasoning model (`stream: false`, `reasoning_effort`): one
 * `chat.completion` JSON body whose message carries the answer and no reasoning text, and whose
 * `usage.completion_tokens_details.reasoning_tokens` counts the hidden reasoning.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording
 * replaces it. Regenerate with `pnpm conformance:openai --live --owner-approved --account <label>`.
 */
export const openAiChatJsonReasoningUsageFixture: WireFixture = {
  id: 'openai.chat.json.reasoning-usage.synthetic',
  caseId: 'openai.chat.json.reasoning-usage',
  evidence: 'unverified',
  recordedAt: '2026-11-20',
  account: 'synthetic',
  endpoint: 'https://api.openai.com/v1/chat/completions',
  model: 'gpt-6-luna',
  note: 'Synthetic placeholder shaped like an OpenAI chat.completion JSON body from a reasoning model, requested with reasoning_effort medium (the probe default). Not recorded from a live service. Sources (checked 2026-11-20): the reasoning guide (https://developers.openai.com/api/docs/guides/reasoning: raw reasoning tokens not exposed, usage reasoning_tokens) and the Chat Completions request docs in the official SDK (https://github.com/openai/openai-python/blob/main/src/openai/types/chat/completion_create_params.py: max_completion_tokens includes reasoning tokens). Replace with a verified recording from pnpm conformance:openai --live --owner-approved --account <label>.',
  exchanges: [
    {
      request: {
        method: 'POST',
        url: 'https://api.openai.com/v1/chat/completions',
        headers: {
          accept: 'application/json',
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
          stream: false
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"id":"chatcmpl-synthetic-json-reasoning","object":"chat.completion","created":1790000000,"model":"gpt-6-luna","choices":[{"index":0,"message":{"role":"assistant","content":"391","refusal":null,"annotations":[]},"logprobs":null,"finish_reason":"stop"}],"usage":{"prompt_tokens":31,"completion_tokens":66,"total_tokens":97,"prompt_tokens_details":{"cached_tokens":0,"audio_tokens":0},"completion_tokens_details":{"reasoning_tokens":64,"audio_tokens":0,"accepted_prediction_tokens":0,"rejected_prediction_tokens":0}},"service_tier":"default","system_fingerprint":"fp_synthetic"}'
      }
    }
  ]
}
