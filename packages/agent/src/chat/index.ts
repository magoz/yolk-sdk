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
  markChatRunStart,
  reduceAgentChatState,
  stepAgentChatProjection,
  stepAgentChatProjectionAll
} from './chat-core.ts'

export type {
  ActiveChatToolPart,
  AgentChatProjectionBatch,
  AgentChatProjectionStep,
  CompletedChatToolPart
} from './chat-core.ts'

export {
  AgentChatEventProjectionStateSchema,
  AgentChatExecutionOutput,
  AgentChatExecutionOutputSchema,
  AgentChatExecutionsSchema,
  AgentChatMessageSchema,
  AgentChatPart,
  AgentChatPartSchema,
  AgentChatStateSchema,
  AgentChatTurnStartSchema,
  ChatPartStateSchema,
  ChatToolState,
  ChatToolStateSchema
} from './chat-schemas.ts'

export type {
  AgentChatEventProjectionState,
  AgentChatMessage,
  AgentChatState,
  AgentChatTurnStart,
  ChatPartState
} from './chat-schemas.ts'

// The client's Schemas the chat state is made of, so a host keeps the chat with one import.
export { AgentExecutionsSchema, HitlPauses } from '@yolk-sdk/agent/client'

export type { AgentExecution, AgentExecutionRun, AgentExecutions } from '@yolk-sdk/agent/client'

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

export type {
  AgentChatItemEnvelope,
  BuildAgentChatItemsInput,
  ToolDuration,
  ToolRunTiming
} from './chat-items.ts'

export {
  appendProtocolMessage,
  applyAgentEventToChatMessages,
  buildAgentChatMessages,
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
  ApplyAgentEventToChatMessagesOptions,
  BuildAgentChatMessagesInput
} from './chat-messages.ts'
