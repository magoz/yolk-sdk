import {
  assistantContent,
  assistantHostToolCalls,
  assistantReasoningText,
  type AgentMessage,
  type Content
} from '@yolk-sdk/agent/protocol'

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
    Math.ceil(
      options.countTextTokens?.(text) ?? text.length / charactersPerToken(options)
    )
  )

export const estimateContentTokens = (content: Content, options: TokenEstimateOptions = {}) => {
  if (typeof content === 'string') {
    return estimateTextTokens(content, options)
  }

  return content.reduce((total, part) => {
    switch (part._tag) {
      case 'Text':
        return total + estimateTextTokens(part.text, options)
      case 'Image':
      case 'Document':
      case 'Audio':
        return total + mediaPartTokens(options)
    }
  }, 0)
}

export const estimateAgentMessageTokens = (
  message: AgentMessage,
  options: TokenEstimateOptions = {}
) => {
  switch (message._tag) {
    case 'User':
    case 'ToolResult':
      return estimateContentTokens(message.content, options) + messageOverheadTokens(options)
    case 'Assistant':
      return (
        estimateContentTokens(assistantContent(message), options) +
        estimateTextTokens(assistantReasoningText(message), options) +
        assistantHostToolCalls(message).reduce(
          (total, call) =>
            total +
            estimateTextTokens(call.id, options) +
            estimateTextTokens(call.name, options) +
            messageOverheadTokens(options),
          0
        ) +
        messageOverheadTokens(options)
      )
  }
}

export const estimateAgentMessagesTokens = (
  messages: ReadonlyArray<AgentMessage>,
  options: TokenEstimateOptions = {}
) => messages.reduce((total, message) => total + estimateAgentMessageTokens(message, options), 0)
