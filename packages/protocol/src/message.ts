import * as Schema from 'effect/Schema'
import { Content } from './content'
import { ToolCall } from './tool'

export class UserMessage extends Schema.TaggedClass<UserMessage>()('User', {
  content: Content
}) {}

export class AssistantAgentMessage extends Schema.TaggedClass<AssistantAgentMessage>()('Assistant', {
  content: Content,
  toolCalls: Schema.Array(ToolCall),
  reasoning: Schema.optional(Schema.String)
}) {}

export class ToolResultMessage extends Schema.TaggedClass<ToolResultMessage>()('ToolResult', {
  toolCallId: Schema.String,
  content: Content
}) {}

export const AgentMessage = Schema.Union([UserMessage, AssistantAgentMessage, ToolResultMessage])
export type AgentMessage = typeof AgentMessage.Type
