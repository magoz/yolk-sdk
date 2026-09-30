import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * Non-streamed OpenAI plain-text answer (`stream: false`): one `chat.completion` JSON body with
 * the assistant message, a `stop` finish reason, and usage.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording
 * replaces it. Regenerate with `pnpm conformance:openai --live --account <label>`.
 */
export const openAiChatJsonPlainTextFixture: WireFixture = {
  id: 'openai.chat.json.plain-text.synthetic',
  caseId: 'openai.chat.json.plain-text',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://api.openai.com/v1/chat/completions',
  model: 'gpt-4.1-nano',
  note: 'Synthetic placeholder shaped like an OpenAI chat.completion JSON body. Not recorded from a live service; replace with a verified recording from pnpm conformance:openai --live --account <label>.',
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
          stream: false
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"id":"chatcmpl-synthetic-json","object":"chat.completion","created":1790000000,"model":"gpt-4.1-nano","choices":[{"index":0,"message":{"role":"assistant","content":"Hello from the synthetic model.","refusal":null,"annotations":[]},"logprobs":null,"finish_reason":"stop"}],"usage":{"prompt_tokens":20,"completion_tokens":7,"total_tokens":27,"prompt_tokens_details":{"cached_tokens":0,"audio_tokens":0},"completion_tokens_details":{"reasoning_tokens":0,"audio_tokens":0,"accepted_prediction_tokens":0,"rejected_prediction_tokens":0}},"service_tier":"default","system_fingerprint":"fp_synthetic"}'
      }
    }
  ]
}
