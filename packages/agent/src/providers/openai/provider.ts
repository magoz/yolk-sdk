import { Config, Context, Effect, Layer, Match, Option, Predicate, Redacted, Ref, Stream } from 'effect'
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
  assistantReasoningText,
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
  LLMReasoningDelta,
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
  /** Opts into a compatible endpoint's reasoning object or reasoning_effort request field. */
  readonly reasoningEffortFormat?: 'reasoning-object' | 'reasoning-effort'
  /** Preserve compatible models' reasoning_content output and assistant replay. */
  readonly reasoningContent?: boolean
  /**
   * Request incremental server-sent deltas instead of one JSON body. Hosts
   * must only enable this against endpoints that serve chat SSE.
   */
  readonly streaming?: boolean
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
      readonly reasoning_content?: string
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
  readonly stream: boolean
  readonly stream_options?: {
    readonly include_usage: boolean
  }
  readonly reasoning?: {
    readonly effort: AgentReasoningEffort
  }
  readonly reasoning_effort?: AgentReasoningEffort
  readonly tools?: ReadonlyArray<OpenAiTool>
  readonly parallel_tool_calls?: true
}

type OpenAiRequestBodyConfig = {
  readonly maxCompletionTokens: number
  readonly completionTokenField?: 'max_completion_tokens' | 'max_tokens'
  readonly extraBody?: unknown
  readonly reasoningEffortFormat?: 'reasoning-object' | 'reasoning-effort'
  readonly reasoningContent?: boolean
  readonly streaming?: boolean
  readonly providerName?: string
}

type OpenAiRequestBodyConfigFields = {
  maxCompletionTokens: number
  providerName: string
  completionTokenField?: OpenAiRequestBodyConfig['completionTokenField']
  extraBody?: OpenAiRequestBodyConfig['extraBody']
  reasoningEffortFormat?: OpenAiRequestBodyConfig['reasoningEffortFormat']
  reasoningContent?: boolean
  streaming?: boolean
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
  reasoning_content: Schema.optional(Schema.Unknown),
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

class OpenAiChatDeltaFunction extends Schema.Class<OpenAiChatDeltaFunction>(
  'OpenAiChatDeltaFunction'
)({
  name: Schema.optional(Schema.String),
  arguments: Schema.optional(Schema.String)
}) {}

class OpenAiChatDeltaToolCall extends Schema.Class<OpenAiChatDeltaToolCall>(
  'OpenAiChatDeltaToolCall'
)({
  index: Schema.optional(Schema.Number),
  id: Schema.optional(Schema.String),
  function: Schema.optional(OpenAiChatDeltaFunction)
}) {}

class OpenAiChatDelta extends Schema.Class<OpenAiChatDelta>('OpenAiChatDelta')({
  content: Schema.optional(Schema.NullOr(Schema.String)),
  reasoning_content: Schema.optional(Schema.Unknown),
  tool_calls: Schema.optional(Schema.Array(OpenAiChatDeltaToolCall))
}) {}

class OpenAiChatStreamChoice extends Schema.Class<OpenAiChatStreamChoice>(
  'OpenAiChatStreamChoice'
)({
  delta: Schema.optional(OpenAiChatDelta),
  finish_reason: Schema.optional(Schema.NullOr(Schema.String)),
  usage: Schema.optional(Schema.Unknown)
}) {}

class OpenAiChatStreamChunk extends Schema.Class<OpenAiChatStreamChunk>(
  'OpenAiChatStreamChunk'
)({
  choices: Schema.optional(Schema.Array(OpenAiChatStreamChoice)),
  usage: Schema.optional(Schema.Unknown)
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

const isJsonRecord = (value: Schema.Json | undefined): value is Schema.JsonObject =>
  value !== undefined && Predicate.isObjectOrArray(value) && !Array.isArray(value)

const jsonRecordField = (
  value: Schema.JsonObject,
  key: string
): Schema.Json | undefined => (Object.hasOwn(value, key) ? value[key] : undefined)

const jsonField = (value: Schema.Json | undefined, key: string): Schema.Json | undefined =>
  isJsonRecord(value) ? jsonRecordField(value, key) : undefined

const stringField = (value: Schema.Json | undefined, key: string) => {
  const raw = jsonField(value, key)

  return Predicate.isString(raw) ? raw : undefined
}

// Machine error codes are safe to surface in provider metadata. Free-text
// upstream messages stay out of LLMError per provider sanitization policy.
const decodeOpenAiHttpErrorCode = (raw: string): Effect.Effect<string | undefined> =>
  Schema.decodeUnknownEffect(JsonFromJsonString)(raw).pipe(
    Effect.map(parsed => {
      const error = jsonField(parsed, 'error')

      return stringField(error, 'code') ?? stringField(error, 'type')
    }),
    Effect.catch(() => Effect.succeed(undefined))
  )

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
  (config.reasoningEffortFormat === 'reasoning-object' && key === 'reasoning') ||
  (config.reasoningEffortFormat === 'reasoning-effort' && key === 'reasoning_effort')

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
  providerName: string,
  reasoningContent: boolean
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

      const reasoning = reasoningContent ? assistantReasoningText(current) : ''
      const reasoningFields = reasoning.length > 0 ? { reasoning_content: reasoning } : {}

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
                    tool_calls: toolCalls,
                    ...reasoningFields
                  }
                : {
                    role: 'assistant' as const,
                    content: text,
                    ...reasoningFields
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
      toOpenAiMessage(message, providerName, config.reasoningContent ?? false)
    )

    const messages = [systemMessage, ...requestMessages]

    const completionTokenLimit =
      config.completionTokenField === 'max_tokens'
        ? { max_tokens: config.maxCompletionTokens }
        : { max_completion_tokens: config.maxCompletionTokens }

    const reasoning =
      request.reasoningEffort === undefined
        ? {}
        : config.reasoningEffortFormat === 'reasoning-object'
          ? { reasoning: { effort: request.reasoningEffort } }
          : config.reasoningEffortFormat === 'reasoning-effort'
            ? { reasoning_effort: request.reasoningEffort }
            : {}

    const extraBody =
      config.extraBody === undefined
        ? {}
        : yield* snapshotOpenAiRequestExtras(config.extraBody, config, providerName)

    const streaming = config.streaming === true

    // Usage only arrives on the stream when the endpoint is asked for it.
    const bodyWithoutTools: OpenAiRequestBody = streaming
      ? {
          ...extraBody,
          ...reasoning,
          model: request.model,
          messages,
          ...completionTokenLimit,
          stream: true,
          stream_options: { include_usage: true }
        }
      : {
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
  providerIdentity: OpenAiProviderIdentity,
  reasoningContent: boolean
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

    const reasoning = reasoningContent
      ? ((yield* Schema.decodeUnknownEffect(Schema.NullOr(Schema.String))(
          choice.message.reasoning_content ?? null
        ).pipe(
          Effect.mapError(
            schemaErrorToLlmError(
              'invalid_response',
              `Invalid ${providerIdentity.name} reasoning content`
            )
          )
        )) ?? '')
      : ''

    const textEvents: Array<LLMEvent> = []

    if (reasoning.length > 0) textEvents.push(LLMReasoningDelta.make({ text: reasoning }))

    if (content.length > 0) textEvents.push(LLMTextDelta.make({ text: content }))

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

type OpenAiChatStreamToolCall = {
  readonly index: number
  readonly id: string | undefined
  readonly name: string | undefined
  readonly arguments: string
}

type OpenAiChatStreamState = {
  readonly buffer: string
  readonly toolCalls: ReadonlyArray<OpenAiChatStreamToolCall>
  readonly finishReason: string | undefined
  readonly hasTerminal: boolean
  // Only [DONE] closes the stream: usage commonly arrives after the finish
  // chunk, so a bare finish reason must not discard later payloads.
  readonly streamClosed: boolean
  readonly usage: unknown
}

const initialOpenAiChatStreamState: OpenAiChatStreamState = {
  buffer: '',
  toolCalls: [],
  finishReason: undefined,
  hasTerminal: false,
  streamClosed: false,
  usage: undefined
}

// Split on blank lines without eagerly normalizing: a chunk-ending CR must
// stay pending so a split CRLF (or CR + multiline continuation) cannot form
// a false event boundary before the rest arrives. The pair is atomic: a
// counted regex would backtrack and split a lone CRLF in two.
const splitCompleteChatSseBlocks = (buffer: string) => {
  const blocks = buffer.split(/\r?\n\r?\n|\r\r/)
  const tail = blocks.at(-1) ?? ''

  return { completeBlocks: blocks.slice(0, -1), tail }
}

const chatSseBlockData = (block: string) => {
  const lines = block
    .split(/\r\n|\n|\r/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trimStart())

  const done = lines.some(line => line === '[DONE]')

  const data = lines
    .filter(line => line.length > 0 && line !== '[DONE]')
    .join('\n')
    .trim()

  return { done, payload: data.length > 0 ? data : undefined }
}

// Stream construction failures use fixed messages: schema diagnostics and
// upstream values stay out of LLMError per provider sanitization policy.
const invalidChatStreamEvent = (providerIdentity: OpenAiProviderIdentity) =>
  new LLMError({
    cause: 'invalid_response',
    message: `Invalid ${providerIdentity.name} stream event`,
    retryable: false
  })

const chatStreamError = (
  providerIdentity: OpenAiProviderIdentity,
  raw: string
): Effect.Effect<never, LLMError> =>
  Effect.gen(function* () {
    const errorCode = yield* decodeOpenAiHttpErrorCode(raw)

    const provider = classifyProviderFailure({
      provider: providerIdentity.id,
      body: raw,
      providerCode: errorCode
    })

    return yield* Effect.fail(
      new LLMError({
        cause: providerFailureCause(provider.kind),
        message: `${providerIdentity.name} stream reported an error`,
        retryable: providerFailureRetryable(provider.kind),
        provider
      })
    )
  })

const mergeChatToolCallDelta = (
  toolCalls: ReadonlyArray<OpenAiChatStreamToolCall>,
  delta: typeof OpenAiChatDeltaToolCall.Type
): ReadonlyArray<OpenAiChatStreamToolCall> => {
  const index = delta.index ?? 0
  const current = toolCalls.find(call => call.index === index)

  const merged = {
    index,
    id: delta.id ?? current?.id,
    name: delta.function?.name ?? current?.name,
    arguments: `${current?.arguments ?? ''}${delta.function?.arguments ?? ''}`
  }

  return [...toolCalls.filter(call => call.index !== index), merged]
}

const decodeChatDeltaReasoning = (
  providerIdentity: OpenAiProviderIdentity,
  reasoning: unknown
): Effect.Effect<string, LLMError> =>
  Schema.decodeUnknownEffect(Schema.NullOr(Schema.String))(reasoning).pipe(
    Effect.map(value => value ?? ''),
    Effect.mapError(() => invalidChatStreamEvent(providerIdentity))
  )

type OpenAiChatStreamStep = {
  readonly state: OpenAiChatStreamState
  readonly events: ReadonlyArray<LLMEvent>
}

const processChatStreamPayload = (
  providerIdentity: OpenAiProviderIdentity,
  reasoningContent: boolean,
  state: OpenAiChatStreamState,
  payload: string
): Effect.Effect<OpenAiChatStreamStep, LLMError> =>
  Effect.gen(function* () {
    const parsed = yield* Schema.decodeUnknownEffect(JsonFromJsonString)(payload).pipe(
      Effect.mapError(() => invalidChatStreamEvent(providerIdentity))
    )

    const envelope = isJsonRecord(parsed) ? jsonRecordField(parsed, 'error') : undefined

    if (envelope !== undefined && isJsonRecord(envelope)) {
      return yield* chatStreamError(providerIdentity, payload)
    }

    const chunk = yield* Schema.decodeUnknownEffect(OpenAiChatStreamChunk)(parsed).pipe(
      Effect.mapError(() => invalidChatStreamEvent(providerIdentity))
    )

    const events: Array<LLMEvent> = []
    let toolCalls = state.toolCalls
    let finishReason = state.finishReason
    let usage = state.usage

    for (const choice of chunk.choices ?? []) {
      if (choice.delta?.content) {
        events.push(LLMTextDelta.make({ text: choice.delta.content }))
      }

      if (reasoningContent && choice.delta?.reasoning_content != null) {
        const reasoning = yield* decodeChatDeltaReasoning(
          providerIdentity,
          choice.delta.reasoning_content
        )

        if (reasoning.length > 0) events.push(LLMReasoningDelta.make({ text: reasoning }))
      }

      for (const call of choice.delta?.tool_calls ?? []) {
        toolCalls = mergeChatToolCallDelta(toolCalls, call)
      }

      if (
        choice.finish_reason !== undefined &&
        choice.finish_reason !== null &&
        finishReason === undefined
      ) {
        finishReason = choice.finish_reason
      }

      if (choice.usage !== undefined) usage = choice.usage
    }

    if (chunk.usage !== undefined) usage = chunk.usage

    return {
      state: {
        ...state,
        toolCalls,
        finishReason,
        hasTerminal: state.hasTerminal || finishReason !== undefined,
        usage
      },
      events
    }
  })

const processChatStreamBlock = (
  providerIdentity: OpenAiProviderIdentity,
  reasoningContent: boolean,
  state: OpenAiChatStreamState,
  block: string
): Effect.Effect<OpenAiChatStreamStep, LLMError> =>
  Effect.gen(function* () {
    // Frames after [DONE] are transport noise: ignore them so a malformed
    // trailer cannot fail an otherwise completed turn.
    if (state.streamClosed) return { state, events: [] }

    const { done, payload } = chatSseBlockData(block)

    const current: OpenAiChatStreamState = done
      ? { ...state, hasTerminal: true, streamClosed: true }
      : state

    if (payload === undefined) return { state: current, events: [] }

    return yield* processChatStreamPayload(providerIdentity, reasoningContent, current, payload)
  })

const processChatStreamText = (
  providerIdentity: OpenAiProviderIdentity,
  reasoningContent: boolean,
  state: OpenAiChatStreamState,
  text: string
): Effect.Effect<OpenAiChatStreamStep, LLMError> =>
  Effect.gen(function* () {
    const split = splitCompleteChatSseBlocks(`${state.buffer}${text}`)
    let current: OpenAiChatStreamState = { ...state, buffer: split.tail }
    const events: Array<LLMEvent> = []

    for (const block of split.completeBlocks) {
      const step = yield* processChatStreamBlock(providerIdentity, reasoningContent, current, block)
      current = step.state
      events.push(...step.events)
    }

    return { state: current, events }
  })

const finalizeChatStreamState = (
  providerIdentity: OpenAiProviderIdentity,
  state: OpenAiChatStreamState
): Effect.Effect<ReadonlyArray<LLMEvent>, LLMError> =>
  Effect.gen(function* () {
    if (!state.hasTerminal) {
      return yield* Effect.fail(
        new LLMError({
          cause: 'invalid_response',
          message: `${providerIdentity.name} stream ended before a terminal chunk`,
          retryable: false,
          provider: providerErrorInfo({
            provider: providerIdentity.id,
            kind: 'invalid_response',
            providerCode: 'incomplete_stream'
          })
        })
      )
    }

    if (state.finishReason === 'length' || state.finishReason === 'content_filter') {
      return yield* Effect.fail(
        new LLMError({
          cause: 'invalid_response',
          message: `${providerIdentity.name} response stopped with ${state.finishReason}`,
          retryable: false,
          provider: providerErrorInfo({
            provider: providerIdentity.id,
            kind: 'invalid_response',
            providerCode: state.finishReason
          })
        })
      )
    }

    if (
      state.finishReason !== undefined &&
      state.finishReason !== 'stop' &&
      state.finishReason !== 'tool_calls'
    ) {
      const provider = classifyProviderFailure({
        provider: providerIdentity.id,
        body: state.finishReason,
        providerCode: state.finishReason
      })

      return yield* Effect.fail(
        new LLMError({
          cause: 'provider_error',
          message: `${providerIdentity.name} stream stopped with unrecognized finish reason`,
          retryable: false,
          provider
        })
      )
    }

    const orderedCalls = [...state.toolCalls].sort((left, right) => left.index - right.index)

    const toolCallEvents = yield* Effect.forEach(orderedCalls, call => {
      const id = call.id
      const name = call.name

      if (id === undefined || name === undefined) {
        return Effect.fail(
          new LLMError({
            cause: 'invalid_response',
            message: `Invalid ${providerIdentity.name} streamed tool call`,
            retryable: false
          })
        )
      }

      return parseToolArguments(call.arguments, providerIdentity.name).pipe(
        Effect.map(params => LLMToolCall.make({ call: ToolCall.make({ id, name, params }) }))
      )
    })

    const events: Array<LLMEvent> = [...toolCallEvents]

    events.push(LLMDone.make({ stopReason: toolCallEvents.length > 0 ? 'tool_use' : 'stop' }))

    if (state.usage !== undefined) {
      const usage = yield* Schema.decodeUnknownEffect(OpenAiUsageResponse)(state.usage).pipe(
        Effect.mapError(() => invalidChatStreamEvent(providerIdentity))
      )

      events.push(LLMUsage.make({ usage: toAgentUsage(usage) }))
    }

    return events
  })

const streamOpenAiChatResponse = (
  providerIdentity: OpenAiProviderIdentity,
  reasoningContent: boolean,
  response: HttpClientResponse.HttpClientResponse
): Stream.Stream<LLMEvent, LLMError> =>
  Stream.unwrap(
    Ref.make(initialOpenAiChatStreamState).pipe(
      Effect.map(stateRef => {
        const chunks = response.stream.pipe(
          Stream.mapError(toHttpClientLlmError(providerIdentity, true)),
          Stream.decodeText,
          Stream.mapEffect(chunk =>
            Effect.gen(function* () {
              const state = yield* Ref.get(stateRef)
              const step = yield* processChatStreamText(providerIdentity, reasoningContent, state, chunk)
              yield* Ref.set(stateRef, step.state)

              return step.events
            })
          ),
          Stream.flatMap(events => Stream.fromIterable(events))
        )

        const finalEvents = Stream.fromEffect(
          Ref.get(stateRef).pipe(
            Effect.flatMap(state => finalizeChatStreamState(providerIdentity, state))
          )
        ).pipe(Stream.flatMap(events => Stream.fromIterable(events)))

        return chunks.pipe(Stream.concat(finalEvents))
      })
    )
  )

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

const openAiRequestBodyFields = (
  config: OpenAiProviderConfig,
  providerIdentity: OpenAiProviderIdentity
): OpenAiRequestBodyConfigFields => {
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

  if (config.reasoningContent !== undefined) {
    fields.reasoningContent = config.reasoningContent
  }

  if (config.streaming !== undefined) {
    fields.streaming = config.streaming
  }

  return fields
}

const serializeOpenAiRequestBody = (
  body: OpenAiRequestBody,
  providerName: string
): Effect.Effect<string, LLMError> =>
  // Replayed transcripts can carry lone surrogates; harden the lowered
  // body so one bad historical string cannot poison every model call.
  Schema.decodeUnknownEffect(Schema.Json)(replaceLoneSurrogatesDeep(body)).pipe(
    Effect.mapError(
      schemaErrorToLlmError('provider_error', `Could not serialize ${providerName} request`)
    ),
    Effect.flatMap(json => encodeJsonString(json, `Could not serialize ${providerName} request`))
  )

const postOpenAiRequest = (
  config: OpenAiProviderConfig,
  providerIdentity: OpenAiProviderIdentity,
  serializedBody: string,
  client: HttpClient.HttpClient
): Effect.Effect<HttpClientResponse.HttpClientResponse, LLMError> =>
  Effect.gen(function* () {
    const httpRequest = HttpClientRequest.post(
      config.chatCompletionsUrl ?? 'https://api.openai.com/v1/chat/completions'
    ).pipe(
      HttpClientRequest.setHeaders({
        ...config.extraHeaders,
        accept: config.streaming === true ? 'text/event-stream' : 'application/json',
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

      const errorCode = yield* decodeOpenAiHttpErrorCode(errorText)

      const provider = classifyProviderFailure({
        provider: providerIdentity.id,
        status: response.status,
        headers: response.headers,
        body: errorText,
        providerCode: errorCode
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

    return response
  })

const sendOpenAiRequestBody = (
  config: OpenAiProviderConfig,
  request: LLMRequest,
  providerIdentity: OpenAiProviderIdentity
): Effect.Effect<string, LLMError> =>
  Effect.gen(function* () {
    const body = yield* toOpenAiRequestBody(request, openAiRequestBodyFields(config, providerIdentity))

    return yield* serializeOpenAiRequestBody(body, providerIdentity.name)
  })

const sendOpenAiRequest = (
  config: OpenAiProviderConfig,
  request: LLMRequest,
  client: HttpClient.HttpClient
): Effect.Effect<ReadonlyArray<LLMEvent>, LLMError> =>
  Effect.gen(function* () {
    const providerIdentity = config.providerIdentity ?? defaultOpenAiProviderIdentity
    const serializedBody = yield* sendOpenAiRequestBody(config, request, providerIdentity)
    const response = yield* postOpenAiRequest(config, providerIdentity, serializedBody, client)
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

    const events = yield* toLlmEvents(choice, providerIdentity, config.reasoningContent ?? false)

    if (parsed.usage === undefined) {
      return events
    }

    return [...events, LLMUsage.make({ usage: toAgentUsage(parsed.usage) })]
  }).pipe(
    Effect.withSpan(`${config.providerIdentity?.id ?? defaultOpenAiProviderIdentity.id}.stream`)
  )

const streamOpenAiRequest = (
  config: OpenAiProviderConfig,
  request: LLMRequest,
  client: HttpClient.HttpClient
): Stream.Stream<LLMEvent, LLMError> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const providerIdentity = config.providerIdentity ?? defaultOpenAiProviderIdentity
      const serializedBody = yield* sendOpenAiRequestBody(config, request, providerIdentity)
      const response = yield* postOpenAiRequest(config, providerIdentity, serializedBody, client)

      return streamOpenAiChatResponse(providerIdentity, config.reasoningContent ?? false, response)
    })
  )

const openAiProviderStream = (
  config: OpenAiProviderConfig,
  request: LLMRequest,
  client: HttpClient.HttpClient
): Stream.Stream<LLMEvent, LLMError> =>
  config.streaming === true
    ? streamOpenAiRequest(config, request, client)
    : Stream.fromEffect(sendOpenAiRequest(config, request, client)).pipe(
        Stream.flatMap(events => Stream.fromIterable(events))
      )

export const makeOpenAiProviderLayer = (config: OpenAiProviderConfig) =>
  Layer.effect(
    LLMProvider,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient

      return LLMProvider.of({
        stream: request => openAiProviderStream(config, request, client)
      })
    })
  )

export const OpenAiProviderLayer = Layer.effect(
  LLMProvider,
  Effect.gen(function* () {
    const config = yield* OpenAiConfig
    const client = yield* HttpClient.HttpClient

    return LLMProvider.of({
      stream: request => openAiProviderStream(config, request, client)
    })
  })
).pipe(Layer.provide(Layer.mergeAll(OpenAiConfigLayer, FetchHttpClient.layer)))
