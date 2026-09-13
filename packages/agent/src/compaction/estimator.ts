import {
  assistantContent,
  assistantHostToolCalls,
  assistantReasoningText,
  type AgentMessage,
  type Content
} from '@yolk-sdk/agent/protocol'
import { Match, Predicate } from 'effect'

export type TokenEstimateOptions = {
  readonly charactersPerToken?: number
  readonly countTextTokens?: (text: string) => number
  readonly mediaPartTokens?: number
  readonly messageOverheadTokens?: number
}

export type MessageTokenEstimator = (message: AgentMessage) => number

export type TranscriptTokenEstimator = (messages: ReadonlyArray<AgentMessage>) => number

export const defaultCharactersPerToken = 4

export const defaultMediaPartTokens = 512

export const defaultMessageOverheadTokens = 6

const charactersPerToken = (options: TokenEstimateOptions) =>
  Math.max(1, options.charactersPerToken ?? defaultCharactersPerToken)

const mediaPartTokens = (options: TokenEstimateOptions) =>
  Math.max(0, options.mediaPartTokens ?? defaultMediaPartTokens)

const messageOverheadTokens = (options: TokenEstimateOptions) =>
  Math.max(0, options.messageOverheadTokens ?? defaultMessageOverheadTokens)

export const estimateTextTokens = (text: string, options: TokenEstimateOptions = {}) =>
  Math.max(
    0,
    Math.ceil(options.countTextTokens?.(text) ?? text.length / charactersPerToken(options))
  )

export const estimateContentTokens = (content: Content, options: TokenEstimateOptions = {}) => {
  if (Predicate.isString(content)) {
    return estimateTextTokens(content, options)
  }

  return content.reduce(
    (total, part) =>
      total +
      Match.value(part).pipe(
        Match.tag('Text', current => estimateTextTokens(current.text, options)),
        Match.tag('Image', 'Document', 'Audio', () => mediaPartTokens(options)),
        Match.exhaustive
      ),
    0
  )
}

export const estimateAgentMessageTokens = (
  message: AgentMessage,
  options: TokenEstimateOptions = {}
) => {
  return Match.value(message).pipe(
    Match.tag(
      'User',
      'ToolResult',
      current => estimateContentTokens(current.content, options) + messageOverheadTokens(options)
    ),
    Match.tag(
      'Assistant',
      current =>
        estimateContentTokens(assistantContent(current), options) +
        estimateTextTokens(assistantReasoningText(current), options) +
        assistantHostToolCalls(current).reduce(
          (total, call) =>
            total +
            estimateTextTokens(call.id, options) +
            estimateTextTokens(call.name, options) +
            messageOverheadTokens(options),
          0
        ) +
        messageOverheadTokens(options)
    ),
    Match.exhaustive
  )
}

export const estimateAgentMessagesTokens = (
  messages: ReadonlyArray<AgentMessage>,
  options: TokenEstimateOptions = {}
) => messages.reduce((total, message) => total + estimateAgentMessageTokens(message, options), 0)
