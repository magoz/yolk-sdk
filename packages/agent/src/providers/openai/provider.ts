import { Config, Context, Effect, Layer, Match, Option, Predicate, Redacted, Stream } from 'effect'
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
  type AgentReasoningEffort,
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

/** Chat Completions extras input; lowering admits a portable JSON-object snapshot. */
export type OpenAiRequestExtras = {
  readonly [key: string]: Schema.Json
}

const isPlainObject = (value: object) => {
  const proto = Object.getPrototypeOf(value)

  return proto === Object.prototype || proto === null
}

const isDataPropertyDescriptor = (descriptor: PropertyDescriptor) =>
  descriptor.enumerable === true && Object.hasOwn(descriptor, 'value')

const snapshotFailed = Option.none<Schema.Json>()

const snapshotPortableJson = (
  value: unknown,
  stack: Set<object>,
  memo: Map<object, Schema.Json>
): Option.Option<Schema.Json> => {
  if (value === null || Predicate.isString(value) || Predicate.isBoolean(value)) {
    return Option.some(value)
  }

  if (Predicate.isNumber(value)) {
    return Number.isFinite(value) ? Option.some(value) : snapshotFailed
  }

  if (!Predicate.isObjectOrArray(value)) {
    return snapshotFailed
  }

  if (stack.has(value)) {
    return snapshotFailed
  }

  const memoized = memo.get(value)

  if (memoized !== undefined) {
    return Option.some(memoized)
  }

  stack.add(value)

  if (Array.isArray(value)) {
    if (
      Object.getPrototypeOf(value) !== Array.prototype ||
      Object.getOwnPropertySymbols(value).length !== 0 ||
      Object.getOwnPropertyNames(value).length !== value.length + 1
    ) {
      stack.delete(value)

      return snapshotFailed
    }

    const items: Array<Schema.Json> = []

    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, index)

      if (descriptor === undefined || !isDataPropertyDescriptor(descriptor)) {
        stack.delete(value)

        return snapshotFailed
      }

      const item = snapshotPortableJson(descriptor.value, stack, memo)

      if (Option.isNone(item)) {
        stack.delete(value)

        return snapshotFailed
      }

      items.push(item.value)
    }

    stack.delete(value)
    memo.set(value, items)

    return Option.some(items)
  }

  if (!isPlainObject(value)) {
    stack.delete(value)

    return snapshotFailed
  }

  const keys = Object.keys(value)

  if (
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.getOwnPropertyNames(value).length !== keys.length
  ) {
    stack.delete(value)

    return snapshotFailed
  }

  const snapshot: { [key: string]: Schema.Json } = {}

  Object.setPrototypeOf(snapshot, null)

  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)

    if (descriptor === undefined || !isDataPropertyDescriptor(descriptor)) {
      stack.delete(value)

      return snapshotFailed
    }

    const field = snapshotPortableJson(descriptor.value, stack, memo)

    if (Option.isNone(field)) {
      stack.delete(value)

      return snapshotFailed
    }

    Object.defineProperty(snapshot, key, {
      value: field.value,
      enumerable: true,
      writable: true,
      configurable: true
    })
  }

  stack.delete(value)
  memo.set(value, snapshot)

  return Option.some(snapshot)
}

const openAiCanonicalRequestKeys = new Set([
  'model',
  'messages',
  'stream',
  'tools',
  'parallel_tool_calls',
  'max_completion_tokens',
  'max_tokens'
])

export type OpenAiProviderConfig = {
  readonly chatCompletionsUrl?: string
  readonly maxCompletionTokens: number
  /** Selects the compatible endpoint's output-limit parameter. Defaults to `max_completion_tokens`. */
  readonly completionTokenField?: 'max_completion_tokens' | 'max_tokens'
  readonly extraHeaders?: Readonly<Record<string, string>>
  /**
   * Admitted portable JSON-object extras. Runtime still snapshots and validates
   * untyped input. Canonical model/messages/limit/stream/tools keys are omitted
   * without reading values.
   */
  readonly extraBody?: OpenAiRequestExtras
  /** Opts into a compatible endpoint's `{ reasoning: { effort } }` request extension. */
  readonly reasoningEffortFormat?: 'reasoning-object'
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
    readonly parameters: Schema.Json
  }
}

type OpenAiRequestBody = {
  readonly model: string
  readonly messages: ReadonlyArray<OpenAiMessage>
  readonly max_completion_tokens?: number
  readonly max_tokens?: number
  readonly stream: false
  readonly reasoning?: {
    readonly effort: AgentReasoningEffort
  }
  readonly tools?: ReadonlyArray<OpenAiTool>
  readonly parallel_tool_calls?: true
}

type OpenAiRequestBodyConfig = {
  readonly maxCompletionTokens: number
  readonly completionTokenField?: 'max_completion_tokens' | 'max_tokens'
  readonly extraBody?: unknown
  readonly reasoningEffortFormat?: 'reasoning-object'
  readonly providerName?: string
}

type OpenAiRequestBodyConfigFields = {
  maxCompletionTokens: number
  providerName: string
  completionTokenField?: OpenAiRequestBodyConfig['completionTokenField']
  extraBody?: OpenAiRequestBodyConfig['extraBody']
  reasoningEffortFormat?: OpenAiRequestBodyConfig['reasoningEffortFormat']
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
    const apiKey = yield* Config.Redacted('OPENAI_API_KEY')
    const maxCompletionTokens = yield* Config.Int('OPENAI_MAX_COMPLETION_TOKENS')

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

const JsonFromJsonString = Schema.fromJsonString(Schema.Json)

const schemaErrorMessage = (error: Schema.SchemaError) => error.message

const schemaErrorToLlmError =
  (cause: LLMError['cause'], message: string) => (error: Schema.SchemaError) =>
    new LLMError({
      cause,
      message: `${message}: ${schemaErrorMessage(error)}`,
      retryable: false
    })

const encodeJsonString = (value: Schema.Json, message: string) =>
  Schema.encodeEffect(JsonFromJsonString)(value).pipe(
    Effect.mapError(schemaErrorToLlmError('provider_error', message))
  )

const invalidExtraBodyError = (providerName: string) =>
  new LLMError({
    cause: 'provider_error',
    message: `Invalid ${providerName} extraBody JSON: expected a JSON object`,
    retryable: false
  })

const isOpenAiCanonicalRequestKey = (key: string, config: OpenAiRequestBodyConfig) =>
  openAiCanonicalRequestKeys.has(key) ||
  (config.reasoningEffortFormat === 'reasoning-object' && key === 'reasoning')

const snapshotOpenAiRequestExtras = (
  extraBody: unknown,
  config: OpenAiRequestBodyConfig,
  providerName: string
): Effect.Effect<OpenAiRequestExtras, LLMError> => {
  if (
    !Predicate.isObjectOrArray(extraBody) ||
    Array.isArray(extraBody) ||
    !isPlainObject(extraBody)
  ) {
    return Effect.fail(invalidExtraBodyError(providerName))
  }

  const surviving: { [key: string]: Schema.Json } = {}

  Object.setPrototypeOf(surviving, null)

  const stack = new Set<object>()
  const memo = new Map<object, Schema.Json>()

  for (const key of Object.keys(extraBody)) {
    if (isOpenAiCanonicalRequestKey(key, config)) continue

    const descriptor = Object.getOwnPropertyDescriptor(extraBody, key)

    if (descriptor === undefined || !isDataPropertyDescriptor(descriptor)) {
      return Effect.fail(invalidExtraBodyError(providerName))
    }

    const field = snapshotPortableJson(descriptor.value, stack, memo)

    if (Option.isNone(field)) {
      return Effect.fail(invalidExtraBodyError(providerName))
    }

    Object.defineProperty(surviving, key, {
      value: field.value,
      enumerable: true,
      writable: true,
      configurable: true
    })
  }

  return Effect.succeed(surviving)
}

const decodeJsonString = (raw: string, message: string) =>
  Schema.decodeUnknownEffect(JsonFromJsonString)(raw).pipe(
    Effect.mapError(schemaErrorToLlmError('invalid_response', message))
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
): Effect.Effect<OpenAiTextContentPart | OpenAiImageContentPart, LLMError> =>
  Match.value(part).pipe(
    Match.tag(
      'Text',
      (current): Effect.Effect<OpenAiTextContentPart | OpenAiImageContentPart, LLMError> =>
        Effect.succeed({ type: 'text', text: current.text })
    ),
    Match.tag(
      'Image',
      (current): Effect.Effect<OpenAiTextContentPart | OpenAiImageContentPart, LLMError> =>
        Option.match(attachmentSourceUrl(current.source, current.mimeType), {
          onNone: () =>
            Effect.fail(unsupportedContentError('Unresolved image source', providerName)),
          onSome: url => Effect.succeed({ type: 'image_url', image_url: { url } })
        })
    ),
    Match.tag('Document', current =>
      isTextDocumentMimeType(current.mimeType)
        ? textDocumentToOpenAiPart(current, providerName)
        : Effect.fail(unsupportedContentError('Document', providerName))
    ),
    Match.tag('Audio', () => Effect.fail(unsupportedContentError('Audio', providerName))),
    Match.exhaustive
  )

const contentToUserContent = (
  content: Content,
  providerName: string
): Effect.Effect<OpenAiUserContent, LLMError> =>
  Predicate.isString(content)
    ? Effect.succeed(content)
    : Effect.forEach(content, part => contentPartToUserPart(part, providerName))

const contentPartToText = (
  part: ContentPart,
  owner: string,
  providerName: string
): Effect.Effect<string, LLMError> =>
  Match.value(part).pipe(
    Match.tag('Text', current => Effect.succeed(current.text)),
    Match.tag('Image', () => Effect.fail(unsupportedContentError(`${owner} image`, providerName))),
    Match.tag('Document', () =>
      Effect.fail(unsupportedContentError(`${owner} document`, providerName))
    ),
    Match.tag('Audio', () => Effect.fail(unsupportedContentError(`${owner} audio`, providerName))),
    Match.exhaustive
  )

const contentToText = (
  content: Content,
  owner: string,
  providerName: string
): Effect.Effect<string, LLMError> =>
  Predicate.isString(content)
    ? Effect.succeed(content)
    : Effect.forEach(content, part => contentPartToText(part, owner, providerName)).pipe(
        Effect.map(textParts => textParts.join('\n'))
      )

const serializeToolArguments = (call: ToolCall, providerName: string) =>
  Schema.decodeUnknownEffect(Schema.Json)(call.params).pipe(
    Effect.mapError(
      schemaErrorToLlmError('provider_error', `Could not serialize ${providerName} tool arguments`)
    ),
    Effect.flatMap(json =>
      encodeJsonString(json, `Could not serialize ${providerName} tool arguments`)
    )
  )

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
        arguments: yield* serializeToolArguments(call, providerName)
      }
    }
  })

const toOpenAiMessage = (
  message: AgentMessage,
  providerName: string
): Effect.Effect<OpenAiMessage, LLMError> =>
  Match.value(message).pipe(
    Match.withReturnType<Effect.Effect<OpenAiMessage, LLMError>>(),
    Match.tag('User', current =>
      contentToUserContent(
        prependMessageContextToContent(current.content, messageContextText(current)),
        providerName
      ).pipe(Effect.map(content => ({ role: 'user' as const, content })))
    ),
    Match.tag('Assistant', current => {
      const content = prependMessageContextToContent(
        assistantContent(current),
        messageContextText(current)
      )

      return Effect.forEach(assistantHostToolCalls(current), call =>
        toolCallToOpenAiToolCall(call, providerName)
      ).pipe(
        Effect.flatMap(toolCalls =>
          contentToText(content, 'Assistant', providerName).pipe(
            Effect.map(text =>
              toolCalls.length > 0
                ? {
                    role: 'assistant' as const,
                    content: text,
                    tool_calls: toolCalls
                  }
                : {
                    role: 'assistant' as const,
                    content: text
                  }
            )
          )
        )
      )
    }),
    Match.tag('ToolResult', current =>
      contentToText(
        prependMessageContextToContent(current.content, messageContextText(current)),
        'Tool result',
        providerName
      ).pipe(
        Effect.map(content => ({
          role: 'tool' as const,
          tool_call_id: current.toolCallId,
          content
        }))
      )
    ),
    Match.exhaustive
  )

const toOpenAiTool = (tool: ToolDef, providerName: string): Effect.Effect<OpenAiTool, LLMError> =>
  Schema.decodeUnknownEffect(Schema.Json)(tool.parameters).pipe(
    Effect.mapError(
      schemaErrorToLlmError('provider_error', `Invalid ${providerName} tool parameters JSON`)
    ),
    Effect.map((parameters): OpenAiTool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters
      }
    }))
  )

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

    const reasoning =
      config.reasoningEffortFormat === 'reasoning-object' && request.reasoningEffort !== undefined
        ? { reasoning: { effort: request.reasoningEffort } }
        : {}

    const extraBody =
      config.extraBody === undefined
        ? {}
        : yield* snapshotOpenAiRequestExtras(config.extraBody, config, providerName)

    const bodyWithoutTools: OpenAiRequestBody = {
      ...extraBody,
      ...reasoning,
      model: request.model,
      messages,
      ...completionTokenLimit,
      stream: false
    }

    const body: OpenAiRequestBody =
      request.tools.length === 0
        ? bodyWithoutTools
        : {
            ...bodyWithoutTools,
            tools: yield* Effect.forEach(request.tools, tool => toOpenAiTool(tool, providerName)),
            parallel_tool_calls: true
          }

    return body
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
): Effect.Effect<Schema.Json, LLMError> =>
  Effect.gen(function* () {
    const raw = yield* response.json.pipe(
      Effect.mapError(
        error =>
          new LLMError({
            cause: 'invalid_response',
            message: `Could not parse ${providerName} response JSON: ${error.message}`,
            retryable: false
          })
      )
    )

    return yield* Schema.decodeUnknownEffect(Schema.Json)(raw).pipe(
      Effect.mapError(
        schemaErrorToLlmError('invalid_response', `Could not parse ${providerName} response JSON`)
      )
    )
  })

const sendOpenAiRequest = (
  config: OpenAiProviderConfig,
  request: LLMRequest,
  client: HttpClient.HttpClient
): Effect.Effect<ReadonlyArray<LLMEvent>, LLMError> =>
  Effect.gen(function* () {
    const providerIdentity = config.providerIdentity ?? defaultOpenAiProviderIdentity

    const body = yield* toOpenAiRequestBody(
      request,
      (() => {
        const fields: OpenAiRequestBodyConfigFields = {
          maxCompletionTokens: config.maxCompletionTokens,
          providerName: providerIdentity.name
        }

        if (config.completionTokenField !== undefined) {
          fields.completionTokenField = config.completionTokenField
        }

        if (config.extraBody !== undefined) {
          fields.extraBody = config.extraBody
        }

        if (config.reasoningEffortFormat !== undefined) {
          fields.reasoningEffortFormat = config.reasoningEffortFormat
        }

        return fields
      })()
    )

    // Replayed transcripts can carry lone surrogates; harden the lowered
    // body so one bad historical string cannot poison every model call.
    const serializedBody = yield* Schema.decodeUnknownEffect(Schema.Json)(
      replaceLoneSurrogatesDeep(body)
    ).pipe(
      Effect.mapError(
        schemaErrorToLlmError(
          'provider_error',
          `Could not serialize ${providerIdentity.name} request`
        )
      ),
      Effect.flatMap(json =>
        encodeJsonString(json, `Could not serialize ${providerIdentity.name} request`)
      )
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
        schemaErrorToLlmError('invalid_response', `Invalid ${providerIdentity.name} response`)
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
