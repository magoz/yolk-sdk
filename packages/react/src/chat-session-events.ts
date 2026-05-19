import * as Schema from 'effect/Schema'
import { AgentMessage, Content, UserMessage } from '@yolk-sdk/agent/protocol'

export class ProtocolMessageAppended extends Schema.TaggedClass<ProtocolMessageAppended>()(
  'ProtocolMessageAppended',
  {
    message: AgentMessage
  }
) {}

export class UserMessageSubmitted extends Schema.TaggedClass<UserMessageSubmitted>()(
  'UserMessageSubmitted',
  {
    message: UserMessage
  }
) {}

export class TurnDeleted extends Schema.TaggedClass<TurnDeleted>()('TurnDeleted', {
  turnStartMessageId: Schema.String,
  deletedMessageIds: Schema.Array(Schema.String)
}) {}

export class MessagesRegenerated extends Schema.TaggedClass<MessagesRegenerated>()(
  'MessagesRegenerated',
  {
    fromMessageId: Schema.String,
    keptMessageIds: Schema.Array(Schema.String)
  }
) {}

export class UserMessageEdited extends Schema.TaggedClass<UserMessageEdited>()(
  'UserMessageEdited',
  {
    messageId: Schema.String,
    content: Content,
    keptMessageIds: Schema.Array(Schema.String)
  }
) {}

export const AgentChatSessionEvent = Schema.Union([
  ProtocolMessageAppended,
  UserMessageSubmitted,
  TurnDeleted,
  MessagesRegenerated,
  UserMessageEdited
])
export type AgentChatSessionEvent = typeof AgentChatSessionEvent.Type
