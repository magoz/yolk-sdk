import {
  Array as Arr,
  Clock,
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
} from 'effect/http'
import * as Schema from 'effect/Schema'
import type * as SchemaIssue from 'effect/SchemaIssue'
import {
  AgentInputUsage,
  AgentOutputUsage,
  AgentUsage,
  type ToolCall,
  attachmentSourceDataUrl,
  attachmentSourceUrl,
  assistantContent,
  assistantHostToolCalls,
  contentParts,
  filePartText,
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
  LLMUsage,
  type LLMEvent,
  type LLMRequest
} from '@yolk-sdk/agent/loop'
import type { OAuthAccessToken } from '@yolk-sdk/agent/oauth'
import {
  classifyProviderFailure,
  echoedParamValues,
  providerErrorInfo,
  providerFailureCause,
  providerFailureRetryable
} from './provider-error.ts'
import { openAiCodexQuotaResetsAtMs } from './quota-reset-internal.ts'
import { requestCacheKeyHeaders, type CacheKeyHeaders } from './cache-key-headers.ts'
import { validateProviderTranscript } from './transcript.ts'
import { providerToolCallEvent } from './tool-call-internal.ts'
import { withoutToolJsonSchemaOmittedNullMarker } from '../protocol/tool-json-schema-marker.ts'

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
  /**
   * Codex compatibility: a final response (SSE `response.completed` or JSON body) whose `output`
   * is missing or lacks a required key (`isMissingFinalOutputIssue`) completes with its decodable
   * output items and usage (`recoveredFinalResponse`); a streamed Done is marked only when that
   * usage is missing or does not decode.
   */
  readonly recoverMissingFinalOutput?: boolean
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
  /** Sends `LLMRequest.cacheKey` as the body `prompt_cache_key`. */
  readonly promptCacheKey?: boolean
  /** Session-affinity headers for `LLMRequest.cacheKey`; auth headers win on a clash. */
  readonly cacheKeyHeaders?: CacheKeyHeaders
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
  readonly tool_choice?: 'none'
  readonly prompt_cache_key?: string
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
  /** The output item id: a final `output` replays a streamed call under the same one. */
  id: Schema.optional(Schema.String),
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

type IssuePath = ReadonlyArray<PropertyKey>

const noMissingKeys = (): ReadonlyArray<IssuePath> => []

/** The path of every `MissingKey` in a decode failure, each union member's included. */
const missingKeyPaths = (issue: SchemaIssue.Issue, path: IssuePath): ReadonlyArray<IssuePath> =>
  Match.value(issue).pipe(
    Match.tagsExhaustive({
      Pointer: pointer => missingKeyPaths(pointer.issue, [...path, ...pointer.path]),
      Composite: composite => composite.issues.flatMap(child => missingKeyPaths(child, path)),
      AnyOf: anyOf => anyOf.issues.flatMap(child => missingKeyPaths(child, path)),
      Filter: filter => missingKeyPaths(filter.issue, path),
      Encoding: encoding => missingKeyPaths(encoding.issue, path),
      MissingKey: () => [path],
      InvalidType: noMissingKeys,
      InvalidValue: noMissingKeys,
      UnexpectedKey: noMissingKeys,
      Forbidden: noMissingKeys,
      OneOf: noMissingKeys
    })
  )

/**
 * A final response decode failure whose `output`, or a key inside one of its items, is missing:
 * the failure Codex compatibility recovers from (`recoverMissingFinalOutput`). Read from the
 * issue, never the formatted message, so no other failure whose text happens to read "Missing
 * key" and `["output"]` looks recoverable.
 */
export const isMissingFinalOutputIssue = (issue: SchemaIssue.Issue) =>
  missingKeyPaths(issue, []).some(path => path[0] === 'output')

const encodeJsonString = (value: Schema.Json, message: string) =>
  Schema.encodeEffect(JsonFromJsonString)(value).pipe(
    Effect.mapError(schemaErrorToLlmError('provider_error', message))
  )

const decodeJsonString = (raw: string, message: string) =>
  Schema.decodeUnknownEffect(JsonFromJsonString)(raw).pipe(
    Effect.mapError(schemaErrorToLlmError('invalid_response', message))
  )

type OpenAiResponsesHttpError = {
  readonly code: string | undefined
  /** Request values the envelope echoes in `error.param`, kept out of the text fallback. */
  readonly echoedValues: ReadonlyArray<string>
  /** `error.type`, classified when the reported `code` names no kind. */
  readonly kindCodes: ReadonlyArray<string>
}

/** An error object's `type`, classified when its reported `code` names no kind. */
const typeKindCodes = (error: Schema.Json | undefined): ReadonlyArray<string> =>
  [stringField(error, 'type')].filter(Predicate.isString)

// Machine error codes are safe to surface in provider metadata. Free-text
// upstream messages stay out of LLMError per provider sanitization policy.
const decodeOpenAiHttpError = (raw: string): Effect.Effect<OpenAiResponsesHttpError> =>
  Schema.decodeUnknownEffect(JsonFromJsonString)(raw).pipe(
    Effect.map(parsed => {
      const error = jsonObjectFromField(parsed, 'error')

      return {
        code: stringField(error, 'code') ?? stringField(error, 'type'),
        echoedValues: echoedParamValues(jsonField(error, 'param')),
        kindCodes: typeKindCodes(error)
      }
    }),
    Effect.catch(() => Effect.succeed({ code: undefined, echoedValues: [], kindCodes: [] }))
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
    Match.tag('File', current => Effect.succeed(filePartText(current))),
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
    Match.tag('File', current =>
      Effect.succeed({ type: 'input_text', text: filePartText(current) })
    ),
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
      parameters: withoutToolJsonSchemaOmittedNullMarker(parameters)
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
    readonly promptCacheKey?: boolean
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

    const transcriptInput = Arr.flatten(
      yield* Effect.forEach(request.messages, message =>
        messageToResponsesInput(
          message,
          config.unsupportedContentProviderName ?? config.providerName,
          config.commentaryPhaseBeforeToolCalls === true
        )
      )
    )

    const input: ReadonlyArray<OpenAiResponsesInputItem> =
      request.turnContext === undefined || request.turnContext.length === 0
        ? transcriptInput
        : [
            ...transcriptInput,
            { role: 'user', content: [{ type: 'input_text', text: request.turnContext }] }
          ]

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

    const promptCacheKey =
      config.promptCacheKey === true && request.cacheKey !== undefined
        ? { prompt_cache_key: request.cacheKey }
        : {}

    if (request.tools.length === 0) {
      return { ...body, ...promptCacheKey }
    }

    const toolChoice: Pick<OpenAiResponsesRequestBody, 'tool_choice'> =
      request.toolChoice === 'none' ? { tool_choice: 'none' } : {}

    return {
      ...body,
      tools: yield* Effect.forEach(request.tools, toOpenAiResponsesTool),
      parallel_tool_calls: true,
      ...toolChoice,
      ...promptCacheKey
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
    readonly promptCacheKey?: boolean
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
  readonly recoverMissingFinalOutput?: boolean
  /**
   * Request values (the model id) an in-stream error event may echo in its message, removed
   * before its text is classified. Set per request; absent where the request is unknown.
   */
  readonly echoedValues?: ReadonlyArray<string>
}

type OpenAiResponsesLlmErrorFields = {
  cause: LLMError['cause']
  message: string
  retryable: boolean
  provider?: LLMError['provider']
  responseIssue?: LLMError['responseIssue']
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

      if (error.responseIssue !== undefined) {
        fields.responseIssue = error.responseIssue
      }

      return fields
    })()
  )

type OpenAiResponsesClassifyFields = {
  provider: string
  message: string
  kindCodes: ReadonlyArray<string>
  echoedValues: ReadonlyArray<string>
  providerCode?: string
  fallbackKind?: ProviderFailureKind
}

type OpenAiResponsesSignalInputFields = {
  message: string
  kindCodes: ReadonlyArray<string>
  echoedValues: ReadonlyArray<string>
  providerCode?: string
}

const providerSignalError = (
  descriptor: OpenAiResponsesProviderDescriptor,
  input: {
    readonly message: string
    readonly providerCode?: string
    readonly kindCodes?: ReadonlyArray<string>
    /** Values the event itself echoes (its `error.param` object), besides the request's. */
    readonly echoedValues?: ReadonlyArray<string>
    readonly fallbackKind?: ProviderFailureKind
  }
) => {
  const provider = classifyProviderFailure(
    (() => {
      const fields: OpenAiResponsesClassifyFields = {
        provider: descriptor.providerId,
        message: input.message,
        kindCodes: input.kindCodes ?? [],
        echoedValues: [...(descriptor.echoedValues ?? []), ...(input.echoedValues ?? [])]
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

/**
 * A stream that ended before its terminal event (`response.completed`, or the failing
 * `response.incomplete` / `response.failed`) emitted no `Done`: the loop's incomplete stream,
 * raised here with `responseIssue: 'missing_done'` so direct consumers of the provider see it
 * too. It keeps its `incomplete_stream` code (OpenCode Go re-routes on it). Only providers
 * without EOF completion raise it: Codex completes such a stream instead, so it emits a `Done`.
 */
const missingTerminalEventError = (descriptor: OpenAiResponsesProviderDescriptor) => {
  const error = providerSignalError(descriptor, {
    message: 'The provider stream ended before a terminal response event',
    providerCode: 'incomplete_stream',
    fallbackKind: 'invalid_response'
  })

  return new LLMError({
    cause: error.cause,
    message: error.message,
    retryable: error.retryable,
    provider: error.provider,
    responseIssue: 'missing_done'
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
              Effect.flatMap(params =>
                providerToolCallEvent(
                  { id: item.call_id, name: item.name, params },
                  invalidFunctionCallError
                )
              ),
              Effect.map(Option.some)
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

/**
 * What a stream already emitted before its final response: function calls by call id and by
 * output item id, and whether any text streamed (final text is then dropped as a replay).
 */
type StreamedOutput = {
  readonly toolCallIds: ReadonlySet<string>
  readonly functionCallItemIds: ReadonlySet<string>
  readonly hasTextDelta: boolean
}

const nothingStreamed: StreamedOutput = {
  toolCallIds: new Set(),
  functionCallItemIds: new Set(),
  hasTextDelta: false
}

const isJsonArray = (value: Schema.Json): value is Schema.JsonArray => Array.isArray(value)

const jsonArrayField = (value: Schema.Json | undefined, key: string) => {
  const raw = jsonField(value, key)

  return raw !== undefined && isJsonArray(raw) ? raw : []
}

/** Whether a raw `function_call` item replays a call the stream emitted (`call_id` or `id`). */
const isEmittedFunctionCall = (item: Schema.Json, emitted: StreamedOutput) => {
  const callId = stringField(item, 'call_id')
  const itemId = stringField(item, 'id')

  return (
    (callId !== undefined && emitted.toolCallIds.has(callId)) ||
    (itemId !== undefined && emitted.functionCallItemIds.has(itemId))
  )
}

/** Whether a raw `message` item carries text: a content part with a non-empty `text`. */
const carriesText = (item: Schema.Json) =>
  jsonArrayField(item, 'content').some(part => {
    const text = stringField(part, 'text')

    return text !== undefined && text.length > 0
  })

/**
 * Whether dropping a raw output item that does not decode loses what the model said: a
 * `function_call` the stream never emitted (`isEmittedFunctionCall`), or a `message` carrying text
 * when no text streamed (once text streamed, every final message is a replay the parser drops
 * anyway; one without text, such as an empty preamble, says nothing). Reasoning and unknown items
 * are dropped.
 */
const losesUnstreamedOutput = (item: Schema.Json, streamed: StreamedOutput) => {
  switch (stringField(item, 'type')) {
    case 'function_call':
      return !isEmittedFunctionCall(item, streamed)
    case 'message':
      return !streamed.hasTextDelta && carriesText(item)
    default:
      return false
  }
}

/**
 * Codex compatibility (`recoverMissingFinalOutput`) for a final response whose decode failed with
 * `isMissingFinalOutputIssue`: its output items are decoded one by one, so the valid ones count
 * (function calls the stream never emitted included) and the others are dropped, and its `usage`
 * is kept when it decodes on its own (else left out, and a streamed Done says so). An item whose
 * loss would drop what the model said (`losesUnstreamedOutput`) fails the response with its decode
 * error (`failure`) instead, so the turn never ends as if finished without it.
 */
const recoveredFinalResponse = (
  raw: Schema.Json | undefined,
  streamed: StreamedOutput,
  failure: LLMError
): Effect.Effect<OpenAiResponsesResponse, LLMError> => {
  const items = jsonArrayField(raw, 'output').map(item => ({
    item,
    decoded: Schema.decodeUnknownOption(OpenAiResponsesOutputItem)(item)
  }))

  const losesOutput = items.some(
    ({ item, decoded }) => Option.isNone(decoded) && losesUnstreamedOutput(item, streamed)
  )

  if (losesOutput) return Effect.fail(failure)

  return Effect.succeed(
    OpenAiResponsesResponse.make({
      output_text: stringField(raw, 'output_text'),
      output: Arr.getSomes(items.map(({ decoded }) => decoded)),
      usage: Option.getOrUndefined(
        Schema.decodeUnknownOption(OpenAiResponsesUsageResponse)(jsonField(raw, 'usage'))
      )
    })
  )
}

/** A final response as decoded, or as `recoveredFinalResponse` read it. */
type FinalResponse = {
  readonly response: OpenAiResponsesResponse
  readonly recovered: boolean
}

const decodeFinalResponse = (
  descriptor: OpenAiResponsesProviderDescriptor,
  raw: Schema.Json | undefined,
  streamed: StreamedOutput
): Effect.Effect<FinalResponse, LLMError> =>
  Schema.decodeUnknownEffect(OpenAiResponsesResponse)(raw).pipe(
    Effect.map(response => ({ response, recovered: false })),
    Effect.catch(error => {
      const failure = schemaErrorToLlmError(
        'invalid_response',
        'Invalid OpenAI Responses response'
      )(error)

      if (
        descriptor.recoverMissingFinalOutput !== true ||
        !isMissingFinalOutputIssue(error.issue)
      ) {
        return Effect.fail(failure)
      }

      return recoveredFinalResponse(raw, streamed, failure).pipe(
        Effect.map(response => ({ response, recovered: true }))
      )
    })
  )

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

    // Nothing streamed before a JSON body, so every call and message it holds is unseen.
    const final = yield* decodeFinalResponse(descriptor, json, nothingStreamed)

    // A recovered JSON response may hold nothing: it still completes, unmarked (JSON responses
    // never carry `usageUnavailable`).
    return yield* toLlmEvents(final.response, {
      allowEmptyStop: final.recovered,
      preserveOutputOrder: descriptor.preserveOutputOrder === true
    })
  })

type OpenAiResponsesBodyFormat = 'undecided' | 'sse' | 'json'

type OpenAiResponsesSseState = StreamedOutput & {
  readonly hasReasoningDelta: boolean
  readonly reasoningSummaryPartKey: string | undefined
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
  functionCallItemIds: new Set(),
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

const invalidFunctionCallError = () =>
  new LLMError({
    cause: 'invalid_response',
    message: 'Invalid OpenAI Responses function call',
    retryable: false
  })

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
        Effect.flatMap(params =>
          providerToolCallEvent(
            { id: item.call_id, name: item.name, params },
            invalidFunctionCallSseItemError
          )
        ),
        Effect.map(event => [event])
      )
  }
}

/** The final response without the calls the stream already emitted (`call_id` or item `id`). */
const responseWithoutReplayedToolCalls = (
  response: OpenAiResponsesResponse,
  streamed: StreamedOutput
): OpenAiResponsesResponse =>
  OpenAiResponsesResponse.make({
    ...response,
    output: response.output.filter(
      item =>
        item.type !== 'function_call' ||
        !(
          streamed.toolCallIds.has(item.call_id) ||
          (item.id !== undefined && streamed.functionCallItemIds.has(item.id))
        )
    )
  })

const finalResponseToEvents = (
  final: FinalResponse,
  state: OpenAiResponsesSseState,
  hasToolCalls: boolean,
  preserveOutputOrder: boolean
): Effect.Effect<ReadonlyArray<LLMEvent>, LLMError> =>
  Effect.gen(function* () {
    const parsedFinal = final.response

    // A recovered response completes even with nothing in it or streamed before it.
    const finalEvents = yield* toLlmEvents(responseWithoutReplayedToolCalls(parsedFinal, state), {
      allowEmptyStop: final.recovered || state.hasTextDelta || hasToolCalls,
      preserveOutputOrder
    })

    const shouldDedupe = state.hasTextDelta || state.hasReasoningDelta || hasToolCalls
    const dedupedEvents = shouldDedupe ? dedupeSseEvents(state, finalEvents) : finalEvents

    // Responses always reports usage on `response.completed`; one without it (or a recovered one
    // whose usage does not decode) completes the turn, but Done says the usage never arrived.
    const usageUnavailable = parsedFinal.usage === undefined

    if (!hasToolCalls && !usageUnavailable) {
      return dedupedEvents
    }

    return dedupedEvents.map(event => {
      if (!Predicate.isTagged(event, 'Done')) return event

      const stopReason = hasToolCalls ? 'tool_use' : event.stopReason

      return usageUnavailable
        ? LLMDone.make({ stopReason, usageUnavailable: true })
        : LLMDone.make({ stopReason })
    })
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

      // The item id of a streamed call, so a final `output` replaying it without its `call_id`
      // still reads as a replay (`isEmittedFunctionCall`).
      const callItemId =
        toolCallIdsFromEvents(outputItemDoneEvents).length > 0
          ? stringField(parsed.item, 'id')
          : undefined

      return {
        state: {
          hasTextDelta:
            state.hasTextDelta || events.some(event => Predicate.isTagged(event, 'TextDelta')),
          hasReasoningDelta:
            state.hasReasoningDelta ||
            events.some(event => Predicate.isTagged(event, 'ReasoningDelta')),
          reasoningSummaryPartKey: state.reasoningSummaryPartKey,
          toolCallIds: new Set([...state.toolCallIds, ...emittedToolCallIds]),
          functionCallItemIds:
            callItemId === undefined
              ? state.functionCallItemIds
              : new Set([...state.functionCallItemIds, callItemId]),
          hasDone: state.hasDone
        },
        events
      }
    }

    if (parsed.type === 'response.completed') {
      if (state.hasDone) {
        return { state, events: [] }
      }

      const hasToolCalls = state.toolCallIds.size > 0

      const events = yield* finalResponseToEvents(
        yield* decodeFinalResponse(descriptor, parsed.response, state),
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
          functionCallItemIds: state.functionCallItemIds,
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
            const fields: OpenAiResponsesSignalInputFields = {
              message,
              kindCodes: typeKindCodes(error),
              echoedValues: echoedParamValues(jsonField(error, 'param'))
            }

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
            // An `error` event's `type` is the event type, not an error type: no kind codes.
            const fields: OpenAiResponsesSignalInputFields = {
              message: parsed.message,
              kindCodes: [],
              echoedValues: echoedParamValues(jsonField(parsed, 'param'))
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

    // `hasDone` is set with the only SSE `Done`, so here no `Done` was emitted.
    if (!sseState.hasDone) {
      if (!descriptor.allowEofCompletion) {
        return yield* Effect.fail(missingTerminalEventError(descriptor))
      }

      // Codex EOF completion. Usage arrives only on `response.completed`, which never came.
      events.push(
        LLMDone.make({
          stopReason: sseState.toolCallIds.size > 0 ? 'tool_use' : 'stop',
          usageUnavailable: true
        })
      )
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
      ...requestCacheKeyHeaders(request.cacheKey, config.cacheKeyHeaders),
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

      const error = yield* decodeOpenAiHttpError(errorText)
      const echoedValues = [request.model, ...error.echoedValues]

      const quotaResetsAtMs = openAiCodexQuotaResetsAtMs({
        status: response.status,
        body: errorText,
        nowMs: yield* Clock.currentTimeMillis
      })

      const provider = classifyProviderFailure(
        quotaResetsAtMs === undefined
          ? {
              provider: config.providerId,
              status: response.status,
              headers: response.headers,
              body: errorText,
              providerCode: error.code,
              echoedValues,
              kindCodes: error.kindCodes
            }
          : {
              provider: config.providerId,
              status: response.status,
              headers: response.headers,
              body: errorText,
              providerCode: error.code,
              echoedValues,
              kindCodes: error.kindCodes,
              quotaResetsAtMs
            }
      )

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
        preserveOutputOrder: config.commentaryPhaseBeforeToolCalls === true,
        recoverMissingFinalOutput: config.recoverMissingFinalOutput === true
      }

      return LLMProvider.of({
        stream: request =>
          Stream.fromEffect(sendOpenAiResponsesRequest(config, request, client)).pipe(
            Stream.flatMap(response =>
              streamOpenAiResponsesResponse(
                { ...descriptor, echoedValues: [request.model] },
                response
              )
            )
          )
      })
    })
  )
