import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * Streamed plain-text answer from the xAI Grok CLI proxy: `response.created`, `response.in_progress`, a `message` item (`response.output_text.delta` events, one split across two network chunks), and `response.completed` with the output and usage.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording
 * replaces it. Regenerate with `pnpm conformance:grok --live --owner-approved --account <label>`.
 */
export const xAiGrokPlainTextFixture: WireFixture = {
  id: 'xai.grok.stream.plain-text.synthetic',
  caseId: 'xai.grok.stream.plain-text',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://cli-chat-proxy.grok.com/v1/responses',
  model: 'grok-build',
  note: 'Synthetic placeholder shaped like OpenAI Responses SSE from the xAI Grok CLI proxy. Not recorded from a live service; replace with a verified recording from pnpm conformance:grok --live --owner-approved --account <label>.',
  exchanges: [
    {
      request: {
        method: 'POST',
        url: 'https://cli-chat-proxy.grok.com/v1/responses',
        headers: {
          accept: 'text/event-stream',
          'content-type': 'application/json'
        },
        body: {
          model: 'grok-build',
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
          'content-type': 'text/event-stream; charset=utf-8'
        },
        chunks: [
          'event: response.created\ndata: {"type":"response.created","sequence_number":0,"response":{"id":"resp_synthetic_plain_text","object":"response","created_at":1790000000,"status":"in_progress","background":false,"error":null,"incomplete_details":null,"instructions":"Reply in one short sentence.","max_output_tokens":64,"model":"grok-build","output":[],"parallel_tool_calls":true,"previous_response_id":null,"reasoning":{"effort":null,"summary":null},"store":false,"temperature":1.0,"text":{"format":{"type":"text"}},"tool_choice":"auto","tools":[],"top_p":1.0,"truncation":"disabled","usage":null,"metadata":{}}}\n\n',
          'event: response.in_progress\ndata: {"type":"response.in_progress","sequence_number":1,"response":{"id":"resp_synthetic_plain_text","object":"response","created_at":1790000000,"status":"in_progress","background":false,"error":null,"incomplete_details":null,"instructions":"Reply in one short sentence.","max_output_tokens":64,"model":"grok-build","output":[],"parallel_tool_calls":true,"previous_response_id":null,"reasoning":{"effort":null,"summary":null},"store":false,"temperature":1.0,"text":{"format":{"type":"text"}},"tool_choice":"auto","tools":[],"top_p":1.0,"truncation":"disabled","usage":null,"metadata":{}}}\n\n',
          'event: response.output_item.added\ndata: {"type":"response.output_item.added","sequence_number":2,"output_index":0,"item":{"id":"msg_synthetic_plain_text","type":"message","status":"in_progress","content":[],"role":"assistant"}}\n\n',
          'event: response.content_part.added\ndata: {"type":"response.content_part.added","sequence_number":3,"item_id":"msg_synthetic_plain_text","output_index":0,"content_index":0,"part":{"type":"output_text","annotations":[],"text":""}}\n\n',
          'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","sequence_number":4,"item_id":"msg_synthetic_plain_text","output_index":0,"content_index":0,"delta":"Hello"}\n\n',
          'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","sequence_number":5,"item_id":"msg_synthetic_plain_text","output_index":0,"content_index":0,',
          '"delta":" from the"}\n\n',
          'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","sequence_number":6,"item_id":"msg_synthetic_plain_text","output_index":0,"content_index":0,"delta":" synthetic model."}\n\n',
          'event: response.output_text.done\ndata: {"type":"response.output_text.done","sequence_number":7,"item_id":"msg_synthetic_plain_text","output_index":0,"content_index":0,"text":"Hello from the synthetic model."}\n\n',
          'event: response.content_part.done\ndata: {"type":"response.content_part.done","sequence_number":8,"item_id":"msg_synthetic_plain_text","output_index":0,"content_index":0,"part":{"type":"output_text","annotations":[],"text":"Hello from the synthetic model."}}\n\n',
          'event: response.output_item.done\ndata: {"type":"response.output_item.done","sequence_number":9,"output_index":0,"item":{"id":"msg_synthetic_plain_text","type":"message","status":"completed","content":[{"type":"output_text","annotations":[],"text":"Hello from the synthetic model."}],"role":"assistant"}}\n\n',
          'event: response.completed\ndata: {"type":"response.completed","sequence_number":10,"response":{"id":"resp_synthetic_plain_text","object":"response","created_at":1790000000,"status":"completed","background":false,"error":null,"incomplete_details":null,"instructions":"Reply in one short sentence.","max_output_tokens":64,"model":"grok-build","output":[{"id":"msg_synthetic_plain_text","type":"message","status":"completed","content":[{"type":"output_text","annotations":[],"text":"Hello from the synthetic model."}],"role":"assistant"}],"parallel_tool_calls":true,"previous_response_id":null,"reasoning":{"effort":null,"summary":null},"store":false,"temperature":1.0,"text":{"format":{"type":"text"}},"tool_choice":"auto","tools":[],"top_p":1.0,"truncation":"disabled","usage":{"input_tokens":24,"input_tokens_details":{"cached_tokens":0},"output_tokens":6,"output_tokens_details":{"reasoning_tokens":0},"total_tokens":30},"metadata":{}}}\n\n'
        ]
      }
    }
  ]
}
