import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * Streamed plain-text answer from OpenCode Go Responses: `response.created`, `response.in_progress`, a `message` item (`response.output_text.delta` events, one split across two network chunks), and `response.completed` with the output and usage.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it. Regenerate
 * with `pnpm conformance:opencode --live --owner-approved --account <label>` and the model flags.
 */
export const openCodeGoResponsesPlainTextFixture: WireFixture = {
  id: 'opencode.go.responses.stream.plain-text.synthetic',
  caseId: 'opencode.go.responses.stream.plain-text',
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
              content: 'Say hello.'
            }
          ],
          store: false,
          stream: true,
          max_output_tokens: 64
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
          'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","sequence_number":4,"item_id":"msg_synthetic_1_0","output_index":0,"content_index":0,"delta":"Hello"}\n\n',
          'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","sequence_number":5,"item_id":"msg_synthetic_1_0","output_index":0,"content_index":0,',
          '"delta":" from the"}\n\n',
          'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","sequence_number":6,"item_id":"msg_synthetic_1_0","output_index":0,"content_index":0,"delta":" synthetic model."}\n\n',
          'event: response.output_text.done\ndata: {"type":"response.output_text.done","sequence_number":7,"item_id":"msg_synthetic_1_0","output_index":0,"content_index":0,"text":"Hello from the synthetic model."}\n\n',
          'event: response.content_part.done\ndata: {"type":"response.content_part.done","sequence_number":8,"item_id":"msg_synthetic_1_0","output_index":0,"content_index":0,"part":{"type":"output_text","text":"Hello from the synthetic model.","annotations":[]}}\n\n',
          'event: response.output_item.done\ndata: {"type":"response.output_item.done","sequence_number":9,"output_index":0,"item":{"id":"msg_synthetic_1_0","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"Hello from the synthetic model.","annotations":[]}]}}\n\n',
          'event: response.completed\ndata: {"type":"response.completed","sequence_number":10,"response":{"id":"resp_synthetic_1","object":"response","created_at":1790000000,"status":"completed","error":null,"incomplete_details":null,"model":"synthetic-go-responses","output":[{"id":"msg_synthetic_1_0","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"Hello from the synthetic model.","annotations":[]}]}],"usage":{"input_tokens":45,"input_tokens_details":{"cached_tokens":0},"output_tokens":12,"output_tokens_details":{"reasoning_tokens":0},"total_tokens":57}}}\n\n'
        ]
      }
    }
  ]
}
