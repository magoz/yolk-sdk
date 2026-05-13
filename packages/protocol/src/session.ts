import * as Schema from 'effect/Schema'
import { AgentEvent } from './event.ts'
import { AgentMessage, UserMessage } from './message.ts'
import { AgentReasoningEffort } from './reasoning.ts'

export class SessionSnapshot extends Schema.TaggedClass<SessionSnapshot>()('SessionSnapshot', {
  revision: Schema.Number,
  messages: Schema.Array(AgentMessage)
}) {}

export class UserInput extends Schema.TaggedClass<UserInput>()('UserInput', {
  message: UserMessage,
  expectedRevision: Schema.optional(Schema.Number),
  model: Schema.optional(Schema.String),
  reasoningEffort: Schema.optional(AgentReasoningEffort)
}) {}

export const AgentWebSocketClientMessage = Schema.Union([UserInput])
export type AgentWebSocketClientMessage = typeof AgentWebSocketClientMessage.Type

export const AgentWebSocketServerMessage = Schema.Union([SessionSnapshot, AgentEvent])
export type AgentWebSocketServerMessage = typeof AgentWebSocketServerMessage.Type
