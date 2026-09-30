import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * Streamed Anthropic `tool_use` block, forced with `tool_choice: { type: 'tool', name }`, whose
 * JSON input arrives as `input_json_delta` fragments (the first one empty) that assemble into one
 * call, followed by `message_delta` with `stop_reason: tool_use` and `message_stop`.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording
 * replaces it. Regenerate with `pnpm conformance:anthropic --live --account <label>`.
 */
export const anthropicMessagesToolUseInputDeltasFixture: WireFixture = {
  id: 'anthropic.messages.stream.tool-use-input-deltas.synthetic',
  caseId: 'anthropic.messages.stream.tool-use-input-deltas',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://api.anthropic.com/v1/messages',
  model: 'claude-haiku-4-5',
  note: 'Synthetic placeholder shaped like Anthropic Messages SSE. Not recorded from a live service; replace with a verified recording from pnpm conformance:anthropic --live --account <label>.',
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
          tool_choice: {
            type: 'tool',
            name: 'lookup_weather'
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
              content: 'What is the weather in Springfield? Use the tool.'
            }
          ],
          max_tokens: 64,
          stream: true,
          tools: [
            {
              name: 'lookup_weather',
              description: 'Look up the current weather for a city.',
              input_schema: {
                type: 'object',
                properties: {
                  city: {
                    type: 'string'
                  }
                },
                required: ['city'],
                additionalProperties: false
              }
            }
          ]
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'text/event-stream; charset=utf-8'
        },
        chunks: [
          'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_synthetic_tool_use","type":"message","role":"assistant","model":"claude-haiku-4-5","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":412,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":1,"service_tier":"standard"}}}\n\n',
          'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_synthetic_weather","name":"lookup_weather","input":{}}}\n\n',
          'event: ping\ndata: {"type":"ping"}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":""}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"ci"}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"ty\\": \\"Spri"}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"ngfield\\"}"}}\n\n',
          'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"input_tokens":412,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":38}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n'
        ]
      }
    }
  ]
}
