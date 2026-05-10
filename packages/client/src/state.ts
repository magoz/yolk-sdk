import type { AgentEvent, AgentMessage, ToolCall, ToolResult, UserMessage } from '@yolk/protocol'

export type AgentRunStatus = 'idle' | 'running' | 'done' | 'error' | 'aborted'

export type AgentClientState = {
  readonly status: AgentRunStatus
  readonly messages: ReadonlyArray<AgentMessage>
  readonly text: string
  readonly reasoning: string
  readonly activeToolCalls: ReadonlyArray<ToolCall>
  readonly completedToolCalls: ReadonlyArray<ToolCall>
  readonly toolResults: ReadonlyArray<ToolResult>
  readonly error: string | null
}

export type AgentTranscript = readonly [AgentMessage, ...Array<AgentMessage>]

export const initialAgentClientState: AgentClientState = {
  status: 'idle',
  messages: [],
  text: '',
  reasoning: '',
  activeToolCalls: [],
  completedToolCalls: [],
  toolResults: [],
  error: null
}

export const appendAgentMessage = (
  messages: ReadonlyArray<AgentMessage>,
  message: AgentMessage
): AgentTranscript => {
  const first = messages[0]

  if (first === undefined) {
    return [message]
  }

  return [first, ...messages.slice(1), message]
}

export const applyAgentEvent = (
  state: AgentClientState,
  event: AgentEvent
): AgentClientState => {
  switch (event._tag) {
    case 'AgentStart':
      return {
        ...state,
        status: 'running',
        text: '',
        reasoning: '',
        activeToolCalls: [],
        completedToolCalls: [],
        toolResults: [],
        error: null
      }
    case 'AgentError':
      return markAgentError(state, event.message)
    case 'LLMTextDelta':
      return { ...state, text: `${state.text}${event.text}` }
    case 'LLMReasoningDelta':
      return { ...state, reasoning: `${state.reasoning}${event.text}` }
    case 'LLMToolCall':
      return { ...state, activeToolCalls: [...state.activeToolCalls, event.call] }
    case 'ToolExecutionEnd':
      return {
        ...state,
        activeToolCalls: state.activeToolCalls.filter(call => call.id !== event.call.id),
        completedToolCalls: [...state.completedToolCalls, event.call],
        toolResults: [...state.toolResults, event.result]
      }
    case 'AgentEnd':
      return {
        ...state,
        status: 'done',
        messages: [...state.messages, ...event.messages],
        text: '',
        reasoning: '',
        activeToolCalls: [],
        completedToolCalls: []
      }
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

export const submitAgentUserMessage = (
  state: AgentClientState,
  message: UserMessage
): AgentClientState => ({
  ...state,
  status: 'running',
  messages: appendAgentMessage(state.messages, message),
  text: '',
  reasoning: '',
  activeToolCalls: [],
  completedToolCalls: [],
  toolResults: [],
  error: null
})

export const markAgentError = (
  state: AgentClientState,
  message = 'Agent request failed'
): AgentClientState => ({
  ...state,
  status: 'error',
  activeToolCalls: [],
  completedToolCalls: [],
  error: message
})

export const markAgentAborted = (state: AgentClientState): AgentClientState => ({
  ...state,
  status: 'aborted',
  activeToolCalls: [],
  completedToolCalls: [],
  error: null
})

export const reduceAgentEvents = (
  events: ReadonlyArray<AgentEvent>,
  initialState: AgentClientState = initialAgentClientState
) => events.reduce(applyAgentEvent, initialState)
