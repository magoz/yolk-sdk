import { describe, expect, it } from '@effect/vitest'
import {
  AssistantAgentMessage,
  ToolCall,
  ToolResult,
  ToolResultMessage,
  UserMessage
} from '@yolk/protocol'
import { buildAgentChatItems } from './agent-chat-items'

describe('buildAgentChatItems', () => {
  it('normalizes protocol messages, tools, drafts, and errors', () => {
    const call = ToolCall.make({
      id: 'call_1',
      name: 'web_fetch',
      params: { url: 'https://example.com' }
    })
    const items = buildAgentChatItems({
      messages: [
        UserMessage.make({ content: 'summarize https://example.com' }),
        AssistantAgentMessage.make({
          content: 'I will fetch it.',
          reasoning: 'Need page content.',
          toolCalls: [call]
        }),
        ToolResultMessage.make({ toolCallId: call.id, content: 'URL: https://example.com' })
      ],
      userDraft: 'voice draft',
      assistantDraft: 'assistant draft',
      reasoningDraft: 'reasoning draft',
      activeToolCalls: [],
      completedToolCalls: [],
      liveToolResults: [],
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
      name: 'web_fetch',
      content: 'URL: https://example.com'
    })
  })

  it('falls back to tool call id when result has no matching call', () => {
    const items = buildAgentChatItems({
      messages: [ToolResultMessage.make({ toolCallId: 'missing_call', content: 'ok' })],
      userDraft: '',
      assistantDraft: '',
      reasoningDraft: '',
      activeToolCalls: [],
      completedToolCalls: [],
      liveToolResults: [],
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
    const call = ToolCall.make({
      id: 'call_1',
      name: 'web_search',
      params: { query: 'latest news' }
    })
    const thinkingItems = buildAgentChatItems({
      messages: [UserMessage.make({ content: 'hello' })],
      userDraft: '',
      assistantDraft: '',
      reasoningDraft: '',
      activeToolCalls: [],
      completedToolCalls: [],
      liveToolResults: [],
      isRunning: true,
      error: null
    })
    const toolItems = buildAgentChatItems({
      messages: [UserMessage.make({ content: 'latest news?' })],
      userDraft: '',
      assistantDraft: '',
      reasoningDraft: '',
      activeToolCalls: [call],
      completedToolCalls: [],
      liveToolResults: [],
      isRunning: true,
      error: null
    })

    expect(thinkingItems.at(-1)).toEqual({
      _tag: 'AssistantStatus',
      id: 'assistant-status',
      label: 'Thinking'
    })
    expect(toolItems.at(-2)).toEqual({
      _tag: 'LiveTool',
      id: 'live-tool-call_1',
      call,
      state: { _tag: 'Running' }
    })
    expect(toolItems.at(-1)).toEqual({
      _tag: 'AssistantStatus',
      id: 'assistant-status',
      label: 'Running web_search'
    })
  })

  it('keeps live tool results visible while the run continues', () => {
    const call = ToolCall.make({
      id: 'call_1',
      name: 'web_fetch',
      params: { url: 'https://example.com' }
    })
    const result = ToolResult.make({ toolCallId: call.id, content: 'Example Domain' })
    const items = buildAgentChatItems({
      messages: [UserMessage.make({ content: 'summarize https://example.com' })],
      userDraft: '',
      assistantDraft: '',
      reasoningDraft: '',
      activeToolCalls: [],
      completedToolCalls: [call],
      liveToolResults: [result],
      isRunning: true,
      error: null
    })

    expect(items.at(-2)).toEqual({
      _tag: 'LiveTool',
      id: 'live-tool-call_1',
      call,
      state: { _tag: 'Completed', result }
    })
    expect(items.at(-1)).toEqual({
      _tag: 'AssistantStatus',
      id: 'assistant-status',
      label: 'Thinking'
    })
  })
})
