import { Effect, Layer, Stream } from 'effect'
import * as Schema from 'effect/Schema'
import { ToolCall, type AgentMessage, type Content, type ToolDef } from '@yolk/protocol'
import {
  LLMError,
  LLMDone,
  LLMProvider,
  LLMTextDelta,
  LLMToolCall,
  type LLMEvent,
  type LLMRequest
} from '@yolk/agent-loop'
import { OPENAI_CODEX_RESPONSES_URL } from '@/lib/services/openai-codex-oauth/live-layer'
import type { OpenAiCodexOAuthToken } from '@/lib/services/openai-codex-oauth/schemas'

type OpenAiCodexConfigShape = {
  readonly token: OpenAiCodexOAuthToken
  readonly fetch: typeof fetch
}

type OpenAiCodexMessageInput = {
  readonly role: 'user' | 'assistant'
  readonly content: string
}

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
  readonly tools?: ReadonlyArray<OpenAiCodexTool>
}

class OpenAiCodexOutputText extends Schema.Class<OpenAiCodexOutputText>(
  'OpenAiCodexOutputText'
)({
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

const OpenAiCodexOutputItem = Schema.Union([
  OpenAiCodexMessageOutput,
  OpenAiCodexFunctionCallOutput
])
type OpenAiCodexOutputItem = typeof OpenAiCodexOutputItem.Type

class OpenAiCodexResponse extends Schema.Class<OpenAiCodexResponse>('OpenAiCodexResponse')({
  output_text: Schema.optional(Schema.String),
  output: Schema.Array(OpenAiCodexOutputItem)
}) {}

const unknownToMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

const unsupportedContentError = (contentType: string) =>
  new LLMError({
    cause: 'provider_error',
    message: `${contentType} content is not supported by the OpenAI Codex OAuth provider yet`,
    retryable: false
  })

const contentToText = (content: Content, owner: string): Effect.Effect<string, LLMError> =>
  Effect.gen(function* () {
    if (typeof content === 'string') {
      return content
    }

    const textParts: Array<string> = []

    for (const part of content) {
      switch (part._tag) {
        case 'Text':
          textParts.push(part.text)
          break
        case 'Image':
          return yield* Effect.fail(unsupportedContentError(`${owner} image`))
        case 'Audio':
          return yield* Effect.fail(unsupportedContentError(`${owner} audio`))
      }
    }

    return textParts.join('\n')
  })

const serializeToolArguments = (params: unknown) =>
  Effect.try({
    try: () => JSON.stringify(params),
    catch: error =>
      new LLMError({
        cause: 'provider_error',
        message: `Could not serialize OpenAI Codex tool arguments: ${unknownToMessage(error)}`,
        retryable: false
      })
  })

const toolCallToCodexInput = (call: ToolCall): Effect.Effect<OpenAiCodexFunctionCallInput, LLMError> =>
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
        return [{ role: 'user', content: yield* contentToText(message.content, 'User') }]
      case 'Assistant': {
        const items: Array<OpenAiCodexInputItem> = []
        const content = yield* contentToText(message.content, 'Assistant')

        if (content.length > 0) {
          items.push({ role: 'assistant', content })
        }

        for (const call of message.toolCalls) {
          items.push(yield* toolCallToCodexInput(call))
        }

        return items
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
    const input: Array<OpenAiCodexInputItem> = []

    for (const message of request.messages) {
      input.push(...(yield* messageToCodexInput(message)))
    }

    const body: Omit<OpenAiCodexRequestBody, 'tools'> = {
      model: request.model,
      instructions: request.systemPrompt,
      input,
      store: false,
      stream: true
    }

    if (request.tools.length === 0) {
      return body
    }

    return {
      ...body,
      tools: request.tools.map(toOpenAiCodexTool)
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

const readText = (response: Response): Promise<string> => response.text()

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const parseToolArguments = (raw: string) =>
  Effect.try({
    try: (): unknown => JSON.parse(raw),
    catch: error =>
      new LLMError({
        cause: 'invalid_response',
        message: `Invalid OpenAI Codex tool arguments JSON: ${unknownToMessage(error)}`,
        retryable: false
      })
  })

const textFromOutputItems = (items: ReadonlyArray<OpenAiCodexOutputItem>) => {
  const textParts: Array<string> = []

  for (const item of items) {
    if (item.type === 'message') {
      for (const content of item.content) {
        textParts.push(content.text)
      }
    }
  }

  return textParts.join('')
}

const toLlmEvents = (response: OpenAiCodexResponse): Effect.Effect<ReadonlyArray<LLMEvent>, LLMError> =>
  Effect.gen(function* () {
    const events: Array<LLMEvent> = []
    const text = response.output_text ?? textFromOutputItems(response.output)

    if (text.length > 0) {
      events.push(LLMTextDelta.make({ text }))
    }

    for (const item of response.output) {
      if (item.type === 'function_call') {
        events.push(
          LLMToolCall.make({
            call: ToolCall.make({
              id: item.call_id,
              name: item.name,
              params: yield* parseToolArguments(item.arguments)
            })
          })
        )
      }
    }

    const hasToolCall = events.some(event => event._tag === 'ToolCall')
    events.push(LLMDone.make({ stopReason: hasToolCall ? 'tool_use' : 'stop' }))

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

const parseOpenAiCodexJsonResponse = (raw: string): Effect.Effect<ReadonlyArray<LLMEvent>, LLMError> =>
  Effect.gen(function* () {
    const json = yield* Effect.try({
      try: (): unknown => JSON.parse(raw),
      catch: error =>
        new LLMError({
          cause: 'invalid_response',
          message: `Could not parse OpenAI Codex response JSON: ${unknownToMessage(error)}`,
          retryable: false
        })
    })
    const parsed = yield* decodeOpenAiCodexResponse(json)

    return yield* toLlmEvents(parsed)
  })

type OpenAiCodexBodyFormat = 'undecided' | 'sse' | 'json'

type OpenAiCodexSseState = {
  readonly hasTextDelta: boolean
  readonly hasDone: boolean
}

type OpenAiCodexSseStep = {
  readonly state: OpenAiCodexSseState
  readonly events: ReadonlyArray<LLMEvent>
}

const initialSseState: OpenAiCodexSseState = {
  hasTextDelta: false,
  hasDone: false
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
  const lines: Array<string> = []

  for (const line of block.split('\n')) {
    if (line.startsWith('data:')) {
      lines.push(line.slice(5).trimStart())
    }
  }

  const data = lines.join('\n').trim()

  if (data.length === 0 || data === '[DONE]') {
    return undefined
  }

  return data
}

const parseOpenAiCodexSseJson = (data: string) =>
  Effect.try({
    try: (): unknown => JSON.parse(data),
    catch: error =>
      new LLMError({
        cause: 'invalid_response',
        message: `Could not parse OpenAI Codex stream event JSON: ${unknownToMessage(error)}`,
        retryable: false
      })
  })

const finalResponseToEvents = (
  response: unknown,
  hasTextDelta: boolean
): Effect.Effect<ReadonlyArray<LLMEvent>, LLMError> =>
  Effect.gen(function* () {
    const parsedFinal = yield* decodeOpenAiCodexResponse(response)
    const finalEvents = yield* toLlmEvents(parsedFinal)

    if (!hasTextDelta) {
      return finalEvents
    }

    return finalEvents.filter(event => event._tag !== 'TextDelta')
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

    if (parsed.type === 'response.output_text.delta' && typeof parsed.delta === 'string') {
      return {
        state: { ...state, hasTextDelta: true },
        events: [LLMTextDelta.make({ text: parsed.delta })]
      }
    }

    if (parsed.type === 'response.completed') {
      const events = yield* finalResponseToEvents(parsed.response, state.hasTextDelta)
      const emittedText = events.some(event => event._tag === 'TextDelta')

      return {
        state: { hasTextDelta: state.hasTextDelta || emittedText, hasDone: true },
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

const toStreamLlmError = (error: unknown) => {
  if (error instanceof LLMError) {
    return error
  }

  return new LLMError({
    cause: 'invalid_response',
    message: `Could not read OpenAI Codex stream: ${unknownToMessage(error)}`,
    retryable: false
  })
}

async function* readOpenAiCodexBody(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<LLMEvent, void, void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let format: OpenAiCodexBodyFormat = 'undecided'
  let state = initialSseState

  const emitSseBlock = async (block: string) => {
    const step = await Effect.runPromise(processSseBlock(state, block))
    state = step.state
    return step.events
  }

  try {
    while (true) {
      const chunk = await reader.read()

      if (chunk.done) {
        break
      }

      buffer = normalizeNewlines(`${buffer}${decoder.decode(chunk.value, { stream: true })}`)

      if (format === 'undecided') {
        format = classifyCodexBody(buffer)
      }

      if (format === 'sse') {
        const split = splitCompleteSseBlocks(buffer)
        buffer = split.tail

        for (const block of split.completeBlocks) {
          const events = await emitSseBlock(block)

          for (const event of events) {
            yield event
          }
        }
      }
    }
  } finally {
    reader.releaseLock()
  }

  buffer = normalizeNewlines(`${buffer}${decoder.decode()}`)

  if (format === 'undecided') {
    format = classifyCodexBody(buffer)
  }

  if (format === 'json') {
    const events = await Effect.runPromise(parseOpenAiCodexJsonResponse(buffer))

    for (const event of events) {
      yield event
    }

    return
  }

  if (format === 'sse') {
    const split = splitCompleteSseBlocks(buffer)
    buffer = split.tail

    for (const block of split.completeBlocks) {
      const events = await emitSseBlock(block)

      for (const event of events) {
        yield event
      }
    }

    if (buffer.trim().length > 0) {
      const events = await emitSseBlock(buffer)

      for (const event of events) {
        yield event
      }
    }
  }

  if (!state.hasDone) {
    yield LLMDone.make({ stopReason: 'stop' })
  }
}

const streamOpenAiCodexResponse = (response: Response): Stream.Stream<LLMEvent, LLMError> => {
  const body = response.body

  if (body === null) {
    return Stream.fail(
      new LLMError({
        cause: 'invalid_response',
        message: 'OpenAI Codex response body is empty',
        retryable: false
      })
    )
  }

  return Stream.fromAsyncIterable(readOpenAiCodexBody(body), toStreamLlmError)
}

const sendOpenAiCodexRequest = (
  config: OpenAiCodexConfigShape,
  request: LLMRequest
): Effect.Effect<Response, LLMError> =>
  Effect.gen(function* () {
    const body = yield* toOpenAiCodexRequestBody(request)
    const serializedBody = yield* Effect.try({
      try: () => JSON.stringify(body),
      catch: error =>
        new LLMError({
          cause: 'provider_error',
          message: `Could not serialize OpenAI Codex request: ${unknownToMessage(error)}`,
          retryable: false
        })
    })

    const headers = new Headers({
      accept: 'application/json',
      authorization: `Bearer ${config.token.access}`,
      'content-type': 'application/json',
      originator: 'opencode'
    })

    if (config.token.accountId !== undefined) {
      headers.set('ChatGPT-Account-Id', config.token.accountId)
    }

    const response = yield* Effect.tryPromise({
      try: signal =>
        config.fetch(OPENAI_CODEX_RESPONSES_URL, {
          method: 'POST',
          headers,
          body: serializedBody,
          signal
        }),
      catch: error =>
        new LLMError({
          cause: 'provider_error',
          message: `OpenAI Codex request failed: ${unknownToMessage(error)}`,
          retryable: true
        })
    })

    if (!response.ok) {
      const errorText = yield* Effect.tryPromise({
        try: () => readText(response),
        catch: error =>
          new LLMError({
            cause: 'provider_error',
            message: `Could not read OpenAI Codex error body: ${unknownToMessage(error)}`,
            retryable: false
          })
      })

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
  Layer.succeed(
    LLMProvider,
    LLMProvider.of({
      stream: request =>
        Stream.fromEffect(sendOpenAiCodexRequest(config, request)).pipe(
          Stream.flatMap(streamOpenAiCodexResponse)
        )
    })
  )
