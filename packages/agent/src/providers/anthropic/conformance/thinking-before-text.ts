import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * Streamed Anthropic answer with extended thinking enabled (`thinking: { type: 'enabled',
 * budget_tokens }`): a `thinking` block (`thinking_delta` events, then a `signature_delta`) before
 * the text block, `stop_reason: end_turn`, and `message_stop`.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording
 * replaces it. Regenerate with `pnpm conformance:anthropic --live --account <label>`.
 */
export const anthropicMessagesThinkingBeforeTextFixture: WireFixture = {
  id: 'anthropic.messages.stream.thinking-before-text.synthetic',
  caseId: 'anthropic.messages.stream.thinking-before-text',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://api.anthropic.com/v1/messages',
  model: 'claude-haiku-4-5',
  note: 'Synthetic placeholder shaped like Anthropic Messages SSE with a thinking block. Not recorded from a live service; replace with a verified recording from pnpm conformance:anthropic --live --account <label>.',
  exchanges: [
    {
      request: {
        method: 'POST',
        url: 'https://api.anthropic.com/v1/messages',
        headers: {
          accept: 'text/event-stream',
          'content-type': 'application/json'
        },
        body: {
          thinking: {
            type: 'enabled',
            budget_tokens: 1024
          },
          model: 'claude-haiku-4-5',
          system: [
            {
              type: 'text',
              text: 'Reply in one short sentence.'
            }
          ],
          messages: [
            {
              role: 'user',
              content: 'Say hello.'
            }
          ],
          max_tokens: 1088,
          stream: true
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'text/event-stream; charset=utf-8'
        },
        chunks: [
          'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_synthetic_thinking","type":"message","role":"assistant","model":"claude-haiku-4-5","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":43,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":1,"service_tier":"standard"}}}\n\n',
          'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}\n\n',
          'event: ping\ndata: {"type":"ping"}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"The user wants a short greeting."}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" One sentence is enough."}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"synthetic-thinking-signature"}}\n\n',
          'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
          'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hello from"}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":" the synthetic model."}}\n\n',
          'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"input_tokens":43,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":31}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n'
        ]
      }
    }
  ]
}
