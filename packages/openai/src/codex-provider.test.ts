import { Effect } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import {
  AssistantAgentMessage,
  HostToolCallPart,
  ImagePart,
  TextPart,
  ToolCall,
  ToolDef,
  ToolResultMessage,
  UserMessage
} from '@yolk-sdk/agent/protocol'
import { toOpenAiCodexRequestBody } from './codex-provider.ts'

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
                ImagePart.make({ data: 'abc', mimeType: 'image/png' })
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
              { type: 'input_image', image_url: 'data:image/png;base64,abc' }
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
})
