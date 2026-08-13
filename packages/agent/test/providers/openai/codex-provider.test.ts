import { Effect, Stream } from 'effect'
import { HttpClientError, HttpClientRequest, HttpClientResponse } from 'effect/unstable/http'
import { describe, expect, it } from '@effect/vitest'
import {
  AudioPart,
  AssistantAgentMessage,
  DocumentPart,
  HostToolCallPart,
  ImagePart,
  TextPart,
  ToolCall,
  ToolDef,
  ToolResultMessage,
  UserMessage,
  inlineBase64Source,
  urlAttachmentSource
} from '@yolk-sdk/agent/protocol'
import {
  streamOpenAiCodexResponse,
  toOpenAiCodexRequestBody as lowerOpenAiCodexRequestBody
} from '../../../src/providers/openai/codex-provider.ts'

const openAiCodexTestMaxOutputTokens = 123

const toOpenAiCodexRequestBody = (
  request: Parameters<typeof lowerOpenAiCodexRequestBody>[0],
  config?: Omit<Parameters<typeof lowerOpenAiCodexRequestBody>[1], 'maxOutputTokens'>
) =>
  lowerOpenAiCodexRequestBody(request, {
    maxOutputTokens: openAiCodexTestMaxOutputTokens,
    ...config
  })

const responseFromText = (text: string) => {
  const request = HttpClientRequest.get('https://example.com')

  return HttpClientResponse.fromWeb(request, new Response(text, { status: 200 }))
}

const responseFromSseEvents = (events: ReadonlyArray<unknown>) =>
  responseFromText(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''))

type CodexFunctionCallFixture = {
  readonly type: 'function_call'
  readonly call_id: string
  readonly name: string
  readonly arguments: string
}

const codexFunctionCall = (
  callId: string,
  name: string,
  argumentsJson = '{}'
): CodexFunctionCallFixture => ({
  type: 'function_call',
  call_id: callId,
  name,
  arguments: argumentsJson
})

const completedCodexResponse = (...output: ReadonlyArray<unknown>) => ({
  type: 'response.completed',
  response: { output }
})

const streamErrorResponse = () => {
  const request = HttpClientRequest.get('https://example.com')
  const response = HttpClientResponse.fromWeb(request, new Response('', { status: 200 }))

  Object.defineProperty(response, 'stream', {
    value: Stream.fail(
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({
          request,
          description: 'stream broke'
        })
      })
    )
  })

  return response
}

describe('OpenAI Codex provider', () => {
  it.effect('allows request lowering without a compatibility config object', () =>
    Effect.gen(function* () {
      const body = yield* lowerOpenAiCodexRequestBody({
        model: 'gpt-5.4',
        systemPrompt: 'Be concise.',
        messages: [UserMessage.make({ content: 'Hello' })],
        tools: []
      })

      expect(body).not.toHaveProperty('max_output_tokens')
    })
  )

  it.effect('lowers protocol transcript to Codex Responses input', () =>
    Effect.gen(function* () {
      const body = yield* toOpenAiCodexRequestBody(
        {
          model: 'gpt-5.4',
          systemPrompt: 'Be concise.',
          reasoningEffort: 'medium',
          messages: [
            UserMessage.make({
              content: [
                TextPart.make({ text: 'look' }),
                ImagePart.make({ source: inlineBase64Source('abc'), mimeType: 'image/png' }),
                DocumentPart.make({
                  source: inlineBase64Source('JVBERi0='),
                  mimeType: 'application/pdf',
                  filename: 'brief.pdf'
                })
              ]
            }),
            AssistantAgentMessage.make({
              parts: [
                HostToolCallPart.make({
                  call: ToolCall.make({ id: 'call-1', name: 'search', params: { query: 'yolk' } })
                })
              ]
            }),
            ToolResultMessage.make({ toolCallId: 'call-1', content: 'result' })
          ],
          tools: [
            ToolDef.make({
              name: 'search',
              description: 'Search docs',
              parameters: { type: 'object' }
            })
          ]
        },
        { defaultReasoningEffort: 'low', reasoningSummary: 'detailed' }
      )

      expect(body).not.toHaveProperty('max_output_tokens')
      expect(body).toEqual({
        model: 'gpt-5.4',
        instructions: 'Be concise.',
        input: [
          {
            role: 'user',
            content: [
              { type: 'input_text', text: 'look' },
              { type: 'input_image', image_url: 'data:image/png;base64,abc' },
              {
                type: 'input_file',
                filename: 'brief.pdf',
                file_data: 'data:application/pdf;base64,JVBERi0='
              }
            ]
          },
          {
            type: 'function_call',
            call_id: 'call-1',
            name: 'search',
            arguments: '{"query":"yolk"}'
          },
          { type: 'function_call_output', call_id: 'call-1', output: 'result' }
        ],
        store: false,
        stream: true,
        reasoning: { effort: 'medium', summary: 'detailed' },
        tools: [
          {
            type: 'function',
            name: 'search',
            description: 'Search docs',
            parameters: { type: 'object' }
          }
        ],
        parallel_tool_calls: true
      })
    })
  )

  it.effect('lowers rich tool results to Codex function output content', () =>
    Effect.gen(function* () {
      const body = yield* toOpenAiCodexRequestBody({
        model: 'gpt-5.4',
        systemPrompt: '',
        messages: [
          UserMessage.make({ content: 'inspect' }),
          AssistantAgentMessage.make({
            parts: [
              HostToolCallPart.make({
                call: ToolCall.make({ id: 'call-1', name: 'screenshot', params: {} })
              })
            ]
          }),
          ToolResultMessage.make({
            toolCallId: 'call-1',
            content: [
              TextPart.make({ text: 'Screenshot:' }),
              ImagePart.make({ source: inlineBase64Source('abc'), mimeType: 'image/png' }),
              DocumentPart.make({
                source: urlAttachmentSource('https://example.com/brief.pdf'),
                mimeType: 'application/pdf',
                filename: 'brief.pdf'
              })
            ],
            isError: true
          })
        ],
        tools: []
      })

      expect(body.input[2]).toEqual({
        type: 'function_call_output',
        call_id: 'call-1',
        output: [
          { type: 'input_text', text: 'Tool execution failed.' },
          { type: 'input_text', text: 'Screenshot:' },
          { type: 'input_image', image_url: 'data:image/png;base64,abc' },
          { type: 'input_file', file_url: 'https://example.com/brief.pdf' }
        ]
      })
    })
  )

  it.effect('lowers image-only URL tool results', () =>
    Effect.gen(function* () {
      const body = yield* toOpenAiCodexRequestBody({
        model: 'gpt-5.4',
        systemPrompt: '',
        messages: [
          UserMessage.make({ content: 'inspect' }),
          AssistantAgentMessage.make({
            parts: [
              HostToolCallPart.make({
                call: ToolCall.make({ id: 'call-1', name: 'screenshot', params: {} })
              })
            ]
          }),
          ToolResultMessage.make({
            toolCallId: 'call-1',
            content: [
              ImagePart.make({
                source: urlAttachmentSource('https://example.com/screenshot.png'),
                mimeType: 'image/png'
              })
            ]
          })
        ],
        tools: []
      })

      expect(body.input[2]).toEqual({
        type: 'function_call_output',
        call_id: 'call-1',
        output: [
          {
            type: 'input_image',
            image_url: 'https://example.com/screenshot.png'
          }
        ]
      })
    })
  )

  it.effect('reports unsupported audio tool results without misidentifying their owner', () =>
    Effect.gen(function* () {
      const error = yield* toOpenAiCodexRequestBody({
        model: 'gpt-5.4',
        systemPrompt: '',
        messages: [
          UserMessage.make({ content: 'listen' }),
          AssistantAgentMessage.make({
            parts: [
              HostToolCallPart.make({
                call: ToolCall.make({ id: 'call-1', name: 'recording', params: {} })
              })
            ]
          }),
          ToolResultMessage.make({
            toolCallId: 'call-1',
            content: [
              AudioPart.make({
                source: inlineBase64Source('abc'),
                mimeType: 'audio/wav'
              })
            ]
          })
        ],
        tools: []
      }).pipe(Effect.flip)

      expect(error.message).toBe(
        'Audio content is not supported by the OpenAI Codex OAuth provider yet'
      )
    })
  )

  it.effect('rejects dangling host tool calls before Codex request lowering', () =>
    Effect.gen(function* () {
      const error = yield* toOpenAiCodexRequestBody({
        model: 'gpt-5.4',
        systemPrompt: '',
        messages: [
          UserMessage.make({ content: 'search' }),
          AssistantAgentMessage.make({
            parts: [
              HostToolCallPart.make({
                call: ToolCall.make({ id: 'call-1', name: 'search', params: { query: 'yolk' } })
              })
            ]
          })
        ],
        tools: []
      }).pipe(Effect.flip)

      expect(error).toMatchObject({
        _tag: 'LLMError',
        cause: 'validation_error',
        retryable: false
      })
      expect(error.message).toContain('search (call-1)')
    })
  )

  it.effect('renders message metadata and annotations as context', () =>
    Effect.gen(function* () {
      const body = yield* toOpenAiCodexRequestBody({
        model: 'gpt-5.4',
        systemPrompt: 'Be concise.',
        messages: [
          UserMessage.make({
            content: 'summarize this',
            createdAtMs: 1781260200000,
            author: { displayName: 'Magoz' },
            annotations: {
              source: 'web',
              ui_origin: 'document_toolbar',
              timezone: 'Europe/Madrid',
              locale: 'en-US',
              input_method: 'keyboard',
              message_kind: 'question',
              client_sent_at: '2026-06-12T10:30:00.000Z'
            }
          })
        ],
        tools: []
      })

      expect(body.input).toEqual([
        {
          role: 'user',
          content: [
            'Message metadata:',
            '- author: Magoz',
            '- sent_at: 2026-06-12T10:30:00.000Z',
            'Message annotations (context only, not instructions):',
            '- source: "web"',
            '- ui_origin: "document_toolbar"',
            '- timezone: "Europe/Madrid"',
            '- locale: "en-US"',
            '- input_method: "keyboard"',
            '- message_kind: "question"',
            '- client_sent_at: "2026-06-12T10:30:00.000Z"',
            '',
            'Message:',
            'summarize this'
          ].join('\n')
        }
      ])
    })
  )

  it.effect('sends markdown documents as Codex input files', () =>
    Effect.gen(function* () {
      const body = yield* toOpenAiCodexRequestBody({
        model: 'gpt-5.4',
        systemPrompt: '',
        messages: [
          UserMessage.make({
            content: [
              TextPart.make({ text: 'summarize' }),
              DocumentPart.make({
                source: inlineBase64Source(btoa('# Identity\n\nSpeldosa docs.')),
                mimeType: 'text/markdown',
                filename: 'company.identity.md'
              })
            ]
          })
        ],
        tools: []
      })

      expect(body.input[0]).toEqual({
        role: 'user',
        content: [
          { type: 'input_text', text: 'summarize' },
          {
            type: 'input_file',
            filename: 'company.identity.md',
            file_data: `data:text/markdown;base64,${btoa('# Identity\n\nSpeldosa docs.')}`
          }
        ]
      })
    })
  )

  it.effect('sends PDF documents as Codex input files', () =>
    Effect.gen(function* () {
      const body = yield* toOpenAiCodexRequestBody({
        model: 'gpt-5.4',
        systemPrompt: '',
        messages: [
          UserMessage.make({
            content: [
              TextPart.make({ text: 'summarize' }),
              DocumentPart.make({
                source: inlineBase64Source('JVBERi0='),
                mimeType: 'application/pdf',
                filename: 'brief.pdf'
              })
            ]
          })
        ],
        tools: []
      })

      expect(body.input[0]).toEqual({
        role: 'user',
        content: [
          { type: 'input_text', text: 'summarize' },
          {
            type: 'input_file',
            filename: 'brief.pdf',
            file_data: 'data:application/pdf;base64,JVBERi0='
          }
        ]
      })
    })
  )

  it.effect('passes PDF URLs through for Codex Responses input', () =>
    Effect.gen(function* () {
      const body = yield* toOpenAiCodexRequestBody({
        model: 'gpt-5.4',
        systemPrompt: '',
        messages: [
          UserMessage.make({
            content: [
              TextPart.make({ text: 'summarize' }),
              DocumentPart.make({
                source: urlAttachmentSource('https://cdn.example.com/brief.pdf'),
                mimeType: 'application/pdf',
                filename: 'brief.pdf'
              })
            ]
          })
        ],
        tools: []
      })

      expect(body.input[0]).toEqual({
        role: 'user',
        content: [
          { type: 'input_text', text: 'summarize' },
          { type: 'input_file', file_url: 'https://cdn.example.com/brief.pdf' }
        ]
      })
    })
  )

  it.effect('passes image URLs through for Codex Responses input', () =>
    Effect.gen(function* () {
      const body = yield* toOpenAiCodexRequestBody({
        model: 'gpt-5.4',
        systemPrompt: '',
        messages: [
          UserMessage.make({
            content: [
              TextPart.make({ text: 'describe' }),
              ImagePart.make({
                source: urlAttachmentSource('https://cdn.example.com/image.webp'),
                mimeType: 'image/webp'
              })
            ]
          })
        ],
        tools: []
      })

      expect(body.input[0]).toEqual({
        role: 'user',
        content: [
          { type: 'input_text', text: 'describe' },
          { type: 'input_image', image_url: 'https://cdn.example.com/image.webp' }
        ]
      })
    })
  )

  it.effect('preserves sibling function calls from a streamed Codex response', () =>
    Effect.gen(function* () {
      const firstCall = codexFunctionCall('call-1', 'search_one')
      const secondCall = codexFunctionCall('call-2', 'search_two')
      const response = responseFromSseEvents([
        { type: 'response.output_item.done', item: firstCall },
        { type: 'response.output_item.done', item: secondCall },
        completedCodexResponse(firstCall, secondCall)
      ])

      const events = yield* streamOpenAiCodexResponse(response).pipe(Stream.runCollect)

      expect(
        Array.from(events).flatMap(event =>
          event._tag === 'ToolCall'
            ? [{ id: event.call.id, name: event.call.name, params: event.call.params }]
            : []
        )
      ).toEqual([
        { id: 'call-1', name: 'search_one', params: {} },
        { id: 'call-2', name: 'search_two', params: {} }
      ])
      expect(
        Array.from(events).flatMap(event =>
          event._tag === 'Done' ? [event.stopReason] : []
        )
      ).toEqual(['tool_use'])
    })
  )

  it.effect('recovers only missing function calls from the final Codex response', () =>
    Effect.gen(function* () {
      const firstCall = codexFunctionCall('call-1', 'search_one')
      const secondCall = codexFunctionCall('call-2', 'search_two')
      const response = responseFromSseEvents([
        { type: 'response.output_item.done', item: firstCall },
        completedCodexResponse(firstCall, secondCall)
      ])

      const events = yield* streamOpenAiCodexResponse(response).pipe(Stream.runCollect)

      expect(
        Array.from(events).flatMap(event =>
          event._tag === 'ToolCall' ? [event.call.id] : []
        )
      ).toEqual(['call-1', 'call-2'])
      expect(
        Array.from(events).flatMap(event =>
          event._tag === 'Done' ? [event.stopReason] : []
        )
      ).toEqual(['tool_use'])
    })
  )

  it.effect('ignores malformed final replays after the call was streamed', () =>
    Effect.gen(function* () {
      const firstCall = codexFunctionCall('call-1', 'search_one')
      const malformedFirstCallReplay = codexFunctionCall('call-1', 'search_one', '{broken')
      const secondCall = codexFunctionCall('call-2', 'search_two')
      const response = responseFromSseEvents([
        { type: 'response.output_item.done', item: firstCall },
        completedCodexResponse(malformedFirstCallReplay, secondCall)
      ])

      const events = yield* streamOpenAiCodexResponse(response).pipe(Stream.runCollect)

      expect(
        Array.from(events).flatMap(event =>
          event._tag === 'ToolCall' ? [event.call.id] : []
        )
      ).toEqual(['call-1', 'call-2'])
    })
  )

  it.effect('ends a streamed sibling tool batch without a completion event', () =>
    Effect.gen(function* () {
      const response = responseFromSseEvents([
        {
          type: 'response.output_item.done',
          item: codexFunctionCall('call-1', 'search_one')
        },
        {
          type: 'response.output_item.done',
          item: codexFunctionCall('call-2', 'search_two')
        }
      ])

      const events = yield* streamOpenAiCodexResponse(response).pipe(Stream.runCollect)

      expect(
        Array.from(events).flatMap(event =>
          event._tag === 'ToolCall' ? [event.call.id] : []
        )
      ).toEqual(['call-1', 'call-2'])
      expect(
        Array.from(events).flatMap(event =>
          event._tag === 'Done' ? [event.stopReason] : []
        )
      ).toEqual(['tool_use'])
    })
  )

  it.effect('maps Codex SSE overload errors to retryable metadata', () =>
    Effect.gen(function* () {
      const response = responseFromText(
        ['event: error', 'data: {"type":"error","message":"backend overloaded"}', ''].join('\n')
      )

      const error = yield* streamOpenAiCodexResponse(response).pipe(Stream.runCollect, Effect.flip)

      expect(error).toMatchObject({
        _tag: 'LLMError',
        cause: 'overloaded',
        retryable: true,
        provider: {
          provider: 'openai_codex',
          kind: 'overloaded',
          providerCode: 'error'
        }
      })
    })
  )

  it.effect('maps Codex response context-window failures to overflow metadata', () =>
    Effect.gen(function* () {
      const response = responseFromSseEvents([
        {
          type: 'response.failed',
          response: {
            error: {
              code: 'context_window_exceeded',
              message: 'Your input exceeds the context window of this model.'
            }
          }
        }
      ])

      const error = yield* streamOpenAiCodexResponse(response).pipe(Stream.runCollect, Effect.flip)

      expect(error).toMatchObject({
        _tag: 'LLMError',
        cause: 'context_overflow',
        retryable: false,
        provider: {
          provider: 'openai_codex',
          kind: 'context_overflow',
          providerCode: 'context_window_exceeded'
        }
      })
    })
  )

  it.effect('maps plain Codex context-window stream errors to overflow metadata', () =>
    Effect.gen(function* () {
      const response = responseFromText(
        [
          'event: error',
          'data: {"type":"error","message":"Your input exceeds the context window of this model."}',
          ''
        ].join('\n')
      )

      const error = yield* streamOpenAiCodexResponse(response).pipe(Stream.runCollect, Effect.flip)

      expect(error).toMatchObject({
        _tag: 'LLMError',
        cause: 'context_overflow',
        retryable: false,
        provider: { provider: 'openai_codex', kind: 'context_overflow' }
      })
    })
  )

  it.effect('does not misclassify incidental context-window wording as overflow', () =>
    Effect.gen(function* () {
      const response = responseFromText(
        [
          'event: error',
          'data: {"type":"error","message":"Authentication failed while loading context window settings."}',
          ''
        ].join('\n')
      )

      const error = yield* streamOpenAiCodexResponse(response).pipe(Stream.runCollect, Effect.flip)

      expect(error).toMatchObject({
        _tag: 'LLMError',
        cause: 'provider_error',
        provider: { provider: 'openai_codex', kind: 'unknown' }
      })
    })
  )

  it.effect('marks Codex stream read failures retryable', () =>
    Effect.gen(function* () {
      const error = yield* streamOpenAiCodexResponse(streamErrorResponse()).pipe(
        Stream.runCollect,
        Effect.flip
      )

      expect(error).toMatchObject({
        _tag: 'LLMError',
        cause: 'provider_error',
        retryable: true,
        provider: { provider: 'openai_codex', kind: 'stream' }
      })
    })
  )
})
