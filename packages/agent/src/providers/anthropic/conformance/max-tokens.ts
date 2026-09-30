import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * Streamed Anthropic answer cut by a small `max_tokens`: partial text, then `message_delta` with
 * `stop_reason: max_tokens` and `message_stop`.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording
 * replaces it. Regenerate with
 * `pnpm conformance:anthropic --live --owner-approved --account <label>`.
 */
export const anthropicMessagesMaxTokensFixture: WireFixture = {
  id: 'anthropic.messages.stream.max-tokens.synthetic',
  caseId: 'anthropic.messages.stream.max-tokens',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://api.anthropic.com/v1/messages',
  model: 'claude-haiku-4-5',
  note: 'Synthetic placeholder shaped like Anthropic Messages SSE stopped by max_tokens. Not recorded from a live service; replace with a verified recording from pnpm conformance:anthropic --live --owner-approved --account <label>.',
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
              content: 'Count from 1 to 100, separated by commas.'
            }
          ],
          max_tokens: 8,
          stream: true
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'text/event-stream; charset=utf-8'
        },
        chunks: [
          'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_synthetic_max_tokens","type":"message","role":"assistant","model":"claude-haiku-4-5","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":24,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":1,"service_tier":"standard"}}}\n\n',
          'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
          'event: ping\ndata: {"type":"ping"}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"1, 2, 3,"}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" 4"}}\n\n',
          'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens","stop_sequence":null},"usage":{"input_tokens":24,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":8}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n'
        ]
      }
    }
  ]
}
