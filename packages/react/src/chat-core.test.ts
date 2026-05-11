import { describe, expect, it } from '@effect/vitest'
import {
  AssistantAgentMessage,
  AssistantMessageEvent,
  LLMReasoningDelta,
  LLMTextDelta,
  LLMToolCall,
  ToolCall,
  ToolExecutionEnd,
  ToolExecutionStart,
  ToolResult,
  ToolResultEvent,
  UserMessage
} from '@yolk/protocol'
import {
  getAgentChatLiveActivityCount,
  hasAgentChatReasoningSummary,
  initialAgentChatState,
  reduceAgentChatState
} from './chat-core'

describe('agent chat core', () => {
  it('submits user messages through the headless reducer', () => {
    const message = UserMessage.make({ content: 'hello' })
    const state = reduceAgentChatState(initialAgentChatState, { _tag: 'Submit', message })

    expect(state.status).toBe('running')
    expect(state.chatMessages.map(chatMessage => chatMessage.role)).toEqual(['user'])
    expect(state.error).toBeNull()
  })

  it('detects streaming reasoning summaries', () => {
    const state = reduceAgentChatState(initialAgentChatState, {
      _tag: 'Event',
      event: LLMReasoningDelta.make({ text: 'Need a tool.' })
    })

    expect(hasAgentChatReasoningSummary(state)).toBe(true)
  })

  it('applies text stream events directly to chat parts', () => {
    const state = [LLMTextDelta.make({ text: 'hel' }), LLMTextDelta.make({ text: 'lo' })].reduce(
      (current, event) => reduceAgentChatState(current, { _tag: 'Event', event }),
      initialAgentChatState
    )

    expect(state.chatMessages).toEqual([
      {
        id: 'message-0-assistant',
        role: 'assistant',
        parts: [
          { _tag: 'Text', id: 'message-0-assistant-text', content: 'hello', state: 'streaming' }
        ]
      }
    ])
  })

  it('merges final assistant messages with existing streamed tool state', () => {
    const call = ToolCall.make({
      id: 'call_1',
      name: 'web_fetch',
      params: { url: 'https://example.com' }
    })
    const result = ToolResult.make({ toolCallId: call.id, content: 'Example Domain' })
    const state = [
      LLMToolCall.make({ call }),
      ToolExecutionEnd.make({ call, result }),
      AssistantMessageEvent.make({
        message: AssistantAgentMessage.make({ content: '', toolCalls: [call] })
      })
    ].reduce(
      (current, event) => reduceAgentChatState(current, { _tag: 'Event', event }),
      initialAgentChatState
    )

    expect(state.chatMessages[0]?.parts.at(-1)).toEqual({
      _tag: 'ToolCall',
      id: 'message-0-tool-call-call_1',
      call,
      state: expect.objectContaining({ _tag: 'Completed', result })
    })
  })

  it('preserves tool execution timing when result event follows completion', () => {
    const call = ToolCall.make({
      id: 'call_1',
      name: 'web_fetch',
      params: { url: 'https://example.com' }
    })
    const result = ToolResult.make({ toolCallId: call.id, content: 'Example Domain' })
    const startedAt = Date.now()
    const state = [
      LLMToolCall.make({ call }),
      ToolExecutionStart.make({ call }),
      ToolExecutionEnd.make({ call, result })
    ].reduce(
      (current, event) => reduceAgentChatState(current, { _tag: 'Event', event }),
      initialAgentChatState
    )
    const afterResult = reduceAgentChatState(state, {
      _tag: 'Event',
      event: ToolResultEvent.make({ result })
    })
    const toolPart = afterResult.chatMessages[0]?.parts.find(part => part._tag === 'ToolCall')

    expect(toolPart).toMatchObject({
      _tag: 'ToolCall',
      state: {
        _tag: 'Completed',
        result
      }
    })

    if (toolPart?._tag !== 'ToolCall' || toolPart.state._tag !== 'Completed') {
      throw new Error('Expected completed tool call part')
    }

    expect(toolPart.state.startedAtMs).toBeGreaterThanOrEqual(startedAt)
    expect(toolPart.state.endedAtMs).toBeGreaterThanOrEqual(startedAt)
  })

  it('counts active text, tool, and voice work', () => {
    expect(
      getAgentChatLiveActivityCount({
        isTextRunning: true,
        activeToolCallCount: 2,
        isVoiceActive: true
      })
    ).toBe(4)
  })
})
