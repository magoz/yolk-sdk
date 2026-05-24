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
import { toAnthropicClaudeRequestBody } from './claude-provider.ts'

describe('Anthropic Claude provider', () => {
  it.effect('lowers protocol transcript to Claude Messages input', () =>
    Effect.gen(function* () {
      const body = yield* toAnthropicClaudeRequestBody(
        {
          model: 'claude-sonnet-4-6',
          systemPrompt: 'Use tools carefully.',
          messages: [
            UserMessage.make({
              content: [
                TextPart.make({ text: 'inspect' }),
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
            ToolResultMessage.make({ toolCallId: 'call-1', content: 'result', isError: false })
          ],
          tools: [
            ToolDef.make({
              name: 'search',
              description: 'Search docs',
              parameters: { type: 'object' }
            })
          ]
        },
        { maxTokens: 123 }
      )

      expect(body).toEqual({
        model: 'claude-sonnet-4-6',
        system: [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }],
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Use tools carefully.' },
              { type: 'text', text: 'inspect' },
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: 'abc' }
              }
            ]
          },
          {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'call-1', name: 'mcp_Search', input: { query: 'yolk' } }
            ]
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'call-1', content: 'result', is_error: false }
            ]
          }
        ],
        max_tokens: 123,
        tools: [{ name: 'mcp_Search', description: 'Search docs', input_schema: { type: 'object' } }]
      })
    }))
})
