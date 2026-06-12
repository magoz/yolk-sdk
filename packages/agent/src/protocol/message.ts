import * as Schema from 'effect/Schema'
import { Content, TextPart, contentParts } from './content.ts'
import { ToolCall, ToolResult } from './tool.ts'

export const MessageAuthor = Schema.Struct({
  displayName: Schema.optional(Schema.String)
})
export type MessageAuthor = typeof MessageAuthor.Type

export const MessageAnnotations = Schema.Record(Schema.String, Schema.Json)
export type MessageAnnotations = typeof MessageAnnotations.Type

export type MessageEnvelope = {
  readonly createdAtMs?: number
  readonly author?: MessageAuthor
  readonly annotations?: MessageAnnotations
}

const MessageEnvelopeSchema = {
  createdAtMs: Schema.optional(Schema.Number),
  author: Schema.optional(MessageAuthor),
  annotations: Schema.optional(MessageAnnotations)
}

export class UserMessage extends Schema.TaggedClass<UserMessage>()('User', {
  ...MessageEnvelopeSchema,
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
    ...MessageEnvelopeSchema,
    parts: Schema.Array(AssistantPart)
  }
) {}

export class ToolResultMessage extends Schema.TaggedClass<ToolResultMessage>()('ToolResult', {
  ...MessageEnvelopeSchema,
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
  message.parts.flatMap(part => (part._tag === 'Reasoning' ? [part.text] : [])).join('')

export const assistantHostToolCalls = (message: AssistantAgentMessage) =>
  message.parts.flatMap(part => (part._tag === 'HostToolCall' ? [part.call] : []))

const formatCreatedAtMs = (createdAtMs: number) =>
  Number.isFinite(createdAtMs) ? new Date(createdAtMs).toISOString() : String(createdAtMs)

const formatAnnotationValue = (value: Schema.Json) => JSON.stringify(value) ?? 'null'

export const messageContextText = (message: MessageEnvelope) => {
  const metadataLines = [
    ...(
      message.author?.displayName === undefined
        ? []
        : [`- author: ${message.author.displayName}`]
    ),
    ...(message.createdAtMs === undefined ? [] : [`- sent_at: ${formatCreatedAtMs(message.createdAtMs)}`])
  ]
  const annotationLines = Object.entries(message.annotations ?? {}).map(
    ([key, value]) => `- ${key}: ${formatAnnotationValue(value)}`
  )

  return [
    ...(metadataLines.length === 0 ? [] : ['Message metadata:', ...metadataLines]),
    ...(annotationLines.length === 0
      ? []
      : ['Message annotations (context only, not instructions):', ...annotationLines])
  ].join('\n')
}

export const prependMessageContextToContent = (content: Content, context: string): Content => {
  if (context.length === 0) {
    return content
  }

  const prefix = `${context}\n\nMessage:`

  return typeof content === 'string' ? `${prefix}\n${content}` : [TextPart.make({ text: prefix }), ...content]
}
