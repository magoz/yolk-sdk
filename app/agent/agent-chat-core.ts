import type { AgentEvent, AgentMessage, UserMessage } from '@yolk/protocol'
import {
  appendProtocolMessage,
  applyAgentEventToChatMessages,
  markChatError,
  type AgentChatMessage,
  type AgentChatPart
} from './agent-chat-messages'

export type AgentRunStatus = 'idle' | 'running' | 'done' | 'error' | 'aborted'

export type AgentChatState = {
  readonly status: AgentRunStatus
  readonly error: string | null
  readonly chatMessages: ReadonlyArray<AgentChatMessage>
}

export const initialAgentChatState: AgentChatState = {
  status: 'idle',
  error: null,
  chatMessages: []
}

export type AgentChatAction =
  | { readonly _tag: 'Submit'; readonly message: UserMessage }
  | { readonly _tag: 'AppendMessage'; readonly message: AgentMessage }
  | { readonly _tag: 'Event'; readonly event: AgentEvent }
  | { readonly _tag: 'Error'; readonly message: string }
  | { readonly _tag: 'Abort' }

export const reduceAgentChatState = (
  state: AgentChatState,
  action: AgentChatAction
): AgentChatState => {
  switch (action._tag) {
    case 'Submit':
      return {
        ...state,
        status: 'running',
        error: null,
        chatMessages: appendProtocolMessage(state.chatMessages, action.message)
      }
    case 'AppendMessage':
      return {
        ...state,
        chatMessages: appendProtocolMessage(state.chatMessages, action.message),
        error: null
      }
    case 'Event': {
      switch (action.event._tag) {
        case 'AgentStart':
          return {
            ...state,
            status: 'running',
            error: null,
            chatMessages: applyAgentEventToChatMessages(state.chatMessages, action.event)
          }
        case 'AgentError':
          return {
            ...state,
            status: 'error',
            error: action.event.message,
            chatMessages: applyAgentEventToChatMessages(state.chatMessages, action.event)
          }
        case 'AgentEnd':
          return {
            ...state,
            status: 'done',
            error: null,
            chatMessages: applyAgentEventToChatMessages(state.chatMessages, action.event)
          }
        case 'AssistantMessage':
        case 'LLMReasoningDelta':
        case 'LLMStreamEnd':
        case 'LLMStreamStart':
        case 'LLMTextDelta':
        case 'LLMToolCall':
        case 'ToolExecutionEnd':
        case 'ToolExecutionStart':
        case 'ToolResult':
        case 'TurnEnd':
        case 'TurnStart':
          return {
            ...state,
            chatMessages: applyAgentEventToChatMessages(state.chatMessages, action.event)
          }
      }
    }
    case 'Error': {
      return {
        ...state,
        status: 'error',
        error: action.message,
        chatMessages: markChatError(state.chatMessages, action.message)
      }
    }
    case 'Abort':
      return { ...state, status: 'aborted', error: null }
  }
}

export const hasAgentMessageReasoning = (message: AgentMessage) =>
  message._tag === 'Assistant' && message.reasoning !== undefined && message.reasoning.length > 0

export const hasAgentChatReasoningSummary = (state: AgentChatState) =>
  state.chatMessages.some(message =>
    message.parts.some(part => part._tag === 'Reasoning' && part.text.length > 0)
  )

export const isActiveChatToolPart = (part: AgentChatPart) =>
  part._tag === 'ToolCall' && part.state._tag !== 'Completed'
export type ActiveChatToolPart = Extract<AgentChatPart, { readonly _tag: 'ToolCall' }>

export const isCompletedChatToolPart = (part: AgentChatPart) =>
  part._tag === 'ToolCall' && part.state._tag === 'Completed'
export type CompletedChatToolPart = Extract<AgentChatPart, { readonly _tag: 'ToolCall' }>

export const getActiveChatToolParts = (messages: ReadonlyArray<AgentChatMessage>) =>
  messages.flatMap(message =>
    message.parts.filter((part): part is ActiveChatToolPart => isActiveChatToolPart(part))
  )

export const getCompletedChatToolParts = (messages: ReadonlyArray<AgentChatMessage>) =>
  messages.flatMap(message =>
    message.parts.filter((part): part is CompletedChatToolPart => isCompletedChatToolPart(part))
  )

type AgentChatLiveActivityInput = {
  readonly isTextRunning: boolean
  readonly activeToolCallCount: number
  readonly isVoiceActive: boolean
}

export const getAgentChatLiveActivityCount = ({
  isTextRunning,
  activeToolCallCount,
  isVoiceActive
}: AgentChatLiveActivityInput) =>
  (isTextRunning ? 1 : 0) + activeToolCallCount + (isVoiceActive ? 1 : 0)
