import { describe, expect, it } from '@effect/vitest'
import { AssistantAgentMessage, ToolCall, ToolResultMessage, UserMessage } from '@yolk/protocol'
import { buildAgentChatItems } from './agent-chat-items'

describe('buildAgentChatItems', () => {
  it('normalizes protocol messages, tools, drafts, and errors', () => {
    const call = ToolCall.make({
      id: 'call_1',
      name: 'calculate',
      params: { operation: 'add', left: 2, right: 2 }
    })
    const items = buildAgentChatItems({
      messages: [
        UserMessage.make({ content: 'what is 2 + 2?' }),
        AssistantAgentMessage.make({
          content: 'I will calculate it.',
          reasoning: 'Arithmetic needed.',
          toolCalls: [call]
        }),
        ToolResultMessage.make({ toolCallId: call.id, content: '4' })
      ],
      userDraft: 'voice draft',
      assistantDraft: 'assistant draft',
      reasoningDraft: 'reasoning draft',
      activeToolCalls: [],
      isRunning: false,
      error: 'boom'
    })

    expect(items.map(item => item._tag)).toEqual([
      'UserMessage',
      'Reasoning',
      'AssistantMessage',
      'ToolCall',
      'ToolResult',
      'Reasoning',
      'UserDraft',
      'AssistantDraft',
      'Error'
    ])
    expect(items).toContainEqual({
      _tag: 'ToolResult',
      id: 'message-2-tool-result-call_1',
      toolCallId: 'call_1',
      name: 'calculate',
      content: '4'
    })
  })

  it('falls back to tool call id when result has no matching call', () => {
    const items = buildAgentChatItems({
      messages: [ToolResultMessage.make({ toolCallId: 'missing_call', content: 'ok' })],
      userDraft: '',
      assistantDraft: '',
      reasoningDraft: '',
      activeToolCalls: [],
      isRunning: false,
      error: null
    })

    expect(items).toEqual([
      {
        _tag: 'ToolResult',
        id: 'message-0-tool-result-missing_call',
        toolCallId: 'missing_call',
        name: 'missing_call',
        content: 'ok'
      }
    ])
  })

  it('adds active assistant status while waiting for more events', () => {
    const call = ToolCall.make({ id: 'call_1', name: 'calculate', params: {} })
    const thinkingItems = buildAgentChatItems({
      messages: [UserMessage.make({ content: 'hello' })],
      userDraft: '',
      assistantDraft: '',
      reasoningDraft: '',
      activeToolCalls: [],
      isRunning: true,
      error: null
    })
    const toolItems = buildAgentChatItems({
      messages: [UserMessage.make({ content: '2+2?' })],
      userDraft: '',
      assistantDraft: '',
      reasoningDraft: '',
      activeToolCalls: [call],
      isRunning: true,
      error: null
    })

    expect(thinkingItems.at(-1)).toEqual({
      _tag: 'AssistantStatus',
      id: 'assistant-status',
      label: 'Thinking'
    })
    expect(toolItems.at(-1)).toEqual({
      _tag: 'AssistantStatus',
      id: 'assistant-status',
      label: 'Running calculate'
    })
  })
})
