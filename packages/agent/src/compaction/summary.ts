import { Match } from 'effect'
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

  return Match.value(part).pipe(
    Match.tag('Text', current => {
      const text = compactionContentText(current.content)

      return text.length === 0 ? '' : `[Assistant]: ${text}`
    }),
    Match.tag('Reasoning', current => {
      const reasoning = current.text.trim()

      return includeReasoning && reasoning.length > 0 ? `[Assistant reasoning]: ${reasoning}` : ''
    }),
    Match.tag('HostToolCall', current =>
      includeToolCalls ? formatToolCallForCompaction('[Assistant tool call]', current, options) : ''
    ),
    Match.tag('ProviderToolCall', current =>
      includeToolCalls
        ? formatToolCallForCompaction('[Assistant provider tool call]', current, options)
        : ''
    ),
    Match.tag('ProviderToolResult', current =>
      includeToolCalls
        ? formatToolResultForCompaction(
            '[Assistant provider tool result',
            current.toolCallId,
            current.result.content,
            options
          )
        : ''
    ),
    Match.exhaustive
  )
}

export const formatAgentMessageForCompaction = (
  message: AgentMessage,
  options: CompactionMessageFormatOptions = {}
) => {
  return Match.value(message).pipe(
    Match.tag('User', current => `[User]: ${compactionContentText(current.content)}`),
    Match.tag('Assistant', current =>
      current.parts
        .map(part => formatAssistantPartForCompaction(part, options))
        .filter(isNonEmptyString)
        .join('\n')
    ),
    Match.tag(
      'ToolResult',
      current =>
        `[Tool result ${current.toolCallId}]: ${truncateCompactionToolOutput(
          compactionContentText(current.content),
          options
        )}`
    ),
    Match.exhaustive
  )
}

export const formatAgentMessagesForCompaction = (
  messages: ReadonlyArray<AgentMessage>,
  options: CompactionMessageFormatOptions = {}
) =>
  messages
    .flatMap(message => {
      const formatted = formatAgentMessageForCompaction(message, options)

      return isNonEmptyString(formatted) ? [formatted] : []
    })
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

  return Match.value(message).pipe(
    Match.tag(
      'User',
      current =>
        `User: ${truncateSummaryPreview(
          contentText(current.content) || contentPreview(current.content),
          maxCharacters
        )}`
    ),
    Match.tag(
      'Assistant',
      current =>
        `Assistant: ${truncateSummaryPreview(
          contentText(assistantContent(current)) || contentPreview(assistantContent(current)),
          maxCharacters
        )}`
    ),
    Match.tag(
      'ToolResult',
      current =>
        `Tool ${current.toolCallId}: ${truncateSummaryPreview(
          contentText(current.content) || contentPreview(current.content),
          maxCharacters
        )}`
    ),
    Match.exhaustive
  )
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
