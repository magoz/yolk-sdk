import {
  UserMessage,
  assistantContent,
  contentPreview,
  contentText,
  type AgentMessage
} from '@yolk-sdk/agent/protocol'

export type PreviewSummaryMessageOptions = {
  readonly header?: string
  readonly maxCharacters?: number
}

export const defaultPreviewSummaryHeader =
  'Earlier conversation compacted. Preserve these facts and continue from the recent messages.'

export const defaultSummaryPreviewMaxCharacters = 180

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
