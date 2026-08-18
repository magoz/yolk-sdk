import { Array as Arr, Effect, Layer, Option, Ref, Stream } from 'effect'
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
  attachmentSourceDataUrl,
  attachmentSourceUrl,
  assistantContent,
  assistantHostToolCalls,
  contentParts,
  messageContextText,
  replaceLoneSurrogatesDeep,
  prependMessageContextToContent,
  type AgentMessage,
  type AgentReasoningEffort,
  type Content,
  type ContentPart,
  type ProviderFailureKind,
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
import type { OAuthAccessToken } from '@yolk-sdk/agent/oauth'
import {
  classifyProviderFailure,
  providerErrorInfo,
  providerFailureCause,
  providerFailureRetryable
} from './provider-error.ts'
import { validateProviderTranscript } from './transcript.ts'

type OpenAiResponsesReasoningSummary = 'auto' | 'concise' | 'detailed'

export type OpenAiResponsesProviderConfig = {
  readonly token: OAuthAccessToken
  readonly providerId: string
  readonly providerName: string
  readonly responsesUrl: string
  readonly authorizationHeaders: (
    token: OAuthAccessToken,
    model: string
  ) => Readonly<Record<string, string>>
  readonly alwaysIncludeReasoning: boolean
  readonly allowEofCompletion: boolean
  readonly unsupportedContentProviderName?: string
  readonly expectedTokenProvider?: string
  readonly maxOutputTokens?: number
  readonly extraHeaders?: Readonly<Record<string, string>>
  readonly defaultReasoningEffort?: AgentReasoningEffort
  readonly reasoningSummary?: OpenAiResponsesReasoningSummary
}

type OpenAiResponsesMessageInput = {
  readonly role: 'user' | 'assistant'
  readonly content: string | ReadonlyArray<OpenAiResponsesInputContentPart>
}

type OpenAiResponsesInputTextPart = {
  readonly type: 'input_text'
  readonly text: string
}

type OpenAiResponsesInputImagePart = {
  readonly type: 'input_image'
  readonly image_url: string
}

type OpenAiResponsesInputFilePart =
  | {
      readonly type: 'input_file'
      readonly filename: string
      readonly file_data: string
    }
  | {
      readonly type: 'input_file'
      readonly file_url: string
    }

type OpenAiResponsesInputContentPart =
  | OpenAiResponsesInputTextPart
  | OpenAiResponsesInputImagePart
  | OpenAiResponsesInputFilePart

type OpenAiResponsesFunctionOutput = string | ReadonlyArray<OpenAiResponsesInputContentPart>

type OpenAiResponsesFunctionCallInput = {
  readonly type: 'function_call'
  readonly call_id: string
  readonly name: string
  readonly arguments: string
}

type OpenAiResponsesFunctionOutputInput = {
  readonly type: 'function_call_output'
  readonly call_id: string
  readonly output: OpenAiResponsesFunctionOutput
}

type OpenAiResponsesInputItem =
  | OpenAiResponsesMessageInput
  | OpenAiResponsesFunctionCallInput
  | OpenAiResponsesFunctionOutputInput

type OpenAiResponsesTool = {
  readonly type: 'function'
  readonly name: string
  readonly description: string
  readonly parameters: unknown
}

type OpenAiResponsesRequestBody = {
  readonly model: string
  readonly instructions: string
  readonly input: ReadonlyArray<OpenAiResponsesInputItem>
  readonly store: false
  readonly stream: true
  readonly max_output_tokens?: number
  readonly reasoning?: {
    readonly effort: AgentReasoningEffort
    readonly summary: OpenAiResponsesReasoningSummary
  }
  readonly tools?: ReadonlyArray<OpenAiResponsesTool>
  readonly parallel_tool_calls?: true
}

type OpenAiResponsesRequestBodyWithReasoning = OpenAiResponsesRequestBody & {
  readonly reasoning: NonNullable<OpenAiResponsesRequestBody['reasoning']>
}

class OpenAiResponsesReasoningSummaryText extends Schema.Class<OpenAiResponsesReasoningSummaryText>(
  'OpenAiResponsesReasoningSummaryText'
)({
  type: Schema.Literals(['summary_text']),
  text: Schema.String
}) {}

class OpenAiResponsesReasoningText extends Schema.Class<OpenAiResponsesReasoningText>(
  'OpenAiResponsesReasoningText'
)({
  type: Schema.Literals(['reasoning_text']),
  text: Schema.String
}) {}

class OpenAiResponsesOutputText extends Schema.Class<OpenAiResponsesOutputText>(
  'OpenAiResponsesOutputText'
)({
  type: Schema.Literals(['output_text']),
  text: Schema.String
}) {}

class OpenAiResponsesMessageOutput extends Schema.Class<OpenAiResponsesMessageOutput>(
  'OpenAiResponsesMessageOutput'
)({
  type: Schema.Literals(['message']),
  content: Schema.Array(OpenAiResponsesOutputText)
}) {}

class OpenAiResponsesFunctionCallOutput extends Schema.Class<OpenAiResponsesFunctionCallOutput>(
  'OpenAiResponsesFunctionCallOutput'
)({
  type: Schema.Literals(['function_call']),
  call_id: Schema.String,
  name: Schema.String,
  arguments: Schema.String
}) {}

class OpenAiResponsesReasoningOutput extends Schema.Class<OpenAiResponsesReasoningOutput>(
  'OpenAiResponsesReasoningOutput'
)({
  type: Schema.Literals(['reasoning']),
  summary: Schema.optional(Schema.Array(OpenAiResponsesReasoningSummaryText)),
  content: Schema.optional(Schema.Array(OpenAiResponsesReasoningText))
}) {}

class OpenAiResponsesInputTokensDetails extends Schema.Class<OpenAiResponsesInputTokensDetails>(
  'OpenAiResponsesInputTokensDetails'
)({
  cached_tokens: Schema.optional(Schema.Number)
}) {}

class OpenAiResponsesOutputTokensDetails extends Schema.Class<OpenAiResponsesOutputTokensDetails>(
  'OpenAiResponsesOutputTokensDetails'
)({
  reasoning_tokens: Schema.optional(Schema.Number)
}) {}

class OpenAiResponsesUsageResponse extends Schema.Class<OpenAiResponsesUsageResponse>(
  'OpenAiResponsesUsageResponse'
)({
  input_tokens: Schema.Number,
  output_tokens: Schema.Number,
  input_tokens_details: Schema.optional(OpenAiResponsesInputTokensDetails),
  output_tokens_details: Schema.optional(OpenAiResponsesOutputTokensDetails)
}) {}

const OpenAiResponsesOutputItem = Schema.Union([
  OpenAiResponsesMessageOutput,
  OpenAiResponsesFunctionCallOutput,
  OpenAiResponsesReasoningOutput
])
type OpenAiResponsesOutputItem = typeof OpenAiResponsesOutputItem.Type

class OpenAiResponsesResponse extends Schema.Class<OpenAiResponsesResponse>(
  'OpenAiResponsesResponse'
)({
  output_text: Schema.optional(Schema.String),
  output: Schema.Array(OpenAiResponsesOutputItem),
  usage: Schema.optional(OpenAiResponsesUsageResponse)
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

const unsupportedContentError = (contentType: string, providerName: string) =>
  new LLMError({
    cause: 'provider_error',
    message: `${contentType} content is not supported by the ${providerName} provider yet`,
    retryable: false
  })

const contentPartToText = (
  part: ContentPart,
  owner: string,
  providerName: string
): Effect.Effect<string, LLMError> => {
  switch (part._tag) {
    case 'Text':
      return Effect.succeed(part.text)
    case 'Image':
      return Effect.fail(unsupportedContentError(`${owner} image`, providerName))
    case 'Document':
      return Effect.fail(unsupportedContentError(`${owner} document`, providerName))
    case 'Audio':
      return Effect.fail(unsupportedContentError(`${owner} audio`, providerName))
  }
}

const contentToText = (
  content: Content,
  owner: string,
  providerName: string
): Effect.Effect<string, LLMError> =>
  typeof content === 'string'
    ? Effect.succeed(content)
    : Effect.forEach(content, part => contentPartToText(part, owner, providerName)).pipe(
        Effect.map(textParts => textParts.join('\n'))
      )

const contentPartToResponsesInputPart = (
  part: ContentPart,
  providerName: string
): Effect.Effect<
  OpenAiResponsesInputTextPart | OpenAiResponsesInputImagePart | OpenAiResponsesInputFilePart,
  LLMError
> => {
  switch (part._tag) {
    case 'Text':
      return Effect.succeed({ type: 'input_text', text: part.text })
    case 'Image':
      return Option.match(attachmentSourceUrl(part.source, part.mimeType), {
        onNone: () => Effect.fail(unsupportedContentError('Unresolved image source', providerName)),
        onSome: url =>
          Effect.succeed({
            type: 'input_image',
            image_url: url
          })
      })
    case 'Document':
      switch (part.source._tag) {
        case 'InlineBase64':
          return Option.match(attachmentSourceDataUrl(part.source, part.mimeType), {
            onNone: () =>
              Effect.fail(unsupportedContentError('Invalid document source', providerName)),
            onSome: url =>
              Effect.succeed({
                type: 'input_file',
                filename: part.filename,
                file_data: url
              })
          })
        case 'Url':
          return Effect.succeed({ type: 'input_file', file_url: part.source.url })
        case 'Ref':
          return Effect.fail(unsupportedContentError('Unresolved document source', providerName))
      }
    case 'Audio':
      return Effect.fail(unsupportedContentError('Audio', providerName))
  }
}

const contentToUserInput = (
  content: Content,
  providerName: string
): Effect.Effect<OpenAiResponsesMessageInput['content'], LLMError> => {
  if (typeof content === 'string') {
    return Effect.succeed(content)
  }

  const parts = contentParts(content)
  const onlyPart = parts[0]

  if (onlyPart !== undefined && parts.length === 1 && onlyPart._tag === 'Text') {
    return Effect.succeed(onlyPart.text)
  }

  return Effect.forEach(parts, part => contentPartToResponsesInputPart(part, providerName))
}

const contentToResponsesFunctionOutput = (
  content: Content,
  providerName: string
): Effect.Effect<OpenAiResponsesFunctionOutput, LLMError> =>
  typeof content === 'string'
    ? Effect.succeed(content)
    : Effect.forEach(content, part => contentPartToResponsesInputPart(part, providerName))

const responsesToolResultOutput = (
  content: Content,
  isError: boolean | undefined,
  providerName: string
): Effect.Effect<OpenAiResponsesFunctionOutput, LLMError> =>
  contentToResponsesFunctionOutput(content, providerName).pipe(
    Effect.map(output => {
      if (isError !== true) return output

      const errorPart: OpenAiResponsesInputTextPart = {
        type: 'input_text',
        text: 'Tool execution failed.'
      }

      return typeof output === 'string' ? `${errorPart.text}\n\n${output}` : [errorPart, ...output]
    })
  )

const serializeToolArguments = (params: unknown) =>
  encodeJsonString(params, 'Could not serialize OpenAI Responses tool arguments')

const toolCallToResponsesInput = (
  call: ToolCall
): Effect.Effect<OpenAiResponsesFunctionCallInput, LLMError> =>
  Effect.gen(function* () {
    return {
      type: 'function_call',
      call_id: call.id,
      name: call.name,
      arguments: yield* serializeToolArguments(call.params)
    }
  })

const messageToResponsesInput = (
  message: AgentMessage,
  providerName: string
): Effect.Effect<ReadonlyArray<OpenAiResponsesInputItem>, LLMError> =>
  Effect.gen(function* () {
    switch (message._tag) {
      case 'User':
        return [
          {
            role: 'user',
            content: yield* contentToUserInput(
              prependMessageContextToContent(message.content, messageContextText(message)),
              providerName
            )
          }
        ]
      case 'Assistant': {
        const content = yield* contentToText(
          prependMessageContextToContent(assistantContent(message), messageContextText(message)),
          'Assistant',
          providerName
        )
        const toolCallInputs = yield* Effect.forEach(
          assistantHostToolCalls(message),
          toolCallToResponsesInput
        )

        if (content.length > 0) {
          const assistantMessage: OpenAiResponsesInputItem = { role: 'assistant', content }

          return [assistantMessage, ...toolCallInputs]
        }

        return toolCallInputs
      }
      case 'ToolResult':
        return [
          {
            type: 'function_call_output',
            call_id: message.toolCallId,
            output: yield* responsesToolResultOutput(
              prependMessageContextToContent(message.content, messageContextText(message)),
              message.isError,
              providerName
            )
          }
        ]
    }
  })

const toOpenAiResponsesTool = (tool: ToolDef): OpenAiResponsesTool => ({
  type: 'function',
  name: tool.name,
  description: tool.description,
  parameters: tool.parameters
})

export const toOpenAiResponsesRequestBody = (
  request: LLMRequest,
  config: {
    readonly providerName: string
    readonly unsupportedContentProviderName?: string
    readonly alwaysIncludeReasoning: boolean
    readonly maxOutputTokens?: number
    readonly defaultReasoningEffort?: AgentReasoningEffort
    readonly reasoningSummary?: OpenAiResponsesReasoningSummary
  }
): Effect.Effect<OpenAiResponsesRequestBody, LLMError> =>
  Effect.gen(function* () {
    if (
      config.maxOutputTokens !== undefined &&
      (!Number.isSafeInteger(config.maxOutputTokens) || config.maxOutputTokens <= 0)
    ) {
      return yield* Effect.fail(
        new LLMError({
          cause: 'validation_error',
          message: 'OpenAI Responses maxOutputTokens must be a positive safe integer',
          retryable: false
        })
      )
    }

    yield* validateProviderTranscript(request.messages)
    const input = Arr.flatten(
      yield* Effect.forEach(request.messages, message =>
        messageToResponsesInput(
          message,
          config.unsupportedContentProviderName ?? config.providerName
        )
      )
    )
    const reasoningEffort = request.reasoningEffort ?? config.defaultReasoningEffort
    const reasoning =
      config.alwaysIncludeReasoning || reasoningEffort !== undefined
        ? {
            effort: reasoningEffort ?? 'low',
            summary: config.reasoningSummary ?? 'auto'
          }
        : undefined

    const body: Omit<OpenAiResponsesRequestBody, 'tools'> = {
      model: request.model,
      instructions: request.systemPrompt,
      input,
      store: false,
      stream: true,
      ...(config.maxOutputTokens === undefined
        ? {}
        : { max_output_tokens: config.maxOutputTokens }),
      ...(reasoning === undefined ? {} : { reasoning })
    }

    if (request.tools.length === 0) {
      return body
    }

    return {
      ...body,
      tools: request.tools.map(toOpenAiResponsesTool),
      parallel_tool_calls: true
    }
  })

export const toOpenAiResponsesRequestBodyWithReasoning = (
  request: LLMRequest,
  config: {
    readonly providerName: string
    readonly unsupportedContentProviderName?: string
    readonly maxOutputTokens?: number
    readonly defaultReasoningEffort?: AgentReasoningEffort
    readonly reasoningSummary?: OpenAiResponsesReasoningSummary
  }
): Effect.Effect<OpenAiResponsesRequestBodyWithReasoning, LLMError> =>
  toOpenAiResponsesRequestBody(request, {
    ...config,
    alwaysIncludeReasoning: true
  }).pipe(
    Effect.flatMap(body =>
      body.reasoning === undefined
        ? Effect.fail(
            new LLMError({
              cause: 'invalid_response',
              message: 'OpenAI Responses reasoning configuration was not lowered',
              retryable: false
            })
          )
        : Effect.succeed({ ...body, reasoning: body.reasoning })
    )
  )

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const stringField = (value: unknown, key: string) => {
  if (!isRecord(value)) {
    return undefined
  }

  const field = Object.getOwnPropertyDescriptor(value, key)?.value

  return typeof field === 'string' ? field : undefined
}

const recordField = (value: unknown, key: string) => {
  if (!isRecord(value)) {
    return undefined
  }

  const field = Object.getOwnPropertyDescriptor(value, key)?.value

  return isRecord(field) ? field : undefined
}

type OpenAiResponsesProviderDescriptor = {
  readonly providerId: string
  readonly providerName: string
  readonly allowEofCompletion: boolean
}

export const withOpenAiResponsesProviderName = (providerName: string, error: LLMError) =>
  new LLMError({
    cause: error.cause,
    message: error.message.replaceAll('OpenAI Responses', providerName),
    retryable: error.retryable,
    ...(error.provider === undefined ? {} : { provider: error.provider })
  })

const providerSignalError = (
  descriptor: OpenAiResponsesProviderDescriptor,
  input: {
    readonly message: string
    readonly providerCode?: string
    readonly fallbackKind?: ProviderFailureKind
  }
) => {
  const provider = classifyProviderFailure({
    provider: descriptor.providerId,
    message: input.message,
    ...(input.providerCode === undefined ? {} : { providerCode: input.providerCode }),
    ...(input.fallbackKind === undefined ? {} : { fallbackKind: input.fallbackKind })
  })

  return new LLMError({
    cause: providerFailureCause(provider.kind),
    message: `${descriptor.providerName} stream error: ${input.message}`,
    retryable: providerFailureRetryable(provider.kind),
    provider
  })
}

const parseToolArguments = (raw: string) =>
  decodeJsonString(raw, 'Invalid OpenAI Responses tool arguments JSON')

const textFromOutputItem = (item: OpenAiResponsesOutputItem) => {
  switch (item.type) {
    case 'message':
      return Arr.map(item.content, content => content.text)
    case 'function_call':
    case 'reasoning':
      return []
  }
}

const textFromOutputItems = (items: ReadonlyArray<OpenAiResponsesOutputItem>) => {
  const textParts = Arr.flatten(Arr.map(items, textFromOutputItem))

  return textParts.join('')
}

const reasoningFromOutputItem = (item: OpenAiResponsesOutputItem) => {
  switch (item.type) {
    case 'reasoning':
      return [
        ...(item.summary ?? []).map(summary => summary.text),
        ...(item.content ?? []).map(content => content.text)
      ]
    case 'message':
    case 'function_call':
      return []
  }
}

const reasoningFromOutputItems = (items: ReadonlyArray<OpenAiResponsesOutputItem>) => {
  const reasoningParts = Arr.flatten(Arr.map(items, reasoningFromOutputItem))

  return reasoningParts.join('')
}

const isValidTokenCount = (value: number) => Number.isSafeInteger(value) && value >= 0

const toAgentUsage = (usage: OpenAiResponsesUsageResponse): Effect.Effect<AgentUsage, LLMError> => {
  const cachedTokens = usage.input_tokens_details?.cached_tokens ?? 0
  const reasoningTokens = usage.output_tokens_details?.reasoning_tokens ?? 0
  const counts = [usage.input_tokens, usage.output_tokens, cachedTokens, reasoningTokens]

  if (
    !counts.every(isValidTokenCount) ||
    cachedTokens > usage.input_tokens ||
    reasoningTokens > usage.output_tokens
  ) {
    return Effect.fail(
      new LLMError({
        cause: 'invalid_response',
        message: 'OpenAI Responses usage contained invalid token counts',
        retryable: false
      })
    )
  }

  return Effect.succeed(
    AgentUsage.make({
      input: AgentInputUsage.make({
        total: usage.input_tokens,
        uncached: usage.input_tokens - cachedTokens,
        cacheRead: usage.input_tokens_details?.cached_tokens
      }),
      output: AgentOutputUsage.make({
        total: usage.output_tokens,
        reasoning: usage.output_tokens_details?.reasoning_tokens,
        text: usage.output_tokens - reasoningTokens
      })
    })
  )
}

type ToLlmEventsOptions = {
  readonly allowEmptyStop: boolean
}

const toLlmEvents = (
  response: OpenAiResponsesResponse,
  options: ToLlmEventsOptions
): Effect.Effect<ReadonlyArray<LLMEvent>, LLMError> =>
  Effect.gen(function* () {
    const text = response.output_text ?? textFromOutputItems(response.output)
    const reasoning = reasoningFromOutputItems(response.output)
    const reasoningEvents =
      reasoning.length > 0 ? [LLMReasoningDelta.make({ text: reasoning })] : []
    const textEvents = text.length > 0 ? [LLMTextDelta.make({ text })] : []
    const toolCallEvents = Arr.getSomes(
      yield* Effect.forEach(response.output, item => {
        switch (item.type) {
          case 'message':
          case 'reasoning':
            return Effect.succeed(Option.none())
          case 'function_call':
            return parseToolArguments(item.arguments).pipe(
              Effect.map(params =>
                Option.some(
                  LLMToolCall.make({
                    call: ToolCall.make({
                      id: item.call_id,
                      name: item.name,
                      params
                    })
                  })
                )
              )
            )
        }
      })
    )

    if (textEvents.length === 0 && toolCallEvents.length === 0 && !options.allowEmptyStop) {
      return yield* Effect.fail(
        new LLMError({
          cause: 'invalid_response',
          message: 'OpenAI Responses response did not include text or tool calls',
          retryable: false
        })
      )
    }

    const events: Array<LLMEvent> = [
      ...reasoningEvents,
      ...textEvents,
      ...toolCallEvents,
      LLMDone.make({ stopReason: toolCallEvents.length > 0 ? 'tool_use' : 'stop' })
    ]

    if (response.usage !== undefined) {
      events.push(LLMUsage.make({ usage: yield* toAgentUsage(response.usage) }))
    }

    return events
  })

const decodeOpenAiResponsesResponse = (json: unknown) =>
  Schema.decodeUnknownEffect(OpenAiResponsesResponse)(json).pipe(
    Effect.mapError(
      error =>
        new LLMError({
          cause: 'invalid_response',
          message: `Invalid OpenAI Responses response: ${unknownToMessage(error)}`,
          retryable: false
        })
    )
  )

const parseOpenAiResponsesJsonResponse = (
  raw: string
): Effect.Effect<ReadonlyArray<LLMEvent>, LLMError> =>
  Effect.gen(function* () {
    const json = yield* decodeJsonString(raw, 'Could not parse OpenAI Responses response JSON')
    const parsed = yield* decodeOpenAiResponsesResponse(json)

    return yield* toLlmEvents(parsed, { allowEmptyStop: false })
  })

type OpenAiResponsesBodyFormat = 'undecided' | 'sse' | 'json'

type OpenAiResponsesSseState = {
  readonly hasTextDelta: boolean
  readonly hasReasoningDelta: boolean
  readonly toolCallIds: ReadonlySet<string>
  readonly hasDone: boolean
}

type OpenAiResponsesSseStep = {
  readonly state: OpenAiResponsesSseState
  readonly events: ReadonlyArray<LLMEvent>
}

type OpenAiResponsesBodyState = {
  readonly format: OpenAiResponsesBodyFormat
  readonly buffer: string
  readonly sse: OpenAiResponsesSseState
}

const initialSseState: OpenAiResponsesSseState = {
  hasTextDelta: false,
  hasReasoningDelta: false,
  toolCallIds: new Set(),
  hasDone: false
}

const initialBodyState: OpenAiResponsesBodyState = {
  format: 'undecided',
  buffer: '',
  sse: initialSseState
}

const shouldEmitSseEvent = (state: OpenAiResponsesSseState, event: LLMEvent) => {
  if (state.hasTextDelta && event._tag === 'TextDelta') return false
  if (state.hasReasoningDelta && event._tag === 'ReasoningDelta') return false
  if (event._tag === 'ToolCall' && state.toolCallIds.has(event.call.id)) return false

  return true
}

const dedupeSseEvents = (
  state: OpenAiResponsesSseState,
  events: ReadonlyArray<LLMEvent>
): ReadonlyArray<LLMEvent> => events.filter(event => shouldEmitSseEvent(state, event))

const toolCallIdsFromEvents = (events: ReadonlyArray<LLMEvent>) =>
  events.flatMap(event => (event._tag === 'ToolCall' ? [event.call.id] : []))

const normalizeNewlines = (text: string) => text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')

const classifyResponsesBody = (buffer: string): OpenAiResponsesBodyFormat => {
  const trimmed = buffer.trimStart()

  if (trimmed.length === 0) {
    return 'undecided'
  }

  const ssePrefixes = ['event:', 'data:', 'id:', 'retry:', ':']

  if (ssePrefixes.some(prefix => trimmed.startsWith(prefix))) {
    return 'sse'
  }

  if (ssePrefixes.some(prefix => prefix.startsWith(trimmed))) {
    return 'undecided'
  }

  return 'json'
}

const splitCompleteSseBlocks = (buffer: string) => {
  const blocks = buffer.split('\n\n')
  const tail = blocks.at(-1) ?? ''

  return { completeBlocks: blocks.slice(0, -1), tail }
}

const dataFromSseBlock = (block: string) => {
  const lines = Arr.map(
    Arr.filter(block.split('\n'), line => line.startsWith('data:')),
    line => line.slice(5).trimStart()
  )

  const data = lines.join('\n').trim()

  if (data.length === 0 || data === '[DONE]') {
    return undefined
  }

  return data
}

const parseOpenAiResponsesSseJson = (data: string) =>
  decodeJsonString(data, 'Could not parse OpenAI Responses stream event JSON')

const decodeOpenAiResponsesOutputItem = (value: unknown) =>
  Schema.decodeUnknownEffect(OpenAiResponsesOutputItem)(value).pipe(
    Effect.mapError(
      error =>
        new LLMError({
          cause: 'invalid_response',
          message: `Invalid OpenAI Responses output item: ${unknownToMessage(error)}`,
          retryable: false
        })
    )
  )

const invalidFunctionCallSseItemError = () =>
  new LLMError({
    cause: 'invalid_response',
    message: 'Invalid OpenAI Responses function call stream item',
    retryable: false
  })

const eventsFromOutputItem = (
  item: OpenAiResponsesOutputItem
): Effect.Effect<ReadonlyArray<LLMEvent>, LLMError> => {
  switch (item.type) {
    case 'message': {
      const text = textFromOutputItems([item])

      return Effect.succeed(text.length > 0 ? [LLMTextDelta.make({ text })] : [])
    }
    case 'reasoning': {
      const reasoning = reasoningFromOutputItems([item])

      return Effect.succeed(
        reasoning.length > 0 ? [LLMReasoningDelta.make({ text: reasoning })] : []
      )
    }
    case 'function_call':
      return parseToolArguments(item.arguments).pipe(
        Effect.map(params => [
          LLMToolCall.make({
            call: ToolCall.make({
              id: item.call_id,
              name: item.name,
              params
            })
          })
        ])
      )
  }
}

const eventsFromOutputItemDone = (
  event: Record<string, unknown>
): Effect.Effect<ReadonlyArray<LLMEvent>, LLMError> =>
  Effect.gen(function* () {
    if (event.type !== 'response.output_item.done') {
      return []
    }

    const item = event.item

    if (item === undefined) {
      return yield* Effect.fail(invalidFunctionCallSseItemError())
    }

    return yield* decodeOpenAiResponsesOutputItem(item).pipe(Effect.flatMap(eventsFromOutputItem))
  })

const responseWithoutReplayedToolCalls = (
  response: OpenAiResponsesResponse,
  emittedCallIds: ReadonlySet<string>
): OpenAiResponsesResponse => ({
  ...response,
  output: response.output.filter(
    item => item.type !== 'function_call' || !emittedCallIds.has(item.call_id)
  )
})

const finalResponseToEvents = (
  response: unknown,
  state: OpenAiResponsesSseState
): Effect.Effect<ReadonlyArray<LLMEvent>, LLMError> =>
  Effect.gen(function* () {
    const hasToolCalls = state.toolCallIds.size > 0
    const parsedFinal = yield* decodeOpenAiResponsesResponse(response)
    const finalEvents = yield* toLlmEvents(
      responseWithoutReplayedToolCalls(parsedFinal, state.toolCallIds),
      { allowEmptyStop: state.hasTextDelta || hasToolCalls }
    )

    const shouldDedupe = state.hasTextDelta || state.hasReasoningDelta || hasToolCalls
    const dedupedEvents = shouldDedupe ? dedupeSseEvents(state, finalEvents) : finalEvents

    if (!hasToolCalls) {
      return dedupedEvents
    }

    return dedupedEvents.map(event =>
      event._tag === 'Done' ? LLMDone.make({ stopReason: 'tool_use' }) : event
    )
  })

const processSseData = (
  descriptor: OpenAiResponsesProviderDescriptor,
  state: OpenAiResponsesSseState,
  data: string
): Effect.Effect<OpenAiResponsesSseStep, LLMError> =>
  Effect.gen(function* () {
    if (state.hasDone) {
      return { state, events: [] }
    }

    const parsed = yield* parseOpenAiResponsesSseJson(data)

    if (!isRecord(parsed)) {
      return { state, events: [] }
    }

    if (
      (parsed.type === 'response.output_text.delta' ||
        parsed.type === 'response.content_part.delta') &&
      typeof parsed.delta === 'string'
    ) {
      return {
        state: { ...state, hasTextDelta: true },
        events: [LLMTextDelta.make({ text: parsed.delta })]
      }
    }

    if (
      (parsed.type === 'response.reasoning_summary_text.delta' ||
        parsed.type === 'response.reasoning_text.delta') &&
      typeof parsed.delta === 'string'
    ) {
      return {
        state: { ...state, hasReasoningDelta: true },
        events: [LLMReasoningDelta.make({ text: parsed.delta })]
      }
    }

    const outputItemDoneEvents = yield* eventsFromOutputItemDone(parsed)
    if (outputItemDoneEvents.length > 0) {
      const events = dedupeSseEvents(state, outputItemDoneEvents)
      const emittedToolCallIds = toolCallIdsFromEvents(events)

      return {
        state: {
          hasTextDelta: state.hasTextDelta || events.some(event => event._tag === 'TextDelta'),
          hasReasoningDelta:
            state.hasReasoningDelta || events.some(event => event._tag === 'ReasoningDelta'),
          toolCallIds: new Set([...state.toolCallIds, ...emittedToolCallIds]),
          hasDone: state.hasDone
        },
        events
      }
    }

    if (parsed.type === 'response.completed') {
      if (state.hasDone) {
        return { state, events: [] }
      }

      const events = yield* finalResponseToEvents(parsed.response, state)
      const emittedText = events.some(event => event._tag === 'TextDelta')
      const emittedReasoning = events.some(event => event._tag === 'ReasoningDelta')
      const emittedToolCallIds = toolCallIdsFromEvents(events)

      return {
        state: {
          hasTextDelta: state.hasTextDelta || emittedText,
          hasReasoningDelta: state.hasReasoningDelta || emittedReasoning,
          toolCallIds: new Set([...state.toolCallIds, ...emittedToolCallIds]),
          hasDone: true
        },
        events
      }
    }

    if (parsed.type === 'response.failed') {
      const error = recordField(recordField(parsed, 'response'), 'error')
      const message = stringField(error, 'message') ?? 'OpenAI Responses response failed'
      const providerCode = stringField(error, 'code') ?? stringField(error, 'type')

      return yield* Effect.fail(
        providerSignalError(descriptor, {
          message,
          ...(providerCode === undefined ? {} : { providerCode })
        })
      )
    }

    if (parsed.type === 'response.incomplete') {
      const details = recordField(recordField(parsed, 'response'), 'incomplete_details')
      const providerCode = stringField(details, 'reason') ?? 'incomplete'

      return yield* Effect.fail(
        providerSignalError(descriptor, {
          message: 'The provider stopped before completing the response',
          providerCode,
          fallbackKind: 'invalid_response'
        })
      )
    }

    if (parsed.type === 'error' && typeof parsed.message === 'string') {
      const providerCode = stringField(parsed, 'code') ?? stringField(parsed, 'type')

      return yield* Effect.fail(
        providerSignalError(descriptor, {
          message: parsed.message,
          ...(providerCode === undefined ? {} : { providerCode })
        })
      )
    }

    return { state, events: [] }
  })

const processSseBlock = (
  descriptor: OpenAiResponsesProviderDescriptor,
  state: OpenAiResponsesSseState,
  block: string
): Effect.Effect<OpenAiResponsesSseStep, LLMError> => {
  const data = dataFromSseBlock(block)

  if (data === undefined) {
    return Effect.succeed({ state, events: [] })
  }

  return processSseData(descriptor, state, data)
}

const processSseBlocks = (
  descriptor: OpenAiResponsesProviderDescriptor,
  state: OpenAiResponsesSseState,
  blocks: ReadonlyArray<string>
): Effect.Effect<OpenAiResponsesSseStep, LLMError> =>
  Effect.gen(function* () {
    const events: Array<LLMEvent> = []
    let currentState = state

    for (const block of blocks) {
      const step = yield* processSseBlock(descriptor, currentState, block)
      currentState = step.state
      events.push(...step.events)
    }

    return { state: currentState, events }
  })

const processBodyChunk = (
  descriptor: OpenAiResponsesProviderDescriptor,
  state: OpenAiResponsesBodyState,
  chunk: string
): Effect.Effect<
  OpenAiResponsesSseStep & { readonly bodyState: OpenAiResponsesBodyState },
  LLMError
> =>
  Effect.gen(function* () {
    const buffer = normalizeNewlines(`${state.buffer}${chunk}`)
    const format = state.format === 'undecided' ? classifyResponsesBody(buffer) : state.format

    if (format !== 'sse') {
      return {
        state: state.sse,
        bodyState: { ...state, format, buffer },
        events: []
      }
    }

    const split = splitCompleteSseBlocks(buffer)
    const step = yield* processSseBlocks(descriptor, state.sse, split.completeBlocks)

    return {
      state: step.state,
      bodyState: { format, buffer: split.tail, sse: step.state },
      events: step.events
    }
  })

const finalizeBodyState = (
  descriptor: OpenAiResponsesProviderDescriptor,
  state: OpenAiResponsesBodyState
): Effect.Effect<ReadonlyArray<LLMEvent>, LLMError> =>
  Effect.gen(function* () {
    const buffer = normalizeNewlines(state.buffer)
    const format = state.format === 'undecided' ? classifyResponsesBody(buffer) : state.format

    if (format === 'json') {
      return yield* parseOpenAiResponsesJsonResponse(buffer)
    }

    const events: Array<LLMEvent> = []
    let sseState = state.sse

    if (format === 'sse') {
      const split = splitCompleteSseBlocks(buffer)
      const step = yield* processSseBlocks(descriptor, sseState, split.completeBlocks)
      sseState = step.state
      events.push(...step.events)

      if (split.tail.trim().length > 0) {
        const tailStep = yield* processSseBlock(descriptor, sseState, split.tail)
        sseState = tailStep.state
        events.push(...tailStep.events)
      }
    }

    if (!sseState.hasDone) {
      if (!descriptor.allowEofCompletion) {
        return yield* Effect.fail(
          providerSignalError(descriptor, {
            message: 'The provider stream ended before a terminal response event',
            providerCode: 'incomplete_stream',
            fallbackKind: 'invalid_response'
          })
        )
      }

      events.push(LLMDone.make({ stopReason: sseState.toolCallIds.size > 0 ? 'tool_use' : 'stop' }))
    }

    return events
  })

const toHttpClientLlmError =
  (
    descriptor: OpenAiResponsesProviderDescriptor,
    message: string,
    retryable: boolean,
    kind: ProviderFailureKind = 'network'
  ) =>
  (error: HttpClientError.HttpClientError) =>
    new LLMError({
      cause: 'provider_error',
      message: `${message}: ${error.message}`,
      retryable,
      provider: providerErrorInfo({
        provider: descriptor.providerId,
        kind: retryable ? kind : 'unknown'
      })
    })

export const streamOpenAiResponsesResponse = (
  descriptor: OpenAiResponsesProviderDescriptor,
  response: HttpClientResponse.HttpClientResponse
): Stream.Stream<LLMEvent, LLMError> =>
  Stream.unwrap(
    Ref.make(initialBodyState).pipe(
      Effect.map(bodyStateRef => {
        const chunks = response.stream.pipe(
          Stream.mapError(
            toHttpClientLlmError(
              descriptor,
              `Could not read ${descriptor.providerName} stream`,
              true,
              'stream'
            )
          ),
          Stream.decodeText,
          Stream.mapEffect(chunk =>
            Effect.gen(function* () {
              const state = yield* Ref.get(bodyStateRef)
              const step = yield* processBodyChunk(descriptor, state, chunk)
              yield* Ref.set(bodyStateRef, step.bodyState)
              return step.events
            })
          ),
          Stream.flatMap(events => Stream.fromIterable(events))
        )

        const finalEvents = Stream.fromEffect(
          Ref.get(bodyStateRef).pipe(Effect.flatMap(state => finalizeBodyState(descriptor, state)))
        ).pipe(Stream.flatMap(events => Stream.fromIterable(events)))

        return chunks.pipe(Stream.concat(finalEvents))
      })
    )
  ).pipe(Stream.mapError(error => withOpenAiResponsesProviderName(descriptor.providerName, error)))

const sendOpenAiResponsesRequest = (
  config: OpenAiResponsesProviderConfig,
  request: LLMRequest,
  client: HttpClient.HttpClient
): Effect.Effect<HttpClientResponse.HttpClientResponse, LLMError> =>
  Effect.gen(function* () {
    const descriptor: OpenAiResponsesProviderDescriptor = {
      providerId: config.providerId,
      providerName: config.providerName,
      allowEofCompletion: config.allowEofCompletion
    }

    if (
      config.expectedTokenProvider !== undefined &&
      (config.token.provider !== config.expectedTokenProvider ||
        config.token.accessToken.trim().length === 0 ||
        !Number.isFinite(config.token.expiresAt) ||
        config.token.expiresAt <= Date.now())
    ) {
      return yield* Effect.fail(
        providerSignalError(descriptor, {
          message: 'The host supplied a mismatched or expired OAuth access token',
          providerCode: 'invalid_access_token',
          fallbackKind: 'auth'
        })
      )
    }

    const body = yield* toOpenAiResponsesRequestBody(request, config).pipe(
      Effect.mapError(error => withOpenAiResponsesProviderName(config.providerName, error))
    )
    // Replayed transcripts can carry lone surrogates; harden the lowered
    // body so one bad historical string cannot poison every model call.
    const serializedBody = yield* encodeJsonString(
      replaceLoneSurrogatesDeep(body),
      `Could not serialize ${config.providerName} request`
    )

    const headers: Record<string, string> = {
      ...config.extraHeaders,
      accept: 'text/event-stream',
      'content-type': 'application/json',
      ...config.authorizationHeaders(config.token, request.model)
    }

    const httpRequest = HttpClientRequest.post(config.responsesUrl).pipe(
      HttpClientRequest.setHeaders(headers),
      HttpClientRequest.bodyText(serializedBody, 'application/json')
    )
    const response = yield* client
      .execute(httpRequest)
      .pipe(
        Effect.mapError(
          toHttpClientLlmError(descriptor, `${config.providerName} request failed`, true)
        )
      )

    if (response.status < 200 || response.status >= 300) {
      const errorText = yield* response.text.pipe(
        Effect.mapError(
          error =>
            new LLMError({
              cause: 'provider_error',
              message: `Could not read ${config.providerName} error body: ${error.message}`,
              retryable: false
            })
        )
      )

      const provider = classifyProviderFailure({
        provider: config.providerId,
        status: response.status,
        headers: response.headers,
        body: errorText
      })

      return yield* Effect.fail(
        new LLMError({
          cause: providerFailureCause(provider.kind),
          message: `${config.providerName} returned ${response.status}`,
          retryable: providerFailureRetryable(provider.kind),
          provider
        })
      )
    }

    return response
  }).pipe(Effect.withSpan('OpenAiResponsesProvider.stream'))

export const makeOpenAiResponsesProviderLayer = (config: OpenAiResponsesProviderConfig) =>
  Layer.effect(LLMProvider)(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient

      const descriptor: OpenAiResponsesProviderDescriptor = {
        providerId: config.providerId,
        providerName: config.providerName,
        allowEofCompletion: config.allowEofCompletion
      }

      return LLMProvider.of({
        stream: request =>
          Stream.fromEffect(sendOpenAiResponsesRequest(config, request, client)).pipe(
            Stream.flatMap(response => streamOpenAiResponsesResponse(descriptor, response))
          )
      })
    })
  )
