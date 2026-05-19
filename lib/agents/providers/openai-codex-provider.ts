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
  assistantContent,
  assistantHostToolCalls,
  contentParts,
  type AgentMessage,
  type AgentReasoningEffort,
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
import { openAiCodexResponsesUrl } from '@yolk-sdk/openai'
import {
  agentTextReasoningEffort,
  agentTextReasoningSummary,
  type AgentTextReasoningSummary
} from '../text-agent-config.ts'
import type { OpenAiCodexOAuthToken } from '../../services/openai-codex-oauth/schemas.ts'

type OpenAiCodexConfigShape = {
  readonly token: OpenAiCodexOAuthToken
  readonly responsesUrl?: string
  readonly extraHeaders?: Readonly<Record<string, string>>
}

type OpenAiCodexMessageInput = {
  readonly role: 'user' | 'assistant'
  readonly content: string | ReadonlyArray<OpenAiCodexInputContentPart>
}

type OpenAiCodexInputTextPart = {
  readonly type: 'input_text'
  readonly text: string
}

type OpenAiCodexInputImagePart = {
  readonly type: 'input_image'
  readonly image_url: string
}

type OpenAiCodexOutputTextPart = {
  readonly type: 'output_text'
  readonly text: string
}

type OpenAiCodexInputContentPart =
  | OpenAiCodexInputTextPart
  | OpenAiCodexInputImagePart
  | OpenAiCodexOutputTextPart

type OpenAiCodexFunctionCallInput = {
  readonly type: 'function_call'
  readonly call_id: string
  readonly name: string
  readonly arguments: string
}

type OpenAiCodexFunctionOutputInput = {
  readonly type: 'function_call_output'
  readonly call_id: string
  readonly output: string
}

type OpenAiCodexInputItem =
  | OpenAiCodexMessageInput
  | OpenAiCodexFunctionCallInput
  | OpenAiCodexFunctionOutputInput

type OpenAiCodexTool = {
  readonly type: 'function'
  readonly name: string
  readonly description: string
  readonly parameters: unknown
}

type OpenAiCodexRequestBody = {
  readonly model: string
  readonly instructions: string
  readonly input: ReadonlyArray<OpenAiCodexInputItem>
  readonly store: false
  readonly stream: true
  readonly reasoning: {
    readonly effort: AgentReasoningEffort
    readonly summary: AgentTextReasoningSummary
  }
  readonly tools?: ReadonlyArray<OpenAiCodexTool>
  readonly parallel_tool_calls?: true
}

class OpenAiCodexReasoningSummaryText extends Schema.Class<OpenAiCodexReasoningSummaryText>(
  'OpenAiCodexReasoningSummaryText'
)({
  type: Schema.Literals(['summary_text']),
  text: Schema.String
}) {}

class OpenAiCodexReasoningText extends Schema.Class<OpenAiCodexReasoningText>(
  'OpenAiCodexReasoningText'
)({
  type: Schema.Literals(['reasoning_text']),
  text: Schema.String
}) {}

class OpenAiCodexOutputText extends Schema.Class<OpenAiCodexOutputText>('OpenAiCodexOutputText')({
  type: Schema.Literals(['output_text']),
  text: Schema.String
}) {}

class OpenAiCodexMessageOutput extends Schema.Class<OpenAiCodexMessageOutput>(
  'OpenAiCodexMessageOutput'
)({
  type: Schema.Literals(['message']),
  content: Schema.Array(OpenAiCodexOutputText)
}) {}

class OpenAiCodexFunctionCallOutput extends Schema.Class<OpenAiCodexFunctionCallOutput>(
  'OpenAiCodexFunctionCallOutput'
)({
  type: Schema.Literals(['function_call']),
  call_id: Schema.String,
  name: Schema.String,
  arguments: Schema.String
}) {}

class OpenAiCodexReasoningOutput extends Schema.Class<OpenAiCodexReasoningOutput>(
  'OpenAiCodexReasoningOutput'
)({
  type: Schema.Literals(['reasoning']),
  summary: Schema.optional(Schema.Array(OpenAiCodexReasoningSummaryText)),
  content: Schema.optional(Schema.Array(OpenAiCodexReasoningText))
}) {}

class OpenAiCodexInputTokensDetails extends Schema.Class<OpenAiCodexInputTokensDetails>(
  'OpenAiCodexInputTokensDetails'
)({
  cached_tokens: Schema.optional(Schema.Number)
}) {}

class OpenAiCodexOutputTokensDetails extends Schema.Class<OpenAiCodexOutputTokensDetails>(
  'OpenAiCodexOutputTokensDetails'
)({
  reasoning_tokens: Schema.optional(Schema.Number)
}) {}

class OpenAiCodexUsageResponse extends Schema.Class<OpenAiCodexUsageResponse>(
  'OpenAiCodexUsageResponse'
)({
  input_tokens: Schema.Number,
  output_tokens: Schema.Number,
  input_tokens_details: Schema.optional(OpenAiCodexInputTokensDetails),
  output_tokens_details: Schema.optional(OpenAiCodexOutputTokensDetails)
}) {}

const OpenAiCodexOutputItem = Schema.Union([
  OpenAiCodexMessageOutput,
  OpenAiCodexFunctionCallOutput,
  OpenAiCodexReasoningOutput
])
type OpenAiCodexOutputItem = typeof OpenAiCodexOutputItem.Type

class OpenAiCodexResponse extends Schema.Class<OpenAiCodexResponse>('OpenAiCodexResponse')({
  output_text: Schema.optional(Schema.String),
  output: Schema.Array(OpenAiCodexOutputItem),
  usage: Schema.optional(OpenAiCodexUsageResponse)
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

const unsupportedContentError = (contentType: string) =>
  new LLMError({
    cause: 'provider_error',
    message: `${contentType} content is not supported by the OpenAI Codex OAuth provider yet`,
    retryable: false
  })

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

const userPartToCodexInputPart = (
  part: ContentPart
): Effect.Effect<OpenAiCodexInputTextPart | OpenAiCodexInputImagePart, LLMError> => {
  switch (part._tag) {
    case 'Text':
      return Effect.succeed({ type: 'input_text', text: part.text })
    case 'Image':
      return Effect.succeed({
        type: 'input_image',
        image_url: `data:${part.mimeType};base64,${part.data}`
      })
    case 'Audio':
      return Effect.fail(unsupportedContentError('User audio'))
  }
}

const contentToUserInput = (
  content: Content
): Effect.Effect<OpenAiCodexMessageInput['content'], LLMError> => {
  if (typeof content === 'string') {
    return Effect.succeed(content)
  }

  const parts = contentParts(content)
  const onlyPart = parts[0]

  if (onlyPart !== undefined && parts.length === 1 && onlyPart._tag === 'Text') {
    return Effect.succeed(onlyPart.text)
  }

  return Effect.forEach(parts, userPartToCodexInputPart)
}

const serializeToolArguments = (params: unknown) =>
  encodeJsonString(params, 'Could not serialize OpenAI Codex tool arguments')

const toolCallToCodexInput = (
  call: ToolCall
): Effect.Effect<OpenAiCodexFunctionCallInput, LLMError> =>
  Effect.gen(function* () {
    return {
      type: 'function_call',
      call_id: call.id,
      name: call.name,
      arguments: yield* serializeToolArguments(call.params)
    }
  })

const messageToCodexInput = (
  message: AgentMessage
): Effect.Effect<ReadonlyArray<OpenAiCodexInputItem>, LLMError> =>
  Effect.gen(function* () {
    switch (message._tag) {
      case 'User':
        return [{ role: 'user', content: yield* contentToUserInput(message.content) }]
      case 'Assistant': {
        const content = yield* contentToText(assistantContent(message), 'Assistant')
        const toolCallInputs = yield* Effect.forEach(
          assistantHostToolCalls(message),
          toolCallToCodexInput
        )

        if (content.length > 0) {
          const assistantMessage: OpenAiCodexInputItem = { role: 'assistant', content }

          return [assistantMessage, ...toolCallInputs]
        }

        return toolCallInputs
      }
      case 'ToolResult':
        return [
          {
            type: 'function_call_output',
            call_id: message.toolCallId,
            output: yield* contentToText(message.content, 'Tool result')
          }
        ]
    }
  })

const toOpenAiCodexTool = (tool: ToolDef): OpenAiCodexTool => ({
  type: 'function',
  name: tool.name,
  description: tool.description,
  parameters: tool.parameters
})

export const toOpenAiCodexRequestBody = (
  request: LLMRequest
): Effect.Effect<OpenAiCodexRequestBody, LLMError> =>
  Effect.gen(function* () {
    const input = Arr.flatten(yield* Effect.forEach(request.messages, messageToCodexInput))

    const body: Omit<OpenAiCodexRequestBody, 'tools'> = {
      model: request.model,
      instructions: request.systemPrompt,
      input,
      store: false,
      stream: true,
      reasoning: {
        effort: request.reasoningEffort ?? agentTextReasoningEffort,
        summary: agentTextReasoningSummary
      }
    }

    if (request.tools.length === 0) {
      return body
    }

    return {
      ...body,
      tools: request.tools.map(toOpenAiCodexTool),
      parallel_tool_calls: true
    }
  })

const responseStatusToCause = (status: number): LLMError['cause'] => {
  if (status === 429) {
    return 'rate_limit'
  }

  if (status === 413) {
    return 'context_overflow'
  }

  return 'provider_error'
}

const isRetryableStatus = (status: number) => status === 429 || status >= 500

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const parseToolArguments = (raw: string) =>
  decodeJsonString(raw, 'Invalid OpenAI Codex tool arguments JSON')

const textFromOutputItem = (item: OpenAiCodexOutputItem) => {
  switch (item.type) {
    case 'message':
      return Arr.map(item.content, content => content.text)
    case 'function_call':
    case 'reasoning':
      return []
  }
}

const textFromOutputItems = (items: ReadonlyArray<OpenAiCodexOutputItem>) => {
  const textParts = Arr.flatten(Arr.map(items, textFromOutputItem))

  return textParts.join('')
}

const reasoningFromOutputItem = (item: OpenAiCodexOutputItem) => {
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

const reasoningFromOutputItems = (items: ReadonlyArray<OpenAiCodexOutputItem>) => {
  const reasoningParts = Arr.flatten(Arr.map(items, reasoningFromOutputItem))

  return reasoningParts.join('')
}

const toAgentUsage = (usage: OpenAiCodexUsageResponse) =>
  AgentUsage.make({
    input: AgentInputUsage.make({
      total: usage.input_tokens,
      uncached: usage.input_tokens - (usage.input_tokens_details?.cached_tokens ?? 0),
      cacheRead: usage.input_tokens_details?.cached_tokens
    }),
    output: AgentOutputUsage.make({
      total: usage.output_tokens,
      reasoning: usage.output_tokens_details?.reasoning_tokens,
      text: usage.output_tokens - (usage.output_tokens_details?.reasoning_tokens ?? 0)
    })
  })

type ToLlmEventsOptions = {
  readonly allowEmptyStop: boolean
}

const toLlmEvents = (
  response: OpenAiCodexResponse,
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
          message: 'OpenAI Codex response did not include text or tool calls',
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
      events.push(LLMUsage.make({ usage: toAgentUsage(response.usage) }))
    }

    return events
  })

const decodeOpenAiCodexResponse = (json: unknown) =>
  Schema.decodeUnknownEffect(OpenAiCodexResponse)(json).pipe(
    Effect.mapError(
      error =>
        new LLMError({
          cause: 'invalid_response',
          message: `Invalid OpenAI Codex response: ${unknownToMessage(error)}`,
          retryable: false
        })
    )
  )

const parseOpenAiCodexJsonResponse = (
  raw: string
): Effect.Effect<ReadonlyArray<LLMEvent>, LLMError> =>
  Effect.gen(function* () {
    const json = yield* decodeJsonString(raw, 'Could not parse OpenAI Codex response JSON')
    const parsed = yield* decodeOpenAiCodexResponse(json)

    return yield* toLlmEvents(parsed, { allowEmptyStop: false })
  })

type OpenAiCodexBodyFormat = 'undecided' | 'sse' | 'json'

type OpenAiCodexSseState = {
  readonly hasTextDelta: boolean
  readonly hasReasoningDelta: boolean
  readonly hasToolCall: boolean
  readonly hasDone: boolean
}

type OpenAiCodexSseStep = {
  readonly state: OpenAiCodexSseState
  readonly events: ReadonlyArray<LLMEvent>
}

type OpenAiCodexBodyState = {
  readonly format: OpenAiCodexBodyFormat
  readonly buffer: string
  readonly sse: OpenAiCodexSseState
}

const initialSseState: OpenAiCodexSseState = {
  hasTextDelta: false,
  hasReasoningDelta: false,
  hasToolCall: false,
  hasDone: false
}

const initialBodyState: OpenAiCodexBodyState = {
  format: 'undecided',
  buffer: '',
  sse: initialSseState
}

const normalizeNewlines = (text: string) => text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')

const classifyCodexBody = (buffer: string): OpenAiCodexBodyFormat => {
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

const parseOpenAiCodexSseJson = (data: string) =>
  decodeJsonString(data, 'Could not parse OpenAI Codex stream event JSON')

const decodeOpenAiCodexOutputItem = (value: unknown) =>
  Schema.decodeUnknownEffect(OpenAiCodexOutputItem)(value).pipe(
    Effect.mapError(
      error =>
        new LLMError({
          cause: 'invalid_response',
          message: `Invalid OpenAI Codex output item: ${unknownToMessage(error)}`,
          retryable: false
        })
    )
  )

const invalidFunctionCallSseItemError = () =>
  new LLMError({
    cause: 'invalid_response',
    message: 'Invalid OpenAI Codex function call stream item',
    retryable: false
  })

const eventsFromOutputItem = (
  item: OpenAiCodexOutputItem
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

    return yield* decodeOpenAiCodexOutputItem(item).pipe(Effect.flatMap(eventsFromOutputItem))
  })

const finalResponseToEvents = (
  response: unknown,
  state: OpenAiCodexSseState
): Effect.Effect<ReadonlyArray<LLMEvent>, LLMError> =>
  Effect.gen(function* () {
    const parsedFinal = yield* decodeOpenAiCodexResponse(response)
    const finalEvents = yield* toLlmEvents(parsedFinal, {
      allowEmptyStop: state.hasTextDelta || state.hasToolCall
    })

    const shouldDedupe = state.hasTextDelta || state.hasReasoningDelta || state.hasToolCall
    const dedupedEvents = shouldDedupe
      ? finalEvents.filter(event => {
          if (state.hasTextDelta && event._tag === 'TextDelta') {
            return false
          }

          if (state.hasReasoningDelta && event._tag === 'ReasoningDelta') {
            return false
          }

          if (state.hasToolCall && event._tag === 'ToolCall') {
            return false
          }

          return true
        })
      : finalEvents

    if (!state.hasToolCall) {
      return dedupedEvents
    }

    return dedupedEvents.map(event =>
      event._tag === 'Done' ? LLMDone.make({ stopReason: 'tool_use' }) : event
    )
  })

const processSseData = (
  state: OpenAiCodexSseState,
  data: string
): Effect.Effect<OpenAiCodexSseStep, LLMError> =>
  Effect.gen(function* () {
    const parsed = yield* parseOpenAiCodexSseJson(data)

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
      const events = outputItemDoneEvents.filter(event => {
        if (state.hasTextDelta && event._tag === 'TextDelta') {
          return false
        }

        if (state.hasReasoningDelta && event._tag === 'ReasoningDelta') {
          return false
        }

        if (state.hasToolCall && event._tag === 'ToolCall') {
          return false
        }

        return true
      })

      return {
        state: {
          hasTextDelta: state.hasTextDelta || events.some(event => event._tag === 'TextDelta'),
          hasReasoningDelta:
            state.hasReasoningDelta || events.some(event => event._tag === 'ReasoningDelta'),
          hasToolCall: state.hasToolCall || events.some(event => event._tag === 'ToolCall'),
          hasDone: state.hasDone
        },
        events
      }
    }

    if (parsed.type === 'response.completed') {
      const events = yield* finalResponseToEvents(parsed.response, state)
      const emittedText = events.some(event => event._tag === 'TextDelta')
      const emittedReasoning = events.some(event => event._tag === 'ReasoningDelta')
      const emittedToolCall = events.some(event => event._tag === 'ToolCall')

      return {
        state: {
          hasTextDelta: state.hasTextDelta || emittedText,
          hasReasoningDelta: state.hasReasoningDelta || emittedReasoning,
          hasToolCall: state.hasToolCall || emittedToolCall,
          hasDone: true
        },
        events
      }
    }

    if (parsed.type === 'error' && typeof parsed.message === 'string') {
      return yield* Effect.fail(
        new LLMError({
          cause: 'provider_error',
          message: `OpenAI Codex stream error: ${parsed.message}`,
          retryable: false
        })
      )
    }

    return { state, events: [] }
  })

const processSseBlock = (
  state: OpenAiCodexSseState,
  block: string
): Effect.Effect<OpenAiCodexSseStep, LLMError> => {
  const data = dataFromSseBlock(block)

  if (data === undefined) {
    return Effect.succeed({ state, events: [] })
  }

  return processSseData(state, data)
}

const processSseBlocks = (
  state: OpenAiCodexSseState,
  blocks: ReadonlyArray<string>
): Effect.Effect<OpenAiCodexSseStep, LLMError> =>
  Effect.gen(function* () {
    const events: Array<LLMEvent> = []
    let currentState = state

    for (const block of blocks) {
      const step = yield* processSseBlock(currentState, block)
      currentState = step.state
      events.push(...step.events)
    }

    return { state: currentState, events }
  })

const processBodyChunk = (
  state: OpenAiCodexBodyState,
  chunk: string
): Effect.Effect<OpenAiCodexSseStep & { readonly bodyState: OpenAiCodexBodyState }, LLMError> =>
  Effect.gen(function* () {
    const buffer = normalizeNewlines(`${state.buffer}${chunk}`)
    const format = state.format === 'undecided' ? classifyCodexBody(buffer) : state.format

    if (format !== 'sse') {
      return {
        state: state.sse,
        bodyState: { ...state, format, buffer },
        events: []
      }
    }

    const split = splitCompleteSseBlocks(buffer)
    const step = yield* processSseBlocks(state.sse, split.completeBlocks)

    return {
      state: step.state,
      bodyState: { format, buffer: split.tail, sse: step.state },
      events: step.events
    }
  })

const finalizeBodyState = (
  state: OpenAiCodexBodyState
): Effect.Effect<ReadonlyArray<LLMEvent>, LLMError> =>
  Effect.gen(function* () {
    const buffer = normalizeNewlines(state.buffer)
    const format = state.format === 'undecided' ? classifyCodexBody(buffer) : state.format

    if (format === 'json') {
      return yield* parseOpenAiCodexJsonResponse(buffer)
    }

    const events: Array<LLMEvent> = []
    let sseState = state.sse

    if (format === 'sse') {
      const split = splitCompleteSseBlocks(buffer)
      const step = yield* processSseBlocks(sseState, split.completeBlocks)
      sseState = step.state
      events.push(...step.events)

      if (split.tail.trim().length > 0) {
        const tailStep = yield* processSseBlock(sseState, split.tail)
        sseState = tailStep.state
        events.push(...tailStep.events)
      }
    }

    if (!sseState.hasDone) {
      events.push(LLMDone.make({ stopReason: sseState.hasToolCall ? 'tool_use' : 'stop' }))
    }

    return events
  })

const toHttpClientLlmError =
  (message: string, retryable: boolean) => (error: HttpClientError.HttpClientError) =>
    new LLMError({
      cause: 'provider_error',
      message: `${message}: ${error.message}`,
      retryable
    })

export const streamOpenAiCodexResponse = (
  response: HttpClientResponse.HttpClientResponse
): Stream.Stream<LLMEvent, LLMError> =>
  Stream.unwrap(
    Ref.make(initialBodyState).pipe(
      Effect.map(bodyStateRef => {
        const chunks = response.stream.pipe(
          Stream.mapError(toHttpClientLlmError('Could not read OpenAI Codex stream', false)),
          Stream.decodeText,
          Stream.mapEffect(chunk =>
            Effect.gen(function* () {
              const state = yield* Ref.get(bodyStateRef)
              const step = yield* processBodyChunk(state, chunk)
              yield* Ref.set(bodyStateRef, step.bodyState)
              return step.events
            })
          ),
          Stream.flatMap(events => Stream.fromIterable(events))
        )

        const finalEvents = Stream.fromEffect(
          Ref.get(bodyStateRef).pipe(Effect.flatMap(finalizeBodyState))
        ).pipe(Stream.flatMap(events => Stream.fromIterable(events)))

        return chunks.pipe(Stream.concat(finalEvents))
      })
    )
  )

const sendOpenAiCodexRequest = (
  config: OpenAiCodexConfigShape,
  request: LLMRequest,
  client: HttpClient.HttpClient
): Effect.Effect<HttpClientResponse.HttpClientResponse, LLMError> =>
  Effect.gen(function* () {
    const body = yield* toOpenAiCodexRequestBody(request)
    const serializedBody = yield* encodeJsonString(body, 'Could not serialize OpenAI Codex request')

    const headers: Record<string, string> = {
      ...config.extraHeaders,
      accept: 'application/json',
      authorization: `Bearer ${config.token.access}`,
      'content-type': 'application/json',
      originator: 'opencode'
    }

    if (config.token.accountId !== undefined) {
      headers['ChatGPT-Account-Id'] = config.token.accountId
    }

    const httpRequest = HttpClientRequest.post(config.responsesUrl ?? openAiCodexResponsesUrl).pipe(
      HttpClientRequest.setHeaders(headers),
      HttpClientRequest.bodyText(serializedBody, 'application/json')
    )
    const response = yield* client
      .execute(httpRequest)
      .pipe(Effect.mapError(toHttpClientLlmError('OpenAI Codex request failed', true)))

    if (response.status < 200 || response.status >= 300) {
      const errorText = yield* response.text.pipe(
        Effect.mapError(
          error =>
            new LLMError({
              cause: 'provider_error',
              message: `Could not read OpenAI Codex error body: ${error.message}`,
              retryable: false
            })
        )
      )

      return yield* Effect.fail(
        new LLMError({
          cause: responseStatusToCause(response.status),
          message: `OpenAI Codex returned ${response.status}: ${errorText}`,
          retryable: isRetryableStatus(response.status)
        })
      )
    }

    return response
  }).pipe(Effect.withSpan('OpenAiCodexProvider.stream'))

export const makeOpenAiCodexProviderLayer = (config: OpenAiCodexConfigShape) =>
  Layer.effect(LLMProvider)(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient

      return LLMProvider.of({
        stream: request =>
          Stream.fromEffect(sendOpenAiCodexRequest(config, request, client)).pipe(
            Stream.flatMap(streamOpenAiCodexResponse)
          )
      })
    })
  )
