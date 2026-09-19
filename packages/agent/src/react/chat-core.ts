import { Match, Predicate } from 'effect'
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
): AgentChatState =>
  Match.value(action).pipe(
    Match.withReturnType<AgentChatState>(),
    Match.tag('HydrateMessage', current => ({
      ...state,
      chatMessages: appendProtocolMessage(state.chatMessages, current.message),
      error: null,
      errorInfo: null,
      retryInfo: null
    })),
    Match.tag('Submit', current => ({
      ...state,
      status: 'running',
      error: null,
      errorInfo: null,
      retryInfo: null,
      seenEventIds: [],
      chatMessages: appendProtocolMessage(state.chatMessages, current.message),
      sessionEvents: [
        ...state.sessionEvents,
        UserMessageSubmitted.make({ message: current.message })
      ]
    })),
    Match.tag('AppendMessage', current => ({
      ...state,
      chatMessages: appendProtocolMessage(state.chatMessages, current.message),
      error: null,
      errorInfo: null,
      retryInfo: null,
      sessionEvents: [
        ...state.sessionEvents,
        ProtocolMessageAppended.make({ message: current.message })
      ]
    })),
    Match.tag('SubmitHitlResponse', current => ({
      ...state,
      status: 'running',
      error: null,
      errorInfo: null,
      retryInfo: null,
      seenEventIds: [],
      // User data is not a validated tool result until the server accepts it. Keep the
      // form mounted while submitting and never replay an optimistic invalid payload.
      chatMessages:
        Predicate.isTagged(current.response, 'InputResponse') ||
        Predicate.isTagged(current.response, 'InteractionResponse')
          ? state.chatMessages
          : applyAgentEventToChatMessages(state.chatMessages, hitlResponseEvent(current.response))
    })),
    Match.tag('DeleteTurn', current =>
      Match.value(deleteChatTurn(state.chatMessages, current.messageId)).pipe(
        Match.withReturnType<AgentChatState>(),
        Match.tag('NotFound', () => state),
        Match.tag('Deleted', next => ({
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
        })),
        Match.exhaustive
      )
    ),
    Match.tag('RegenerateFrom', current =>
      Match.value(regenerateChatMessagesFrom(state.chatMessages, current.messageId)).pipe(
        Match.withReturnType<AgentChatState>(),
        Match.tag('NotFound', () => state),
        Match.tag('Regenerated', next => ({
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
              fromMessageId: current.messageId,
              keptMessageIds: next.messages.map(message => message.id)
            })
          ]
        })),
        Match.exhaustive
      )
    ),
    Match.tag('EditUserMessage', current =>
      Match.value(editChatUserMessage(state.chatMessages, current.messageId, current.content)).pipe(
        Match.withReturnType<AgentChatState>(),
        Match.tag('NotFound', 'NotUserMessage', () => state),
        Match.tag('Edited', next => ({
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
              content: current.content,
              keptMessageIds: next.messages.map(message => message.id)
            })
          ]
        })),
        Match.exhaustive
      )
    ),
    Match.tag('Event', current => {
      if (hasSeenEvent(state, current.event)) {
        return state
      }

      return Match.value(current.event).pipe(
        Match.withReturnType<AgentChatState>(),
        Match.tag('AgentStart', event =>
          rememberEvent(
            {
              ...state,
              status: 'running',
              error: null,
              errorInfo: null,
              retryInfo: null,
              chatMessages: applyAgentEventToChatMessages(state.chatMessages, event, current)
            },
            event
          )
        ),
        Match.tag('AgentError', event =>
          rememberEvent(
            {
              ...state,
              status: 'error',
              error: event.message,
              errorInfo: event,
              retryInfo: null,
              chatMessages: applyAgentEventToChatMessages(state.chatMessages, event, current)
            },
            event
          )
        ),
        Match.tag('AgentEnd', event =>
          rememberEvent(
            {
              ...state,
              status: 'done',
              error: null,
              errorInfo: null,
              retryInfo: null,
              chatMessages: applyAgentEventToChatMessages(state.chatMessages, event, current)
            },
            event
          )
        ),
        Match.tag('AgentAwaitingInput', event =>
          rememberEvent(
            {
              ...state,
              status: 'waiting',
              error: null,
              errorInfo: null,
              retryInfo: null,
              chatMessages: applyAgentEventToChatMessages(state.chatMessages, event, current)
            },
            event
          )
        ),
        Match.tag('AgentRetry', event =>
          rememberEvent(
            {
              ...state,
              retryInfo: event,
              chatMessages: applyAgentEventToChatMessages(state.chatMessages, event, current)
            },
            event
          )
        ),
        Match.tag(
          'CompactionEnd',
          'AssistantMessage',
          'CompactionStart',
          'LLMReasoningDelta',
          'LLMStreamEnd',
          'LLMStreamStart',
          'LLMTextDelta',
          'ProviderToolResult',
          'QuestionAnswered',
          'QuestionCancelled',
          'QuestionRequested',
          'InputRequested',
          'InputSubmitted',
          'InputCancelled',
          'InteractionRequested',
          'InteractionSubmitted',
          'InteractionCancelled',
          'SubagentCompleted',
          'SubagentStarted',
          'ToolApprovalDenied',
          'ToolApprovalGranted',
          'ToolApprovalRequested',
          'ToolExecutionAccepted',
          'ToolExecutionCompleted',
          'ToolExecutionError',
          'ToolExecutionStarted',
          'ToolInputDelta',
          'ToolInputEnd',
          'ToolInputStart',
          'TurnEnd',
          'TurnStart',
          'UsageUpdate',
          'UserMessage',
          event =>
            rememberEvent(
              clearRetryInfo({
                ...state,
                chatMessages: applyAgentEventToChatMessages(state.chatMessages, event, current)
              }),
              event
            )
        ),
        Match.exhaustive
      )
    }),
    Match.tag('Error', current => ({
      ...state,
      status: 'error',
      error: current.message,
      errorInfo: null,
      retryInfo: null,
      chatMessages: markChatError(state.chatMessages, current.message)
    })),
    Match.tag('Abort', () => ({
      ...state,
      status: 'aborted',
      error: null,
      errorInfo: null,
      retryInfo: null
    })),
    Match.exhaustive
  )

export const hasAgentMessageReasoning = (message: AgentMessage) =>
  Predicate.isTagged(message, 'Assistant') &&
  message.parts.some(part => Predicate.isTagged(part, 'Reasoning') && part.text.length > 0)

export const hasAgentChatReasoningSummary = (state: AgentChatState) =>
  state.chatMessages.some(message =>
    message.parts.some(part => Predicate.isTagged(part, 'Reasoning') && part.text.length > 0)
  )

export const isActiveChatToolPart = (part: AgentChatPart) =>
  Predicate.isTagged(part, 'ToolCall') &&
  !Predicate.isTagged(part.state, 'Completed') &&
  !Predicate.isTagged(part.state, 'Accepted') &&
  !Predicate.isTagged(part.state, 'ProviderCompleted') &&
  !Predicate.isTagged(part.state, 'QuestionAnswered') &&
  !Predicate.isTagged(part.state, 'QuestionCancelled') &&
  !Predicate.isTagged(part.state, 'InputSubmitted') &&
  !Predicate.isTagged(part.state, 'InputCancelled') &&
  !Predicate.isTagged(part.state, 'InteractionCancelled') &&
  !Predicate.isTagged(part.state, 'Errored') &&
  !Predicate.isTagged(part.state, 'Denied')

export type ActiveChatToolPart = Extract<AgentChatPart, { readonly _tag: 'ToolCall' }>

export const isCompletedChatToolPart = (part: AgentChatPart) =>
  Predicate.isTagged(part, 'ToolCall') && Predicate.isTagged(part.state, 'Completed')

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
