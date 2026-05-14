import { describe, expect, it } from '@effect/vitest'
import { Option } from 'effect'
import {
  AssistantAgentMessage,
  AssistantReasoningPart,
  AssistantTextPart,
  HostToolCallPart,
  ToolCall,
  ToolResult,
  ToolResultMessage,
  UserMessage
} from '@yolk/agent/protocol'
import { buildAgentChatItems } from './chat-items'
import { buildAgentChatMessages, toAgentMessages } from './chat-messages'

const assistantMessage = (input: {
  readonly content: string
  readonly reasoning?: string
  readonly toolCalls?: ReadonlyArray<ToolCall>
}) =>
  AssistantAgentMessage.make({
    parts: [
      ...(input.reasoning === undefined
        ? []
        : [AssistantReasoningPart.make({ text: input.reasoning })]),
      AssistantTextPart.make({ content: input.content }),
      ...(input.toolCalls ?? []).map(call => HostToolCallPart.make({ call }))
    ]
  })

describe('buildAgentChatMessages', () => {
  it('projects protocol transcript into ordered message parts', () => {
    const call = ToolCall.make({
      id: 'call_1',
      name: 'web_fetch',
      params: { url: 'https://example.com' }
    })
    const result = ToolResult.make({ toolCallId: call.id, content: 'Example Domain' })
    const messages = buildAgentChatMessages({
      messages: [
        UserMessage.make({ content: 'summarize https://example.com' }),
        assistantMessage({
          content: 'Fetching.',
          reasoning: 'Need source.',
          toolCalls: [call]
        }),
        ToolResultMessage.make({ toolCallId: call.id, content: result.content })
      ],
      userDraft: '',
      assistantDraft: 'Done.',
      reasoningDraft: '',
      toolRuns: [{ _tag: 'Completed', call, result, startedAtMs: 1000, endedAtMs: 1250 }],
      error: null
    })

    expect(messages.map(message => message.role)).toEqual(['user', 'assistant', 'assistant'])
    expect(messages[1]?.parts.map(part => part._tag)).toEqual(['Reasoning', 'Text', 'ToolCall'])
    expect(messages[2]?.parts).toEqual([
      { _tag: 'Text', id: 'draft-assistant-text', content: 'Done.', state: 'streaming' }
    ])
  })

  it('converts chat parts back to protocol transcript', () => {
    const call = ToolCall.make({
      id: 'call_1',
      name: 'web_fetch',
      params: { url: 'https://example.com' }
    })
    const result = ToolResult.make({ toolCallId: call.id, content: 'Example Domain' })
    const messages = buildAgentChatMessages({
      messages: [
        UserMessage.make({ content: 'summarize https://example.com' }),
        assistantMessage({
          content: 'Fetching.',
          reasoning: 'Need source.',
          toolCalls: [call]
        }),
        ToolResultMessage.make({ toolCallId: call.id, content: result.content })
      ],
      userDraft: '',
      assistantDraft: '',
      reasoningDraft: '',
      toolRuns: [{ _tag: 'Completed', call, result, startedAtMs: 1000, endedAtMs: 1250 }],
      error: null
    })

    expect(toAgentMessages(messages)).toEqual([
      UserMessage.make({ content: 'summarize https://example.com' }),
      assistantMessage({
        content: 'Fetching.',
        reasoning: 'Need source.',
        toolCalls: [call]
      }),
      ToolResultMessage.make({ toolCallId: call.id, content: result.content })
    ])
  })
})

describe('buildAgentChatItems', () => {
  it('normalizes protocol messages, tools, drafts, and errors', () => {
    const call = ToolCall.make({
      id: 'call_1',
      name: 'web_fetch',
      params: { url: 'https://example.com' }
    })
    const messages = buildAgentChatMessages({
      messages: [
        UserMessage.make({ content: 'summarize https://example.com' }),
        assistantMessage({
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
      error: 'boom'
    })
    const items = buildAgentChatItems({
      messages,
      isRunning: false,
      activeToolLabel: Option.none()
    })

    expect(items.map(item => item._tag)).toEqual([
      'UserMessage',
      'Reasoning',
      'AssistantMessage',
      'ToolRun',
      'UserDraft',
      'Reasoning',
      'AssistantDraft',
      'Error'
    ])
    expect(items).toContainEqual({
      _tag: 'ToolRun',
      id: 'message-1-tool-call-call_1',
      messageId: 'message-1-assistant',
      call,
      state: {
        _tag: 'Completed',
        duration: { _tag: 'Known', milliseconds: 250 },
        result: ToolResult.make({ toolCallId: call.id, content: 'URL: https://example.com' })
      }
    })
  })

  it('falls back to tool call id when result has no matching call', () => {
    const messages = buildAgentChatMessages({
      messages: [ToolResultMessage.make({ toolCallId: 'missing_call', content: 'ok' })],
      userDraft: '',
      assistantDraft: '',
      reasoningDraft: '',
      toolRuns: [],
      error: null
    })
    const items = buildAgentChatItems({
      messages,
      isRunning: false,
      activeToolLabel: Option.none()
    })

    expect(items).toEqual([
      {
        _tag: 'ToolResult',
        id: 'message-0-tool-result-missing_call',
        messageId: 'message-0-tool-result-message',
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
    const thinkingMessages = buildAgentChatMessages({
      messages: [UserMessage.make({ content: 'hello' })],
      userDraft: '',
      assistantDraft: '',
      reasoningDraft: '',
      toolRuns: [],
      error: null
    })
    const thinkingItems = buildAgentChatItems({
      messages: thinkingMessages,
      isRunning: true,
      activeToolLabel: Option.none()
    })
    const toolMessages = buildAgentChatMessages({
      messages: [
        UserMessage.make({ content: 'latest news?' }),
        assistantMessage({ content: '', toolCalls: [call] })
      ],
      userDraft: '',
      assistantDraft: '',
      reasoningDraft: '',
      toolRuns: [{ _tag: 'Executing', call, startedAtMs: 1000 }],
      error: null
    })
    const toolItems = buildAgentChatItems({
      messages: toolMessages,
      isRunning: true,
      activeToolLabel: Option.some('Running web_search')
    })

    expect(thinkingItems.at(-1)).toEqual({
      _tag: 'AssistantStatus',
      id: 'assistant-status',
      label: 'Thinking'
    })
    expect(toolItems.at(-2)).toEqual({
      _tag: 'ToolRun',
      id: 'message-1-tool-call-call_1',
      messageId: 'message-1-assistant',
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
    const messages = buildAgentChatMessages({
      messages: [
        UserMessage.make({ content: 'summarize https://example.com' }),
        assistantMessage({ content: '', toolCalls: [call] }),
        ToolResultMessage.make({ toolCallId: call.id, content: result.content })
      ],
      userDraft: '',
      assistantDraft: '',
      reasoningDraft: '',
      toolRuns: [{ _tag: 'Completed', call, result, startedAtMs: 1000, endedAtMs: 1800 }],
      error: null
    })
    const items = buildAgentChatItems({ messages, isRunning: true, activeToolLabel: Option.none() })

    expect(items.at(-2)).toEqual({
      _tag: 'ToolRun',
      id: 'message-1-tool-call-call_1',
      messageId: 'message-1-assistant',
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
    const messages = buildAgentChatMessages({
      messages: [
        UserMessage.make({ content: 'latest news?' }),
        assistantMessage({ content: '', toolCalls: [call] }),
        ToolResultMessage.make({ toolCallId: call.id, content: result.content })
      ],
      userDraft: '',
      assistantDraft: 'Here is what I found.',
      reasoningDraft: '',
      toolRuns: [{ _tag: 'Completed', call, result, startedAtMs: 1000, endedAtMs: 1300 }],
      error: null
    })
    const items = buildAgentChatItems({ messages, isRunning: true, activeToolLabel: Option.none() })

    expect(items.map(item => item._tag)).toEqual([
      'UserMessage',
      'AssistantMessage',
      'ToolRun',
      'AssistantDraft',
      'AssistantStatus'
    ])
  })
})
