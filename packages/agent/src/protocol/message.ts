import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import {
  Content,
  TextPart,
  contentParts,
  resolveContentAttachmentSources,
  type AttachmentSourceResolver
} from './content.ts'
import { BackgroundToolAccepted, ToolCall, ToolResult } from './tool.ts'

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
  structuredContent: Schema.optional(Schema.Unknown),
  acceptance: Schema.optional(BackgroundToolAccepted)
}) {}

export const AgentMessage = Schema.Union([UserMessage, AssistantAgentMessage, ToolResultMessage])
export type AgentMessage = typeof AgentMessage.Type

const resolveAssistantPartAttachmentSources = <E, R>(
  part: AssistantPart,
  resolver: AttachmentSourceResolver<E, R>
): Effect.Effect<AssistantPart, E, R> => {
  switch (part._tag) {
    case 'Text':
      return resolveContentAttachmentSources(part.content, resolver).pipe(
        Effect.map(content => AssistantTextPart.make({ ...part, content }))
      )
    case 'ProviderToolResult':
      return resolveContentAttachmentSources(part.result.content, resolver).pipe(
        Effect.map(content =>
          ProviderToolResultPart.make({
            ...part,
            result: ToolResult.make({ ...part.result, content })
          })
        )
      )
    case 'Reasoning':
    case 'HostToolCall':
    case 'ProviderToolCall':
      return Effect.succeed(part)
  }
}

/**
 * Resolve every attachment in protocol content, including assistant text and
 * nested provider tool results. Envelopes, ordering and opaque tool/provider
 * payloads are preserved; unknown payloads are not traversed. The resolver owns
 * source policy (it receives Url and InlineBase64 sources as well as Ref).
 * Returns a request-local copy; never mutates the input or caches resolution.
 */
export const resolveMessageAttachmentSources = <E, R>(
  message: AgentMessage,
  resolver: AttachmentSourceResolver<E, R>
): Effect.Effect<AgentMessage, E, R> => {
  switch (message._tag) {
    case 'User':
      return resolveContentAttachmentSources(message.content, resolver).pipe(
        Effect.map(content => UserMessage.make({ ...message, content }))
      )
    case 'ToolResult':
      return resolveContentAttachmentSources(message.content, resolver).pipe(
        Effect.map(content => ToolResultMessage.make({ ...message, content }))
      )
    case 'Assistant':
      return Effect.forEach(message.parts, part =>
        resolveAssistantPartAttachmentSources(part, resolver)
      ).pipe(Effect.map(parts => AssistantAgentMessage.make({ ...message, parts })))
  }
}

/** Resolve messages in order with the same Effect-native resolver; no deduplication or caching. */
export const resolveMessagesAttachmentSources = <E, R>(
  messages: ReadonlyArray<AgentMessage>,
  resolver: AttachmentSourceResolver<E, R>
): Effect.Effect<ReadonlyArray<AgentMessage>, E, R> =>
  Effect.forEach(messages, message => resolveMessageAttachmentSources(message, resolver))

export type DanglingHostToolCall = {
  readonly call: ToolCall
  readonly assistantMessageIndex: number
  readonly beforeMessageIndex?: number
}

export type TranscriptInvariantValidation =
  | { readonly _tag: 'Valid' }
  | {
      readonly _tag: 'DanglingHostToolCalls'
      readonly calls: ReadonlyArray<DanglingHostToolCall>
      readonly message: string
    }

export type RepairDanglingHostToolCallsOptions = {
  readonly content?: (call: ToolCall) => Content
  readonly structuredContent?: (call: ToolCall) => unknown
}

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

type PendingHostToolCall = {
  readonly call: ToolCall
  readonly assistantMessageIndex: number
}

const pendingHostToolCalls = (message: AgentMessage, messageIndex: number) =>
  message._tag === 'Assistant'
    ? assistantHostToolCalls(message).map(call => ({ call, assistantMessageIndex: messageIndex }))
    : []

const danglingHostToolCall = (
  pending: PendingHostToolCall,
  beforeMessageIndex: number | undefined
): DanglingHostToolCall => ({
  call: pending.call,
  assistantMessageIndex: pending.assistantMessageIndex,
  ...(beforeMessageIndex === undefined ? {} : { beforeMessageIndex })
})

const danglingHostToolCallSummary = (calls: ReadonlyArray<DanglingHostToolCall>) =>
  calls.map(({ call }) => `${call.name} (${call.id})`).join(', ')

const danglingHostToolResultContent = (call: ToolCall) =>
  `Tool ${call.name} did not return a result before the transcript continued.`

const danglingHostToolResultMessage = (
  call: ToolCall,
  options: RepairDanglingHostToolCallsOptions | undefined
) => {
  const structuredContent = options?.structuredContent?.(call)

  return ToolResultMessage.make({
    toolCallId: call.id,
    content: options?.content?.(call) ?? danglingHostToolResultContent(call),
    isError: true,
    ...(structuredContent === undefined ? {} : { structuredContent })
  })
}

export const danglingHostToolCalls = (
  messages: ReadonlyArray<AgentMessage>
): ReadonlyArray<DanglingHostToolCall> => {
  const dangling: Array<DanglingHostToolCall> = []
  let pending: ReadonlyArray<PendingHostToolCall> = []

  for (const [messageIndex, message] of messages.entries()) {
    if (message._tag !== 'ToolResult' && pending.length > 0) {
      dangling.push(...pending.map(call => danglingHostToolCall(call, messageIndex)))
      pending = []
    }

    pending = [...pending, ...pendingHostToolCalls(message, messageIndex)]

    if (message._tag === 'ToolResult') {
      pending = pending.filter(call => call.call.id !== message.toolCallId)
    }
  }

  dangling.push(...pending.map(call => danglingHostToolCall(call, undefined)))

  return dangling
}

export const validateNoDanglingHostToolCalls = (
  messages: ReadonlyArray<AgentMessage>
): TranscriptInvariantValidation => {
  const dangling = danglingHostToolCalls(messages)

  if (dangling.length === 0) {
    return { _tag: 'Valid' }
  }

  return {
    _tag: 'DanglingHostToolCalls',
    calls: dangling,
    message: `Transcript has host tool calls without tool results: ${danglingHostToolCallSummary(dangling)}`
  }
}

export const repairDanglingHostToolCalls = (
  messages: ReadonlyArray<AgentMessage>,
  options?: RepairDanglingHostToolCallsOptions
): ReadonlyArray<AgentMessage> => {
  const repaired: Array<AgentMessage> = []
  let pending: ReadonlyArray<ToolCall> = []

  for (const message of messages) {
    if (message._tag !== 'ToolResult' && pending.length > 0) {
      repaired.push(...pending.map(call => danglingHostToolResultMessage(call, options)))
      pending = []
    }

    repaired.push(message)

    if (message._tag === 'Assistant') {
      pending = [...pending, ...assistantHostToolCalls(message)]
    }

    if (message._tag === 'ToolResult') {
      pending = pending.filter(call => call.id !== message.toolCallId)
    }
  }

  repaired.push(...pending.map(call => danglingHostToolResultMessage(call, options)))

  return repaired
}

const formatCreatedAtMs = (createdAtMs: number) =>
  Number.isFinite(createdAtMs) ? new Date(createdAtMs).toISOString() : String(createdAtMs)

const formatAnnotationValue = (value: Schema.Json) => JSON.stringify(value) ?? 'null'

export const messageContextText = (message: MessageEnvelope) => {
  const metadataLines = [
    ...(message.author?.displayName === undefined
      ? []
      : [`- author: ${message.author.displayName}`]),
    ...(message.createdAtMs === undefined
      ? []
      : [`- sent_at: ${formatCreatedAtMs(message.createdAtMs)}`])
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

  return typeof content === 'string'
    ? `${prefix}\n${content}`
    : [TextPart.make({ text: prefix }), ...content]
}
