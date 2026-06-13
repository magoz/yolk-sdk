import { Effect } from 'effect'
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
import { toOpenAiCodexRequestBody } from '../../../src/providers/openai/codex-provider.ts'

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
})
