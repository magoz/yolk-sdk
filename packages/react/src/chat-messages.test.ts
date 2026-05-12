import { describe, expect, it } from '@effect/vitest'
import {
  AssistantAgentMessage,
  ImagePart,
  TextPart,
  ToolCall,
  ToolResult,
  ToolResultMessage,
  UserMessage
} from '@yolk/protocol'
import { buildAgentChatMessages, toAgentMessages, type AgentChatMessage } from './chat-messages'

describe('agent chat messages', () => {
  it('preserves multipart user content for protocol replay', () => {
    const chatMessages: ReadonlyArray<AgentChatMessage> = [
      {
        id: 'message-0-user',
        role: 'user',
        parts: [
          {
            _tag: 'Text',
            id: 'message-0-user-content',
            content: [
              TextPart.make({ text: 'describe this' }),
              ImagePart.make({ data: 'abc', mimeType: 'image/png' })
            ],
            state: 'done'
          }
        ]
      }
    ]

    expect(toAgentMessages(chatMessages)).toEqual([
      {
        _tag: 'User',
        content: [
          TextPart.make({ text: 'describe this' }),
          ImagePart.make({ data: 'abc', mimeType: 'image/png' })
        ]
      }
    ])
  })

  it('orders reasoning, text, tool calls, drafts, and errors', () => {
    const call = ToolCall.make({ id: 'call_1', name: 'web_fetch', params: { url: 'https://e.com' } })
    const messages = buildAgentChatMessages({
      messages: [
        UserMessage.make({ content: 'hi' }),
        AssistantAgentMessage.make({ content: 'done', reasoning: 'thinking', toolCalls: [call] })
      ],
      userDraft: 'draft user',
      assistantDraft: 'draft assistant',
      reasoningDraft: 'draft reasoning',
      toolRuns: [],
      error: 'boom'
    })

    expect(messages.map(message => message.id)).toEqual([
      'message-0-user',
      'message-1-assistant',
      'draft-user',
      'draft-assistant',
      'error-message'
    ])
    expect(messages[1]?.parts.map(part => part._tag)).toEqual(['Reasoning', 'Text', 'ToolCall'])
    expect(messages[3]?.parts.map(part => part._tag)).toEqual(['Reasoning', 'Text'])
  })

  it('preserves tool state and hides matched tool result messages', () => {
    const call = ToolCall.make({ id: 'call_1', name: 'web_fetch', params: { url: 'https://e.com' } })
    const result = ToolResult.make({ toolCallId: call.id, content: 'Example Domain' })
    const messages = buildAgentChatMessages({
      messages: [
        AssistantAgentMessage.make({ content: '', toolCalls: [call] }),
        ToolResultMessage.make({ toolCallId: call.id, content: result.content })
      ],
      userDraft: '',
      assistantDraft: '',
      reasoningDraft: '',
      toolRuns: [
        {
          _tag: 'Completed',
          call,
          result,
          startedAtMs: 10,
          endedAtMs: 25
        }
      ],
      error: null
    })

    expect(messages).toHaveLength(1)
    expect(messages[0]?.parts).toEqual([
      { _tag: 'Text', id: 'message-0-assistant-text', content: '', state: 'done' },
      {
        _tag: 'ToolCall',
        id: 'message-0-tool-call-call_1',
        call,
        state: { _tag: 'Completed', result, startedAtMs: 10, endedAtMs: 25 }
      }
    ])
  })
})
