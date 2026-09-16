import {
  Array as Arr,
  Effect,
  Layer,
  Match,
  Option,
  Predicate,
  Redacted,
  Ref,
  Stream
} from 'effect'
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
  type AssistantAgentMessage,
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

type OpenAiResponsesAuthentication =
  | {
      readonly token: OAuthAccessToken
      readonly authorizationHeaders: (
        token: OAuthAccessToken,
        model: string
      ) => Readonly<Record<string, string>>
      readonly expectedTokenProvider?: string
      readonly apiKey?: never
    }
  | {
      readonly apiKey: Redacted.Redacted<string>
      readonly token?: never
      readonly authorizationHeaders?: never
      readonly expectedTokenProvider?: never
    }

export type OpenAiResponsesProviderConfig = OpenAiResponsesAuthentication & {
  readonly providerId: string
  readonly providerName: string
  readonly responsesUrl: string
  readonly alwaysIncludeReasoning: boolean
  readonly allowEofCompletion: boolean
  readonly requireJsonCompletion?: boolean
  readonly unsupportedContentProviderName?: string
  readonly maxOutputTokens?: number
  readonly extraHeaders?: Readonly<Record<string, string>>
  readonly defaultReasoningEffort?: AgentReasoningEffort
  readonly reasoningSummary?: OpenAiResponsesReasoningSummary
  /**
   * When true, assistant text that precedes host `function_call` items is tagged
   * `phase: commentary` without moving later text ahead of those calls. Final
   * answers omit phase. Also preserves output-item order in complete response
   * parsing so replay can recover those boundaries. Default false so Codex and
   * Grok keep flattened parsing and untagged assistant messages.
   */
  readonly commentaryPhaseBeforeToolCalls?: boolean
}

type OpenAiResponsesMessageInput = {
  readonly role: 'user' | 'assistant'
  readonly content: string | ReadonlyArray<OpenAiResponsesInputContentPart>
  readonly phase?: 'commentary'
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
  readonly parameters: Schema.Json
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

const decodeJsonString = (raw: string, message: string) =>
  Schema.decodeUnknownEffect(JsonFromJsonString)(raw).pipe(
    Effect.mapError(schemaErrorToLlmError('invalid_response', message))
  )

// Machine error codes are safe to surface in provider metadata. Free-text
// upstream messages stay out of LLMError per provider sanitization policy.
const decodeOpenAiHttpErrorCode = (raw: string): Effect.Effect<string | undefined> =>
  Schema.decodeUnknownEffect(JsonFromJsonString)(raw).pipe(
    Effect.map(parsed => {
      const error = jsonObjectFromField(parsed, 'error')

      return stringField(error, 'code') ?? stringField(error, 'type')
    }),
    Effect.catch(() => Effect.succeed(undefined))
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

const contentPartToResponsesInputPart = (
  part: ContentPart,
  providerName: string
): Effect.Effect<
  OpenAiResponsesInputTextPart | OpenAiResponsesInputImagePart | OpenAiResponsesInputFilePart,
  LLMError
> =>
  Match.value(part).pipe(
    Match.withReturnType<
      Effect.Effect<
        OpenAiResponsesInputTextPart | OpenAiResponsesInputImagePart | OpenAiResponsesInputFilePart,
        LLMError
      >
    >(),
    Match.tag('Text', current => Effect.succeed({ type: 'input_text', text: current.text })),
    Match.tag('Image', current =>
      Option.match(attachmentSourceUrl(current.source, current.mimeType), {
        onNone: () => Effect.fail(unsupportedContentError('Unresolved image source', providerName)),
        onSome: url =>
          Effect.succeed({
            type: 'input_image',
            image_url: url
          })
      })
    ),
    Match.tag('Document', current =>
      Match.value(current.source).pipe(
        Match.withReturnType<
          Effect.Effect<
            | OpenAiResponsesInputTextPart
            | OpenAiResponsesInputImagePart
            | OpenAiResponsesInputFilePart,
            LLMError
          >
        >(),
        Match.tag('InlineBase64', source =>
          Option.match(attachmentSourceDataUrl(source, current.mimeType), {
            onNone: () =>
              Effect.fail(unsupportedContentError('Invalid document source', providerName)),
            onSome: url =>
              Effect.succeed({
                type: 'input_file',
                filename: current.filename,
                file_data: url
              })
          })
        ),
        Match.tag('Url', source => Effect.succeed({ type: 'input_file', file_url: source.url })),
        Match.tag('Ref', () =>
          Effect.fail(unsupportedContentError('Unresolved document source', providerName))
        ),
        Match.exhaustive
      )
    ),
    Match.tag('Audio', () => Effect.fail(unsupportedContentError('Audio', providerName))),
    Match.exhaustive
  )

const contentToUserInput = (
  content: Content,
  providerName: string
): Effect.Effect<OpenAiResponsesMessageInput['content'], LLMError> => {
  if (Predicate.isString(content)) {
    return Effect.succeed(content)
  }

  const parts = contentParts(content)
  const onlyPart = parts[0]

  if (onlyPart !== undefined && parts.length === 1 && Predicate.isTagged(onlyPart, 'Text')) {
    return Effect.succeed(onlyPart.text)
  }

  return Effect.forEach(parts, part => contentPartToResponsesInputPart(part, providerName))
}

const contentToResponsesFunctionOutput = (
  content: Content,
  providerName: string
): Effect.Effect<OpenAiResponsesFunctionOutput, LLMError> =>
  Predicate.isString(content)
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

      return Predicate.isString(output) ? `${errorPart.text}\n\n${output}` : [errorPart, ...output]
    })
  )

const serializeToolArguments = (call: ToolCall) =>
  Schema.decodeUnknownEffect(Schema.Json)(call.params).pipe(
    Effect.mapError(
      schemaErrorToLlmError('provider_error', 'Could not serialize OpenAI Responses tool arguments')
    ),
    Effect.flatMap(json =>
      encodeJsonString(json, 'Could not serialize OpenAI Responses tool arguments')
    )
  )

const toolCallToResponsesInput = (
  call: ToolCall
): Effect.Effect<OpenAiResponsesFunctionCallInput, LLMError> =>
  Effect.gen(function* () {
    return {
      type: 'function_call',
      call_id: call.id,
      name: call.name,
      arguments: yield* serializeToolArguments(call)
    }
  })

const assistantResponsesMessage = (
  content: string,
  phase: 'commentary' | undefined
): OpenAiResponsesMessageInput =>
  phase === 'commentary'
    ? { role: 'assistant', content, phase: 'commentary' }
    : { role: 'assistant', content }

const combinedAssistantContent = (contents: ReadonlyArray<Content>): Content => {
  const first = contents[0]

  if (contents.length === 0) {
    return ''
  }

  if (contents.length === 1 && first !== undefined) {
    return first
  }

  return contents.flatMap(contentParts)
}

const flattenAssistantToResponsesInput = (
  current: AssistantAgentMessage,
  providerName: string
): Effect.Effect<ReadonlyArray<OpenAiResponsesInputItem>, LLMError> =>
  Effect.gen(function* () {
    const content = yield* contentToText(
      prependMessageContextToContent(assistantContent(current), messageContextText(current)),
      'Assistant',
      providerName
    )

    const toolCallInputs = yield* Effect.forEach(
      assistantHostToolCalls(current),
      toolCallToResponsesInput
    )

    if (content.length > 0) {
      return [assistantResponsesMessage(content, undefined), ...toolCallInputs]
    }

    return toolCallInputs
  })

const orderedAssistantToResponsesInput = (
  current: AssistantAgentMessage,
  providerName: string
): Effect.Effect<ReadonlyArray<OpenAiResponsesInputItem>, LLMError> =>
  Effect.gen(function* () {
    const items: Array<OpenAiResponsesInputItem> = []
    const context = messageContextText(current)
    let pending: Array<Content> = []
    let contextApplied = false

    const flushPendingText = (phase: 'commentary' | undefined) =>
      Effect.gen(function* () {
        if (pending.length === 0) {
          return
        }

        const content = yield* contentToText(
          prependMessageContextToContent(
            combinedAssistantContent(pending),
            contextApplied ? '' : context
          ),
          'Assistant',
          providerName
        )

        pending = []
        contextApplied = true

        if (content.length > 0) {
          items.push(assistantResponsesMessage(content, phase))
        }
      })

    for (const part of current.parts) {
      if (Predicate.isTagged(part, 'Text')) {
        pending = [...pending, part.content]
        continue
      }

      if (Predicate.isTagged(part, 'HostToolCall')) {
        yield* flushPendingText('commentary')
        items.push(yield* toolCallToResponsesInput(part.call))
      }
    }

    yield* flushPendingText(undefined)

    if (!contextApplied && context.length > 0) {
      const content = yield* contentToText(
        prependMessageContextToContent('', context),
        'Assistant',
        providerName
      )

      if (content.length > 0) {
        const hasHostToolCall = items.some(item => 'type' in item && item.type === 'function_call')

        items.unshift(
          assistantResponsesMessage(content, hasHostToolCall ? 'commentary' : undefined)
        )
      }
    }

    return items
  })

const messageToResponsesInput = (
  message: AgentMessage,
  providerName: string,
  commentaryPhaseBeforeToolCalls: boolean
): Effect.Effect<ReadonlyArray<OpenAiResponsesInputItem>, LLMError> =>
  Match.value(message).pipe(
    Match.withReturnType<Effect.Effect<ReadonlyArray<OpenAiResponsesInputItem>, LLMError>>(),
    Match.tag('User', current =>
      contentToUserInput(
        prependMessageContextToContent(current.content, messageContextText(current)),
        providerName
      ).pipe(Effect.map(content => [{ role: 'user' as const, content }]))
    ),
    Match.tag('Assistant', current =>
      commentaryPhaseBeforeToolCalls
        ? orderedAssistantToResponsesInput(current, providerName)
        : flattenAssistantToResponsesInput(current, providerName)
    ),
    Match.tag('ToolResult', current =>
      responsesToolResultOutput(
        prependMessageContextToContent(current.content, messageContextText(current)),
        current.isError,
        providerName
      ).pipe(
        Effect.map(output => [
          {
            type: 'function_call_output' as const,
            call_id: current.toolCallId,
            output
          }
        ])
      )
    ),
    Match.exhaustive
  )

const toOpenAiResponsesTool = (tool: ToolDef): Effect.Effect<OpenAiResponsesTool, LLMError> =>
  Schema.decodeUnknownEffect(Schema.Json)(tool.parameters).pipe(
    Effect.mapError(
      schemaErrorToLlmError('provider_error', 'Invalid OpenAI Responses tool parameters JSON')
    ),
    Effect.map((parameters): OpenAiResponsesTool => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters
    }))
  )

export const toOpenAiResponsesRequestBody = (
  request: LLMRequest,
  config: {
    readonly providerName: string
    readonly unsupportedContentProviderName?: string
    readonly alwaysIncludeReasoning: boolean
    readonly maxOutputTokens?: number
    readonly defaultReasoningEffort?: AgentReasoningEffort
    readonly reasoningSummary?: OpenAiResponsesReasoningSummary
    readonly commentaryPhaseBeforeToolCalls?: boolean
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
          config.unsupportedContentProviderName ?? config.providerName,
          config.commentaryPhaseBeforeToolCalls === true
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

    type OpenAiResponsesRequestBodyFields = {
      model: string
      instructions: string
      input: ReadonlyArray<OpenAiResponsesInputItem>
      store: false
      stream: true
      max_output_tokens?: number
      reasoning?: OpenAiResponsesRequestBody['reasoning']
    }

    const body: OpenAiResponsesRequestBodyFields = {
      model: request.model,
      instructions: request.systemPrompt,
      input,
      store: false,
      stream: true
    }

    if (config.maxOutputTokens !== undefined) {
      body.max_output_tokens = config.maxOutputTokens
    }

    if (reasoning !== undefined) {
      body.reasoning = reasoning
    }

    if (request.tools.length === 0) {
      return body
    }

    return {
      ...body,
      tools: yield* Effect.forEach(request.tools, toOpenAiResponsesTool),
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

const isJsonObject = (value: Schema.Json | undefined): value is Schema.JsonObject =>
  value !== undefined && Predicate.isObjectOrArray(value) && !Array.isArray(value)

const jsonObjectField = (value: Schema.JsonObject, key: string): Schema.Json | undefined =>
  Object.hasOwn(value, key) ? value[key] : undefined

const jsonField = (value: Schema.Json | undefined, key: string): Schema.Json | undefined =>
  value !== undefined && isJsonObject(value) ? jsonObjectField(value, key) : undefined

const stringField = (value: Schema.Json | undefined, key: string) => {
  const raw = jsonField(value, key)

  return Predicate.isString(raw) ? raw : undefined
}

const jsonObjectFromField = (value: Schema.Json | undefined, key: string) => {
  const raw = jsonField(value, key)

  return isJsonObject(raw) ? raw : undefined
}

type OpenAiResponsesProviderDescriptor = {
  readonly providerId: string
  readonly providerName: string
  readonly allowEofCompletion: boolean
  readonly requireJsonCompletion?: boolean
  readonly preserveOutputOrder?: boolean
}

type OpenAiResponsesLlmErrorFields = {
  cause: LLMError['cause']
  message: string
  retryable: boolean
  provider?: LLMError['provider']
}

export const withOpenAiResponsesProviderName = (providerName: string, error: LLMError) =>
  new LLMError(
    (() => {
      const fields: OpenAiResponsesLlmErrorFields = {
        cause: error.cause,
        message: error.message.replaceAll('OpenAI Responses', providerName),
        retryable: error.retryable
      }

      if (error.provider !== undefined) {
        fields.provider = error.provider
      }

      return fields
    })()
  )

type OpenAiResponsesClassifyFields = {
  provider: string
  message: string
  providerCode?: string
  fallbackKind?: ProviderFailureKind
}

type OpenAiResponsesSignalInputFields = {
  message: string
  providerCode?: string
}

const providerSignalError = (
  descriptor: OpenAiResponsesProviderDescriptor,
  input: {
    readonly message: string
    readonly providerCode?: string
    readonly fallbackKind?: ProviderFailureKind
  }
) => {
  const provider = classifyProviderFailure(
    (() => {
      const fields: OpenAiResponsesClassifyFields = {
        provider: descriptor.providerId,
        message: input.message
      }

      if (input.providerCode !== undefined) {
        fields.providerCode = input.providerCode
      }

      if (input.fallbackKind !== undefined) {
        fields.fallbackKind = input.fallbackKind
      }

      return fields
    })()
  )

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

  return reasoningParts.join('\n\n')
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

const flattenedResponseContentEvents = (
  response: OpenAiResponsesResponse
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

    return [...reasoningEvents, ...textEvents, ...toolCallEvents]
  })

const orderedResponseContentEvents = (
  response: OpenAiResponsesResponse
): Effect.Effect<ReadonlyArray<LLMEvent>, LLMError> =>
  Effect.gen(function* () {
    const events = (yield* Effect.forEach(response.output, eventsFromOutputItem)).flat()

    // output_text is an aggregate, not an ordered segment. Only use it when
    // output items contain no text; otherwise it destroys host-call boundaries.
    if (
      !events.some(event => Predicate.isTagged(event, 'TextDelta')) &&
      response.output_text !== undefined &&
      response.output_text.length > 0
    ) {
      return [LLMTextDelta.make({ text: response.output_text }), ...events]
    }

    return events
  })

type ToLlmEventsOptions = {
  readonly allowEmptyStop: boolean
  readonly preserveOutputOrder: boolean
}

const toLlmEvents = (
  response: OpenAiResponsesResponse,
  options: ToLlmEventsOptions
): Effect.Effect<ReadonlyArray<LLMEvent>, LLMError> =>
  Effect.gen(function* () {
    const contentEvents = yield* options.preserveOutputOrder
      ? orderedResponseContentEvents(response)
      : flattenedResponseContentEvents(response)

    const hasText = contentEvents.some(event => Predicate.isTagged(event, 'TextDelta'))
    const hasToolCalls = contentEvents.some(event => Predicate.isTagged(event, 'ToolCall'))

    if (!hasText && !hasToolCalls && !options.allowEmptyStop) {
      return yield* Effect.fail(
        new LLMError({
          cause: 'invalid_response',
          message: 'OpenAI Responses response did not include text or tool calls',
          retryable: false
        })
      )
    }

    const events: Array<LLMEvent> = [
      ...contentEvents,
      LLMDone.make({ stopReason: hasToolCalls ? 'tool_use' : 'stop' })
    ]

    if (response.usage !== undefined) {
      events.push(LLMUsage.make({ usage: yield* toAgentUsage(response.usage) }))
    }

    return events
  })

const parseOpenAiResponsesJsonResponse = (
  descriptor: OpenAiResponsesProviderDescriptor,
  raw: string
): Effect.Effect<ReadonlyArray<LLMEvent>, LLMError> =>
  Effect.gen(function* () {
    const json = yield* decodeJsonString(raw, 'Could not parse OpenAI Responses response JSON')

    if (descriptor.requireJsonCompletion && stringField(json, 'status') !== 'completed') {
      return yield* Effect.fail(
        providerSignalError(descriptor, {
          message: 'The provider JSON response was not completed',
          providerCode: 'incomplete_response',
          fallbackKind: 'invalid_response'
        })
      )
    }

    const parsed = yield* Schema.decodeUnknownEffect(OpenAiResponsesResponse)(json).pipe(
      Effect.mapError(
        schemaErrorToLlmError('invalid_response', 'Invalid OpenAI Responses response')
      )
    )

    return yield* toLlmEvents(parsed, {
      allowEmptyStop: false,
      preserveOutputOrder: descriptor.preserveOutputOrder === true
    })
  })

type OpenAiResponsesBodyFormat = 'undecided' | 'sse' | 'json'

type OpenAiResponsesSseState = {
  readonly hasTextDelta: boolean
  readonly hasReasoningDelta: boolean
  readonly reasoningSummaryPartKey: string | undefined
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
  reasoningSummaryPartKey: undefined,
  toolCallIds: new Set(),
  hasDone: false
}

const initialBodyState: OpenAiResponsesBodyState = {
  format: 'undecided',
  buffer: '',
  sse: initialSseState
}

const shouldEmitSseEvent = (state: OpenAiResponsesSseState, event: LLMEvent) => {
  if (state.hasTextDelta && Predicate.isTagged(event, 'TextDelta')) return false

  if (state.hasReasoningDelta && Predicate.isTagged(event, 'ReasoningDelta')) return false

  if (Predicate.isTagged(event, 'ToolCall') && state.toolCallIds.has(event.call.id)) return false

  return true
}

const dedupeSseEvents = (
  state: OpenAiResponsesSseState,
  events: ReadonlyArray<LLMEvent>
): ReadonlyArray<LLMEvent> => events.filter(event => shouldEmitSseEvent(state, event))

const toolCallIdsFromEvents = (events: ReadonlyArray<LLMEvent>) =>
  events.flatMap(event => (Predicate.isTagged(event, 'ToolCall') ? [event.call.id] : []))

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
  parsedFinal: OpenAiResponsesResponse,
  state: OpenAiResponsesSseState,
  hasToolCalls: boolean,
  preserveOutputOrder: boolean
): Effect.Effect<ReadonlyArray<LLMEvent>, LLMError> =>
  Effect.gen(function* () {
    const finalEvents = yield* toLlmEvents(
      responseWithoutReplayedToolCalls(parsedFinal, state.toolCallIds),
      { allowEmptyStop: state.hasTextDelta || hasToolCalls, preserveOutputOrder }
    )

    const shouldDedupe = state.hasTextDelta || state.hasReasoningDelta || hasToolCalls
    const dedupedEvents = shouldDedupe ? dedupeSseEvents(state, finalEvents) : finalEvents

    if (!hasToolCalls) {
      return dedupedEvents
    }

    return dedupedEvents.map(event =>
      Predicate.isTagged(event, 'Done') ? LLMDone.make({ stopReason: 'tool_use' }) : event
    )
  })

const reasoningSummaryPartKey = (event: Schema.JsonObject) => {
  const itemId = jsonObjectField(event, 'item_id')
  const summaryIndex = jsonObjectField(event, 'summary_index')

  if (!Predicate.isString(itemId) || !Predicate.isNumber(summaryIndex)) {
    return undefined
  }

  return `${itemId}:${summaryIndex}`
}

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

    if (!isJsonObject(parsed)) {
      return { state, events: [] }
    }

    if (
      (parsed.type === 'response.output_text.delta' ||
        parsed.type === 'response.content_part.delta') &&
      Predicate.isString(parsed.delta)
    ) {
      return {
        state: { ...state, hasTextDelta: true },
        events: [LLMTextDelta.make({ text: parsed.delta })]
      }
    }

    if (
      parsed.type === 'response.reasoning_summary_text.delta' &&
      Predicate.isString(parsed.delta)
    ) {
      const partKey = reasoningSummaryPartKey(parsed)

      const startsNewPart =
        partKey !== undefined &&
        state.reasoningSummaryPartKey !== undefined &&
        partKey !== state.reasoningSummaryPartKey

      return {
        state: {
          ...state,
          hasReasoningDelta: true,
          reasoningSummaryPartKey: partKey ?? state.reasoningSummaryPartKey
        },
        events: [LLMReasoningDelta.make({ text: `${startsNewPart ? '\n\n' : ''}${parsed.delta}` })]
      }
    }

    if (parsed.type === 'response.reasoning_text.delta' && Predicate.isString(parsed.delta)) {
      return {
        state: { ...state, hasReasoningDelta: true },
        events: [LLMReasoningDelta.make({ text: parsed.delta })]
      }
    }

    const outputItemDoneEvents = yield* Effect.gen(function* () {
      if (parsed.type !== 'response.output_item.done') {
        return []
      }

      const item = parsed.item

      if (item === undefined) {
        return yield* Effect.fail(invalidFunctionCallSseItemError())
      }

      return yield* Schema.decodeUnknownEffect(OpenAiResponsesOutputItem)(item).pipe(
        Effect.mapError(
          schemaErrorToLlmError('invalid_response', 'Invalid OpenAI Responses output item')
        ),
        Effect.flatMap(eventsFromOutputItem)
      )
    })

    if (outputItemDoneEvents.length > 0) {
      const events = dedupeSseEvents(state, outputItemDoneEvents)
      const emittedToolCallIds = toolCallIdsFromEvents(events)

      return {
        state: {
          hasTextDelta:
            state.hasTextDelta || events.some(event => Predicate.isTagged(event, 'TextDelta')),
          hasReasoningDelta:
            state.hasReasoningDelta ||
            events.some(event => Predicate.isTagged(event, 'ReasoningDelta')),
          reasoningSummaryPartKey: state.reasoningSummaryPartKey,
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

      const responseInput = parsed.response
      const hasToolCalls = state.toolCallIds.size > 0

      const parsedFinal = yield* Schema.decodeUnknownEffect(OpenAiResponsesResponse)(
        responseInput
      ).pipe(
        Effect.mapError(
          schemaErrorToLlmError('invalid_response', 'Invalid OpenAI Responses response')
        )
      )

      const events = yield* finalResponseToEvents(
        parsedFinal,
        state,
        hasToolCalls,
        descriptor.preserveOutputOrder === true
      )

      const emittedText = events.some(event => Predicate.isTagged(event, 'TextDelta'))
      const emittedReasoning = events.some(event => Predicate.isTagged(event, 'ReasoningDelta'))
      const emittedToolCallIds = toolCallIdsFromEvents(events)

      return {
        state: {
          hasTextDelta: state.hasTextDelta || emittedText,
          hasReasoningDelta: state.hasReasoningDelta || emittedReasoning,
          reasoningSummaryPartKey: state.reasoningSummaryPartKey,
          toolCallIds: new Set([...state.toolCallIds, ...emittedToolCallIds]),
          hasDone: true
        },
        events
      }
    }

    if (parsed.type === 'response.failed') {
      const error = jsonObjectFromField(jsonObjectFromField(parsed, 'response'), 'error')
      const message = stringField(error, 'message') ?? 'OpenAI Responses response failed'
      const providerCode = stringField(error, 'code') ?? stringField(error, 'type')

      return yield* Effect.fail(
        providerSignalError(
          descriptor,
          (() => {
            const fields: OpenAiResponsesSignalInputFields = { message }

            if (providerCode !== undefined) {
              fields.providerCode = providerCode
            }

            return fields
          })()
        )
      )
    }

    if (parsed.type === 'response.incomplete') {
      const details = jsonObjectFromField(
        jsonObjectFromField(parsed, 'response'),
        'incomplete_details'
      )

      const providerCode = stringField(details, 'reason') ?? 'incomplete'

      return yield* Effect.fail(
        providerSignalError(descriptor, {
          message: 'The provider stopped before completing the response',
          providerCode,
          fallbackKind: 'invalid_response'
        })
      )
    }

    if (parsed.type === 'error' && Predicate.isString(parsed.message)) {
      const providerCode = stringField(parsed, 'code') ?? stringField(parsed, 'type')

      return yield* Effect.fail(
        providerSignalError(
          descriptor,
          (() => {
            const fields: OpenAiResponsesSignalInputFields = {
              message: parsed.message
            }

            if (providerCode !== undefined) {
              fields.providerCode = providerCode
            }

            return fields
          })()
        )
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
      return yield* parseOpenAiResponsesJsonResponse(descriptor, buffer)
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
    const serializedBody = yield* Schema.decodeUnknownEffect(Schema.Json)(
      replaceLoneSurrogatesDeep(body)
    ).pipe(
      Effect.mapError(
        schemaErrorToLlmError(
          'provider_error',
          `Could not serialize ${config.providerName} request`
        )
      ),
      Effect.flatMap(json =>
        encodeJsonString(json, `Could not serialize ${config.providerName} request`)
      )
    )

    const headers = {
      ...config.extraHeaders,
      accept: 'text/event-stream',
      'content-type': 'application/json',
      ...(config.apiKey !== undefined
        ? { authorization: `Bearer ${Redacted.value(config.apiKey)}` }
        : config.authorizationHeaders(config.token, request.model))
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

      const errorCode = yield* decodeOpenAiHttpErrorCode(errorText)

      const provider = classifyProviderFailure({
        provider: config.providerId,
        status: response.status,
        headers: response.headers,
        body: errorText,
        providerCode: errorCode
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
        allowEofCompletion: config.allowEofCompletion,
        requireJsonCompletion: config.requireJsonCompletion ?? false,
        preserveOutputOrder: config.commentaryPhaseBeforeToolCalls === true
      }

      return LLMProvider.of({
        stream: request =>
          Stream.fromEffect(sendOpenAiResponsesRequest(config, request, client)).pipe(
            Stream.flatMap(response => streamOpenAiResponsesResponse(descriptor, response))
          )
      })
    })
  )
