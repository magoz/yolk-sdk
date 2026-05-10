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
      toolRuns: [
        {
          _tag: 'Completed',
          call,
          result: ToolResult.make({ toolCallId: call.id, content: 'URL: https://example.com' }),
          startedAtMs: 1000,
          endedAtMs: 1250
        }
      ],
      isRunning: false,
      error: 'boom'
    })

    expect(items.map(item => item._tag)).toEqual([
      'UserMessage',
      'Reasoning',
      'AssistantMessage',
      'ToolRun',
      'Reasoning',
      'UserDraft',
      'AssistantDraft',
      'Error'
    ])
    expect(items).toContainEqual({
      _tag: 'ToolRun',
      id: 'message-1-tool-run-call_1',
      call,
      state: {
        _tag: 'Completed',
        duration: { _tag: 'Known', milliseconds: 250 },
        result: ToolResult.make({ toolCallId: call.id, content: 'URL: https://example.com' })
      }
    })
  })

  it('falls back to tool call id when result has no matching call', () => {
    const items = buildAgentChatItems({
      messages: [ToolResultMessage.make({ toolCallId: 'missing_call', content: 'ok' })],
      userDraft: '',
      assistantDraft: '',
      reasoningDraft: '',
      toolRuns: [],
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
      toolRuns: [],
      isRunning: true,
      error: null
    })
    const toolItems = buildAgentChatItems({
      messages: [
        UserMessage.make({ content: 'latest news?' }),
        AssistantAgentMessage.make({ content: '', toolCalls: [call] })
      ],
      userDraft: '',
      assistantDraft: '',
      reasoningDraft: '',
      toolRuns: [{ _tag: 'Running', call, startedAtMs: 1000 }],
      isRunning: true,
      error: null
    })

    expect(thinkingItems.at(-1)).toEqual({
      _tag: 'AssistantStatus',
      id: 'assistant-status',
      label: 'Thinking'
    })
    expect(toolItems.at(-2)).toEqual({
      _tag: 'ToolRun',
      id: 'message-1-tool-run-call_1',
      call,
      state: { _tag: 'Running', duration: { _tag: 'Unknown' } }
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
      messages: [
        UserMessage.make({ content: 'summarize https://example.com' }),
        AssistantAgentMessage.make({ content: '', toolCalls: [call] }),
        ToolResultMessage.make({ toolCallId: call.id, content: result.content })
      ],
      userDraft: '',
      assistantDraft: '',
      reasoningDraft: '',
      toolRuns: [{ _tag: 'Completed', call, result, startedAtMs: 1000, endedAtMs: 1800 }],
      isRunning: true,
      error: null
    })

    expect(items.at(-2)).toEqual({
      _tag: 'ToolRun',
      id: 'message-1-tool-run-call_1',
      call,
      state: {
        _tag: 'Completed',
        duration: { _tag: 'Known', milliseconds: 800 },
        result
      }
    })
    expect(items.at(-1)).toEqual({
      _tag: 'AssistantStatus',
      id: 'assistant-status',
      label: 'Thinking'
    })
  })

  it('anchors tool rows before the next assistant draft', () => {
    const call = ToolCall.make({
      id: 'call_1',
      name: 'web_search',
      params: { query: 'latest news' }
    })
    const result = ToolResult.make({ toolCallId: call.id, content: 'Search result' })
    const items = buildAgentChatItems({
      messages: [
        UserMessage.make({ content: 'latest news?' }),
        AssistantAgentMessage.make({ content: '', toolCalls: [call] }),
        ToolResultMessage.make({ toolCallId: call.id, content: result.content })
      ],
      userDraft: '',
      assistantDraft: 'Here is what I found.',
      reasoningDraft: '',
      toolRuns: [{ _tag: 'Completed', call, result, startedAtMs: 1000, endedAtMs: 1300 }],
      isRunning: true,
      error: null
    })

    expect(items.map(item => item._tag)).toEqual([
      'UserMessage',
      'AssistantMessage',
      'ToolRun',
      'AssistantDraft',
      'AssistantStatus'
    ])
  })
})
