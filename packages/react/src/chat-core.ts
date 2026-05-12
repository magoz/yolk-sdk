import type { AgentEvent, AgentMessage, UserMessage } from '@yolk/protocol'
import {
  appendProtocolMessage,
  applyAgentEventToChatMessages,
  deleteChatTurn,
  markChatError,
  regenerateChatMessagesFrom,
  type AgentChatMessage,
  type AgentChatPart,
  type ApplyAgentEventToChatMessagesOptions
} from './chat-messages.ts'
import {
  MessagesRegenerated,
  ProtocolMessageAppended,
  TurnDeleted,
  UserMessageSubmitted,
  type AgentChatSessionEvent
} from './chat-session-events.ts'

export type AgentRunStatus = 'idle' | 'running' | 'done' | 'error' | 'aborted'

export type AgentChatState = {
  readonly status: AgentRunStatus
  readonly error: string | null
  readonly chatMessages: ReadonlyArray<AgentChatMessage>
  readonly sessionEvents: ReadonlyArray<AgentChatSessionEvent>
}

export const initialAgentChatState: AgentChatState = {
  status: 'idle',
  error: null,
  chatMessages: [],
  sessionEvents: []
}

export type AgentChatAction =
  | { readonly _tag: 'HydrateMessage'; readonly message: AgentMessage }
  | { readonly _tag: 'Submit'; readonly message: UserMessage }
  | { readonly _tag: 'AppendMessage'; readonly message: AgentMessage }
  | { readonly _tag: 'DeleteTurn'; readonly messageId: string }
  | { readonly _tag: 'RegenerateFrom'; readonly messageId: string }
  | ({ readonly _tag: 'Event'; readonly event: AgentEvent } & ApplyAgentEventToChatMessagesOptions)
  | { readonly _tag: 'Error'; readonly message: string }
  | { readonly _tag: 'Abort' }

export const reduceAgentChatState = (
  state: AgentChatState,
  action: AgentChatAction
): AgentChatState => {
  switch (action._tag) {
    case 'HydrateMessage':
      return {
        ...state,
        chatMessages: appendProtocolMessage(state.chatMessages, action.message),
        error: null
      }
    case 'Submit':
      return {
        ...state,
        status: 'running',
        error: null,
        chatMessages: appendProtocolMessage(state.chatMessages, action.message),
        sessionEvents: [...state.sessionEvents, UserMessageSubmitted.make({ message: action.message })]
      }
    case 'AppendMessage':
      return {
        ...state,
        chatMessages: appendProtocolMessage(state.chatMessages, action.message),
        error: null,
        sessionEvents: [
          ...state.sessionEvents,
          ProtocolMessageAppended.make({ message: action.message })
        ]
      }
    case 'DeleteTurn': {
      const next = deleteChatTurn(state.chatMessages, action.messageId)

      if (next._tag === 'NotFound') {
        return state
      }

      return {
        ...state,
        error: null,
        chatMessages: next.messages,
        sessionEvents: [
          ...state.sessionEvents,
          TurnDeleted.make({
            turnStartMessageId: next.turnStartMessageId,
            deletedMessageIds: next.deletedMessageIds
          })
        ]
      }
    }
    case 'RegenerateFrom': {
      const next = regenerateChatMessagesFrom(state.chatMessages, action.messageId)

      if (next._tag === 'NotFound') {
        return state
      }

      return {
        ...state,
        status: 'running',
        error: null,
        chatMessages: next.messages,
        sessionEvents: [
          ...state.sessionEvents,
          MessagesRegenerated.make({
            fromMessageId: action.messageId,
            keptMessageIds: next.messages.map(message => message.id)
          })
        ]
      }
    }
    case 'Event': {
      switch (action.event._tag) {
        case 'AgentStart':
          return {
            ...state,
            status: 'running',
            error: null,
            chatMessages: applyAgentEventToChatMessages(state.chatMessages, action.event, action)
          }
        case 'AgentError':
          return {
            ...state,
            status: 'error',
            error: action.event.message,
            chatMessages: applyAgentEventToChatMessages(state.chatMessages, action.event, action)
          }
        case 'AgentEnd':
          return {
            ...state,
            status: 'done',
            error: null,
            chatMessages: applyAgentEventToChatMessages(state.chatMessages, action.event, action)
          }
        case 'AssistantMessage':
        case 'AgentRetry':
        case 'CompactionEnd':
        case 'CompactionStart':
        case 'LLMReasoningDelta':
        case 'LLMStreamEnd':
        case 'LLMStreamStart':
        case 'LLMTextDelta':
        case 'ProviderToolResult':
        case 'ToolApprovalDenied':
        case 'ToolApprovalGranted':
        case 'ToolApprovalRequested':
        case 'ToolExecutionCompleted':
        case 'ToolExecutionError':
        case 'ToolExecutionStarted':
        case 'ToolInputDelta':
        case 'ToolInputEnd':
        case 'ToolInputStart':
        case 'TurnEnd':
        case 'TurnStart':
        case 'UsageUpdate':
          return {
            ...state,
            chatMessages: applyAgentEventToChatMessages(state.chatMessages, action.event, action)
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
  message._tag === 'Assistant' &&
  message.parts.some(part => part._tag === 'Reasoning' && part.text.length > 0)

export const hasAgentChatReasoningSummary = (state: AgentChatState) =>
  state.chatMessages.some(message =>
    message.parts.some(part => part._tag === 'Reasoning' && part.text.length > 0)
  )

export const isActiveChatToolPart = (part: AgentChatPart) =>
  part._tag === 'ToolCall' &&
  part.state._tag !== 'Completed' &&
  part.state._tag !== 'ProviderCompleted' &&
  part.state._tag !== 'Errored' &&
  part.state._tag !== 'Denied'
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
