import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * Streamed plain-text answer from OpenCode Go Messages: `message_start` (input usage), one text block (`content_block_start`, a `ping`, `text_delta` events with one event split across two network chunks, `content_block_stop`), `message_delta` with `stop_reason: end_turn` and usage, and `message_stop`.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it. Regenerate
 * with `pnpm conformance:opencode --live --owner-approved --account <label>` and the model flags.
 */
export const openCodeGoMessagesPlainTextFixture: WireFixture = {
  id: 'opencode.go.messages.stream.plain-text.synthetic',
  caseId: 'opencode.go.messages.stream.plain-text',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://opencode.ai/zen/go/v1/messages',
  model: 'synthetic-go-messages',
  note: 'Synthetic placeholder shaped like Anthropic Messages SSE from OpenCode Go. Not recorded from a live service; replace with a verified recording from pnpm conformance:opencode --live --owner-approved --account <label> (with the per-protocol model flags).',
  exchanges: [
    {
      request: {
        method: 'POST',
        url: 'https://opencode.ai/zen/go/v1/messages',
        headers: {
          accept: 'text/event-stream',
          'content-type': 'application/json'
        },
        body: {
          model: 'synthetic-go-messages',
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
          max_tokens: 64,
          stream: true
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'text/event-stream'
        },
        chunks: [
          'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_synthetic_1","type":"message","role":"assistant","model":"synthetic-go-messages","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":45,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":1}}}\n\n',
          'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
          'event: ping\ndata: {"type":"ping"}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta",',
          '"text":" from the"}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" synthetic Anthropic emulator."}}\n\n',
          'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"input_tokens":45,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":11}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n'
        ]
      }
    }
  ]
}
