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
  replaceLoneSurrogatesDeep,
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

type OpenAiProviderIdentity = {
  readonly id: string
  readonly name: string
}

export type OpenAiProviderConfig = {
  readonly chatCompletionsUrl?: string
  readonly maxCompletionTokens: number
  /** Selects the compatible endpoint's output-limit parameter. Defaults to `max_completion_tokens`. */
  readonly completionTokenField?: 'max_completion_tokens' | 'max_tokens'
  readonly extraHeaders?: Readonly<Record<string, string>>
  /** Adds compatible endpoint extensions; canonical model/messages/limit/stream fields win. */
  readonly extraBody?: Readonly<Record<string, unknown>>
  /** Customizes safe error metadata for a branded OpenAI-compatible endpoint. */
  readonly providerIdentity?: OpenAiProviderIdentity
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
  readonly max_completion_tokens?: number
  readonly max_tokens?: number
  readonly stream: false
  readonly tools?: ReadonlyArray<OpenAiTool>
  readonly parallel_tool_calls?: true
}

type OpenAiRequestBodyConfig = {
  readonly maxCompletionTokens: number
  readonly completionTokenField?: 'max_completion_tokens' | 'max_tokens'
  readonly extraBody?: Readonly<Record<string, unknown>>
  readonly providerName?: string
}

const defaultOpenAiProviderIdentity: OpenAiProviderIdentity = {
  id: 'openai',
  name: 'OpenAI'
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
  message: OpenAiMessageResponse,
  finish_reason: Schema.optional(Schema.NullOr(Schema.String))
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
    const maxCompletionTokens = yield* Config.int('OPENAI_MAX_COMPLETION_TOKENS')
    return { apiKey, maxCompletionTokens }
  }).pipe(
    Effect.mapError(
      () =>
        new LLMError({
          cause: 'provider_error',
          message: 'OpenAI provider environment configuration missing',
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

const unsupportedContentError = (contentType: string, providerName: string) =>
  new LLMError({
    cause: 'provider_error',
    message: `${contentType} content is not supported by the ${providerName} provider yet`,
    retryable: false
  })

const textDocumentToOpenAiPart = (
  part: Extract<ContentPart, { readonly _tag: 'Document' }>,
  providerName: string
) =>
  attachmentSourceText(part.source).pipe(
    Effect.mapError(() => unsupportedContentError('Invalid document text', providerName)),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(unsupportedContentError('Unresolved document source', providerName)),
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
  part: ContentPart,
  providerName: string
): Effect.Effect<OpenAiTextContentPart | OpenAiImageContentPart, LLMError> => {
  switch (part._tag) {
    case 'Text':
      return Effect.succeed({ type: 'text', text: part.text })
    case 'Image':
      return Option.match(attachmentSourceUrl(part.source, part.mimeType), {
        onNone: () => Effect.fail(unsupportedContentError('Unresolved image source', providerName)),
        onSome: url => Effect.succeed({ type: 'image_url', image_url: { url } })
      })
    case 'Document':
      return isTextDocumentMimeType(part.mimeType)
        ? textDocumentToOpenAiPart(part, providerName)
        : Effect.fail(unsupportedContentError('Document', providerName))
    case 'Audio':
      return Effect.fail(unsupportedContentError('Audio', providerName))
  }
}

const contentToUserContent = (
  content: Content,
  providerName: string
): Effect.Effect<OpenAiUserContent, LLMError> =>
  typeof content === 'string'
    ? Effect.succeed(content)
    : Effect.forEach(content, part => contentPartToUserPart(part, providerName))

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

const serializeToolArguments = (params: unknown, providerName: string) =>
  encodeJsonString(params, `Could not serialize ${providerName} tool arguments`)

const toolCallToOpenAiToolCall = (
  call: ToolCall,
  providerName: string
): Effect.Effect<OpenAiToolCall, LLMError> =>
  Effect.gen(function* () {
    return {
      id: call.id,
      type: 'function',
      function: {
        name: call.name,
        arguments: yield* serializeToolArguments(call.params, providerName)
      }
    }
  })

const toOpenAiMessage = (
  message: AgentMessage,
  providerName: string
): Effect.Effect<OpenAiMessage, LLMError> =>
  Effect.gen(function* () {
    switch (message._tag) {
      case 'User':
        return {
          role: 'user',
          content: yield* contentToUserContent(
            prependMessageContextToContent(message.content, messageContextText(message)),
            providerName
          )
        }
      case 'Assistant': {
        const content = prependMessageContextToContent(
          assistantContent(message),
          messageContextText(message)
        )
        const toolCalls = yield* Effect.forEach(assistantHostToolCalls(message), call =>
          toolCallToOpenAiToolCall(call, providerName)
        )

        if (toolCalls.length > 0) {
          return {
            role: 'assistant',
            content: yield* contentToText(content, 'Assistant', providerName),
            tool_calls: toolCalls
          }
        }

        return {
          role: 'assistant',
          content: yield* contentToText(content, 'Assistant', providerName)
        }
      }
      case 'ToolResult':
        return {
          role: 'tool',
          tool_call_id: message.toolCallId,
          content: yield* contentToText(
            prependMessageContextToContent(message.content, messageContextText(message)),
            'Tool result',
            providerName
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
  config: OpenAiRequestBodyConfig
): Effect.Effect<OpenAiRequestBody, LLMError> =>
  Effect.gen(function* () {
    const providerName = config.providerName ?? defaultOpenAiProviderIdentity.name

    if (!Number.isSafeInteger(config.maxCompletionTokens) || config.maxCompletionTokens <= 0) {
      return yield* Effect.fail(
        new LLMError({
          cause: 'validation_error',
          message: `${providerName} maxCompletionTokens must be a positive safe integer`,
          retryable: false
        })
      )
    }

    yield* validateProviderTranscript(request.messages)
    const systemMessage: OpenAiMessage = { role: 'system', content: request.systemPrompt }
    const requestMessages = yield* Effect.forEach(request.messages, message =>
      toOpenAiMessage(message, providerName)
    )
    const messages = [systemMessage, ...requestMessages]

    const completionTokenLimit =
      config.completionTokenField === 'max_tokens'
        ? { max_tokens: config.maxCompletionTokens }
        : { max_completion_tokens: config.maxCompletionTokens }
    const body: OpenAiRequestBody = {
      ...config.extraBody,
      model: request.model,
      messages,
      ...completionTokenLimit,
      stream: false
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

const parseToolArguments = (raw: string, providerName: string) =>
  decodeJsonString(raw, `Invalid ${providerName} tool arguments JSON`)

const toLlmEvents = (
  choice: OpenAiChoiceResponse,
  providerIdentity: OpenAiProviderIdentity
): Effect.Effect<ReadonlyArray<LLMEvent>, LLMError> =>
  Effect.gen(function* () {
    if (choice.finish_reason === 'length' || choice.finish_reason === 'content_filter') {
      return yield* Effect.fail(
        new LLMError({
          cause: 'invalid_response',
          message: `${providerIdentity.name} response stopped with ${choice.finish_reason}`,
          retryable: false,
          provider: providerErrorInfo({
            provider: providerIdentity.id,
            kind: 'invalid_response',
            providerCode: choice.finish_reason
          })
        })
      )
    }

    const content = choice.message.content ?? ''
    const textEvents = content.length > 0 ? [LLMTextDelta.make({ text: content })] : []
    const toolCallEvents = yield* Effect.forEach(choice.message.tool_calls ?? [], call =>
      parseToolArguments(call.function.arguments, providerIdentity.name).pipe(
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
  (providerIdentity: OpenAiProviderIdentity, retryable: boolean) =>
  (error: HttpClientError.HttpClientError) =>
    new LLMError({
      cause: 'provider_error',
      message: `${providerIdentity.name} request failed: ${error.message}`,
      retryable,
      provider: providerErrorInfo({
        provider: providerIdentity.id,
        kind: retryable ? 'network' : 'unknown'
      })
    })

const parseOpenAiResponseJson = (
  response: HttpClientResponse.HttpClientResponse,
  providerName: string
): Effect.Effect<unknown, LLMError> =>
  response.json.pipe(
    Effect.mapError(
      error =>
        new LLMError({
          cause: 'invalid_response',
          message: `Could not parse ${providerName} response JSON: ${error.message}`,
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
    const providerIdentity = config.providerIdentity ?? defaultOpenAiProviderIdentity
    const body = yield* toOpenAiRequestBody(request, {
      maxCompletionTokens: config.maxCompletionTokens,
      providerName: providerIdentity.name,
      ...(config.completionTokenField === undefined
        ? {}
        : { completionTokenField: config.completionTokenField }),
      ...(config.extraBody === undefined ? {} : { extraBody: config.extraBody })
    })
    // Replayed transcripts can carry lone surrogates; harden the lowered
    // body so one bad historical string cannot poison every model call.
    const serializedBody = yield* encodeJsonString(
      replaceLoneSurrogatesDeep(body),
      `Could not serialize ${providerIdentity.name} request`
    )

    const httpRequest = HttpClientRequest.post(
      config.chatCompletionsUrl ?? 'https://api.openai.com/v1/chat/completions'
    ).pipe(
      HttpClientRequest.setHeaders({
        ...config.extraHeaders,
        accept: 'application/json',
        authorization: `Bearer ${Redacted.value(config.apiKey)}`,
        'content-type': 'application/json'
      }),
      HttpClientRequest.bodyText(serializedBody, 'application/json')
    )
    const response = yield* client
      .execute(httpRequest)
      .pipe(Effect.mapError(toHttpClientLlmError(providerIdentity, true)))

    if (response.status < 200 || response.status >= 300) {
      const errorText = yield* response.text.pipe(
        Effect.mapError(
          error =>
            new LLMError({
              cause: 'provider_error',
              message: `Could not read ${providerIdentity.name} error body: ${error.message}`,
              retryable: false
            })
        )
      )

      const provider = classifyProviderFailure({
        provider: providerIdentity.id,
        status: response.status,
        headers: response.headers,
        body: errorText
      })

      return yield* Effect.fail(
        new LLMError({
          cause: providerFailureCause(provider.kind),
          message: `${providerIdentity.name} returned ${response.status}`,
          retryable: providerFailureRetryable(provider.kind),
          provider
        })
      )
    }

    const json = yield* parseOpenAiResponseJson(response, providerIdentity.name)
    const parsed = yield* Schema.decodeUnknownEffect(OpenAiChatCompletionResponse)(json).pipe(
      Effect.mapError(
        error =>
          new LLMError({
            cause: 'invalid_response',
            message: `Invalid ${providerIdentity.name} response: ${unknownToMessage(error)}`,
            retryable: false
          })
      )
    )
    const choice = parsed.choices[0]

    if (choice === undefined) {
      return yield* Effect.fail(
        new LLMError({
          cause: 'invalid_response',
          message: `${providerIdentity.name} response contained no choices`,
          retryable: false
        })
      )
    }

    const events = yield* toLlmEvents(choice, providerIdentity)

    if (parsed.usage === undefined) {
      return events
    }

    return [...events, LLMUsage.make({ usage: toAgentUsage(parsed.usage) })]
  }).pipe(
    Effect.withSpan(`${config.providerIdentity?.id ?? defaultOpenAiProviderIdentity.id}.stream`)
  )

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
