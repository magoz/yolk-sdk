import { describe, expect, it } from '@effect/vitest'
import {
  AgentAwaitingInput,
  AgentEnd,
  AgentError,
  AgentStart,
  AssistantAgentMessage,
  AssistantMessageEvent,
  AssistantReasoningPart,
  AssistantTextPart,
  HostToolCallPart,
  LLMReasoningDelta,
  LLMTextDelta,
  ToolExecutionCompleted,
  ToolExecutionError,
  ToolExecutionStarted,
  ToolCall,
  ProviderToolResult,
  QuestionAnswered,
  QuestionPrompt,
  QuestionRequest,
  QuestionRequested,
  QuestionResponse,
  ToolApprovalDenied,
  ToolApprovalRequested,
  ToolInputDelta,
  ToolResult,
  ToolResultMessage,
  ToolInputEnd,
  ToolInputStart,
  UserMessage,
  zeroAgentUsage
} from '@yolk-sdk/agent/protocol'
import { markAgentAborted, markAgentError, reduceAgentEvents, submitAgentUserMessage } from '../../src/client'

describe('reduceAgentEvents', () => {
  it('builds client state from streamed events', () => {
    const call = ToolCall.make({ id: 'call_1', name: 'weather', params: {} })
    const result = ToolResult.make({ toolCallId: 'call_1', content: '72F' })
    const message = AssistantAgentMessage.make({
      parts: [AssistantTextPart.make({ content: 'ok' }), HostToolCallPart.make({ call })]
    })
    const toolResultMessage = ToolResultMessage.make({
      toolCallId: call.id,
      content: result.content
    })

    const state = reduceAgentEvents(
      [
        AgentStart.make({}),
        LLMTextDelta.make({ text: 'o' }),
        LLMTextDelta.make({ text: 'k' }),
        ToolInputEnd.make({ call }),
        AssistantMessageEvent.make({ message }),
        ToolExecutionStarted.make({ call }),
        ToolExecutionCompleted.make({ call, result }),
        AgentEnd.make({
          messages: [message, toolResultMessage],
          turns: 1,
          usage: zeroAgentUsage
        })
      ],
      undefined,
      { nowMs: 123 }
    )

    expect(state.status).toBe('done')
    expect(state.text).toBe('')
    expect(state.liveMessages).toEqual([])
    expect(state.toolRuns).toEqual([
      expect.objectContaining({ _tag: 'Completed', call, result, startedAtMs: 123, endedAtMs: 123 })
    ])
    expect(state.messages).toEqual([message, toolResultMessage])
    expect(state.error).toBeNull()
  })

  it('keeps tool runs anchored in live messages during active runs', () => {
    const call = ToolCall.make({ id: 'call_1', name: 'weather', params: {} })
    const result = ToolResult.make({ toolCallId: 'call_1', content: '72F' })
    const message = AssistantAgentMessage.make({
      parts: [HostToolCallPart.make({ call })]
    })

    const state = reduceAgentEvents([
      AgentStart.make({}),
      ToolInputEnd.make({ call }),
      AssistantMessageEvent.make({ message }),
      ToolExecutionStarted.make({ call }),
      ToolExecutionCompleted.make({ call, result })
    ])

    expect(state.liveMessages).toEqual([message])
    expect(state.toolRuns).toEqual([expect.objectContaining({ _tag: 'Completed', call, result })])
  })

  it('projects rich tool lifecycle states', () => {
    const call = ToolCall.make({
      id: 'call_1',
      name: 'web_fetch',
      params: { url: 'https://e.com' }
    })
    const result = ToolResult.make({ toolCallId: call.id, content: 'Example Domain' })

    const inputStreaming = reduceAgentEvents([
      AgentStart.make({}),
      ToolInputStart.make({ id: call.id, name: call.name }),
      ToolInputDelta.make({ id: call.id, delta: '{"url"' }),
      ToolInputDelta.make({ id: call.id, delta: ':"https://e.com"}' })
    ])

    expect(inputStreaming.toolRuns).toEqual([
      { _tag: 'InputStreaming', id: call.id, name: call.name, input: '{"url":"https://e.com"}' }
    ])

    const approval = reduceAgentEvents([AgentStart.make({}), ToolApprovalRequested.make({ call })])
    expect(approval.toolRuns).toEqual([{ _tag: 'ApprovalRequested', call }])

    const questionRequest = QuestionRequest.make({
      requestId: 'question:call_1',
      toolCallId: call.id,
      call,
      questions: [QuestionPrompt.make({ id: 'choice', prompt: 'Pick one' })]
    })
    const question = reduceAgentEvents([
      AgentStart.make({}),
      QuestionRequested.make({ request: questionRequest })
    ])
    expect(question.toolRuns).toEqual([{ _tag: 'QuestionRequested', request: questionRequest }])

    const questionResponse = QuestionResponse.make({
      requestId: questionRequest.requestId,
      toolCallId: call.id,
      outcome: 'answered',
      source: 'user'
    })
    const answeredQuestion = reduceAgentEvents([
      AgentStart.make({}),
      QuestionRequested.make({ request: questionRequest }),
      QuestionAnswered.make({ response: questionResponse })
    ])
    expect(answeredQuestion.toolRuns).toEqual([
      { _tag: 'QuestionAnswered', response: questionResponse, request: questionRequest }
    ])

    const denied = reduceAgentEvents([
      AgentStart.make({}),
      ToolApprovalRequested.make({ call }),
      ToolApprovalDenied.make({ toolCallId: call.id, reason: 'policy' })
    ])
    expect(denied.toolRuns).toEqual([{ _tag: 'Denied', toolCallId: call.id, reason: 'policy' }])

    const errored = reduceAgentEvents(
      [
        AgentStart.make({}),
        ToolExecutionError.make({ call, message: 'safe failure', code: 'tool_error' })
      ],
      undefined,
      { nowMs: 42 }
    )
    expect(errored.toolRuns).toEqual([
      { _tag: 'Errored', call, message: 'safe failure', endedAtMs: 42 }
    ])

    const providerCompleted = reduceAgentEvents([
      AgentStart.make({}),
      ProviderToolResult.make({ call, result })
    ])
    expect(providerCompleted.toolRuns).toEqual([{ _tag: 'ProviderCompleted', call, result }])
  })

  it('marks client state waiting on HITL input', () => {
    const call = ToolCall.make({ id: 'call_1', name: 'question', params: {} })
    const request = QuestionRequest.make({
      requestId: 'question:call_1',
      toolCallId: call.id,
      call,
      questions: [QuestionPrompt.make({ id: 'choice', prompt: 'Pick one' })]
    })
    const message = AssistantAgentMessage.make({ parts: [HostToolCallPart.make({ call })] })
    const state = reduceAgentEvents([
      AgentStart.make({}),
      AgentAwaitingInput.make({ requests: [request], messages: [message], turns: 1, usage: zeroAgentUsage })
    ])

    expect(state.status).toBe('waiting')
    expect(state.messages).toEqual([message])
  })

  it('stores in-band agent errors', () => {
    const state = reduceAgentEvents([
      AgentStart.make({}),
      AgentError.make({ code: 'provider_error', message: 'Provider failed', retryable: true })
    ])

    expect(state).toMatchObject({
      status: 'error',
      toolRuns: [],
      error: 'Provider failed'
    })
  })

  it('ignores duplicate events with the same event id', () => {
    const state = reduceAgentEvents([
      AgentStart.make({ eventId: 'workflow:1:0' }),
      LLMTextDelta.make({ eventId: 'workflow:1:1', text: 'hel' }),
      LLMTextDelta.make({ eventId: 'workflow:1:1', text: 'hel' }),
      LLMTextDelta.make({ eventId: 'workflow:1:2', text: 'lo' })
    ])

    expect(state.text).toBe('hello')
    expect(state.seenEventIds).toEqual(['workflow:1:0', 'workflow:1:1', 'workflow:1:2'])
  })

  it('allows duplicate events without event ids', () => {
    const state = reduceAgentEvents([
      AgentStart.make({}),
      LLMTextDelta.make({ text: 'ha' }),
      LLMTextDelta.make({ text: 'ha' })
    ])

    expect(state.text).toBe('haha')
    expect(state.seenEventIds).toEqual([])
  })

  it('marks client state as errored', () => {
    const state = reduceAgentEvents([AgentStart.make({})])

    expect(markAgentError(state)).toMatchObject({
      status: 'error',
      toolRuns: [],
      error: 'Agent request failed'
    })
  })

  it('adds submitted user messages to the transcript', () => {
    const message = UserMessage.make({ content: 'hello' })
    const state = submitAgentUserMessage(reduceAgentEvents([]), message)

    expect(state).toMatchObject({
      status: 'running',
      messages: [message],
      liveMessages: [],
      text: '',
      toolRuns: [],
      reasoning: '',
      error: null
    })
  })

  it('stores reasoning while streaming and moves final reasoning into messages', () => {
    const message = AssistantAgentMessage.make({
      parts: [
        AssistantReasoningPart.make({ text: 'thinking' }),
        AssistantTextPart.make({ content: 'ok' })
      ]
    })

    const streaming = reduceAgentEvents([
      AgentStart.make({}),
      LLMReasoningDelta.make({ text: 'think' }),
      LLMReasoningDelta.make({ text: 'ing' })
    ])

    expect(streaming.reasoning).toBe('thinking')

    const done = reduceAgentEvents([
      AgentStart.make({}),
      LLMReasoningDelta.make({ text: 'thinking' }),
      AgentEnd.make({ messages: [message], turns: 1, usage: zeroAgentUsage })
    ])

    expect(done.reasoning).toBe('')
    expect(done.messages).toEqual([message])
  })

  it('marks client state as aborted', () => {
    const state = reduceAgentEvents([AgentStart.make({}), LLMTextDelta.make({ text: 'partial' })])

    expect(markAgentAborted(state)).toMatchObject({
      status: 'aborted',
      text: 'partial',
      toolRuns: [],
      error: null
    })
  })
})
