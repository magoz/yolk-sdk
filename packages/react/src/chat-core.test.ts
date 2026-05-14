import { describe, expect, it } from '@effect/vitest'
import {
  AssistantAgentMessage,
  AssistantMessageEvent,
  AssistantTextPart,
  HostToolCallPart,
  LLMReasoningDelta,
  LLMTextDelta,
  ToolCall,
  ToolExecutionCompleted,
  ToolExecutionStarted,
  ToolInputEnd,
  ToolResult,
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
        turnId: 'turn-0',
        sequence: 0,
        role: 'assistant',
        parts: [
          { _tag: 'Text', id: 'message-0-assistant-text', content: 'hello', state: 'streaming' }
        ]
      }
    ])
  })

  it('ignores duplicate events with the same event id', () => {
    const state = [
      LLMTextDelta.make({ eventId: 'workflow:1:0', text: 'hel' }),
      LLMTextDelta.make({ eventId: 'workflow:1:0', text: 'hel' }),
      LLMTextDelta.make({ eventId: 'workflow:1:1', text: 'lo' })
    ].reduce(
      (current, event) => reduceAgentChatState(current, { _tag: 'Event', event }),
      initialAgentChatState
    )

    expect(state.seenEventIds).toEqual(['workflow:1:0', 'workflow:1:1'])
    expect(state.chatMessages[0]?.parts).toEqual([
      { _tag: 'Text', id: 'message-0-assistant-text', content: 'hello', state: 'streaming' }
    ])
  })

  it('streams text after reasoning in the same assistant message', () => {
    const state = [
      LLMReasoningDelta.make({ text: 'Thinking.' }),
      LLMTextDelta.make({ text: 'hel' }),
      LLMTextDelta.make({ text: 'lo' })
    ].reduce(
      (current, event) => reduceAgentChatState(current, { _tag: 'Event', event }),
      initialAgentChatState
    )

    expect(state.chatMessages).toEqual([
      {
        id: 'message-0-assistant',
        turnId: 'turn-0',
        sequence: 0,
        role: 'assistant',
        parts: [
          { _tag: 'Reasoning', id: 'message-0-reasoning', text: 'Thinking.', state: 'streaming' },
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
      ToolInputEnd.make({ call }),
      ToolExecutionCompleted.make({ call, result }),
      AssistantMessageEvent.make({
        message: AssistantAgentMessage.make({
          parts: [AssistantTextPart.make({ content: '' }), HostToolCallPart.make({ call })]
        })
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
    const state = [
      ToolInputEnd.make({ call }),
      ToolExecutionStarted.make({ call }),
      ToolExecutionCompleted.make({ call, result })
    ].reduce(
      (current, event) => reduceAgentChatState(current, { _tag: 'Event', event, nowMs: 123 }),
      initialAgentChatState
    )
    const toolPart = state.chatMessages[0]?.parts.find(part => part._tag === 'ToolCall')

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

    expect(toolPart.state.startedAtMs).toBe(123)
    expect(toolPart.state.endedAtMs).toBe(123)
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
