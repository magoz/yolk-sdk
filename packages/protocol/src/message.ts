import * as Schema from 'effect/Schema'
import { Content, contentParts } from './content.ts'
import { ToolCall, ToolResult } from './tool.ts'

export class UserMessage extends Schema.TaggedClass<UserMessage>()('User', {
  content: Content
}) {}

export class AssistantTextPart extends Schema.TaggedClass<AssistantTextPart>()('Text', {
  content: Content
}) {}

export class AssistantReasoningPart extends Schema.TaggedClass<AssistantReasoningPart>()(
  'Reasoning',
  {
    text: Schema.String
  }
) {}

export class HostToolCallPart extends Schema.TaggedClass<HostToolCallPart>()('HostToolCall', {
  call: ToolCall
}) {}

export class ProviderToolCallPart extends Schema.TaggedClass<ProviderToolCallPart>()(
  'ProviderToolCall',
  {
    call: ToolCall,
    providerMetadata: Schema.optional(Schema.Unknown)
  }
) {}

export class ProviderToolResultPart extends Schema.TaggedClass<ProviderToolResultPart>()(
  'ProviderToolResult',
  {
    toolCallId: Schema.String,
    result: ToolResult,
    providerMetadata: Schema.optional(Schema.Unknown)
  }
) {}

export const AssistantPart = Schema.Union([
  AssistantTextPart,
  AssistantReasoningPart,
  HostToolCallPart,
  ProviderToolCallPart,
  ProviderToolResultPart
])
export type AssistantPart = typeof AssistantPart.Type

export class AssistantAgentMessage extends Schema.TaggedClass<AssistantAgentMessage>()(
  'Assistant',
  {
    parts: Schema.Array(AssistantPart)
  }
) {}

export class ToolResultMessage extends Schema.TaggedClass<ToolResultMessage>()('ToolResult', {
  toolCallId: Schema.String,
  content: Content,
  isError: Schema.optional(Schema.Boolean),
  structuredContent: Schema.optional(Schema.Unknown)
}) {}

export const AgentMessage = Schema.Union([UserMessage, AssistantAgentMessage, ToolResultMessage])
export type AgentMessage = typeof AgentMessage.Type

export const assistantContent = (message: AssistantAgentMessage): Content => {
  const parts = message.parts.flatMap(part => (part._tag === 'Text' ? [part.content] : []))
  const first = parts[0]

  if (parts.length === 0) {
    return ''
  }

  if (parts.length === 1 && first !== undefined) {
    return first
  }

  return parts.flatMap(contentParts)
}

export const assistantReasoningText = (message: AssistantAgentMessage) =>
  message.parts
    .flatMap(part => (part._tag === 'Reasoning' ? [part.text] : []))
    .join('')

export const assistantHostToolCalls = (message: AssistantAgentMessage) =>
  message.parts.flatMap(part => (part._tag === 'HostToolCall' ? [part.call] : []))
