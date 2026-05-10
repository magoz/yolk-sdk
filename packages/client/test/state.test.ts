import { describe, expect, it } from '@effect/vitest'
import {
  AgentEnd,
  AgentError,
  AgentStart,
  AssistantAgentMessage,
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
    expect(state.toolResults).toEqual([result])
    expect(state.messages).toEqual([message])
    expect(state.error).toBeNull()
  })

  it('stores in-band agent errors', () => {
    const state = reduceAgentEvents([
      AgentStart.make({}),
      AgentError.make({ code: 'provider_error', message: 'Provider failed', retryable: true })
    ])

    expect(state).toMatchObject({
      status: 'error',
      activeToolCalls: [],
      error: 'Provider failed'
    })
  })

  it('marks client state as errored', () => {
    const state = reduceAgentEvents([AgentStart.make({})])

    expect(markAgentError(state)).toMatchObject({
      status: 'error',
      activeToolCalls: [],
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
      toolResults: [],
      error: null
    })
  })

  it('marks client state as aborted', () => {
    const state = reduceAgentEvents([AgentStart.make({}), LLMTextDelta.make({ text: 'partial' })])

    expect(markAgentAborted(state)).toMatchObject({
      status: 'aborted',
      text: 'partial',
      activeToolCalls: [],
      error: null
    })
  })
})
