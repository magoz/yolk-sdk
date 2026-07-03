import { Config, Context, Effect, Layer, Option, Redacted, Stream } from 'effect'
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpClientError,
  type HttpClientResponse
} from 'effect/unstable/http'
import * as Schema from 'effect/Schema'
import {
  ToolCall,
  AgentInputUsage,
  AgentOutputUsage,
  AgentUsage,
  attachmentSourceText,
  attachmentSourceUrl,
  assistantContent,
  assistantHostToolCalls,
  isTextDocumentMimeType,
  messageContextText,
  prependMessageContextToContent,
  type AgentMessage,
  type Content,
  type ContentPart,
  type ToolDef
} from '@yolk-sdk/agent/protocol'
import {
  LLMError,
  LLMDone,
  LLMProvider,
  LLMTextDelta,
  LLMToolCall,
  LLMUsage,
  type LLMEvent,
  type LLMRequest
} from '@yolk-sdk/agent/loop'
import {
  classifyProviderFailure,
  providerErrorInfo,
  providerFailureCause,
  providerFailureRetryable
} from '../provider-error.ts'
import { validateProviderTranscript } from '../transcript.ts'

export type OpenAiProviderConfig = {
  readonly chatCompletionsUrl?: string
  readonly maxCompletionTokens?: number
  readonly extraHeaders?: Readonly<Record<string, string>>
  readonly apiKey: Redacted.Redacted<string>
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
  readonly parallel_tool_calls?: true
}

class OpenAiFunctionResponse extends Schema.Class<OpenAiFunctionResponse>('OpenAiFunctionResponse')(
  {
    name: Schema.String,
    arguments: Schema.String
  }
) {}

class OpenAiToolCallResponse extends Schema.Class<OpenAiToolCallResponse>('OpenAiToolCallResponse')(
  {
    id: Schema.String,
    type: Schema.Literals(['function']),
    function: OpenAiFunctionResponse
  }
) {}

class OpenAiMessageResponse extends Schema.Class<OpenAiMessageResponse>('OpenAiMessageResponse')({
  content: Schema.NullOr(Schema.String),
  tool_calls: Schema.optional(Schema.Array(OpenAiToolCallResponse))
}) {}

class OpenAiChoiceResponse extends Schema.Class<OpenAiChoiceResponse>('OpenAiChoiceResponse')({
  message: OpenAiMessageResponse
}) {}

class OpenAiPromptTokensDetails extends Schema.Class<OpenAiPromptTokensDetails>(
  'OpenAiPromptTokensDetails'
)({
  cached_tokens: Schema.optional(Schema.Number)
}) {}

class OpenAiCompletionTokensDetails extends Schema.Class<OpenAiCompletionTokensDetails>(
  'OpenAiCompletionTokensDetails'
)({
  reasoning_tokens: Schema.optional(Schema.Number)
}) {}

class OpenAiUsageResponse extends Schema.Class<OpenAiUsageResponse>('OpenAiUsageResponse')({
  prompt_tokens: Schema.Number,
  completion_tokens: Schema.Number,
  prompt_tokens_details: Schema.optional(OpenAiPromptTokensDetails),
  completion_tokens_details: Schema.optional(OpenAiCompletionTokensDetails)
}) {}

class OpenAiChatCompletionResponse extends Schema.Class<OpenAiChatCompletionResponse>(
  'OpenAiChatCompletionResponse'
)({
  choices: Schema.Array(OpenAiChoiceResponse),
  usage: Schema.optional(OpenAiUsageResponse)
}) {}

class OpenAiConfig extends Context.Service<OpenAiConfig, OpenAiProviderConfig>()(
  '@app/OpenAiConfig'
) {}

const OpenAiConfigLayer = Layer.effect(
  OpenAiConfig,
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted('OPENAI_API_KEY')
    return { apiKey }
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
    message: `${contentType} content is not supported by the OpenAI provider yet`,
    retryable: false
  })

const textDocumentToOpenAiPart = (part: Extract<ContentPart, { readonly _tag: 'Document' }>) =>
  attachmentSourceText(part.source).pipe(
    Effect.mapError(() => unsupportedContentError('Invalid document text')),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(unsupportedContentError('Unresolved document source')),
        onSome: text => {
          const block: OpenAiTextContentPart = {
            type: 'text',
            text: `Document: ${part.title ?? part.filename}\n\n${text}`
          }

          return Effect.succeed(block)
        }
      })
    )
  )

const contentPartToUserPart = (
  part: ContentPart
): Effect.Effect<OpenAiTextContentPart | OpenAiImageContentPart, LLMError> => {
  switch (part._tag) {
    case 'Text':
      return Effect.succeed({ type: 'text', text: part.text })
    case 'Image':
      return Option.match(attachmentSourceUrl(part.source, part.mimeType), {
        onNone: () => Effect.fail(unsupportedContentError('Unresolved image source')),
        onSome: url => Effect.succeed({ type: 'image_url', image_url: { url } })
      })
    case 'Document':
      return isTextDocumentMimeType(part.mimeType)
        ? textDocumentToOpenAiPart(part)
        : Effect.fail(unsupportedContentError('Document'))
    case 'Audio':
      return Effect.fail(unsupportedContentError('Audio'))
  }
}

const contentToUserContent = (content: Content): Effect.Effect<OpenAiUserContent, LLMError> =>
  typeof content === 'string'
    ? Effect.succeed(content)
    : Effect.forEach(content, contentPartToUserPart)

const contentPartToText = (part: ContentPart, owner: string): Effect.Effect<string, LLMError> => {
  switch (part._tag) {
    case 'Text':
      return Effect.succeed(part.text)
    case 'Image':
      return Effect.fail(unsupportedContentError(`${owner} image`))
    case 'Document':
      return Effect.fail(unsupportedContentError(`${owner} document`))
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

const serializeToolArguments = (params: unknown) =>
  encodeJsonString(params, 'Could not serialize OpenAI tool arguments')

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
        return {
          role: 'user',
          content: yield* contentToUserContent(
            prependMessageContextToContent(message.content, messageContextText(message))
          )
        }
      case 'Assistant': {
        const content = prependMessageContextToContent(
          assistantContent(message),
          messageContextText(message)
        )
        const toolCalls = yield* Effect.forEach(
          assistantHostToolCalls(message),
          toolCallToOpenAiToolCall
        )

        if (toolCalls.length > 0) {
          return {
            role: 'assistant',
            content: yield* contentToText(content, 'Assistant'),
            tool_calls: toolCalls
          }
        }

        return {
          role: 'assistant',
          content: yield* contentToText(content, 'Assistant')
        }
      }
      case 'ToolResult':
        return {
          role: 'tool',
          tool_call_id: message.toolCallId,
          content: yield* contentToText(
            prependMessageContextToContent(message.content, messageContextText(message)),
            'Tool result'
          )
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
  request: LLMRequest,
  config?: { readonly maxCompletionTokens?: number }
): Effect.Effect<OpenAiRequestBody, LLMError> =>
  Effect.gen(function* () {
    yield* validateProviderTranscript(request.messages)
    const systemMessage: OpenAiMessage = { role: 'system', content: request.systemPrompt }
    const requestMessages = yield* Effect.forEach(request.messages, toOpenAiMessage)
    const messages = [systemMessage, ...requestMessages]

    const body = {
      model: request.model,
      messages,
      max_completion_tokens: config?.maxCompletionTokens ?? 4096
    }

    if (request.tools.length === 0) {
      return body
    }

    return {
      ...body,
      tools: request.tools.map(toOpenAiTool),
      parallel_tool_calls: true
    }
  })

const parseToolArguments = (raw: string) =>
  decodeJsonString(raw, 'Invalid OpenAI tool arguments JSON')

const toLlmEvents = (
  message: OpenAiMessageResponse
): Effect.Effect<ReadonlyArray<LLMEvent>, LLMError> =>
  Effect.gen(function* () {
    const content = message.content ?? ''
    const textEvents = content.length > 0 ? [LLMTextDelta.make({ text: content })] : []
    const toolCallEvents = yield* Effect.forEach(message.tool_calls ?? [], call =>
      parseToolArguments(call.function.arguments).pipe(
        Effect.map(params =>
          LLMToolCall.make({
            call: ToolCall.make({
              id: call.id,
              name: call.function.name,
              params
            })
          })
        )
      )
    )

    if (toolCallEvents.length > 0) {
      return [...textEvents, ...toolCallEvents, LLMDone.make({ stopReason: 'tool_use' })]
    }

    return [...textEvents, LLMDone.make({ stopReason: 'stop' })]
  })

const toAgentUsage = (usage: OpenAiUsageResponse) =>
  AgentUsage.make({
    input: AgentInputUsage.make({
      total: usage.prompt_tokens,
      uncached: usage.prompt_tokens - (usage.prompt_tokens_details?.cached_tokens ?? 0),
      cacheRead: usage.prompt_tokens_details?.cached_tokens
    }),
    output: AgentOutputUsage.make({
      total: usage.completion_tokens,
      reasoning: usage.completion_tokens_details?.reasoning_tokens,
      text: usage.completion_tokens - (usage.completion_tokens_details?.reasoning_tokens ?? 0)
    })
  })

const toHttpClientLlmError =
  (message: string, retryable: boolean) => (error: HttpClientError.HttpClientError) =>
    new LLMError({
      cause: 'provider_error',
      message: `${message}: ${error.message}`,
      retryable,
      provider: providerErrorInfo({
        provider: 'openai',
        kind: retryable ? 'network' : 'unknown'
      })
    })

const parseOpenAiResponseJson = (
  response: HttpClientResponse.HttpClientResponse
): Effect.Effect<unknown, LLMError> =>
  response.json.pipe(
    Effect.mapError(
      error =>
        new LLMError({
          cause: 'invalid_response',
          message: `Could not parse OpenAI response JSON: ${error.message}`,
          retryable: false
        })
    )
  )

const sendOpenAiRequest = (
  config: OpenAiProviderConfig,
  request: LLMRequest,
  client: HttpClient.HttpClient
): Effect.Effect<ReadonlyArray<LLMEvent>, LLMError> =>
  Effect.gen(function* () {
    const body = yield* toOpenAiRequestBody(request, config)
    const serializedBody = yield* encodeJsonString(body, 'Could not serialize OpenAI request')

    const httpRequest = HttpClientRequest.post(
      config.chatCompletionsUrl ?? 'https://api.openai.com/v1/chat/completions'
    ).pipe(
      HttpClientRequest.setHeaders({
        accept: 'application/json',
        authorization: `Bearer ${Redacted.value(config.apiKey)}`,
        'content-type': 'application/json',
        ...config.extraHeaders
      }),
      HttpClientRequest.bodyText(serializedBody, 'application/json')
    )
    const response = yield* client
      .execute(httpRequest)
      .pipe(Effect.mapError(toHttpClientLlmError('OpenAI request failed', true)))

    if (response.status < 200 || response.status >= 300) {
      const errorText = yield* response.text.pipe(
        Effect.mapError(
          error =>
            new LLMError({
              cause: 'provider_error',
              message: `Could not read OpenAI error body: ${error.message}`,
              retryable: false
            })
        )
      )

      const provider = classifyProviderFailure({
        provider: 'openai',
        status: response.status,
        headers: response.headers,
        body: errorText
      })

      return yield* Effect.fail(
        new LLMError({
          cause: providerFailureCause(provider.kind),
          message: `OpenAI returned ${response.status}`,
          retryable: providerFailureRetryable(provider.kind),
          provider
        })
      )
    }

    const json = yield* parseOpenAiResponseJson(response)
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

    const events = yield* toLlmEvents(choice.message)

    if (parsed.usage === undefined) {
      return events
    }

    return [...events, LLMUsage.make({ usage: toAgentUsage(parsed.usage) })]
  }).pipe(Effect.withSpan('OpenAiProvider.stream'))

export const makeOpenAiProviderLayer = (config: OpenAiProviderConfig) =>
  Layer.effect(
    LLMProvider,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient

      return LLMProvider.of({
        stream: request =>
          Stream.fromEffect(sendOpenAiRequest(config, request, client)).pipe(
            Stream.flatMap(events => Stream.fromIterable(events))
          )
      })
    })
  )

export const OpenAiProviderLayer = Layer.effect(
  LLMProvider,
  Effect.gen(function* () {
    const config = yield* OpenAiConfig
    const client = yield* HttpClient.HttpClient

    return LLMProvider.of({
      stream: request =>
        Stream.fromEffect(sendOpenAiRequest(config, request, client)).pipe(
          Stream.flatMap(events => Stream.fromIterable(events))
        )
    })
  })
).pipe(Layer.provide(Layer.mergeAll(OpenAiConfigLayer, FetchHttpClient.layer)))
