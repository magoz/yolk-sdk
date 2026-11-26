import { Data } from 'effect'
import type { AgentTranscript } from '@yolk-sdk/agent/client'
import type { Content, HitlResponse, UserMessage } from '@yolk-sdk/agent/protocol'
import type { AgentChatAction as AgentChatActionType } from './chat-core.ts'

export type AgentChatAction = AgentChatActionType

export const AgentChatAction = Data.taggedEnum<AgentChatAction>()

export type AgentChatSubmitResult =
  | {
      readonly _tag: 'Submitted'
      readonly content: Content
      readonly message: UserMessage
      readonly messages: AgentTranscript
    }
  | { readonly _tag: 'Ignored' }

export const AgentChatSubmitResult = Data.taggedEnum<AgentChatSubmitResult>()

export type AgentChatDeleteTurnResult =
  | {
      readonly _tag: 'Deleted'
      readonly turnStartMessageId: string
      readonly deletedMessageIds: ReadonlyArray<string>
    }
  | { readonly _tag: 'Ignored' }

export const AgentChatDeleteTurnResult = Data.taggedEnum<AgentChatDeleteTurnResult>()

export type AgentChatRegenerateResult =
  | {
      readonly _tag: 'Regenerated'
      readonly messageId: string
      readonly messages: AgentTranscript
    }
  | { readonly _tag: 'Ignored' }

export const AgentChatRegenerateResult = Data.taggedEnum<AgentChatRegenerateResult>()

export type AgentChatEditUserMessageResult =
  | {
      readonly _tag: 'Edited'
      readonly messageId: string
      readonly messages: AgentTranscript
    }
  | { readonly _tag: 'Ignored' }

export const AgentChatEditUserMessageResult = Data.taggedEnum<AgentChatEditUserMessageResult>()

export type AgentChatHitlResponseResult =
  | {
      readonly _tag: 'Submitted'
      readonly response: HitlResponse
      readonly messages: AgentTranscript
    }
  | { readonly _tag: 'Ignored' }

export const AgentChatHitlResponseResult = Data.taggedEnum<AgentChatHitlResponseResult>()
