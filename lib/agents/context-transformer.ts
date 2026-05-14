import { Effect, Layer } from 'effect'
import {
  CompactionEnd,
  CompactionStart,
  UserMessage,
  assistantContent,
  assistantHostToolCalls,
  assistantReasoningText,
  contentPreview,
  contentText,
  type AgentMessage,
  type Content
} from '@yolk/agent/protocol'
import { ContextTransformer, type ContextTransformResult } from '@yolk/agent/loop'
import { agentTextContextBudget } from './context-budget'

export const contextCompactionStrategy = 'window-summary-v1'

const exactTailMessageCount = 16
const messageOverheadTokens = 6
const mediaPartApproxTokens = 512
const summaryPreviewMaxCharacters = 180

const estimateTextTokens = (text: string) => Math.ceil(text.length / 4)

const estimateContentTokens = (content: Content) => {
  if (typeof content === 'string') {
    return estimateTextTokens(content)
  }

  return content.reduce((total, part) => {
    switch (part._tag) {
      case 'Text':
        return total + estimateTextTokens(part.text)
      case 'Image':
      case 'Audio':
        return total + mediaPartApproxTokens
    }
  }, 0)
}

export const estimateAgentMessageTokens = (message: AgentMessage) => {
  switch (message._tag) {
    case 'User':
    case 'ToolResult':
      return estimateContentTokens(message.content) + messageOverheadTokens
    case 'Assistant':
      return (
        estimateContentTokens(assistantContent(message)) +
        estimateTextTokens(assistantReasoningText(message)) +
        assistantHostToolCalls(message).reduce(
          (total, call) =>
            total +
            estimateTextTokens(call.id) +
            estimateTextTokens(call.name) +
            messageOverheadTokens,
          0
        ) +
        messageOverheadTokens
      )
  }
}

export const estimateAgentMessagesTokens = (messages: ReadonlyArray<AgentMessage>) =>
  messages.reduce((total, message) => total + estimateAgentMessageTokens(message), 0)

const truncatePreview = (value: string) => {
  const normalized = value.replaceAll(/\s+/g, ' ').trim()

  if (normalized.length <= summaryPreviewMaxCharacters) {
    return normalized
  }

  return `${normalized.slice(0, summaryPreviewMaxCharacters - 1)}…`
}

const messagePreview = (message: AgentMessage) => {
  switch (message._tag) {
    case 'User':
      return `User: ${truncatePreview(contentText(message.content) || contentPreview(message.content))}`
    case 'Assistant':
      return `Assistant: ${truncatePreview(
        contentText(assistantContent(message)) || contentPreview(assistantContent(message))
      )}`
    case 'ToolResult':
      return `Tool ${message.toolCallId}: ${truncatePreview(
        contentText(message.content) || contentPreview(message.content)
      )}`
  }
}

const compactedSummaryContent = (messages: ReadonlyArray<AgentMessage>) =>
  [
    'Earlier conversation compacted. Preserve these facts and continue from the recent messages.',
    ...messages.map(messagePreview)
  ].join('\n')

const compactedSummaryMessage = (messages: ReadonlyArray<AgentMessage>) =>
  UserMessage.make({ content: compactedSummaryContent(messages) })

const tailStartIndex = (messages: ReadonlyArray<AgentMessage>) => {
  const tailCount = Math.min(exactTailMessageCount, messages.length - 1)
  const initialIndex = Math.max(1, messages.length - tailCount)
  let index = initialIndex

  while (index > 1 && messages[index]?._tag === 'ToolResult') {
    index -= 1
  }

  return index
}

export const compactAgentMessages = (
  messages: ReadonlyArray<AgentMessage>
): ContextTransformResult => {
  const beforeTokens = estimateAgentMessagesTokens(messages)

  if (messages.length <= 2 || beforeTokens < agentTextContextBudget.compactionInputTokens) {
    return { messages, events: [] }
  }

  const tailIndex = tailStartIndex(messages)
  const compactedMessages = messages.slice(0, tailIndex)
  const recentMessages = messages.slice(tailIndex)

  if (compactedMessages.length === 0 || recentMessages.length === 0) {
    return { messages, events: [] }
  }

  const nextMessages = [compactedSummaryMessage(compactedMessages), ...recentMessages]
  const afterTokens = estimateAgentMessagesTokens(nextMessages)

  if (afterTokens >= beforeTokens) {
    return { messages, events: [] }
  }

  return {
    messages: nextMessages,
    events: [
      CompactionStart.make({ strategy: contextCompactionStrategy }),
      CompactionEnd.make({
        strategy: contextCompactionStrategy,
        beforeTokens,
        afterTokens
      })
    ]
  }
}

export const AgentContextTransformerLayer = Layer.succeed(
  ContextTransformer,
  ContextTransformer.of({
    transform: messages => Effect.succeed(compactAgentMessages(messages))
  })
)
