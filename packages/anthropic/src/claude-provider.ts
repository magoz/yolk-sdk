import { Effect, Layer, Ref, Stream } from 'effect'
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
  readonly stream?: true
  readonly tools?: ReadonlyArray<AnthropicTool>
}

type AnthropicToolBlockState = {
  readonly id: string
  readonly name: string
  readonly partialJson: string
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

class AnthropicStreamUsageResponse extends Schema.Class<AnthropicStreamUsageResponse>(
  'AnthropicStreamUsageResponse'
)({
  input_tokens: Schema.optional(Schema.Number),
  output_tokens: Schema.optional(Schema.Number),
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
  config?: { readonly maxTokens?: number; readonly stream?: boolean }
): Effect.Effect<AnthropicRequestBody, LLMError> =>
  Effect.gen(function* () {
    const rawMessages = yield* Effect.forEach(request.messages, toAnthropicMessage)
    const messages = prependSystemPromptToFirstUserMessage(rawMessages, request.systemPrompt)
    const baseBody = {
      model: request.model,
      system: [anthropicClaudeIdentitySystemBlock],
      messages,
      max_tokens: config?.maxTokens ?? anthropicClaudeMaxTokens
    }
    const body: AnthropicRequestBody =
      config?.stream === true ? { ...baseBody, stream: true } : baseBody

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

const decodeJsonString = (raw: string, message: string) =>
  Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(raw).pipe(
    Effect.mapError(
      error =>
        new LLMError({
          cause: 'invalid_response',
          message: `${message}: ${unknownToMessage(error)}`,
          retryable: false
        })
    )
  )

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null

const field = (value: unknown, key: string) =>
  isRecord(value) ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined

const stringField = (value: unknown, key: string) => {
  const raw = field(value, key)
  return typeof raw === 'string' ? raw : undefined
}

const numberField = (value: unknown, key: string) => {
  const raw = field(value, key)
  return typeof raw === 'number' ? raw : undefined
}

const sseDataFromBlock = (block: string) =>
  block
    .split('\n')
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice('data:'.length).trimStart())
    .join('\n')
    .trim()

const dataFromSseBlock = (block: string) => {
  const data = sseDataFromBlock(block)

  if (data.length === 0 || data === '[DONE]') {
    return undefined
  }

  return data
}

const normalizeNewlines = (text: string) => text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')

const splitCompleteSseBlocks = (buffer: string) => {
  const blocks = buffer.split('\n\n')
  const tail = blocks.at(-1) ?? ''

  return { completeBlocks: blocks.slice(0, -1), tail }
}

const parseToolParams = (raw: string) => {
  const trimmed = raw.trim()

  if (trimmed.length === 0) return Effect.succeed({})

  return decodeJsonString(trimmed, 'Invalid Anthropic Claude tool arguments JSON')
}

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

const toPartialAgentUsage = (usage: AnthropicStreamUsageResponse) =>
  AgentUsage.make({
    input: AgentInputUsage.make({
      total: usage.input_tokens ?? 0,
      uncached:
        usage.input_tokens === undefined
          ? undefined
          : usage.input_tokens -
            (usage.cache_read_input_tokens ?? 0) -
            (usage.cache_creation_input_tokens ?? 0),
      cacheRead: usage.cache_read_input_tokens,
      cacheWrite: usage.cache_creation_input_tokens
    }),
    output: AgentOutputUsage.make({
      total: usage.output_tokens ?? 0,
      text: usage.output_tokens
    })
  })

const usageEventFromUnknown = (usage: unknown) => {
  const parsed = Schema.decodeUnknownOption(AnthropicStreamUsageResponse)(usage)

  if (parsed._tag === 'None') {
    return []
  }

  const value = parsed.value
  const hasUsage =
    value.input_tokens !== undefined ||
    value.output_tokens !== undefined ||
    value.cache_read_input_tokens !== undefined ||
    value.cache_creation_input_tokens !== undefined

  return hasUsage ? [LLMUsage.make({ usage: toPartialAgentUsage(value) })] : []
}

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

const decodeAnthropicMessageResponse = (json: unknown) =>
  Schema.decodeUnknownEffect(AnthropicMessageResponse)(json).pipe(
    Effect.mapError(
      error =>
        new LLMError({
          cause: 'invalid_response',
          message: `Invalid Anthropic Claude response: ${unknownToMessage(error)}`,
          retryable: false
        })
    )
  )

const parseAnthropicJsonResponse = (raw: string): Effect.Effect<ReadonlyArray<LLMEvent>, LLMError> =>
  Effect.gen(function* () {
    const json = yield* decodeJsonString(raw, 'Could not parse Anthropic Claude response JSON')
    const parsed = yield* decodeAnthropicMessageResponse(json)

    return yield* toLlmEvents(parsed)
  })

type AnthropicBodyFormat = 'undecided' | 'sse' | 'json'

type AnthropicSseState = {
  readonly hasToolCall: boolean
  readonly hasDone: boolean
}

type AnthropicSseStep = {
  readonly state: AnthropicSseState
  readonly events: ReadonlyArray<LLMEvent>
}

type AnthropicBodyState = {
  readonly format: AnthropicBodyFormat
  readonly buffer: string
  readonly sse: AnthropicSseState
}

const initialSseState: AnthropicSseState = {
  hasToolCall: false,
  hasDone: false
}

const initialBodyState: AnthropicBodyState = {
  format: 'undecided',
  buffer: '',
  sse: initialSseState
}

const classifyAnthropicBody = (buffer: string): AnthropicBodyFormat => {
  const trimmed = buffer.trimStart()

  if (trimmed.length === 0) {
    return 'undecided'
  }

  if (trimmed.startsWith('event:') || trimmed.startsWith('data:')) {
    return 'sse'
  }

  if ('event:'.startsWith(trimmed) || 'data:'.startsWith(trimmed)) {
    return 'undecided'
  }

  return 'json'
}

const invalidToolUseStartError = () =>
  new LLMError({
    cause: 'invalid_response',
    message: 'Invalid Anthropic Claude tool_use stream block',
    retryable: false
  })

const makeAnthropicStreamEmitter = () => {
  const toolBlocks = new Map<number, AnthropicToolBlockState>()

  return (state: AnthropicSseState, data: unknown): Effect.Effect<AnthropicSseStep, LLMError> => {
    const type = stringField(data, 'type')

    if (type === 'message_start') {
      const message = field(data, 'message')
      return Effect.succeed({ state, events: usageEventFromUnknown(field(message, 'usage')) })
    }

    if (type === 'content_block_start') {
      const index = numberField(data, 'index')
      const block = field(data, 'content_block')

      if (index !== undefined && stringField(block, 'type') === 'tool_use') {
        const id = stringField(block, 'id')
        const name = stringField(block, 'name')

        if (id === undefined || name === undefined) {
          return Effect.fail(invalidToolUseStartError())
        }

        toolBlocks.set(index, {
          id,
          name: unprefixClaudeToolName(name),
          partialJson: ''
        })
      }

      return Effect.succeed({ state, events: [] })
    }

    if (type === 'content_block_delta') {
      const index = numberField(data, 'index')
      const delta = field(data, 'delta')
      const deltaType = stringField(delta, 'type')
      const text = stringField(delta, 'text')
      const thinking = stringField(delta, 'thinking')
      const partialJson = stringField(delta, 'partial_json')

      if (deltaType === 'text_delta' && text !== undefined) {
        return Effect.succeed({ state, events: [LLMTextDelta.make({ text })] })
      }

      if (deltaType === 'thinking_delta' && thinking !== undefined) {
        return Effect.succeed({ state, events: [LLMReasoningDelta.make({ text: thinking })] })
      }

      if (index !== undefined && deltaType === 'input_json_delta' && partialJson !== undefined) {
        const current = toolBlocks.get(index)
        if (current !== undefined) {
          toolBlocks.set(index, { ...current, partialJson: `${current.partialJson}${partialJson}` })
        }
      }

      return Effect.succeed({ state, events: [] })
    }

    if (type === 'content_block_stop') {
      const index = numberField(data, 'index')
      const toolBlock = index === undefined ? undefined : toolBlocks.get(index)

      if (toolBlock === undefined) return Effect.succeed({ state, events: [] })

      return parseToolParams(toolBlock.partialJson).pipe(
        Effect.map(params => {
          if (index !== undefined) toolBlocks.delete(index)

          return {
            state: { ...state, hasToolCall: true },
            events: [
              LLMToolCall.make({
                call: ToolCall.make({
                  id: toolBlock.id,
                  name: toolBlock.name,
                  params
                })
              })
            ]
          }
        })
      )
    }

    if (type === 'message_delta') {
      return Effect.succeed({ state, events: usageEventFromUnknown(field(data, 'usage')) })
    }

    if (type === 'message_stop') {
      return Effect.succeed({
        state: { ...state, hasDone: true },
        events: [LLMDone.make({ stopReason: state.hasToolCall ? 'tool_use' : 'stop' })]
      })
    }

    if (type === 'error') {
      const error = field(data, 'error')
      return Effect.fail(
        new LLMError({
          cause: 'provider_error',
          message: stringField(error, 'message') ?? 'Anthropic Claude stream error',
          retryable: false
        })
      )
    }

    return Effect.succeed({ state, events: [] })
  }
}

const processSseData = (
  emitData: ReturnType<typeof makeAnthropicStreamEmitter>,
  state: AnthropicSseState,
  data: string
): Effect.Effect<AnthropicSseStep, LLMError> =>
  decodeJsonString(data, 'Could not parse Anthropic Claude stream event JSON').pipe(
    Effect.flatMap(parsed => emitData(state, parsed))
  )

const processSseBlock = (
  emitData: ReturnType<typeof makeAnthropicStreamEmitter>,
  state: AnthropicSseState,
  block: string
): Effect.Effect<AnthropicSseStep, LLMError> => {
  const data = dataFromSseBlock(block)

  if (data === undefined) {
    return Effect.succeed({ state, events: [] })
  }

  return processSseData(emitData, state, data)
}

const processSseBlocks = (
  emitData: ReturnType<typeof makeAnthropicStreamEmitter>,
  state: AnthropicSseState,
  blocks: ReadonlyArray<string>
): Effect.Effect<AnthropicSseStep, LLMError> =>
  Effect.gen(function* () {
    const events: Array<LLMEvent> = []
    let currentState = state

    for (const block of blocks) {
      const step = yield* processSseBlock(emitData, currentState, block)
      currentState = step.state
      events.push(...step.events)
    }

    return { state: currentState, events }
  })

const processBodyChunk = (
  emitData: ReturnType<typeof makeAnthropicStreamEmitter>,
  state: AnthropicBodyState,
  chunk: string
): Effect.Effect<AnthropicSseStep & { readonly bodyState: AnthropicBodyState }, LLMError> =>
  Effect.gen(function* () {
    const buffer = normalizeNewlines(`${state.buffer}${chunk}`)
    const format = state.format === 'undecided' ? classifyAnthropicBody(buffer) : state.format

    if (format !== 'sse') {
      return {
        state: state.sse,
        bodyState: { ...state, format, buffer },
        events: []
      }
    }

    const split = splitCompleteSseBlocks(buffer)
    const step = yield* processSseBlocks(emitData, state.sse, split.completeBlocks)

    return {
      state: step.state,
      bodyState: { format, buffer: split.tail, sse: step.state },
      events: step.events
    }
  })

const finalizeBodyState = (
  emitData: ReturnType<typeof makeAnthropicStreamEmitter>,
  state: AnthropicBodyState
): Effect.Effect<ReadonlyArray<LLMEvent>, LLMError> =>
  Effect.gen(function* () {
    const buffer = normalizeNewlines(state.buffer)
    const format = state.format === 'undecided' ? classifyAnthropicBody(buffer) : state.format

    if (format === 'json') {
      return yield* parseAnthropicJsonResponse(buffer)
    }

    const events: Array<LLMEvent> = []
    let sseState = state.sse

    if (format === 'sse') {
      const split = splitCompleteSseBlocks(buffer)
      const step = yield* processSseBlocks(emitData, sseState, split.completeBlocks)
      sseState = step.state
      events.push(...step.events)

      if (split.tail.trim().length > 0) {
        const tailStep = yield* processSseBlock(emitData, sseState, split.tail)
        sseState = tailStep.state
        events.push(...tailStep.events)
      }
    }

    if (!sseState.hasDone) {
      events.push(LLMDone.make({ stopReason: sseState.hasToolCall ? 'tool_use' : 'stop' }))
    }

    return events
  })

export const streamAnthropicClaudeResponse = (
  response: HttpClientResponse.HttpClientResponse
): Stream.Stream<LLMEvent, LLMError> =>
  Stream.unwrap(
    Ref.make(initialBodyState).pipe(
      Effect.map(bodyStateRef => {
        const emitData = makeAnthropicStreamEmitter()
        const chunks = response.stream.pipe(
          Stream.mapError(toHttpClientLlmError('Could not read Anthropic Claude stream', false)),
          Stream.decodeText,
          Stream.mapEffect(chunk =>
            Effect.gen(function* () {
              const state = yield* Ref.get(bodyStateRef)
              const step = yield* processBodyChunk(emitData, state, chunk)
              yield* Ref.set(bodyStateRef, step.bodyState)
              return step.events
            })
          ),
          Stream.flatMap(events => Stream.fromIterable(events))
        )
        const finalEvents = Stream.fromEffect(
          Ref.get(bodyStateRef).pipe(Effect.flatMap(state => finalizeBodyState(emitData, state)))
        ).pipe(
          Stream.flatMap(events => Stream.fromIterable(events))
        )

        return chunks.pipe(Stream.concat(finalEvents))
      })
    )
  )

const sendAnthropicClaudeRequest = (
  config: AnthropicClaudeProviderConfig,
  request: LLMRequest,
  client: HttpClient.HttpClient
): Effect.Effect<HttpClientResponse.HttpClientResponse, LLMError> =>
  Effect.gen(function* () {
    const body = yield* toAnthropicClaudeRequestBody(request, { ...config, stream: true })
    const serializedBody = yield* encodeJsonString(body, 'Could not serialize Anthropic Claude request')
    const httpRequest = HttpClientRequest.post(config.messagesUrl ?? anthropicClaudeMessagesUrl).pipe(
      HttpClientRequest.setHeaders({
        accept: 'text/event-stream',
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

    return response
  }).pipe(Effect.withSpan('AnthropicClaudeProvider.stream'))

export const makeAnthropicClaudeProviderLayer = (config: AnthropicClaudeProviderConfig) =>
  Layer.effect(
    LLMProvider,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient

      return LLMProvider.of({
        stream: request =>
          Stream.fromEffect(sendAnthropicClaudeRequest(config, request, client)).pipe(
            Stream.flatMap(streamAnthropicClaudeResponse)
          )
      })
    })
  )
