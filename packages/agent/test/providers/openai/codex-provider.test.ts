import { Effect, Stream } from 'effect'
import { HttpClientError, HttpClientRequest, HttpClientResponse } from 'effect/unstable/http'
import { describe, expect, it } from '@effect/vitest'
import {
  AssistantAgentMessage,
  DocumentPart,
  HostToolCallPart,
  ImagePart,
  TextPart,
  ToolCall,
  ToolDef,
  ToolResultMessage,
  UserMessage,
  inlineBase64Source
} from '@yolk-sdk/agent/protocol'
import {
  streamOpenAiCodexResponse,
  toOpenAiCodexRequestBody
} from '../../../src/providers/openai/codex-provider.ts'

const responseFromText = (text: string) => {
  const request = HttpClientRequest.get('https://example.com')

  return HttpClientResponse.fromWeb(request, new Response(text, { status: 200 }))
}

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
    }))

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

  it.effect('maps Codex SSE overload errors to retryable metadata', () =>
    Effect.gen(function* () {
      const response = responseFromText(
        ['event: error', 'data: {"type":"error","message":"backend overloaded"}', ''].join('\n')
      )

      const error = yield* streamOpenAiCodexResponse(response).pipe(
        Stream.runCollect,
        Effect.flip
      )

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
