/**
 * OpenCode Go recordings the `/opencode` emulator answers from: one per Go conformance fixture.
 *
 * Copied as data from the committed (synthetic, unverified) conformance fixtures; never imported.
 * `test/fixture-recordings.test.ts` fails when a fixture changes and this copy does not. Internal;
 * not a package export.
 */
import type { FixtureRecording } from './fixture-route.ts'

export const openCodeGoRecordings: ReadonlyArray<FixtureRecording> = [
  {
    fixtureId: 'opencode.go.chat.stream.plain-text.synthetic',
    caseId: 'opencode.go.chat.stream.plain-text',
    request: {
      method: 'POST',
      path: '/zen/go/v1/chat/completions',
      query: '',
      headers: {
        accept: 'text/event-stream',
        'content-type': 'application/json'
      },
      body: {
        model: 'synthetic-go-chat',
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
      status: 200,
      headers: {
        'content-type': 'text/event-stream'
      },
      streamed: true,
      chunks: [
        'data: {"id":"chatcmpl-synthetic-go-1","object":"chat.completion.chunk","created":1790000000,"model":"synthetic-go-chat","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl-synthetic-go-1","object":"chat.completion.chunk","created":1790000000,"model":"synthetic-go-chat","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl-synthetic-go-1","object":"chat.completion.chunk","created":1790000000,"model":"synthetic-go-chat","choices":[{"index":0,',
        '"delta":{"content":" from the"},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl-synthetic-go-1","object":"chat.completion.chunk","created":1790000000,"model":"synthetic-go-chat","choices":[{"index":0,"delta":{"content":" synthetic model."},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl-synthetic-go-1","object":"chat.completion.chunk","created":1790000000,"model":"synthetic-go-chat","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: {"id":"chatcmpl-synthetic-go-1","object":"chat.completion.chunk","created":1790000000,"model":"synthetic-go-chat","choices":[],"usage":{"prompt_tokens":53,"completion_tokens":12,"total_tokens":65}}\n\n',
        'data: [DONE]\n\n'
      ]
    }
  },
  {
    fixtureId: 'opencode.go.messages.stream.plain-text.synthetic',
    caseId: 'opencode.go.messages.stream.plain-text',
    request: {
      method: 'POST',
      path: '/zen/go/v1/messages',
      query: '',
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
      streamed: true,
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
  },
  {
    fixtureId: 'opencode.go.responses.stream.plain-text.synthetic',
    caseId: 'opencode.go.responses.stream.plain-text',
    request: {
      method: 'POST',
      path: '/zen/go/v1/responses',
      query: '',
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
      streamed: true,
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
  },
  {
    fixtureId: 'opencode.go.responses.stream.commentary-replay.synthetic',
    caseId: 'opencode.go.responses.stream.commentary-replay',
    request: {
      method: 'POST',
      path: '/zen/go/v1/responses',
      query: '',
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
      streamed: true,
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
  },
  {
    fixtureId: 'opencode.go.usage.snapshot.synthetic',
    caseId: 'opencode.go.usage.snapshot',
    request: {
      method: 'GET',
      path: '/zen/go/v1/usage',
      query: '',
      headers: {
        accept: 'application/json'
      }
    },
    response: {
      status: 200,
      headers: {
        'content-type': 'application/json'
      },
      streamed: false,
      chunks: [
        '{"usage":{"rolling":{"percent":12.5,"resetsAt":"2026-10-01T03:00:00.000Z"},"weekly":{"percent":40,"resetsAt":"2026-10-05T00:00:00.000Z"},"monthly":{"percent":55,"resetsAt":"2026-10-31T00:00:00.000Z"}}}'
      ]
    }
  }
]
