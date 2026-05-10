import type { AgentClientState } from '@yolk/client'
import {
  appendAgentMessage,
  applyAgentEvent,
  markAgentAborted,
  markAgentError,
  submitAgentUserMessage
} from '@yolk/client'
import type { AgentEvent, AgentMessage, UserMessage } from '@yolk/protocol'

export type AgentChatAction =
  | { readonly _tag: 'Submit'; readonly message: UserMessage }
  | { readonly _tag: 'AppendMessage'; readonly message: AgentMessage }
  | { readonly _tag: 'Event'; readonly event: AgentEvent }
  | { readonly _tag: 'Error'; readonly message: string }
  | { readonly _tag: 'Abort' }

export const reduceAgentChatState = (
  state: AgentClientState,
  action: AgentChatAction
): AgentClientState => {
  switch (action._tag) {
    case 'Submit':
      return submitAgentUserMessage(state, action.message)
    case 'AppendMessage':
      return { ...state, messages: appendAgentMessage(state.messages, action.message), error: null }
    case 'Event':
      return applyAgentEvent(state, action.event)
    case 'Error':
      return markAgentError(state, action.message)
    case 'Abort':
      return markAgentAborted(state)
  }
}

export const hasAgentMessageReasoning = (message: AgentMessage) =>
  message._tag === 'Assistant' && message.reasoning !== undefined && message.reasoning.length > 0

export const hasAgentChatReasoningSummary = (state: AgentClientState) =>
  state.reasoning.length > 0 || state.messages.some(hasAgentMessageReasoning)

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
