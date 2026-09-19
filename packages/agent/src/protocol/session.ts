import * as Schema from 'effect/Schema'
import { AgentEvent } from './event.ts'
import { AgentMessage, UserMessage } from './message.ts'
import { AgentReasoningEffort } from './reasoning.ts'
import {
  InputResponse,
  InteractionResponse,
  QuestionResponse,
  ToolApprovalResponse
} from './tool.ts'

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

export class ToolApprovalResponseInput extends Schema.TaggedClass<ToolApprovalResponseInput>()(
  'ToolApprovalResponseInput',
  {
    response: ToolApprovalResponse,
    expectedRevision: Schema.optional(Schema.Number),
    model: Schema.optional(Schema.String),
    reasoningEffort: Schema.optional(AgentReasoningEffort)
  }
) {}

export class QuestionResponseInput extends Schema.TaggedClass<QuestionResponseInput>()(
  'QuestionResponseInput',
  {
    response: QuestionResponse,
    expectedRevision: Schema.optional(Schema.Number),
    model: Schema.optional(Schema.String),
    reasoningEffort: Schema.optional(AgentReasoningEffort)
  }
) {}

export class InputResponseInput extends Schema.TaggedClass<InputResponseInput>()(
  'InputResponseInput',
  {
    response: InputResponse,
    expectedRevision: Schema.optional(Schema.Number),
    model: Schema.optional(Schema.String),
    reasoningEffort: Schema.optional(AgentReasoningEffort)
  }
) {}

export class InteractionResponseInput extends Schema.TaggedClass<InteractionResponseInput>()(
  'InteractionResponseInput',
  {
    response: InteractionResponse,
    expectedRevision: Schema.optional(Schema.Number),
    model: Schema.optional(Schema.String),
    reasoningEffort: Schema.optional(AgentReasoningEffort)
  }
) {}

export const AgentWebSocketClientMessage = Schema.Union([
  UserInput,
  ToolApprovalResponseInput,
  QuestionResponseInput,
  InputResponseInput,
  InteractionResponseInput
])

export type AgentWebSocketClientMessage = typeof AgentWebSocketClientMessage.Type

export const AgentWebSocketServerMessage = Schema.Union([SessionSnapshot, AgentEvent])

export type AgentWebSocketServerMessage = typeof AgentWebSocketServerMessage.Type
