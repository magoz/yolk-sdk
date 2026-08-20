import {
  hitlResponseEvent,
  type AgentError,
  type AgentEvent,
  type AgentMessage,
  type AgentRetry,
  type Content,
  type HitlResponse,
  type UserMessage
} from '@yolk-sdk/agent/protocol'
import {
  appendProtocolMessage,
  applyAgentEventToChatMessages,
  deleteChatTurn,
  editChatUserMessage,
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
  UserMessageEdited,
  UserMessageSubmitted,
  type AgentChatSessionEvent
} from './chat-session-events.ts'

export type AgentRunStatus = 'idle' | 'running' | 'waiting' | 'done' | 'error' | 'aborted'

export type AgentChatState = {
  readonly status: AgentRunStatus
  readonly error: string | null
  readonly errorInfo: AgentError | null
  readonly retryInfo: AgentRetry | null
  readonly chatMessages: ReadonlyArray<AgentChatMessage>
  readonly sessionEvents: ReadonlyArray<AgentChatSessionEvent>
  readonly seenEventIds: ReadonlyArray<string>
}

export type AgentChatEventProjectionState = {
  readonly chatMessages: ReadonlyArray<AgentChatMessage>
  readonly seenEventIds: ReadonlyArray<string>
}

export const initialAgentChatState: AgentChatState = {
  status: 'idle',
  error: null,
  errorInfo: null,
  retryInfo: null,
  chatMessages: [],
  sessionEvents: [],
  seenEventIds: []
}

const hasSeenEventId = (seenEventIds: ReadonlyArray<string>, event: AgentEvent) =>
  event.eventId !== undefined && seenEventIds.includes(event.eventId)

const rememberEventId = (seenEventIds: ReadonlyArray<string>, event: AgentEvent) =>
  event.eventId === undefined ? seenEventIds : [...seenEventIds, event.eventId]

const hasSeenEvent = (state: AgentChatState, event: AgentEvent) =>
  hasSeenEventId(state.seenEventIds, event)

const rememberEvent = (state: AgentChatState, event: AgentEvent): AgentChatState =>
  event.eventId === undefined
    ? state
    : { ...state, seenEventIds: rememberEventId(state.seenEventIds, event) }

const clearRetryInfo = (state: AgentChatState): AgentChatState =>
  state.retryInfo === null ? state : { ...state, retryInfo: null }

export const makeAgentChatEventProjectionState = (
  chatMessages: ReadonlyArray<AgentChatMessage> = []
): AgentChatEventProjectionState => ({
  chatMessages,
  seenEventIds: []
})

/**
 * Applies replayable agent events to chat messages while deduping by `eventId`.
 *
 * Use this for durable streams that may reconnect, overlap, or replay events.
 * For ephemeral local streams, `applyAgentEventToChatMessages` is still useful.
 */
export const applyAgentEventToChatProjection = (
  state: AgentChatEventProjectionState,
  event: AgentEvent,
  options: ApplyAgentEventToChatMessagesOptions = {}
): AgentChatEventProjectionState => {
  if (hasSeenEventId(state.seenEventIds, event)) {
    return state
  }

  return {
    chatMessages: applyAgentEventToChatMessages(state.chatMessages, event, options),
    seenEventIds: rememberEventId(state.seenEventIds, event)
  }
}

export type AgentChatAction =
  | { readonly _tag: 'HydrateMessage'; readonly message: AgentMessage }
  | { readonly _tag: 'Submit'; readonly message: UserMessage }
  | { readonly _tag: 'AppendMessage'; readonly message: AgentMessage }
  | { readonly _tag: 'SubmitHitlResponse'; readonly response: HitlResponse }
  | { readonly _tag: 'DeleteTurn'; readonly messageId: string }
  | { readonly _tag: 'RegenerateFrom'; readonly messageId: string }
  | { readonly _tag: 'EditUserMessage'; readonly messageId: string; readonly content: Content }
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
        error: null,
        errorInfo: null,
        retryInfo: null
      }
    case 'Submit':
      return {
        ...state,
        status: 'running',
        error: null,
        errorInfo: null,
        retryInfo: null,
        seenEventIds: [],
        chatMessages: appendProtocolMessage(state.chatMessages, action.message),
        sessionEvents: [
          ...state.sessionEvents,
          UserMessageSubmitted.make({ message: action.message })
        ]
      }
    case 'AppendMessage':
      return {
        ...state,
        chatMessages: appendProtocolMessage(state.chatMessages, action.message),
        error: null,
        errorInfo: null,
        retryInfo: null,
        sessionEvents: [
          ...state.sessionEvents,
          ProtocolMessageAppended.make({ message: action.message })
        ]
      }
    case 'SubmitHitlResponse':
      return {
        ...state,
        status: 'running',
        error: null,
        errorInfo: null,
        retryInfo: null,
        seenEventIds: [],
        chatMessages: applyAgentEventToChatMessages(
          state.chatMessages,
          hitlResponseEvent(action.response)
        )
      }
    case 'DeleteTurn': {
      const next = deleteChatTurn(state.chatMessages, action.messageId)

      if (next._tag === 'NotFound') {
        return state
      }

      return {
        ...state,
        error: null,
        errorInfo: null,
        retryInfo: null,
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
        errorInfo: null,
        retryInfo: null,
        seenEventIds: [],
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
    case 'EditUserMessage': {
      const next = editChatUserMessage(state.chatMessages, action.messageId, action.content)

      if (next._tag !== 'Edited') {
        return state
      }

      return {
        ...state,
        status: 'running',
        error: null,
        errorInfo: null,
        retryInfo: null,
        seenEventIds: [],
        chatMessages: next.messages,
        sessionEvents: [
          ...state.sessionEvents,
          UserMessageEdited.make({
            messageId: next.messageId,
            content: action.content,
            keptMessageIds: next.messages.map(message => message.id)
          })
        ]
      }
    }
    case 'Event': {
      if (hasSeenEvent(state, action.event)) {
        return state
      }

      switch (action.event._tag) {
        case 'AgentStart':
          return rememberEvent(
            {
              ...state,
              status: 'running',
              error: null,
              errorInfo: null,
              retryInfo: null,
              chatMessages: applyAgentEventToChatMessages(state.chatMessages, action.event, action)
            },
            action.event
          )
        case 'AgentError':
          return rememberEvent(
            {
              ...state,
              status: 'error',
              error: action.event.message,
              errorInfo: action.event,
              retryInfo: null,
              chatMessages: applyAgentEventToChatMessages(state.chatMessages, action.event, action)
            },
            action.event
          )
        case 'AgentEnd':
          return rememberEvent(
            {
              ...state,
              status: 'done',
              error: null,
              errorInfo: null,
              retryInfo: null,
              chatMessages: applyAgentEventToChatMessages(state.chatMessages, action.event, action)
            },
            action.event
          )
        case 'AgentAwaitingInput':
          return rememberEvent(
            {
              ...state,
              status: 'waiting',
              error: null,
              errorInfo: null,
              retryInfo: null,
              chatMessages: applyAgentEventToChatMessages(state.chatMessages, action.event, action)
            },
            action.event
          )
        case 'AgentRetry':
          return rememberEvent(
            {
              ...state,
              retryInfo: action.event,
              chatMessages: applyAgentEventToChatMessages(state.chatMessages, action.event, action)
            },
            action.event
          )
        case 'CompactionEnd':
        case 'AssistantMessage':
        case 'CompactionStart':
        case 'LLMReasoningDelta':
        case 'LLMStreamEnd':
        case 'LLMStreamStart':
        case 'LLMTextDelta':
        case 'ProviderToolResult':
        case 'QuestionAnswered':
        case 'QuestionCancelled':
        case 'QuestionRequested':
        case 'SubagentCompleted':
        case 'SubagentStarted':
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
        case 'UserMessage':
          return rememberEvent(
            clearRetryInfo({
              ...state,
              chatMessages: applyAgentEventToChatMessages(state.chatMessages, action.event, action)
            }),
            action.event
          )
      }
    }
    case 'Error': {
      return {
        ...state,
        status: 'error',
        error: action.message,
        errorInfo: null,
        retryInfo: null,
        chatMessages: markChatError(state.chatMessages, action.message)
      }
    }
    case 'Abort':
      return { ...state, status: 'aborted', error: null, errorInfo: null, retryInfo: null }
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
  part.state._tag !== 'QuestionAnswered' &&
  part.state._tag !== 'QuestionCancelled' &&
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
