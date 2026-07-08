import {
  UserMessage,
  assistantContent,
  contentPreview,
  contentText,
  type AgentMessage,
  type AssistantPart,
  type Content
} from '@yolk-sdk/agent/protocol'

export type PreviewSummaryMessageOptions = {
  readonly header?: string
  readonly maxCharacters?: number
}

export type CompactionMessageFormatOptions = {
  readonly maxToolOutputCharacters?: number
  readonly includeAssistantReasoning?: boolean
  readonly includeAssistantToolCalls?: boolean
}

export const defaultPreviewSummaryHeader =
  'Earlier conversation compacted. Preserve these facts and continue from the recent messages.'

export const defaultSummaryPreviewMaxCharacters = 180
export const defaultCompactionToolOutputMaxCharacters = 2_000

const compactionToolOutputMaxCharacters = (options: CompactionMessageFormatOptions) =>
  Math.max(0, options.maxToolOutputCharacters ?? defaultCompactionToolOutputMaxCharacters)

export const truncateCompactionToolOutput = (
  value: string,
  options: CompactionMessageFormatOptions = {}
) => {
  const maxCharacters = compactionToolOutputMaxCharacters(options)

  return value.length <= maxCharacters ? value : `${value.slice(0, maxCharacters)}\n[truncated]`
}

export const compactionContentText = (content: Content) => {
  const text = contentText(content).trim()

  return text.length === 0 ? contentPreview(content) : text
}

const jsonPreview = (value: unknown, options: CompactionMessageFormatOptions) => {
  try {
    return truncateCompactionToolOutput(JSON.stringify(value) ?? 'undefined', options)
  } catch {
    return truncateCompactionToolOutput(String(value), options)
  }
}

const isNonEmptyString = (value: string) => value.length > 0

const formatToolCallForCompaction = (
  label: string,
  part: { readonly call: { readonly name: string; readonly params: unknown } },
  options: CompactionMessageFormatOptions
) => `${label}: ${part.call.name}(${jsonPreview(part.call.params, options)})`

const formatToolResultForCompaction = (
  label: string,
  toolCallId: string,
  content: Content,
  options: CompactionMessageFormatOptions
) =>
  `${label} ${toolCallId}]: ${truncateCompactionToolOutput(
    compactionContentText(content),
    options
  )}`

const formatAssistantPartForCompaction = (
  part: AssistantPart,
  options: CompactionMessageFormatOptions
) => {
  const includeReasoning = options.includeAssistantReasoning ?? true
  const includeToolCalls = options.includeAssistantToolCalls ?? true

  switch (part._tag) {
    case 'Text': {
      const text = compactionContentText(part.content)

      return text.length === 0 ? '' : `[Assistant]: ${text}`
    }
    case 'Reasoning': {
      const reasoning = part.text.trim()

      return includeReasoning && reasoning.length > 0 ? `[Assistant reasoning]: ${reasoning}` : ''
    }
    case 'HostToolCall':
      return includeToolCalls
        ? formatToolCallForCompaction('[Assistant tool call]', part, options)
        : ''
    case 'ProviderToolCall':
      return includeToolCalls
        ? formatToolCallForCompaction('[Assistant provider tool call]', part, options)
        : ''
    case 'ProviderToolResult':
      return includeToolCalls
        ? formatToolResultForCompaction(
            '[Assistant provider tool result',
            part.toolCallId,
            part.result.content,
            options
          )
        : ''
  }
}

export const formatAgentMessageForCompaction = (
  message: AgentMessage,
  options: CompactionMessageFormatOptions = {}
) => {
  switch (message._tag) {
    case 'User':
      return `[User]: ${compactionContentText(message.content)}`
    case 'Assistant':
      return message.parts
        .map(part => formatAssistantPartForCompaction(part, options))
        .filter(isNonEmptyString)
        .join('\n')
    case 'ToolResult':
      return `[Tool result ${message.toolCallId}]: ${truncateCompactionToolOutput(
        compactionContentText(message.content),
        options
      )}`
  }
}

export const formatAgentMessagesForCompaction = (
  messages: ReadonlyArray<AgentMessage>,
  options: CompactionMessageFormatOptions = {}
) =>
  messages
    .map(message => formatAgentMessageForCompaction(message, options))
    .filter(isNonEmptyString)
    .join('\n\n')

export const truncateSummaryPreview = (value: string, maxCharacters: number) => {
  const normalized = value.replaceAll(/\s+/g, ' ').trim()

  if (maxCharacters <= 0) {
    return ''
  }

  if (normalized.length <= maxCharacters) {
    return normalized
  }

  return `${normalized.slice(0, Math.max(0, maxCharacters - 1))}…`
}

export const previewAgentMessage = (
  message: AgentMessage,
  options: PreviewSummaryMessageOptions = {}
) => {
  const maxCharacters = options.maxCharacters ?? defaultSummaryPreviewMaxCharacters

  switch (message._tag) {
    case 'User':
      return `User: ${truncateSummaryPreview(
        contentText(message.content) || contentPreview(message.content),
        maxCharacters
      )}`
    case 'Assistant':
      return `Assistant: ${truncateSummaryPreview(
        contentText(assistantContent(message)) || contentPreview(assistantContent(message)),
        maxCharacters
      )}`
    case 'ToolResult':
      return `Tool ${message.toolCallId}: ${truncateSummaryPreview(
        contentText(message.content) || contentPreview(message.content),
        maxCharacters
      )}`
  }
}

export const makePreviewSummaryContent = (
  messages: ReadonlyArray<AgentMessage>,
  options: PreviewSummaryMessageOptions = {}
) =>
  [
    options.header ?? defaultPreviewSummaryHeader,
    ...messages.map(message => previewAgentMessage(message, options))
  ].join('\n')

export const makePreviewSummaryMessage = (
  messages: ReadonlyArray<AgentMessage>,
  options: PreviewSummaryMessageOptions = {}
) => UserMessage.make({ content: makePreviewSummaryContent(messages, options) })
