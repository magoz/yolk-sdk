import { describe, expect, it } from '@effect/vitest'
import {
  AgentEnd,
  AgentError,
  AgentStart,
  AssistantAgentMessage,
  LLMReasoningDelta,
  LLMTextDelta,
  LLMToolCall,
  ToolExecutionEnd,
  ToolCall,
  ToolResult,
  UserMessage
} from '@yolk/protocol'
import { markAgentAborted, markAgentError, reduceAgentEvents, submitAgentUserMessage } from '../src'

describe('reduceAgentEvents', () => {
  it('builds client state from streamed events', () => {
    const call = ToolCall.make({ id: 'call_1', name: 'weather', params: {} })
    const result = ToolResult.make({ toolCallId: 'call_1', content: '72F' })
    const message = AssistantAgentMessage.make({ content: 'ok', toolCalls: [] })

    const state = reduceAgentEvents([
      AgentStart.make({}),
      LLMTextDelta.make({ text: 'o' }),
      LLMTextDelta.make({ text: 'k' }),
      LLMToolCall.make({ call }),
      ToolExecutionEnd.make({ call, result }),
      AgentEnd.make({ messages: [message], turns: 1, usage: { input: 0, output: 0 } })
    ])

    expect(state.status).toBe('done')
    expect(state.text).toBe('')
    expect(state.activeToolCalls).toEqual([])
    expect(state.completedToolCalls).toEqual([])
    expect(state.toolResults).toEqual([result])
    expect(state.messages).toEqual([message])
    expect(state.error).toBeNull()
  })

  it('keeps completed tool calls during active runs', () => {
    const call = ToolCall.make({ id: 'call_1', name: 'weather', params: {} })
    const result = ToolResult.make({ toolCallId: 'call_1', content: '72F' })

    const state = reduceAgentEvents([
      AgentStart.make({}),
      LLMToolCall.make({ call }),
      ToolExecutionEnd.make({ call, result })
    ])

    expect(state.activeToolCalls).toEqual([])
    expect(state.completedToolCalls).toEqual([call])
    expect(state.toolResults).toEqual([result])
  })

  it('stores in-band agent errors', () => {
    const state = reduceAgentEvents([
      AgentStart.make({}),
      AgentError.make({ code: 'provider_error', message: 'Provider failed', retryable: true })
    ])

    expect(state).toMatchObject({
      status: 'error',
      activeToolCalls: [],
      completedToolCalls: [],
      error: 'Provider failed'
    })
  })

  it('marks client state as errored', () => {
    const state = reduceAgentEvents([AgentStart.make({})])

    expect(markAgentError(state)).toMatchObject({
      status: 'error',
      activeToolCalls: [],
      completedToolCalls: [],
      error: 'Agent request failed'
    })
  })

  it('adds submitted user messages to the transcript', () => {
    const message = UserMessage.make({ content: 'hello' })
    const state = submitAgentUserMessage(reduceAgentEvents([]), message)

    expect(state).toMatchObject({
      status: 'running',
      messages: [message],
      text: '',
      activeToolCalls: [],
      completedToolCalls: [],
      toolResults: [],
      reasoning: '',
      error: null
    })
  })

  it('stores reasoning while streaming and moves final reasoning into messages', () => {
    const message = AssistantAgentMessage.make({
      content: 'ok',
      toolCalls: [],
      reasoning: 'thinking'
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
      AgentEnd.make({ messages: [message], turns: 1, usage: { input: 0, output: 0 } })
    ])

    expect(done.reasoning).toBe('')
    expect(done.messages).toEqual([message])
  })

  it('marks client state as aborted', () => {
    const state = reduceAgentEvents([AgentStart.make({}), LLMTextDelta.make({ text: 'partial' })])

    expect(markAgentAborted(state)).toMatchObject({
      status: 'aborted',
      text: 'partial',
      activeToolCalls: [],
      completedToolCalls: [],
      error: null
    })
  })
})
