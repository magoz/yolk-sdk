import { describe, expect, it } from '@effect/vitest'
import {
  AssistantAgentMessage,
  AssistantReasoningPart,
  AssistantTextPart,
  HostToolCallPart,
  ImagePart,
  ProviderToolResult,
  TextPart,
  ToolCall,
  ToolInputDelta,
  ToolInputStart,
  ToolResult,
  ToolResultMessage,
  UserMessage
} from '@yolk-sdk/agent/protocol'
import {
  appendProtocolMessage,
  applyAgentEventToChatMessages,
  buildAgentChatMessages,
  deleteChatTurn,
  editChatUserMessage,
  regenerateChatMessagesFrom,
  toAgentMessages,
  type AgentChatMessage
} from './chat-messages'

describe('agent chat messages', () => {
  it('preserves multipart user content for protocol replay', () => {
    const chatMessages: ReadonlyArray<AgentChatMessage> = [
      {
        id: 'message-0-user',
        turnId: 'turn-0',
        sequence: 0,
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
    const call = ToolCall.make({
      id: 'call_1',
      name: 'web_fetch',
      params: { url: 'https://e.com' }
    })
    const messages = buildAgentChatMessages({
      messages: [
        UserMessage.make({ content: 'hi' }),
        AssistantAgentMessage.make({
          parts: [
            AssistantReasoningPart.make({ text: 'thinking' }),
            AssistantTextPart.make({ content: 'done' }),
            HostToolCallPart.make({ call })
          ]
        })
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
    const call = ToolCall.make({
      id: 'call_1',
      name: 'web_fetch',
      params: { url: 'https://e.com' }
    })
    const result = ToolResult.make({
      toolCallId: call.id,
      content: 'Example Domain',
      isError: true,
      structuredContent: { title: 'Example Domain' }
    })
    const messages = buildAgentChatMessages({
      messages: [
        AssistantAgentMessage.make({
          parts: [AssistantTextPart.make({ content: '' }), HostToolCallPart.make({ call })]
        }),
        ToolResultMessage.make({
          toolCallId: call.id,
          content: result.content,
          isError: result.isError,
          structuredContent: result.structuredContent
        })
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
      { _tag: 'Text', id: 'message-0-assistant-text-0', content: '', state: 'done' },
      {
        _tag: 'ToolCall',
        id: 'message-0-tool-call-call_1',
        call,
        state: { _tag: 'Completed', result, startedAtMs: 10, endedAtMs: 25 }
      }
    ])
  })

  it('renders streamed tool input and provider-completed tools', () => {
    const call = ToolCall.make({
      id: 'call_1',
      name: 'web_fetch',
      params: { url: 'https://e.com' }
    })
    const streamingCall = ToolCall.make({ id: call.id, name: call.name, params: {} })
    const result = ToolResult.make({ toolCallId: call.id, content: 'Example Domain' })
    const inputStarted = applyAgentEventToChatMessages(
      [],
      ToolInputStart.make({ id: call.id, name: call.name })
    )
    const inputUpdated = applyAgentEventToChatMessages(
      inputStarted,
      ToolInputDelta.make({ id: call.id, delta: '{"url":"https://e.com"}' })
    )

    expect(inputUpdated).toEqual([
      {
        id: 'message-0-assistant',
        turnId: 'turn-0',
        sequence: 0,
        role: 'assistant',
        parts: [
          {
            _tag: 'ToolCall',
            id: `tool-call-${call.id}`,
            call: streamingCall,
            state: { _tag: 'InputStreaming', input: '{"url":"https://e.com"}' }
          }
        ]
      }
    ])

    const providerCompleted = applyAgentEventToChatMessages(
      inputUpdated,
      ProviderToolResult.make({ call, result })
    )

    expect(providerCompleted[0]?.parts[0]).toEqual({
      _tag: 'ToolCall',
      id: `tool-call-${call.id}`,
      call,
      state: { _tag: 'ProviderCompleted', result }
    })
  })

  it('deletes whole turns from any message in the turn', () => {
    const messages = buildAgentChatMessages({
      messages: [
        UserMessage.make({ content: 'one' }),
        AssistantAgentMessage.make({ parts: [AssistantTextPart.make({ content: 'first' })] }),
        UserMessage.make({ content: 'two' }),
        AssistantAgentMessage.make({ parts: [AssistantTextPart.make({ content: 'second' })] })
      ],
      userDraft: '',
      assistantDraft: '',
      reasoningDraft: '',
      toolRuns: [],
      error: null
    })

    const deleted = deleteChatTurn(messages, 'message-1-assistant')

    expect(deleted).toEqual({
      _tag: 'Deleted',
      turnStartMessageId: 'message-0-user',
      deletedMessageIds: ['message-0-user', 'message-1-assistant'],
      messages: messages.slice(2)
    })
  })

  it('truncates transcript for regeneration by target role', () => {
    const messages = buildAgentChatMessages({
      messages: [
        UserMessage.make({ content: 'one' }),
        AssistantAgentMessage.make({ parts: [AssistantTextPart.make({ content: 'first' })] }),
        UserMessage.make({ content: 'two' }),
        AssistantAgentMessage.make({ parts: [AssistantTextPart.make({ content: 'second' })] })
      ],
      userDraft: '',
      assistantDraft: '',
      reasoningDraft: '',
      toolRuns: [],
      error: null
    })

    expect(regenerateChatMessagesFrom(messages, 'message-2-user')).toEqual({
      _tag: 'Regenerated',
      messages: messages.slice(0, 3)
    })
    expect(regenerateChatMessagesFrom(messages, 'message-3-assistant')).toEqual({
      _tag: 'Regenerated',
      messages: messages.slice(0, 3)
    })
  })

  it('edits a user message and truncates following messages', () => {
    const messages = buildAgentChatMessages({
      messages: [
        UserMessage.make({ content: 'one' }),
        AssistantAgentMessage.make({ parts: [AssistantTextPart.make({ content: 'first' })] }),
        UserMessage.make({ content: 'two' }),
        AssistantAgentMessage.make({ parts: [AssistantTextPart.make({ content: 'second' })] })
      ],
      userDraft: '',
      assistantDraft: '',
      reasoningDraft: '',
      toolRuns: [],
      error: null
    })

    expect(editChatUserMessage(messages, 'message-2-user', 'updated')).toEqual({
      _tag: 'Edited',
      messageId: 'message-2-user',
      messages: [
        messages[0],
        messages[1],
        {
          id: 'message-2-user',
          turnId: 'turn-2',
          sequence: 2,
          role: 'user',
          parts: [{ _tag: 'Text', id: 'message-2-user-text', content: 'updated', state: 'done' }]
        }
      ]
    })
    expect(editChatUserMessage(messages, 'message-3-assistant', 'updated')).toEqual({
      _tag: 'NotUserMessage'
    })
  })

  it('appends with monotonic message ids after deletion', () => {
    const messages = buildAgentChatMessages({
      messages: [
        UserMessage.make({ content: 'one' }),
        AssistantAgentMessage.make({ parts: [AssistantTextPart.make({ content: 'first' })] }),
        UserMessage.make({ content: 'two' })
      ],
      userDraft: '',
      assistantDraft: '',
      reasoningDraft: '',
      toolRuns: [],
      error: null
    })
    const deleted = deleteChatTurn(messages, 'message-0-user')

    if (deleted._tag !== 'Deleted') {
      throw new Error('Expected deleted turn')
    }

    expect(appendProtocolMessage(deleted.messages, UserMessage.make({ content: 'three' }))).toEqual(
      [
        messages[2],
        {
          id: 'message-3-user',
          turnId: 'turn-3',
          sequence: 3,
          role: 'user',
          parts: [{ _tag: 'Text', id: 'message-3-user-text', content: 'three', state: 'done' }]
        }
      ]
    )
  })
})
