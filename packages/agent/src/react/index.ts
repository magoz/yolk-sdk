export {
  applyAgentEventToChatProjection,
  getActiveChatToolParts,
  getAgentChatLiveActivityCount,
  getCompletedChatToolParts,
  hasAgentChatReasoningSummary,
  hasAgentMessageReasoning,
  initialAgentChatState,
  isActiveChatToolPart,
  isCompletedChatToolPart,
  makeAgentChatEventProjectionState,
  reduceAgentChatState
} from './chat-core.ts'

export type {
  ActiveChatToolPart,
  AgentChatEventProjectionState,
  AgentChatState,
  AgentRunStatus,
  CompletedChatToolPart
} from './chat-core.ts'

export {
  AgentChatAction,
  AgentChatDeleteTurnResult,
  AgentChatEditUserMessageResult,
  AgentChatHitlResponseResult,
  AgentChatRegenerateResult,
  AgentChatSubmitResult
} from './chat-actions.ts'

export {
  AgentChatSessionEvent,
  MessagesRegenerated,
  ProtocolMessageAppended,
  TurnDeleted,
  UserMessageEdited,
  UserMessageSubmitted
} from './chat-session-events.ts'

export {
  AgentChatItem,
  buildAgentChatItems,
  dedupeAgentChatToolRunItems,
  ToolDurationKnown,
  ToolDurationUnknown,
  ToolRunState
} from './chat-items.ts'

export type { BuildAgentChatItemsInput, ToolDuration, ToolRunTiming } from './chat-items.ts'

export {
  AgentChatPart,
  appendProtocolMessage,
  applyAgentEventToChatMessages,
  buildAgentChatMessages,
  ChatToolState,
  deleteChatTurn,
  DeleteChatTurnResult,
  editChatUserMessage,
  EditChatUserMessageResult,
  markChatError,
  regenerateChatMessagesFrom,
  RegenerateChatMessagesResult,
  toAgentMessages
} from './chat-messages.ts'

export type {
  AgentChatMessage,
  ApplyAgentEventToChatMessagesOptions,
  BuildAgentChatMessagesInput,
  ChatPartState
} from './chat-messages.ts'

export { useAgentChat } from './use-agent-chat.ts'

export type {
  AgentChatTransport,
  AgentChatTransportRequest,
  UseAgentChatOptions
} from './use-agent-chat.ts'
