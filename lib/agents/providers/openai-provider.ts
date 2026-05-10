import { Config, Context, Effect, Layer, Redacted, Stream } from 'effect'
import * as Schema from 'effect/Schema'
import { ToolCall, type AgentMessage, type Content, type ContentPart, type ToolDef } from '@yolk/protocol'
import {
  LLMError,
  LLMDone,
  LLMProvider,
  LLMTextDelta,
  LLMToolCall,
  type LLMEvent,
  type LLMRequest
} from '@yolk/agent-loop'

type OpenAiConfigShape = {
  readonly apiKey: Redacted.Redacted<string>
  readonly fetch: typeof fetch
}

type OpenAiTextContentPart = {
  readonly type: 'text'
  readonly text: string
}

type OpenAiImageContentPart = {
  readonly type: 'image_url'
  readonly image_url: {
    readonly url: string
  }
}

type OpenAiUserContent = string | ReadonlyArray<OpenAiTextContentPart | OpenAiImageContentPart>

type OpenAiToolCall = {
  readonly id: string
  readonly type: 'function'
  readonly function: {
    readonly name: string
    readonly arguments: string
  }
}

type OpenAiMessage =
  | { readonly role: 'system'; readonly content: string }
  | { readonly role: 'user'; readonly content: OpenAiUserContent }
  | {
      readonly role: 'assistant'
      readonly content: string | null
      readonly tool_calls?: ReadonlyArray<OpenAiToolCall>
    }
  | { readonly role: 'tool'; readonly tool_call_id: string; readonly content: string }

type OpenAiTool = {
  readonly type: 'function'
  readonly function: {
    readonly name: string
    readonly description: string
    readonly parameters: unknown
  }
}

type OpenAiRequestBody = {
  readonly model: string
  readonly messages: ReadonlyArray<OpenAiMessage>
  readonly max_completion_tokens: number
  readonly tools?: ReadonlyArray<OpenAiTool>
}

class OpenAiFunctionResponse extends Schema.Class<OpenAiFunctionResponse>('OpenAiFunctionResponse')({
  name: Schema.String,
  arguments: Schema.String
}) {}

class OpenAiToolCallResponse extends Schema.Class<OpenAiToolCallResponse>(
  'OpenAiToolCallResponse'
)({
  id: Schema.String,
  type: Schema.Literals(['function']),
  function: OpenAiFunctionResponse
}) {}

class OpenAiMessageResponse extends Schema.Class<OpenAiMessageResponse>('OpenAiMessageResponse')({
  content: Schema.NullOr(Schema.String),
  tool_calls: Schema.optional(Schema.Array(OpenAiToolCallResponse))
}) {}

class OpenAiChoiceResponse extends Schema.Class<OpenAiChoiceResponse>('OpenAiChoiceResponse')({
  message: OpenAiMessageResponse
}) {}

class OpenAiChatCompletionResponse extends Schema.Class<OpenAiChatCompletionResponse>(
  'OpenAiChatCompletionResponse'
)({
  choices: Schema.Array(OpenAiChoiceResponse)
}) {}

class OpenAiConfig extends Context.Service<OpenAiConfig, OpenAiConfigShape>()('@app/OpenAiConfig') {}

const OpenAiConfigLayer = Layer.effect(
  OpenAiConfig,
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted('OPENAI_API_KEY')
    return { apiKey, fetch: globalThis.fetch }
  }).pipe(
    Effect.mapError(
      () =>
        new LLMError({
          cause: 'provider_error',
          message: 'OPENAI_API_KEY not found',
          retryable: false
        })
    )
  )
)

const unknownToMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

const unsupportedContentError = (contentType: string) =>
  new LLMError({
    cause: 'provider_error',
    message: `${contentType} content is not supported by the OpenAI provider yet`,
    retryable: false
  })

const contentPartToUserPart = (
  part: ContentPart
): Effect.Effect<OpenAiTextContentPart | OpenAiImageContentPart, LLMError> => {
  switch (part._tag) {
    case 'Text':
      return Effect.succeed({ type: 'text', text: part.text })
    case 'Image':
      return Effect.succeed({
        type: 'image_url',
        image_url: { url: `data:${part.mimeType};base64,${part.data}` }
      })
    case 'Audio':
      return Effect.fail(unsupportedContentError('Audio'))
  }
}

const contentToUserContent = (content: Content): Effect.Effect<OpenAiUserContent, LLMError> =>
  Effect.gen(function* () {
    if (typeof content === 'string') {
      return content
    }

    const parts: Array<OpenAiTextContentPart | OpenAiImageContentPart> = []

    for (const part of content) {
      parts.push(yield* contentPartToUserPart(part))
    }

    return parts
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
        message: `Could not serialize OpenAI tool arguments: ${unknownToMessage(error)}`,
        retryable: false
      })
  })

const toolCallToOpenAiToolCall = (call: ToolCall): Effect.Effect<OpenAiToolCall, LLMError> =>
  Effect.gen(function* () {
    return {
      id: call.id,
      type: 'function',
      function: {
        name: call.name,
        arguments: yield* serializeToolArguments(call.params)
      }
    }
  })

const toOpenAiMessage = (message: AgentMessage): Effect.Effect<OpenAiMessage, LLMError> =>
  Effect.gen(function* () {
    switch (message._tag) {
      case 'User':
        return { role: 'user', content: yield* contentToUserContent(message.content) }
      case 'Assistant': {
        const toolCalls: Array<OpenAiToolCall> = []
        for (const call of message.toolCalls) {
          toolCalls.push(yield* toolCallToOpenAiToolCall(call))
        }

        if (toolCalls.length > 0) {
          return {
            role: 'assistant',
            content: yield* contentToText(message.content, 'Assistant'),
            tool_calls: toolCalls
          }
        }

        return {
          role: 'assistant',
          content: yield* contentToText(message.content, 'Assistant')
        }
      }
      case 'ToolResult':
        return {
          role: 'tool',
          tool_call_id: message.toolCallId,
          content: yield* contentToText(message.content, 'Tool result')
        }
    }
  })

const toOpenAiTool = (tool: ToolDef): OpenAiTool => ({
  type: 'function',
  function: {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters
  }
})

export const toOpenAiRequestBody = (
  request: LLMRequest
): Effect.Effect<OpenAiRequestBody, LLMError> =>
  Effect.gen(function* () {
    const messages: Array<OpenAiMessage> = [
      { role: 'system', content: request.systemPrompt }
    ]

    for (const message of request.messages) {
      messages.push(yield* toOpenAiMessage(message))
    }

    const body = {
      model: request.model,
      messages,
      max_completion_tokens: 4096
    }

    if (request.tools.length === 0) {
      return body
    }

    return {
      ...body,
      tools: request.tools.map(toOpenAiTool)
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

const parseJson = (response: Response): Promise<unknown> => response.json()
const readText = (response: Response): Promise<string> => response.text()

const parseToolArguments = (raw: string) =>
  Effect.try({
    try: (): unknown => JSON.parse(raw),
    catch: error =>
      new LLMError({
        cause: 'invalid_response',
        message: `Invalid OpenAI tool arguments JSON: ${unknownToMessage(error)}`,
        retryable: false
      })
  })

const toLlmEvents = (
  message: OpenAiMessageResponse
): Effect.Effect<ReadonlyArray<LLMEvent>, LLMError> =>
  Effect.gen(function* () {
    const events: Array<LLMEvent> = []
    const content = message.content ?? ''

    if (content.length > 0) {
      events.push(LLMTextDelta.make({ text: content }))
    }

    if (message.tool_calls !== undefined && message.tool_calls.length > 0) {
      for (const call of message.tool_calls) {
        events.push(
          LLMToolCall.make({
            call: ToolCall.make({
              id: call.id,
              name: call.function.name,
              params: yield* parseToolArguments(call.function.arguments)
            })
          })
        )
      }

      events.push(LLMDone.make({ stopReason: 'tool_use' }))
      return events
    }

    events.push(LLMDone.make({ stopReason: 'stop' }))
    return events
  })

const sendOpenAiRequest = (
  config: OpenAiConfigShape,
  request: LLMRequest
): Effect.Effect<ReadonlyArray<LLMEvent>, LLMError> =>
  Effect.gen(function* () {
    const body = yield* toOpenAiRequestBody(request)
    const serializedBody = yield* Effect.try({
      try: () => JSON.stringify(body),
      catch: error =>
        new LLMError({
          cause: 'provider_error',
          message: `Could not serialize OpenAI request: ${unknownToMessage(error)}`,
          retryable: false
        })
    })

    const response = yield* Effect.tryPromise({
      try: signal =>
        config.fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${Redacted.value(config.apiKey)}`,
            'content-type': 'application/json'
          },
          body: serializedBody,
          signal
        }),
      catch: error =>
        new LLMError({
          cause: 'provider_error',
          message: `OpenAI request failed: ${unknownToMessage(error)}`,
          retryable: true
        })
    })

    if (!response.ok) {
      const errorText = yield* Effect.tryPromise({
        try: () => readText(response),
        catch: error =>
          new LLMError({
            cause: 'provider_error',
            message: `Could not read OpenAI error body: ${unknownToMessage(error)}`,
            retryable: false
          })
      })

      return yield* Effect.fail(
        new LLMError({
          cause: responseStatusToCause(response.status),
          message: `OpenAI returned ${response.status}: ${errorText}`,
          retryable: isRetryableStatus(response.status)
        })
      )
    }

    const json = yield* Effect.tryPromise({
      try: () => parseJson(response),
      catch: error =>
        new LLMError({
          cause: 'invalid_response',
          message: `Could not parse OpenAI response JSON: ${unknownToMessage(error)}`,
          retryable: false
        })
    })
    const parsed = yield* Schema.decodeUnknownEffect(OpenAiChatCompletionResponse)(json).pipe(
      Effect.mapError(
        error =>
          new LLMError({
            cause: 'invalid_response',
            message: `Invalid OpenAI response: ${unknownToMessage(error)}`,
            retryable: false
          })
      )
    )
    const choice = parsed.choices[0]

    if (choice === undefined) {
      return yield* Effect.fail(
        new LLMError({
          cause: 'invalid_response',
          message: 'OpenAI response contained no choices',
          retryable: false
        })
      )
    }

    return yield* toLlmEvents(choice.message)
  }).pipe(Effect.withSpan('OpenAiProvider.stream'))

export const makeOpenAiProviderLayer = (config: OpenAiConfigShape) =>
  Layer.succeed(
    LLMProvider,
    LLMProvider.of({
      stream: request =>
        Stream.fromEffect(sendOpenAiRequest(config, request)).pipe(
          Stream.flatMap(events => Stream.fromIterable(events))
        )
    })
  )

export const OpenAiProviderLayer = Layer.effect(
  LLMProvider,
  Effect.gen(function* () {
    const config = yield* OpenAiConfig

    return LLMProvider.of({
      stream: request =>
        Stream.fromEffect(sendOpenAiRequest(config, request)).pipe(
          Stream.flatMap(events => Stream.fromIterable(events))
        )
    })
  })
).pipe(Layer.provide(OpenAiConfigLayer))
