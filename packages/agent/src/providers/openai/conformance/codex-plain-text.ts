import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * Streamed plain-text answer from the ChatGPT Codex Responses endpoint: `response.created`, `response.in_progress`, a reasoning summary item, a `message` item (`response.output_text.delta` events, one split across two network chunks), and `response.completed` with the output and usage.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording
 * replaces it. Regenerate with `pnpm conformance:codex --live --account <label>`.
 */
export const openAiCodexPlainTextFixture: WireFixture = {
  id: 'openai.codex.stream.plain-text.synthetic',
  caseId: 'openai.codex.stream.plain-text',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://chatgpt.com/backend-api/codex/responses',
  model: 'gpt-5.4',
  note: 'Synthetic placeholder shaped like OpenAI Responses SSE from the ChatGPT Codex Responses endpoint. Not recorded from a live service; replace with a verified recording from pnpm conformance:codex --live --account <label>.',
  exchanges: [
    {
      request: {
        method: 'POST',
        url: 'https://chatgpt.com/backend-api/codex/responses',
        headers: {
          accept: 'text/event-stream',
          'content-type': 'application/json'
        },
        body: {
          model: 'gpt-5.4',
          instructions: 'Reply in one short sentence.',
          input: [
            {
              role: 'user',
              content: 'Say hello.'
            }
          ],
          store: false,
          stream: true,
          reasoning: {
            effort: 'low',
            summary: 'auto'
          }
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'text/event-stream; charset=utf-8'
        },
        chunks: [
          'event: response.created\ndata: {"type":"response.created","sequence_number":0,"response":{"id":"resp_synthetic_plain_text","object":"response","created_at":1790000000,"status":"in_progress","background":false,"error":null,"incomplete_details":null,"instructions":"Reply in one short sentence.","max_output_tokens":null,"model":"gpt-5.4","output":[],"parallel_tool_calls":true,"previous_response_id":null,"reasoning":{"effort":"low","summary":"auto"},"store":false,"temperature":1.0,"text":{"format":{"type":"text"}},"tool_choice":"auto","tools":[],"top_p":1.0,"truncation":"disabled","usage":null,"metadata":{}}}\n\n',
          'event: response.in_progress\ndata: {"type":"response.in_progress","sequence_number":1,"response":{"id":"resp_synthetic_plain_text","object":"response","created_at":1790000000,"status":"in_progress","background":false,"error":null,"incomplete_details":null,"instructions":"Reply in one short sentence.","max_output_tokens":null,"model":"gpt-5.4","output":[],"parallel_tool_calls":true,"previous_response_id":null,"reasoning":{"effort":"low","summary":"auto"},"store":false,"temperature":1.0,"text":{"format":{"type":"text"}},"tool_choice":"auto","tools":[],"top_p":1.0,"truncation":"disabled","usage":null,"metadata":{}}}\n\n',
          'event: response.output_item.added\ndata: {"type":"response.output_item.added","sequence_number":2,"output_index":0,"item":{"id":"rs_synthetic_plain_text","type":"reasoning","summary":[]}}\n\n',
          'event: response.reasoning_summary_part.added\ndata: {"type":"response.reasoning_summary_part.added","sequence_number":3,"item_id":"rs_synthetic_plain_text","output_index":0,"summary_index":0,"part":{"type":"summary_text","text":""}}\n\n',
          'event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","sequence_number":4,"item_id":"rs_synthetic_plain_text","output_index":0,"summary_index":0,"delta":"The user wants"}\n\n',
          'event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","sequence_number":5,"item_id":"rs_synthetic_plain_text","output_index":0,"summary_index":0,"delta":" a short greeting."}\n\n',
          'event: response.reasoning_summary_text.done\ndata: {"type":"response.reasoning_summary_text.done","sequence_number":6,"item_id":"rs_synthetic_plain_text","output_index":0,"summary_index":0,"text":"The user wants a short greeting."}\n\n',
          'event: response.reasoning_summary_part.done\ndata: {"type":"response.reasoning_summary_part.done","sequence_number":7,"item_id":"rs_synthetic_plain_text","output_index":0,"summary_index":0,"part":{"type":"summary_text","text":"The user wants a short greeting."}}\n\n',
          'event: response.output_item.done\ndata: {"type":"response.output_item.done","sequence_number":8,"output_index":0,"item":{"id":"rs_synthetic_plain_text","type":"reasoning","summary":[{"type":"summary_text","text":"The user wants a short greeting."}]}}\n\n',
          'event: response.output_item.added\ndata: {"type":"response.output_item.added","sequence_number":9,"output_index":1,"item":{"id":"msg_synthetic_plain_text","type":"message","status":"in_progress","content":[],"role":"assistant"}}\n\n',
          'event: response.content_part.added\ndata: {"type":"response.content_part.added","sequence_number":10,"item_id":"msg_synthetic_plain_text","output_index":1,"content_index":0,"part":{"type":"output_text","annotations":[],"text":""}}\n\n',
          'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","sequence_number":11,"item_id":"msg_synthetic_plain_text","output_index":1,"content_index":0,"delta":"Hello"}\n\n',
          'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","sequence_number":12,"item_id":"msg_synthetic_plain_text","output_index":1,"content_index":0,',
          '"delta":" from the"}\n\n',
          'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","sequence_number":13,"item_id":"msg_synthetic_plain_text","output_index":1,"content_index":0,"delta":" synthetic model."}\n\n',
          'event: response.output_text.done\ndata: {"type":"response.output_text.done","sequence_number":14,"item_id":"msg_synthetic_plain_text","output_index":1,"content_index":0,"text":"Hello from the synthetic model."}\n\n',
          'event: response.content_part.done\ndata: {"type":"response.content_part.done","sequence_number":15,"item_id":"msg_synthetic_plain_text","output_index":1,"content_index":0,"part":{"type":"output_text","annotations":[],"text":"Hello from the synthetic model."}}\n\n',
          'event: response.output_item.done\ndata: {"type":"response.output_item.done","sequence_number":16,"output_index":1,"item":{"id":"msg_synthetic_plain_text","type":"message","status":"completed","content":[{"type":"output_text","annotations":[],"text":"Hello from the synthetic model."}],"role":"assistant"}}\n\n',
          'event: response.completed\ndata: {"type":"response.completed","sequence_number":17,"response":{"id":"resp_synthetic_plain_text","object":"response","created_at":1790000000,"status":"completed","background":false,"error":null,"incomplete_details":null,"instructions":"Reply in one short sentence.","max_output_tokens":null,"model":"gpt-5.4","output":[{"id":"rs_synthetic_plain_text","type":"reasoning","summary":[{"type":"summary_text","text":"The user wants a short greeting."}]},{"id":"msg_synthetic_plain_text","type":"message","status":"completed","content":[{"type":"output_text","annotations":[],"text":"Hello from the synthetic model."}],"role":"assistant"}],"parallel_tool_calls":true,"previous_response_id":null,"reasoning":{"effort":"low","summary":"auto"},"store":false,"temperature":1.0,"text":{"format":{"type":"text"}},"tool_choice":"auto","tools":[],"top_p":1.0,"truncation":"disabled","usage":{"input_tokens":24,"input_tokens_details":{"cached_tokens":0},"output_tokens":30,"output_tokens_details":{"reasoning_tokens":24},"total_tokens":54},"metadata":{}}}\n\n'
        ]
      }
    }
  ]
}
