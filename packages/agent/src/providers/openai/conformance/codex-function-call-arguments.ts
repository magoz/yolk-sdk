import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * Streamed `function_call` item from the ChatGPT Codex Responses endpoint: `response.output_item.added` with the call id and name, `response.function_call_arguments.delta` fragments, `response.function_call_arguments.done`, `response.output_item.done`, and `response.completed` repeating the call in `output`.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording
 * replaces it. Regenerate with `pnpm conformance:codex --live --account <label>`.
 */
export const openAiCodexFunctionCallArgumentsFixture: WireFixture = {
  id: 'openai.codex.stream.function-call-arguments.synthetic',
  caseId: 'openai.codex.stream.function-call-arguments',
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
              content: 'What is the weather in Springfield? Use the tool.'
            }
          ],
          store: false,
          stream: true,
          reasoning: {
            effort: 'low',
            summary: 'auto'
          },
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
          'content-type': 'text/event-stream; charset=utf-8'
        },
        chunks: [
          'event: response.created\ndata: {"type":"response.created","sequence_number":0,"response":{"id":"resp_synthetic_function_call","object":"response","created_at":1790000000,"status":"in_progress","background":false,"error":null,"incomplete_details":null,"instructions":"Reply in one short sentence.","max_output_tokens":null,"model":"gpt-5.4","output":[],"parallel_tool_calls":true,"previous_response_id":null,"reasoning":{"effort":"low","summary":"auto"},"store":false,"temperature":1.0,"text":{"format":{"type":"text"}},"tool_choice":"auto","tools":[{"type":"function","name":"lookup_weather","description":"Look up the current weather for a city.","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"],"additionalProperties":false}}],"top_p":1.0,"truncation":"disabled","usage":null,"metadata":{}}}\n\n',
          'event: response.in_progress\ndata: {"type":"response.in_progress","sequence_number":1,"response":{"id":"resp_synthetic_function_call","object":"response","created_at":1790000000,"status":"in_progress","background":false,"error":null,"incomplete_details":null,"instructions":"Reply in one short sentence.","max_output_tokens":null,"model":"gpt-5.4","output":[],"parallel_tool_calls":true,"previous_response_id":null,"reasoning":{"effort":"low","summary":"auto"},"store":false,"temperature":1.0,"text":{"format":{"type":"text"}},"tool_choice":"auto","tools":[{"type":"function","name":"lookup_weather","description":"Look up the current weather for a city.","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"],"additionalProperties":false}}],"top_p":1.0,"truncation":"disabled","usage":null,"metadata":{}}}\n\n',
          'event: response.output_item.added\ndata: {"type":"response.output_item.added","sequence_number":2,"output_index":0,"item":{"id":"rs_synthetic_function_call","type":"reasoning","summary":[]}}\n\n',
          'event: response.reasoning_summary_part.added\ndata: {"type":"response.reasoning_summary_part.added","sequence_number":3,"item_id":"rs_synthetic_function_call","output_index":0,"summary_index":0,"part":{"type":"summary_text","text":""}}\n\n',
          'event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","sequence_number":4,"item_id":"rs_synthetic_function_call","output_index":0,"summary_index":0,"delta":"The user asks for the weather;"}\n\n',
          'event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","sequence_number":5,"item_id":"rs_synthetic_function_call","output_index":0,"summary_index":0,"delta":" call the tool."}\n\n',
          'event: response.reasoning_summary_text.done\ndata: {"type":"response.reasoning_summary_text.done","sequence_number":6,"item_id":"rs_synthetic_function_call","output_index":0,"summary_index":0,"text":"The user asks for the weather; call the tool."}\n\n',
          'event: response.reasoning_summary_part.done\ndata: {"type":"response.reasoning_summary_part.done","sequence_number":7,"item_id":"rs_synthetic_function_call","output_index":0,"summary_index":0,"part":{"type":"summary_text","text":"The user asks for the weather; call the tool."}}\n\n',
          'event: response.output_item.done\ndata: {"type":"response.output_item.done","sequence_number":8,"output_index":0,"item":{"id":"rs_synthetic_function_call","type":"reasoning","summary":[{"type":"summary_text","text":"The user asks for the weather; call the tool."}]}}\n\n',
          'event: response.output_item.added\ndata: {"type":"response.output_item.added","sequence_number":9,"output_index":1,"item":{"id":"fc_synthetic_function_call","type":"function_call","status":"in_progress","arguments":"","call_id":"call_synthetic_function_call","name":"lookup_weather"}}\n\n',
          'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","sequence_number":10,"item_id":"fc_synthetic_function_call","output_index":1,"delta":"{\\"ci"}\n\n',
          'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","sequence_number":11,"item_id":"fc_synthetic_function_call","output_index":1,"delta":"ty\\":\\"Spr"}\n\n',
          'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","sequence_number":12,"item_id":"fc_synthetic_function_call","output_index":1,"delta":"ingfield\\"}"}\n\n',
          'event: response.function_call_arguments.done\ndata: {"type":"response.function_call_arguments.done","sequence_number":13,"item_id":"fc_synthetic_function_call","output_index":1,"arguments":"{\\"city\\":\\"Springfield\\"}"}\n\n',
          'event: response.output_item.done\ndata: {"type":"response.output_item.done","sequence_number":14,"output_index":1,"item":{"id":"fc_synthetic_function_call","type":"function_call","status":"completed","arguments":"{\\"city\\":\\"Springfield\\"}","call_id":"call_synthetic_function_call","name":"lookup_weather"}}\n\n',
          'event: response.completed\ndata: {"type":"response.completed","sequence_number":15,"response":{"id":"resp_synthetic_function_call","object":"response","created_at":1790000000,"status":"completed","background":false,"error":null,"incomplete_details":null,"instructions":"Reply in one short sentence.","max_output_tokens":null,"model":"gpt-5.4","output":[{"id":"rs_synthetic_function_call","type":"reasoning","summary":[{"type":"summary_text","text":"The user asks for the weather; call the tool."}]},{"id":"fc_synthetic_function_call","type":"function_call","status":"completed","arguments":"{\\"city\\":\\"Springfield\\"}","call_id":"call_synthetic_function_call","name":"lookup_weather"}],"parallel_tool_calls":true,"previous_response_id":null,"reasoning":{"effort":"low","summary":"auto"},"store":false,"temperature":1.0,"text":{"format":{"type":"text"}},"tool_choice":"auto","tools":[{"type":"function","name":"lookup_weather","description":"Look up the current weather for a city.","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"],"additionalProperties":false}}],"top_p":1.0,"truncation":"disabled","usage":{"input_tokens":80,"input_tokens_details":{"cached_tokens":0},"output_tokens":40,"output_tokens_details":{"reasoning_tokens":22},"total_tokens":120},"metadata":{}}}\n\n'
        ]
      }
    }
  ]
}
