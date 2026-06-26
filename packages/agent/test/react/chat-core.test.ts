import { describe, expect, it } from '@effect/vitest'
import {
  AgentError,
  AgentRetry,
  AssistantAgentMessage,
  AssistantMessageEvent,
  AssistantTextPart,
  HostToolCallPart,
  LLMReasoningDelta,
  LLMTextDelta,
  ProviderErrorInfo,
  QuestionAnswer,
  QuestionPrompt,
  QuestionRequest,
  QuestionResponse,
  QuestionRequested,
  ToolCall,
  ToolExecutionCompleted,
  ToolExecutionStarted,
  ToolInputEnd,
  ToolResult,
  UserMessage
} from '@yolk-sdk/agent/protocol'
import {
  applyAgentEventToChatProjection,
  getAgentChatLiveActivityCount,
  hasAgentChatReasoningSummary,
  initialAgentChatState,
  makeAgentChatEventProjectionState,
  reduceAgentChatState
} from '../../src/react/chat-core.ts'

describe('agent chat core', () => {
  it('submits user messages through the headless reducer', () => {
    const message = UserMessage.make({ content: 'hello' })
    const state = reduceAgentChatState(initialAgentChatState, { _tag: 'Submit', message })

    expect(state.status).toBe('running')
    expect(state.chatMessages.map(chatMessage => chatMessage.role)).toEqual(['user'])
    expect(state.error).toBeNull()
  })

  it('stores typed retry and error events on chat state', () => {
    const provider = ProviderErrorInfo.make({
      provider: 'anthropic',
      kind: 'overloaded',
      status: 529
    })
    const retry = AgentRetry.make({
      attempt: 1,
      reason: 'overloaded',
      delayMs: 2000,
      message: 'overloaded',
      provider
    })
    const error = AgentError.make({
      code: 'overloaded',
      message: 'provider overloaded',
      retryable: true,
      provider
    })
    const retrying = reduceAgentChatState(initialAgentChatState, {
      _tag: 'Event',
      event: retry
    })
    const failed = reduceAgentChatState(retrying, { _tag: 'Event', event: error })

    expect(retrying.retryInfo).toBe(retry)
    expect(failed).toMatchObject({
      status: 'error',
      error: 'provider overloaded',
      errorInfo: error,
      retryInfo: null
    })
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

  it('dedupes text deltas in replay-safe chat projection state', () => {
    const state = [
      LLMTextDelta.make({ eventId: 'workflow:1:0', text: 'hel' }),
      LLMTextDelta.make({ eventId: 'workflow:1:0', text: 'hel' }),
      LLMTextDelta.make({ eventId: 'workflow:1:1', text: 'lo' })
    ].reduce(
      (current, event) => applyAgentEventToChatProjection(current, event),
      makeAgentChatEventProjectionState()
    )

    expect(state.seenEventIds).toEqual(['workflow:1:0', 'workflow:1:1'])
    expect(state.chatMessages[0]?.parts).toEqual([
      { _tag: 'Text', id: 'message-0-assistant-text', content: 'hello', state: 'streaming' }
    ])
  })

  it('dedupes reasoning deltas in replay-safe chat projection state', () => {
    const state = [
      LLMReasoningDelta.make({ eventId: 'workflow:1:0', text: 'Think.' }),
      LLMReasoningDelta.make({ eventId: 'workflow:1:0', text: 'Think.' }),
      LLMReasoningDelta.make({ eventId: 'workflow:1:1', text: ' Done.' })
    ].reduce(
      (current, event) => applyAgentEventToChatProjection(current, event),
      makeAgentChatEventProjectionState()
    )

    expect(state.seenEventIds).toEqual(['workflow:1:0', 'workflow:1:1'])
    expect(state.chatMessages[0]?.parts).toEqual([
      {
        _tag: 'Reasoning',
        id: 'message-0-reasoning',
        text: 'Think. Done.',
        state: 'streaming'
      }
    ])
  })

  it('uses text snapshots when projecting replayed durable deltas', () => {
    const state = [
      LLMTextDelta.make({ eventId: 'workflow:1:0', text: 'hel', textSoFar: 'hel' }),
      LLMTextDelta.make({ eventId: 'workflow:1:1', text: 'hel', textSoFar: 'hel' }),
      LLMTextDelta.make({ eventId: 'workflow:1:2', text: 'lo', textSoFar: 'hello' })
    ].reduce(
      (current, event) => applyAgentEventToChatProjection(current, event),
      makeAgentChatEventProjectionState()
    )

    expect(state.chatMessages[0]?.parts).toEqual([
      { _tag: 'Text', id: 'message-0-assistant-text', content: 'hello', state: 'streaming' }
    ])
  })

  it('uses reasoning snapshots when projecting replayed durable deltas', () => {
    const state = [
      LLMReasoningDelta.make({ eventId: 'workflow:1:0', text: 'Think', reasoningSoFar: 'Think' }),
      LLMReasoningDelta.make({ eventId: 'workflow:1:1', text: 'Think', reasoningSoFar: 'Think' }),
      LLMReasoningDelta.make({
        eventId: 'workflow:1:2',
        text: ' done',
        reasoningSoFar: 'Think done'
      })
    ].reduce(
      (current, event) => applyAgentEventToChatProjection(current, event),
      makeAgentChatEventProjectionState()
    )

    expect(state.chatMessages[0]?.parts).toEqual([
      {
        _tag: 'Reasoning',
        id: 'message-0-reasoning',
        text: 'Think done',
        state: 'streaming'
      }
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

  it('optimistically applies HITL responses', () => {
    const call = ToolCall.make({ id: 'call_question', name: 'question', params: {} })
    const request = QuestionRequest.make({
      requestId: 'question:call_question',
      toolCallId: call.id,
      call,
      questions: [QuestionPrompt.make({ id: 'choice', prompt: 'Pick one' })]
    })
    const response = QuestionResponse.make({
      requestId: request.requestId,
      toolCallId: call.id,
      outcome: 'answered',
      source: 'user',
      answers: [QuestionAnswer.make({ questionId: 'choice', customAnswer: 'A' })]
    })
    const waiting = reduceAgentChatState(initialAgentChatState, {
      _tag: 'Event',
      event: QuestionRequested.make({ request })
    })
    const submitted = reduceAgentChatState(waiting, {
      _tag: 'SubmitHitlResponse',
      response
    })

    expect(submitted.status).toBe('running')
    expect(submitted.chatMessages[0]?.parts[0]).toEqual({
      _tag: 'ToolCall',
      id: 'tool-call-call_question',
      call,
      state: { _tag: 'QuestionAnswered', response, request }
    })
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
