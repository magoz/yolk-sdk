import type { AgentEvent, AgentMessage, ToolCall, ToolResult } from '@yolk/protocol'

export type AgentRunStatus = 'idle' | 'running' | 'done' | 'error'

export type AgentClientState = {
  readonly status: AgentRunStatus
  readonly messages: ReadonlyArray<AgentMessage>
  readonly text: string
  readonly activeToolCalls: ReadonlyArray<ToolCall>
  readonly toolResults: ReadonlyArray<ToolResult>
}

export const initialAgentClientState: AgentClientState = {
  status: 'idle',
  messages: [],
  text: '',
  activeToolCalls: [],
  toolResults: []
}

export const applyAgentEvent = (
  state: AgentClientState,
  event: AgentEvent
): AgentClientState => {
  switch (event._tag) {
    case 'AgentStart':
      return { ...state, status: 'running', text: '', activeToolCalls: [], toolResults: [] }
    case 'LLMTextDelta':
      return { ...state, text: `${state.text}${event.text}` }
    case 'LLMToolCall':
      return { ...state, activeToolCalls: [...state.activeToolCalls, event.call] }
    case 'ToolExecutionEnd':
      return {
        ...state,
        activeToolCalls: state.activeToolCalls.filter(call => call.id !== event.call.id),
        toolResults: [...state.toolResults, event.result]
      }
    case 'AgentEnd':
      return { ...state, status: 'done', messages: [...state.messages, ...event.messages] }
    case 'AssistantMessage':
    case 'LLMStreamEnd':
    case 'LLMStreamStart':
    case 'ToolExecutionStart':
    case 'ToolResult':
    case 'TurnEnd':
    case 'TurnStart':
      return state
  }
}

export const markAgentError = (state: AgentClientState): AgentClientState => ({
  ...state,
  status: 'error',
  activeToolCalls: []
})

export const reduceAgentEvents = (events: ReadonlyArray<AgentEvent>) =>
  events.reduce(applyAgentEvent, initialAgentClientState)
