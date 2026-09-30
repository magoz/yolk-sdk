import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * Streamed OpenCode Go Responses answer to a request replaying one earlier tool turn: the request `input` carries the user prompt, the assistant text with `phase: "commentary"`, the `function_call`, and its `function_call_output`; the response streams a `message` item and ends with `response.completed`.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it. Regenerate
 * with `pnpm conformance:opencode --live --owner-approved --account <label>` and the model flags.
 */
export const openCodeGoResponsesCommentaryReplayFixture: WireFixture = {
  id: 'opencode.go.responses.stream.commentary-replay.synthetic',
  caseId: 'opencode.go.responses.stream.commentary-replay',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://opencode.ai/zen/go/v1/responses',
  model: 'synthetic-go-responses',
  note: 'Synthetic placeholder shaped like OpenAI Responses SSE from OpenCode Go. Not recorded from a live service; replace with a verified recording from pnpm conformance:opencode --live --owner-approved --account <label> (with the per-protocol model flags).',
  exchanges: [
    {
      request: {
        method: 'POST',
        url: 'https://opencode.ai/zen/go/v1/responses',
        headers: {
          accept: 'text/event-stream',
          'content-type': 'application/json'
        },
        body: {
          model: 'synthetic-go-responses',
          instructions: 'Reply in one short sentence.',
          input: [
            {
              role: 'user',
              content: 'What is the weather in Springfield?'
            },
            {
              role: 'assistant',
              content: 'I will look up the weather first.',
              phase: 'commentary'
            },
            {
              type: 'function_call',
              call_id: 'call_synthetic_weather',
              name: 'lookup_weather',
              arguments: '{"city":"Springfield"}'
            },
            {
              type: 'function_call_output',
              call_id: 'call_synthetic_weather',
              output: 'Sunny and mild.'
            }
          ],
          store: false,
          stream: true,
          max_output_tokens: 64,
          tools: [
            {
              type: 'function',
              name: 'lookup_weather',
              description: 'Look up the current weather for a city.',
              parameters: {
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
          ],
          parallel_tool_calls: true
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'text/event-stream'
        },
        chunks: [
          'event: response.created\ndata: {"type":"response.created","sequence_number":0,"response":{"id":"resp_synthetic_1","object":"response","created_at":1790000000,"status":"in_progress","error":null,"incomplete_details":null,"model":"synthetic-go-responses","output":[],"usage":null}}\n\n',
          'event: response.in_progress\ndata: {"type":"response.in_progress","sequence_number":1,"response":{"id":"resp_synthetic_1","object":"response","created_at":1790000000,"status":"in_progress","error":null,"incomplete_details":null,"model":"synthetic-go-responses","output":[],"usage":null}}\n\n',
          'event: response.output_item.added\ndata: {"type":"response.output_item.added","sequence_number":2,"output_index":0,"item":{"id":"msg_synthetic_1_0","type":"message","status":"in_progress","role":"assistant","content":[]}}\n\n',
          'event: response.content_part.added\ndata: {"type":"response.content_part.added","sequence_number":3,"item_id":"msg_synthetic_1_0","output_index":0,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]}}\n\n',
          'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","sequence_number":4,"item_id":"msg_synthetic_1_0","output_index":0,"content_index":0,"delta":"It is sunny"}\n\n',
          'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","sequence_number":5,"item_id":"msg_synthetic_1_0","output_index":0,"content_index":0,',
          '"delta":" and mild in Springfield."}\n\n',
          'event: response.output_text.done\ndata: {"type":"response.output_text.done","sequence_number":6,"item_id":"msg_synthetic_1_0","output_index":0,"content_index":0,"text":"It is sunny and mild in Springfield."}\n\n',
          'event: response.content_part.done\ndata: {"type":"response.content_part.done","sequence_number":7,"item_id":"msg_synthetic_1_0","output_index":0,"content_index":0,"part":{"type":"output_text","text":"It is sunny and mild in Springfield.","annotations":[]}}\n\n',
          'event: response.output_item.done\ndata: {"type":"response.output_item.done","sequence_number":8,"output_index":0,"item":{"id":"msg_synthetic_1_0","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"It is sunny and mild in Springfield.","annotations":[]}]}}\n\n',
          'event: response.completed\ndata: {"type":"response.completed","sequence_number":9,"response":{"id":"resp_synthetic_1","object":"response","created_at":1790000000,"status":"completed","error":null,"incomplete_details":null,"model":"synthetic-go-responses","output":[{"id":"msg_synthetic_1_0","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"It is sunny and mild in Springfield.","annotations":[]}]}],"usage":{"input_tokens":193,"input_tokens_details":{"cached_tokens":0},"output_tokens":9,"output_tokens_details":{"reasoning_tokens":0},"total_tokens":202}}}\n\n'
        ]
      }
    }
  ]
}
