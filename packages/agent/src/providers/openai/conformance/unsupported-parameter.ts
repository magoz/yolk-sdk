import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * OpenAI 400 JSON error envelope for a reasoning model sent `max_tokens`
 * (`{ error: { message, type: 'invalid_request_error', param: 'max_tokens', code:
 * 'unsupported_parameter' } }`), answered before any stream starts.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording
 * replaces it. Regenerate with `pnpm conformance:openai --live --owner-approved --account <label>`.
 */
export const openAiChatUnsupportedParameterFixture: WireFixture = {
  id: 'openai.chat.stream.unsupported-parameter.synthetic',
  caseId: 'openai.chat.stream.unsupported-parameter',
  evidence: 'unverified',
  recordedAt: '2026-11-20',
  account: 'synthetic',
  endpoint: 'https://api.openai.com/v1/chat/completions',
  model: 'gpt-6-luna',
  note: "Synthetic placeholder for the OpenAI 400 a reasoning model answers to max_tokens. Not recorded from a live service. Sources (checked 2026-11-20): the Chat Completions request docs in the official SDK (https://github.com/openai/openai-python/blob/main/src/openai/types/chat/completion_create_params.py: max_tokens is deprecated in favour of max_completion_tokens and not compatible with reasoning models); the envelope's message, type, param, and code as quoted from the live API in public issue reports (https://github.com/nyxtron/paperless-aissist/issues/59, gpt-6-luna). Replace with a verified recording from pnpm conformance:openai --live --owner-approved --account <label>.",
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
          model: 'gpt-6-luna',
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
        status: 400,
        headers: {
          'content-type': 'application/json'
        },
        body: '{"error":{"message":"Unsupported parameter: \'max_tokens\' is not supported with this model. Use \'max_completion_tokens\' instead.","type":"invalid_request_error","param":"max_tokens","code":"unsupported_parameter"}}'
      }
    }
  ]
}
