import { Data } from 'effect'
import type { AgentChatAction as AgentChatActionType } from './chat-core.ts'
import type {
  AgentChatDeleteTurnResult as AgentChatDeleteTurnResultType,
  AgentChatEditUserMessageResult as AgentChatEditUserMessageResultType,
  AgentChatHitlResponseResult as AgentChatHitlResponseResultType,
  AgentChatRegenerateResult as AgentChatRegenerateResultType,
  AgentChatSubmitResult as AgentChatSubmitResultType
} from './use-agent-chat.ts'

export type AgentChatAction = AgentChatActionType

export const AgentChatAction = Data.taggedEnum<AgentChatAction>()

export type AgentChatSubmitResult = AgentChatSubmitResultType

export const AgentChatSubmitResult = Data.taggedEnum<AgentChatSubmitResult>()

export type AgentChatDeleteTurnResult = AgentChatDeleteTurnResultType

export const AgentChatDeleteTurnResult = Data.taggedEnum<AgentChatDeleteTurnResult>()

export type AgentChatRegenerateResult = AgentChatRegenerateResultType

export const AgentChatRegenerateResult = Data.taggedEnum<AgentChatRegenerateResult>()

export type AgentChatEditUserMessageResult = AgentChatEditUserMessageResultType

export const AgentChatEditUserMessageResult = Data.taggedEnum<AgentChatEditUserMessageResult>()

export type AgentChatHitlResponseResult = AgentChatHitlResponseResultType

export const AgentChatHitlResponseResult = Data.taggedEnum<AgentChatHitlResponseResult>()
