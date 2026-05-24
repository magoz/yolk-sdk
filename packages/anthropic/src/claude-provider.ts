import { Effect, Layer, Stream } from 'effect'
import {
  HttpClient,
  HttpClientRequest,
  type HttpClientError,
  type HttpClientResponse
} from 'effect/unstable/http'
import * as Schema from 'effect/Schema'
import {
  AgentInputUsage,
  AgentOutputUsage,
  AgentUsage,
  ToolCall,
  assistantContent,
  assistantHostToolCalls,
  type AgentMessage,
  type Content,
  type ContentPart,
  type ToolDef
} from '@yolk-sdk/agent/protocol'
import {
  LLMError,
  LLMDone,
  LLMProvider,
  LLMReasoningDelta,
  LLMTextDelta,
  LLMToolCall,
  LLMUsage,
  type LLMEvent,
  type LLMRequest
} from '@yolk-sdk/agent/loop'
import { anthropicClaudeAuthorizationHeaders, anthropicClaudeOAuthUserAgent } from './claude.ts'
import type { OAuthAccessToken } from '@yolk-sdk/oauth'

export type AnthropicClaudeProviderConfig = {
  readonly token: OAuthAccessToken
  readonly messagesUrl?: string
  readonly maxTokens?: number
  readonly extraHeaders?: Readonly<Record<string, string>>
}

type AnthropicTextBlock = {
  readonly type: 'text'
  readonly text: string
}

type AnthropicSystemBlock = AnthropicTextBlock

type AnthropicImageBlock = {
  readonly type: 'image'
  readonly source: {
    readonly type: 'base64'
    readonly media_type: string
    readonly data: string
  }
}

type AnthropicToolUseBlock = {
  readonly type: 'tool_use'
  readonly id: string
  readonly name: string
  readonly input: unknown
}

type AnthropicToolResultBlock = {
  readonly type: 'tool_result'
  readonly tool_use_id: string
  readonly content: string
  readonly is_error?: boolean
}

type AnthropicUserBlock = AnthropicTextBlock | AnthropicImageBlock | AnthropicToolResultBlock
type AnthropicAssistantBlock = AnthropicTextBlock | AnthropicToolUseBlock

type AnthropicMessage =
  | { readonly role: 'user'; readonly content: string | ReadonlyArray<AnthropicUserBlock> }
  | { readonly role: 'assistant'; readonly content: ReadonlyArray<AnthropicAssistantBlock> }

type AnthropicTool = {
  readonly name: string
  readonly description: string
  readonly input_schema: unknown
}

type AnthropicRequestBody = {
  readonly model: string
  readonly system: ReadonlyArray<AnthropicSystemBlock>
  readonly messages: ReadonlyArray<AnthropicMessage>
  readonly max_tokens: number
  readonly tools?: ReadonlyArray<AnthropicTool>
}

const anthropicClaudeSystemIdentity = "You are Claude Code, Anthropic's official CLI for Claude."
const anthropicClaudeToolPrefix = 'mcp_'
const anthropicClaudeVersion = '2023-06-01'
const anthropicClaudeOAuthBeta = 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14'

// Claude subscription OAuth is fingerprinted against Claude Code tool names.
const prefixClaudeToolName = (name: string) =>
  `${anthropicClaudeToolPrefix}${name.charAt(0).toUpperCase()}${name.slice(1)}`

const unprefixClaudeToolName = (name: string) => {
  if (!name.startsWith(anthropicClaudeToolPrefix)) {
    return name
  }

  const unprefixed = name.slice(anthropicClaudeToolPrefix.length)

  return `${unprefixed.charAt(0).toLowerCase()}${unprefixed.slice(1)}`
}

const anthropicClaudeMessagesUrl = 'https://api.anthropic.com/v1/messages?beta=true'
const anthropicClaudeMaxTokens = 8192
const anthropicClaudeIdentitySystemBlock: AnthropicSystemBlock = {
  type: 'text',
  text: anthropicClaudeSystemIdentity
}

// Keep app instructions out of `system[]`; Anthropic can reject/limit otherwise.
const prependSystemPromptToFirstUserMessage = (
  messages: ReadonlyArray<AnthropicMessage>,
  systemPrompt: string
): ReadonlyArray<AnthropicMessage> => {
  if (systemPrompt.trim().length === 0) {
    return messages
  }

  let relocated = false

  return messages.map(message => {
    if (relocated || message.role !== 'user') {
      return message
    }

    relocated = true

    if (typeof message.content === 'string') {
      return { ...message, content: `${systemPrompt}\n\n${message.content}` }
    }

    return { ...message, content: [{ type: 'text', text: systemPrompt }, ...message.content] }
  })
}

class AnthropicTextResponseBlock extends Schema.Class<AnthropicTextResponseBlock>(
  'AnthropicTextResponseBlock'
)({
  type: Schema.Literal('text'),
  text: Schema.String
}) {}

class AnthropicThinkingResponseBlock extends Schema.Class<AnthropicThinkingResponseBlock>(
  'AnthropicThinkingResponseBlock'
)({
  type: Schema.Literal('thinking'),
  thinking: Schema.String
}) {}

class AnthropicToolUseResponseBlock extends Schema.Class<AnthropicToolUseResponseBlock>(
  'AnthropicToolUseResponseBlock'
)({
  type: Schema.Literal('tool_use'),
  id: Schema.String,
  name: Schema.String,
  input: Schema.Unknown
}) {}

const AnthropicContentResponseBlock = Schema.Union([
  AnthropicTextResponseBlock,
  AnthropicThinkingResponseBlock,
  AnthropicToolUseResponseBlock
])

class AnthropicUsageResponse extends Schema.Class<AnthropicUsageResponse>('AnthropicUsageResponse')({
  input_tokens: Schema.Number,
  output_tokens: Schema.Number,
  cache_read_input_tokens: Schema.optional(Schema.Number),
  cache_creation_input_tokens: Schema.optional(Schema.Number)
}) {}

class AnthropicMessageResponse extends Schema.Class<AnthropicMessageResponse>(
  'AnthropicMessageResponse'
)({
  content: Schema.Array(AnthropicContentResponseBlock),
  stop_reason: Schema.NullOr(Schema.String),
  usage: Schema.optional(AnthropicUsageResponse)
}) {}

const unknownToMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

const encodeJsonString = (value: unknown, message: string) =>
  Schema.encodeUnknownEffect(Schema.UnknownFromJsonString)(value).pipe(
    Effect.mapError(
      error =>
        new LLMError({
          cause: 'provider_error',
          message: `${message}: ${unknownToMessage(error)}`,
          retryable: false
        })
    )
  )

const unsupportedContentError = (contentType: string) =>
  new LLMError({
    cause: 'provider_error',
    message: `${contentType} content is not supported by the Anthropic Claude provider yet`,
    retryable: false
  })

const contentPartToUserBlock = (part: ContentPart): Effect.Effect<AnthropicUserBlock, LLMError> => {
  switch (part._tag) {
    case 'Text':
      return Effect.succeed({ type: 'text', text: part.text })
    case 'Image':
      return Effect.succeed({
        type: 'image',
        source: {
          type: 'base64',
          media_type: part.mimeType,
          data: part.data
        }
      })
    case 'Audio':
      return Effect.fail(unsupportedContentError('Audio'))
  }
}

const contentToUserContent = (
  content: Content
): Effect.Effect<string | ReadonlyArray<AnthropicUserBlock>, LLMError> =>
  typeof content === 'string' ? Effect.succeed(content) : Effect.forEach(content, contentPartToUserBlock)

const contentPartToText = (part: ContentPart, owner: string): Effect.Effect<string, LLMError> => {
  switch (part._tag) {
    case 'Text':
      return Effect.succeed(part.text)
    case 'Image':
      return Effect.fail(unsupportedContentError(`${owner} image`))
    case 'Audio':
      return Effect.fail(unsupportedContentError(`${owner} audio`))
  }
}

const contentToText = (content: Content, owner: string): Effect.Effect<string, LLMError> =>
  typeof content === 'string'
    ? Effect.succeed(content)
    : Effect.forEach(content, part => contentPartToText(part, owner)).pipe(
        Effect.map(textParts => textParts.join('\n'))
      )

const toolCallToAnthropicBlock = (call: ToolCall): AnthropicToolUseBlock => ({
  type: 'tool_use',
  id: call.id,
  name: prefixClaudeToolName(call.name),
  input: call.params
})

const toAnthropicMessage = (message: AgentMessage): Effect.Effect<AnthropicMessage, LLMError> =>
  Effect.gen(function* () {
    switch (message._tag) {
      case 'User':
        return { role: 'user', content: yield* contentToUserContent(message.content) }
      case 'Assistant': {
        const text = yield* contentToText(assistantContent(message), 'Assistant')
        const textBlocks: ReadonlyArray<AnthropicTextBlock> =
          text.length === 0 ? [] : [{ type: 'text', text }]
        const toolBlocks = assistantHostToolCalls(message).map(toolCallToAnthropicBlock)
        return { role: 'assistant', content: [...textBlocks, ...toolBlocks] }
      }
      case 'ToolResult':
        return {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: message.toolCallId,
              content: yield* contentToText(message.content, 'Tool result'),
              is_error: message.isError
            }
          ]
        }
    }
  })

const toAnthropicTool = (tool: ToolDef): AnthropicTool => ({
  name: prefixClaudeToolName(tool.name),
  description: tool.description,
  input_schema: tool.parameters
})

export const toAnthropicClaudeRequestBody = (
  request: LLMRequest,
  config?: { readonly maxTokens?: number }
): Effect.Effect<AnthropicRequestBody, LLMError> =>
  Effect.gen(function* () {
    const rawMessages = yield* Effect.forEach(request.messages, toAnthropicMessage)
    const messages = prependSystemPromptToFirstUserMessage(rawMessages, request.systemPrompt)
    const body = {
      model: request.model,
      system: [anthropicClaudeIdentitySystemBlock],
      messages,
      max_tokens: config?.maxTokens ?? anthropicClaudeMaxTokens
    }

    if (request.tools.length === 0) {
      return body
    }

    return {
      ...body,
      tools: request.tools.map(toAnthropicTool)
    }
  })

const responseStatusToCause = (status: number): LLMError['cause'] => {
  if (status === 429) {
    return 'rate_limit'
  }

  if (status === 413 || status === 400) {
    return 'context_overflow'
  }

  return 'provider_error'
}

const isRetryableStatus = (status: number) => status === 429 || status >= 500

const toHttpClientLlmError =
  (message: string, retryable: boolean) => (error: HttpClientError.HttpClientError) =>
    new LLMError({
      cause: 'provider_error',
      message: `${message}: ${error.message}`,
      retryable
    })

const parseAnthropicResponseJson = (
  response: HttpClientResponse.HttpClientResponse
): Effect.Effect<unknown, LLMError> =>
  response.json.pipe(
    Effect.mapError(
      error =>
        new LLMError({
          cause: 'invalid_response',
          message: `Could not parse Anthropic Claude response JSON: ${error.message}`,
          retryable: false
        })
    )
  )

const toAgentUsage = (usage: AnthropicUsageResponse) =>
  AgentUsage.make({
    input: AgentInputUsage.make({
      total: usage.input_tokens,
      uncached:
        usage.input_tokens -
        (usage.cache_read_input_tokens ?? 0) -
        (usage.cache_creation_input_tokens ?? 0),
      cacheRead: usage.cache_read_input_tokens,
      cacheWrite: usage.cache_creation_input_tokens
    }),
    output: AgentOutputUsage.make({
      total: usage.output_tokens,
      text: usage.output_tokens
    })
  })

const toLlmEvents = (
  response: AnthropicMessageResponse
): Effect.Effect<ReadonlyArray<LLMEvent>, LLMError> =>
  Effect.gen(function* () {
    const events = yield* Effect.forEach(response.content, block => {
      switch (block.type) {
        case 'text':
          return Effect.succeed<LLMEvent>(LLMTextDelta.make({ text: block.text }))
        case 'thinking':
          return Effect.succeed<LLMEvent>(LLMReasoningDelta.make({ text: block.thinking }))
        case 'tool_use':
          return Effect.succeed<LLMEvent>(
            LLMToolCall.make({
              call: ToolCall.make({
                id: block.id,
                name: unprefixClaudeToolName(block.name),
                params: block.input
              })
            })
          )
      }
    })
    const stopReason = response.stop_reason === 'tool_use' ? 'tool_use' : 'stop'
    const usageEvent =
      response.usage === undefined ? [] : [LLMUsage.make({ usage: toAgentUsage(response.usage) })]

    return [...events, LLMDone.make({ stopReason }), ...usageEvent]
  })

const sendAnthropicClaudeRequest = (
  config: AnthropicClaudeProviderConfig,
  request: LLMRequest,
  client: HttpClient.HttpClient
): Effect.Effect<ReadonlyArray<LLMEvent>, LLMError> =>
  Effect.gen(function* () {
    const body = yield* toAnthropicClaudeRequestBody(request, config)
    const serializedBody = yield* encodeJsonString(body, 'Could not serialize Anthropic Claude request')
    const httpRequest = HttpClientRequest.post(config.messagesUrl ?? anthropicClaudeMessagesUrl).pipe(
      HttpClientRequest.setHeaders({
        accept: 'application/json',
        ...anthropicClaudeAuthorizationHeaders(config.token),
        'anthropic-beta': anthropicClaudeOAuthBeta,
        'anthropic-version': anthropicClaudeVersion,
        'content-type': 'application/json',
        'user-agent': anthropicClaudeOAuthUserAgent,
        'x-app': 'cli',
        ...config.extraHeaders
      }),
      HttpClientRequest.bodyText(serializedBody, 'application/json')
    )
    const response = yield* client
      .execute(httpRequest)
      .pipe(Effect.mapError(toHttpClientLlmError('Anthropic Claude request failed', true)))

    if (response.status < 200 || response.status >= 300) {
      const errorText = yield* response.text.pipe(
        Effect.mapError(
          error =>
            new LLMError({
              cause: 'provider_error',
              message: `Could not read Anthropic Claude error body: ${error.message}`,
              retryable: false
            })
        )
      )

      return yield* Effect.fail(
        new LLMError({
          cause: responseStatusToCause(response.status),
          message: `Anthropic Claude returned ${response.status}: ${errorText}`,
          retryable: isRetryableStatus(response.status)
        })
      )
    }

    const json = yield* parseAnthropicResponseJson(response)
    const parsed = yield* Schema.decodeUnknownEffect(AnthropicMessageResponse)(json).pipe(
      Effect.mapError(
        error =>
          new LLMError({
            cause: 'invalid_response',
            message: `Invalid Anthropic Claude response: ${unknownToMessage(error)}`,
            retryable: false
          })
      )
    )

    return yield* toLlmEvents(parsed)
  }).pipe(Effect.withSpan('AnthropicClaudeProvider.stream'))

export const makeAnthropicClaudeProviderLayer = (config: AnthropicClaudeProviderConfig) =>
  Layer.effect(
    LLMProvider,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient

      return LLMProvider.of({
        stream: request =>
          Stream.fromEffect(sendAnthropicClaudeRequest(config, request, client)).pipe(
            Stream.flatMap(events => Stream.fromIterable(events))
          )
      })
    })
  )
