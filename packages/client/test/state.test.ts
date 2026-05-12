import { describe, expect, it } from '@effect/vitest'
import {
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
  ToolExecutionStarted,
  ToolCall,
  ToolResult,
  ToolResultMessage,
  ToolInputEnd,
  UserMessage,
  zeroAgentUsage
} from '@yolk/protocol'
import { markAgentAborted, markAgentError, reduceAgentEvents, submitAgentUserMessage } from '../src'

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
