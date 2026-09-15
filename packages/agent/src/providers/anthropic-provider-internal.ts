import { Effect, Layer, Match, Option, Predicate, Ref, Result, Stream } from 'effect'
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
  attachmentSourceText,
  assistantContent,
  assistantHostToolCalls,
  isTextDocumentMimeType,
  messageContextText,
  replaceLoneSurrogatesDeep,
  prependMessageContextToContent,
  type AgentMessage,
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
import {
  anthropicClaudeAuthorizationHeaders,
  anthropicClaudeCodeEntrypoint,
  anthropicClaudeCodeVersion,
  anthropicClaudeOAuthUserAgent
} from './anthropic/claude.ts'
import type { OAuthAccessToken } from '@yolk-sdk/agent/oauth'
import {
  classifyProviderFailure,
  providerErrorInfo,
  providerFailureCause,
  providerFailureRetryable
} from './provider-error.ts'
import { validateProviderTranscript } from './transcript.ts'

export type AnthropicClaudeProviderConfig = {
  readonly token: OAuthAccessToken
  readonly messagesUrl?: string
  readonly maxTokens: number
  readonly extraHeaders?: Readonly<Record<string, string>>
}

type AnthropicTextBlock = {
  readonly type: 'text'
  readonly text: string
}

type AnthropicSystemBlock = AnthropicTextBlock

type AnthropicImageBlock = {
  readonly type: 'image'
  readonly source:
    | {
        readonly type: 'base64'
        readonly media_type: string
        readonly data: string
      }
    | {
        readonly type: 'url'
        readonly url: string
      }
}

type AnthropicDocumentBlock = {
  readonly type: 'document'
  readonly source:
    | {
        readonly type: 'base64'
        readonly media_type: 'application/pdf'
        readonly data: string
      }
    | {
        readonly type: 'url'
        readonly url: string
      }
  readonly title?: string
}

type AnthropicToolUseBlock = {
  readonly type: 'tool_use'
  readonly id: string
  readonly name: string
  readonly input: Schema.Json
}

type AnthropicToolResultContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicDocumentBlock

type AnthropicToolResultBlock = {
  readonly type: 'tool_result'
  readonly tool_use_id: string
  readonly content: string | ReadonlyArray<AnthropicToolResultContentBlock>
  readonly is_error?: boolean
}

type AnthropicUserBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicDocumentBlock
  | AnthropicToolResultBlock

type AnthropicAssistantBlock = AnthropicTextBlock | AnthropicToolUseBlock

type AnthropicMessage =
  | { readonly role: 'user'; readonly content: string | ReadonlyArray<AnthropicUserBlock> }
  | { readonly role: 'assistant'; readonly content: ReadonlyArray<AnthropicAssistantBlock> }

type TopLevelJsonSchemaCombinatorKey = 'anyOf' | 'oneOf' | 'allOf'

type TopLevelJsonSchemaCombinator = {
  readonly key: TopLevelJsonSchemaCombinatorKey
  readonly items: ReadonlyArray<Schema.Json>
}

type AnthropicTool = {
  readonly name: string
  readonly description: string
  readonly input_schema: Schema.Json
}

type AnthropicRequestBody = {
  readonly model: string
  readonly system: ReadonlyArray<AnthropicSystemBlock>
  readonly messages: ReadonlyArray<AnthropicMessage>
  readonly max_tokens: number
  readonly output_config?: {
    readonly effort: 'low' | 'medium' | 'high' | 'xhigh'
  }
  readonly stream?: true
  readonly tools?: ReadonlyArray<AnthropicTool>
}

type AnthropicToolBlockState = {
  readonly id: string
  readonly name: string
  readonly partialJson: string
}

const anthropicClaudeSystemIdentity = "You are Claude Code, Anthropic's official CLI for Claude."

const anthropicClaudeBillingPrefix = 'x-anthropic-billing-header:'

const anthropicClaudeToolPrefix = 'mcp_'

const anthropicClaudeVersion = '2023-06-01'

const anthropicClaudeCchSalt = '59cf53e54c78'

const anthropicClaudeCchPositions: ReadonlyArray<number> = [4, 7, 20]

const anthropicClaudeEffortBeta = 'effort-2025-11-24'

const anthropicClaudeInterleavedThinkingBeta = 'interleaved-thinking-2025-05-14'

const anthropicClaudeRequiredBetas: ReadonlyArray<string> = [
  'claude-code-20250219',
  'oauth-2025-04-20',
  anthropicClaudeInterleavedThinkingBeta,
  'prompt-caching-scope-2026-01-05',
  'context-management-2025-06-27',
  'advisor-tool-2026-03-01'
]

const anthropicClaudeSystemTextReplacements: ReadonlyArray<{
  readonly match: string
  readonly replacement: string
}> = [
  {
    match: 'if OpenCode honestly',
    replacement: 'if the assistant honestly'
  },
  {
    match: 'Here is some useful information about the environment you are running in:',
    replacement: 'Environment context you are running in:'
  }
]

const anthropicClaudeStainlessPackageVersion = '0.81.0'

// Claude subscription OAuth is fingerprinted against Claude Code tool names.
const prefixClaudeToolName = (name: string) =>
  `${anthropicClaudeToolPrefix}${name.charAt(0).toUpperCase()}${name.slice(1)}`

const unprefixClaudeToolName = (name: string) => {
  if (!name.startsWith(anthropicClaudeToolPrefix)) {
    return name
  }

  const unprefixed = name.slice(anthropicClaudeToolPrefix.length)

  if (unprefixed === 'StructuredOutput') {
    return unprefixed
  }

  return `${unprefixed.charAt(0).toLowerCase()}${unprefixed.slice(1)}`
}

const anthropicClaudeMessagesUrl = 'https://api.anthropic.com/v1/messages?beta=true'

const anthropicClaudeIdentitySystemBlock: AnthropicSystemBlock = {
  type: 'text',
  text: anthropicClaudeSystemIdentity
}

const randomHex = (byteLength: number) => {
  const crypto = globalThis.crypto
  const bytes = new Uint8Array(byteLength)

  if (crypto !== undefined && Predicate.isFunction(crypto.getRandomValues)) {
    crypto.getRandomValues(bytes)
  }

  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

const makeAnthropicClaudeRequestId = () => {
  const crypto = globalThis.crypto

  if (crypto !== undefined && Predicate.isFunction(crypto.randomUUID)) {
    return crypto.randomUUID()
  }

  return randomHex(16)
}

const sha256Hex = (value: string): Effect.Effect<string, LLMError> => {
  const crypto = globalThis.crypto

  if (crypto === undefined || crypto.subtle === undefined) {
    return Effect.fail(
      new LLMError({
        cause: 'provider_error',
        message: 'Web Crypto SHA-256 is required for Anthropic Claude OAuth billing headers',
        retryable: false
      })
    )
  }

  return Effect.tryPromise({
    try: () =>
      crypto.subtle
        .digest('SHA-256', new TextEncoder().encode(value))
        .then(buffer =>
          Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, '0')).join('')
        ),
    catch: error =>
      new LLMError({
        cause: 'provider_error',
        message: `Could not compute Anthropic Claude OAuth billing header: ${error instanceof Error ? error.message : String(error)}`,
        retryable: false
      })
  })
}

const computeAnthropicClaudeCch = (messageText: string) =>
  sha256Hex(messageText).pipe(Effect.map(hash => hash.slice(0, 5)))

const computeAnthropicClaudeVersionSuffix = (messageText: string) => {
  const chars = anthropicClaudeCchPositions.map(index => messageText[index] ?? '0').join('')

  return sha256Hex(`${anthropicClaudeCchSalt}${chars}${anthropicClaudeCodeVersion}`).pipe(
    Effect.map(hash => hash.slice(0, 3))
  )
}

const firstUserMessageText = (messages: ReadonlyArray<AnthropicMessage>) => {
  for (const message of messages) {
    if (message.role !== 'user') {
      continue
    }

    if (Predicate.isString(message.content)) {
      return message.content
    }

    for (const block of message.content) {
      if (block.type === 'text') {
        return block.text
      }
    }
  }

  return ''
}

const makeAnthropicClaudeBillingSystemBlock = (
  messages: ReadonlyArray<AnthropicMessage>
): Effect.Effect<AnthropicSystemBlock, LLMError> => {
  const text = firstUserMessageText(messages)

  return Effect.all({
    cch: computeAnthropicClaudeCch(text),
    suffix: computeAnthropicClaudeVersionSuffix(text)
  }).pipe(
    Effect.map(({ cch, suffix }): AnthropicSystemBlock => ({
      type: 'text',
      text:
        `${anthropicClaudeBillingPrefix} ` +
        `cc_version=${anthropicClaudeCodeVersion}.${suffix}; ` +
        `cc_entrypoint=${anthropicClaudeCodeEntrypoint}; ` +
        `cch=${cch};`
    }))
  )
}

const sanitizeAnthropicClaudeSystemText = (text: string) => {
  let result = text

  for (const rule of anthropicClaudeSystemTextReplacements) {
    result = result.split(rule.match).join(rule.replacement)
  }

  return result
}

const anthropicClaudeBetaHeader = (model: string) => {
  const lowerModel = model.toLowerCase()

  const baseBetas = lowerModel.includes('haiku')
    ? anthropicClaudeRequiredBetas.filter(beta => beta !== anthropicClaudeInterleavedThinkingBeta)
    : anthropicClaudeRequiredBetas

  if (
    !lowerModel.includes('haiku') &&
    (lowerModel.includes('4-6') || lowerModel.includes('4-7')) &&
    !baseBetas.includes(anthropicClaudeEffortBeta)
  ) {
    return [...baseBetas, anthropicClaudeEffortBeta].join(',')
  }

  return baseBetas.join(',')
}

const makeAnthropicClaudeCompatibilityHeaders = (input: {
  readonly model: string
  readonly sessionId: string
}) => ({
  'anthropic-beta': anthropicClaudeBetaHeader(input.model),
  'anthropic-dangerous-direct-browser-access': 'true',
  'anthropic-version': anthropicClaudeVersion,
  'user-agent': anthropicClaudeOAuthUserAgent,
  'x-app': 'cli',
  'x-client-request-id': makeAnthropicClaudeRequestId(),
  'X-Claude-Code-Session-Id': input.sessionId,
  'x-stainless-arch': 'unknown',
  'x-stainless-lang': 'js',
  'x-stainless-os': 'unknown',
  'x-stainless-package-version': anthropicClaudeStainlessPackageVersion,
  'x-stainless-retry-count': '0',
  'x-stainless-runtime': 'node',
  'x-stainless-runtime-version': 'unknown',
  'x-stainless-timeout': '600'
})

// Keep app instructions out of `system[]`; Anthropic can reject/limit otherwise.
const prependSystemPromptToFirstUserMessage = (
  messages: ReadonlyArray<AnthropicMessage>,
  systemPrompt: string
): ReadonlyArray<AnthropicMessage> => {
  const sanitizedSystemPrompt = sanitizeAnthropicClaudeSystemText(systemPrompt).trim()

  if (sanitizedSystemPrompt.length === 0) {
    return messages
  }

  let relocated = false

  return messages.map(message => {
    if (relocated || message.role !== 'user') {
      return message
    }

    relocated = true

    if (Predicate.isString(message.content)) {
      return { ...message, content: `${sanitizedSystemPrompt}\n\n${message.content}` }
    }

    return {
      ...message,
      content: [{ type: 'text', text: sanitizedSystemPrompt }, ...message.content]
    }
  })
}

class AnthropicTextResponseBlock extends Schema.Class<AnthropicTextResponseBlock>(
  'AnthropicTextResponseBlock'
)({
  type: Schema.Literal('text'),
  text: Schema.String
}) {}

class AnthropicThinkingResponseBlock extends Schema.Class<AnthropicThinkingResponseBlock>(
  'AnthropicThinkingResponseBlock'
)({
  type: Schema.Literal('thinking'),
  thinking: Schema.String
}) {}

class AnthropicToolUseResponseBlock extends Schema.Class<AnthropicToolUseResponseBlock>(
  'AnthropicToolUseResponseBlock'
)({
  type: Schema.Literal('tool_use'),
  id: Schema.String,
  name: Schema.String,
  input: Schema.Json
}) {}

const AnthropicContentResponseBlock = Schema.Union([
  AnthropicTextResponseBlock,
  AnthropicThinkingResponseBlock,
  AnthropicToolUseResponseBlock
])

class AnthropicUsageResponse extends Schema.Class<AnthropicUsageResponse>('AnthropicUsageResponse')(
  {
    input_tokens: Schema.Number,
    output_tokens: Schema.Number,
    cache_read_input_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
    cache_creation_input_tokens: Schema.optional(Schema.NullOr(Schema.Number))
  }
) {}

class AnthropicStreamUsageResponse extends Schema.Class<AnthropicStreamUsageResponse>(
  'AnthropicStreamUsageResponse'
)({
  input_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
  output_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
  cache_read_input_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
  cache_creation_input_tokens: Schema.optional(Schema.NullOr(Schema.Number))
}) {}

class AnthropicMessageResponse extends Schema.Class<AnthropicMessageResponse>(
  'AnthropicMessageResponse'
)({
  content: Schema.Array(AnthropicContentResponseBlock),
  stop_reason: Schema.NullOr(Schema.String),
  usage: Schema.optional(AnthropicUsageResponse)
}) {}

const JsonFromJsonString = Schema.fromJsonString(Schema.Json)

const schemaErrorMessage = (error: Schema.SchemaError) => String(error)

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

const unsupportedContentError = (contentType: string) =>
  new LLMError({
    cause: 'provider_error',
    message: `${contentType} content is not supported by the Anthropic Claude provider yet`,
    retryable: false
  })

const imageToAnthropicBlock = (
  part: Extract<ContentPart, { readonly _tag: 'Image' }>
): Effect.Effect<AnthropicImageBlock, LLMError> =>
  Match.value(part.source).pipe(
    Match.tag('InlineBase64', (source): Effect.Effect<AnthropicImageBlock, LLMError> =>
      Effect.succeed({
        type: 'image',
        source: {
          type: 'base64',
          media_type: part.mimeType,
          data: source.data
        }
      })
    ),
    Match.tag('Url', (source): Effect.Effect<AnthropicImageBlock, LLMError> =>
      Effect.succeed({
        type: 'image',
        source: {
          type: 'url',
          url: source.url
        }
      })
    ),
    Match.tag('Ref', () => Effect.fail(unsupportedContentError('Unresolved image source'))),
    Match.exhaustive
  )

const pdfDocumentToAnthropicBlock = (
  part: Extract<ContentPart, { readonly _tag: 'Document' }>
): Effect.Effect<AnthropicDocumentBlock, LLMError> =>
  Match.value(part.source).pipe(
    Match.tag('InlineBase64', (source): Effect.Effect<AnthropicDocumentBlock, LLMError> =>
      Effect.succeed({
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: source.data
        },
        title: part.title ?? part.filename
      })
    ),
    Match.tag('Url', (source): Effect.Effect<AnthropicDocumentBlock, LLMError> =>
      Effect.succeed({
        type: 'document',
        source: {
          type: 'url',
          url: source.url
        },
        title: part.title ?? part.filename
      })
    ),
    Match.tag('Ref', () => Effect.fail(unsupportedContentError('Unresolved document source'))),
    Match.exhaustive
  )

const textDocumentToAnthropicBlock = (part: Extract<ContentPart, { readonly _tag: 'Document' }>) =>
  attachmentSourceText(part.source).pipe(
    Effect.mapError(() => unsupportedContentError('Invalid document text')),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(unsupportedContentError('Unresolved document source')),
        onSome: text => {
          const block: AnthropicTextBlock = {
            type: 'text',
            text: `Document: ${part.title ?? part.filename}\n\n${text}`
          }

          return Effect.succeed(block)
        }
      })
    )
  )

const contentPartToAnthropicBlock = (
  part: ContentPart
): Effect.Effect<AnthropicToolResultContentBlock, LLMError> =>
  Match.value(part).pipe(
    Match.tag('Text', (current): Effect.Effect<AnthropicToolResultContentBlock, LLMError> =>
      Effect.succeed({ type: 'text', text: current.text })
    ),
    Match.tag('Image', current => imageToAnthropicBlock(current)),
    Match.tag('Document', current =>
      isTextDocumentMimeType(current.mimeType)
        ? textDocumentToAnthropicBlock(current)
        : current.mimeType === 'application/pdf'
          ? pdfDocumentToAnthropicBlock(current)
          : Effect.fail(unsupportedContentError(`Document ${current.mimeType}`))
    ),
    Match.tag('Audio', () => Effect.fail(unsupportedContentError('Audio'))),
    Match.exhaustive
  )

const contentToAnthropicContent = (
  content: Content
): Effect.Effect<string | ReadonlyArray<AnthropicToolResultContentBlock>, LLMError> =>
  Predicate.isString(content)
    ? Effect.succeed(content)
    : Effect.forEach(content, contentPartToAnthropicBlock)

const contentPartToText = (part: ContentPart, owner: string): Effect.Effect<string, LLMError> =>
  Match.value(part).pipe(
    Match.tag('Text', current => Effect.succeed(current.text)),
    Match.tag('Image', () => Effect.fail(unsupportedContentError(`${owner} image`))),
    Match.tag('Document', () => Effect.fail(unsupportedContentError(`${owner} document`))),
    Match.tag('Audio', () => Effect.fail(unsupportedContentError(`${owner} audio`))),
    Match.exhaustive
  )

const contentToText = (content: Content, owner: string): Effect.Effect<string, LLMError> =>
  Predicate.isString(content)
    ? Effect.succeed(content)
    : Effect.forEach(content, part => contentPartToText(part, owner)).pipe(
        Effect.map(textParts => textParts.join('\n'))
      )

const toolCallToAnthropicBlock = (
  call: ToolCall,
  claudeCompatibility: boolean
): Effect.Effect<AnthropicToolUseBlock, LLMError> =>
  Schema.decodeUnknownEffect(Schema.Json)(call.params).pipe(
    Effect.mapError(
      schemaErrorToLlmError('provider_error', 'Invalid Anthropic Claude tool arguments JSON')
    ),
    Effect.map((input): AnthropicToolUseBlock => ({
      type: 'tool_use',
      id: call.id,
      name: claudeCompatibility ? prefixClaudeToolName(call.name) : call.name,
      input
    }))
  )

const isJsonObject = (value: Schema.Json | undefined): value is Schema.JsonObject =>
  value !== undefined && Predicate.isObjectOrArray(value) && !Array.isArray(value)

const jsonObjectField = (value: Schema.JsonObject, key: string): Schema.Json | undefined =>
  Object.hasOwn(value, key) ? value[key] : undefined

// Claude subscription OAuth validates tool schemas more narrowly than the regular
// Anthropic API: combinators and tuple-only prefixItems can be rejected even when
// they are valid JSON Schema. Effect Schema emits those constructs for unions,
// refinements, and tuples, so the provider needs a compatibility projection.
//
// This projection is model guidance, not the execution validator. Whenever an
// unsupported constraint cannot be represented faithfully, normalization must
// widen it (usually to {}) rather than exclude an input accepted by the original
// schema. makeTool continues to validate calls against that original Effect Schema.
const topLevelJsonSchemaCombinatorKeys: ReadonlyArray<TopLevelJsonSchemaCombinatorKey> = [
  'anyOf',
  'oneOf',
  'allOf'
]

const isTopLevelJsonSchemaCombinatorKey = (key: string): key is TopLevelJsonSchemaCombinatorKey =>
  key === 'anyOf' || key === 'oneOf' || key === 'allOf'

const topLevelJsonSchemaCombinator = (
  schema: Schema.JsonObject
): TopLevelJsonSchemaCombinator | undefined => {
  for (const key of topLevelJsonSchemaCombinatorKeys) {
    const value = jsonObjectField(schema, key)

    if (Array.isArray(value)) {
      return { key, items: value }
    }
  }

  return undefined
}

const withoutTopLevelJsonSchemaCombinators = (schema: Schema.JsonObject): Schema.JsonObject =>
  Object.fromEntries(
    Object.entries(schema).filter(([key]) => !isTopLevelJsonSchemaCombinatorKey(key))
  )

const withoutJsonSchemaCombinatorsAndTupleHints = (schema: Schema.JsonObject): Schema.JsonObject =>
  Object.fromEntries(
    Object.entries(schema).filter(
      ([key]) =>
        !isTopLevelJsonSchemaCombinatorKey(key) &&
        key !== 'prefixItems' &&
        key !== 'not' &&
        key !== 'if' &&
        key !== 'then' &&
        key !== 'else'
    )
  )

const jsonSchemaMap = (schema: Schema.JsonObject, key: string) => {
  const value = jsonObjectField(schema, key)

  return isJsonObject(value) ? value : {}
}

const jsonSchemaProperties = (schema: Schema.JsonObject) => jsonSchemaMap(schema, 'properties')

const jsonSchemaDefinitions = (schema: Schema.JsonObject) => {
  const definitions = jsonObjectField(schema, '$defs')

  return isJsonObject(definitions) ? definitions : {}
}

const jsonSchemaRequired = (schema: Schema.JsonObject) => {
  const required = jsonObjectField(schema, 'required')

  return Array.isArray(required) ? required.filter(item => Predicate.isString(item)) : []
}

const jsonValueKey = (value: Schema.Json) =>
  Result.try(() => JSON.stringify(value)).pipe(
    Result.match({
      onFailure: () => undefined,
      onSuccess: encoded => encoded
    })
  )

const uniqueJsonArray = (items: ReadonlyArray<Schema.Json>): ReadonlyArray<Schema.Json> => {
  const seen = new Set<string>()
  const result: Array<Schema.Json> = []

  for (const item of items) {
    const key = jsonValueKey(item)

    if (key === undefined || seen.has(key)) {
      continue
    }

    seen.add(key)
    result.push(item)
  }

  return result
}

const mergeEnumPropertySchemas = (
  left: Schema.JsonObject,
  right: Schema.JsonObject
): Schema.JsonObject | undefined => {
  const leftEnum = jsonObjectField(left, 'enum')
  const rightEnum = jsonObjectField(right, 'enum')

  if (!Array.isArray(leftEnum) || !Array.isArray(rightEnum)) {
    return undefined
  }

  const leftType = jsonObjectField(left, 'type')
  const rightType = jsonObjectField(right, 'type')

  if (leftType !== rightType) {
    return undefined
  }

  const descriptions = [jsonObjectField(left, 'description'), jsonObjectField(right, 'description')]
  const description = descriptions.find(value => Predicate.isString(value))

  type MergedEnumPropertySchemaFields = {
    type?: Schema.Json
    enum: ReadonlyArray<Schema.Json>
    description?: string
  }

  const fields: MergedEnumPropertySchemaFields =
    leftType === undefined
      ? { enum: uniqueJsonArray([...leftEnum, ...rightEnum]) }
      : { type: leftType, enum: uniqueJsonArray([...leftEnum, ...rightEnum]) }

  if (description !== undefined) {
    fields.description = description
  }

  return fields
}

const mergePropertySchemas = (left: Schema.Json, right: Schema.Json): Schema.Json => {
  const leftKey = jsonValueKey(left)

  if (leftKey !== undefined && leftKey === jsonValueKey(right)) {
    return left
  }

  if (isJsonObject(left) && isJsonObject(right)) {
    const mergedEnum = mergeEnumPropertySchemas(left, right)

    if (mergedEnum !== undefined) {
      return mergedEnum
    }
  }

  // Anthropic rejects combinators in tool schemas. An unconstrained schema
  // preserves every value accepted by either incompatible variant; makeTool
  // still validates calls against the complete original Effect Schema.
  return {}
}

const mergeJsonSchemaObjects = (objects: ReadonlyArray<Schema.JsonObject>): Schema.JsonObject => {
  const merged = new Map<string, Schema.Json>()

  for (const object of objects) {
    for (const [key, value] of Object.entries(object)) {
      const current = merged.get(key)
      merged.set(key, current === undefined ? value : mergePropertySchemas(current, value))
    }
  }

  return Object.fromEntries(merged)
}

const mergeUnionJsonSchemaObjects = (
  objects: ReadonlyArray<Schema.JsonObject>,
  owners?: ReadonlyArray<Schema.JsonObject>
): Schema.JsonObject => {
  const keys = new Set(objects.flatMap(object => Object.keys(object)))

  return Object.fromEntries(
    Array.from(keys, key => {
      const values = objects.flatMap((object, index) => {
        if (Object.hasOwn(object, key)) {
          const owned = jsonObjectField(object, key)

          return owned === undefined ? [] : [owned]
        }

        const additionalProperties = owners?.[index]

        if (additionalProperties === undefined) return []

        const additionalPropertySchema = jsonObjectField(
          additionalProperties,
          'additionalProperties'
        )

        if (additionalPropertySchema === false) return []

        return [isJsonObject(additionalPropertySchema) ? additionalPropertySchema : {}]
      })

      const [first, ...rest] = values

      return [key, first === undefined ? {} : rest.reduce(mergePropertySchemas, first)]
    })
  )
}

const mergeRightBiasedJsonSchemaObjects = (
  objects: ReadonlyArray<Schema.JsonObject>
): Schema.JsonObject => Object.assign({}, ...objects)

const mergeAllOfSchemaObjects = (objects: ReadonlyArray<Schema.JsonObject>): Schema.JsonObject => {
  const merged = mergeRightBiasedJsonSchemaObjects(objects)
  const properties = mergeRightBiasedJsonSchemaObjects(objects.map(jsonSchemaProperties))
  const required = mergeJsonSchemaRequired('allOf', objects)
  const definitions = mergeJsonSchemaObjects(objects.map(jsonSchemaDefinitions))

  const fields = { ...merged }

  if (Object.keys(properties).length !== 0) {
    fields.properties = properties
  }

  if (required.length !== 0) {
    fields.required = required
  }

  if (Object.keys(definitions).length !== 0) {
    fields.$defs = definitions
  }

  return fields
}

// JSON objects are not always schemas. Values under schema-map keywords are
// schemas, while values under data keywords are literals and must remain opaque;
// recursively normalizing enum data or property/definition names can corrupt it.
const jsonSchemaMapKeywords = new Set([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas'
])

const jsonSchemaDataKeywords = new Set(['const', 'default', 'enum', 'examples'])

const normalizeJsonSchemaObjectFields = (schema: Schema.JsonObject): Schema.JsonObject => {
  const normalized = Object.fromEntries(
    Object.entries(withoutJsonSchemaCombinatorsAndTupleHints(schema)).map(([key, value]) => {
      if (jsonSchemaDataKeywords.has(key)) return [key, value]

      if (key === 'dependencies' && isJsonObject(value)) {
        return [
          key,
          Object.fromEntries(
            Object.entries(value).map(([name, dependency]) => [
              name,
              Array.isArray(dependency) ? dependency : normalizeAnthropicToolSchema(dependency)
            ])
          )
        ]
      }

      if (jsonSchemaMapKeywords.has(key) && isJsonObject(value)) {
        return [
          key,
          Object.fromEntries(
            Object.entries(value).map(([name, childSchema]) => [
              name,
              normalizeAnthropicToolSchema(childSchema)
            ])
          )
        ]
      }

      return [key, normalizeAnthropicToolSchema(value)]
    })
  )

  if (Array.isArray(jsonObjectField(schema, 'prefixItems'))) {
    return { ...normalized, items: {} }
  }

  return normalized
}

const jsonSchemaType = (schema: Schema.JsonObject) => {
  const type = jsonObjectField(schema, 'type')

  return Predicate.isString(type) ? type : undefined
}

const firstJsonObject = (items: ReadonlyArray<Schema.JsonObject>) => items[0]

const independentCommonVariantKeys = new Set([
  'type',
  'enum',
  'const',
  'format',
  'pattern',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
  'description'
])

const commonVariantFields = (variants: ReadonlyArray<Schema.JsonObject>): Schema.JsonObject => {
  const first = firstJsonObject(variants)

  if (first === undefined) return {}

  if (variants.length === 1) return first

  return Object.fromEntries(
    Object.entries(first).filter(([key, value]) => {
      if (!independentCommonVariantKeys.has(key)) return false

      const valueKey = jsonValueKey(value)

      return (
        valueKey !== undefined &&
        variants.every(variant => {
          const other = jsonObjectField(variant, key)

          return other !== undefined && valueKey === jsonValueKey(other)
        })
      )
    })
  )
}

const objectVariant = (
  variants: ReadonlyArray<Schema.JsonObject>
): Schema.JsonObject | undefined => {
  if (variants.length === 0 || variants.some(variant => jsonSchemaType(variant) !== 'object')) {
    return undefined
  }

  if (
    variants.some(variant => Object.keys(jsonSchemaMap(variant, 'patternProperties')).length > 0)
  ) {
    return { type: 'object' }
  }

  const additionalProperties = mergeAdditionalProperties(variants)

  type AnthropicObjectVariantSchemaFields = {
    type: 'object'
    properties: ReturnType<typeof mergeUnionJsonSchemaObjects>
    required: ReturnType<typeof mergeJsonSchemaRequired>
    $defs: ReturnType<typeof mergeJsonSchemaObjects>
    additionalProperties?: boolean
  }

  const fields: AnthropicObjectVariantSchemaFields = {
    type: 'object',
    properties: mergeUnionJsonSchemaObjects(variants.map(jsonSchemaProperties), variants),
    required: mergeJsonSchemaRequired('oneOf', variants),
    $defs: mergeJsonSchemaObjects(variants.map(jsonSchemaDefinitions))
  }

  if (additionalProperties !== undefined) {
    fields.additionalProperties = additionalProperties
  }

  return fields
}

const normalizeJsonSchemaCombinator = (
  schema: Schema.JsonObject,
  combinator: TopLevelJsonSchemaCombinator
): Schema.JsonObject => {
  const base = normalizeJsonSchemaObjectFields(schema)
  const normalizedItems = combinator.items.map(normalizeAnthropicToolSchema)
  const variants = normalizedItems.filter(isJsonObject)
  const first = firstJsonObject(variants)

  if (combinator.key === 'allOf') {
    return mergeAllOfSchemaObjects([base, ...variants])
  }

  if (normalizedItems.includes(true)) return base

  if (first === undefined) return base

  const merged = objectVariant(variants) ?? commonVariantFields(variants)

  return mergeAllOfSchemaObjects([merged, base])
}

function normalizeAnthropicToolSchema(value: Schema.Json): Schema.Json {
  if (Array.isArray(value)) return value.map(normalizeAnthropicToolSchema)

  if (!isJsonObject(value)) return value

  const combinator = topLevelJsonSchemaCombinator(value)

  if (combinator !== undefined) return normalizeJsonSchemaCombinator(value, combinator)

  return normalizeJsonSchemaObjectFields(value)
}

const mergeJsonSchemaRequired = (
  combinatorKey: TopLevelJsonSchemaCombinatorKey,
  objects: ReadonlyArray<Schema.JsonObject>
): ReadonlyArray<string> => {
  const requiredSets = objects.map(jsonSchemaRequired)

  if (requiredSets.length === 0) {
    return []
  }

  if (combinatorKey === 'allOf') {
    return Array.from(new Set(requiredSets.flat()))
  }

  const first = requiredSets[0] ?? []

  return first.filter(item => requiredSets.every(required => required.includes(item)))
}

const mergeAdditionalProperties = (objects: ReadonlyArray<Schema.JsonObject>) => {
  const values = objects.map(object => jsonObjectField(object, 'additionalProperties'))

  if (values.every(value => value === false)) {
    return false
  }

  if (values.every(value => value === true)) {
    return true
  }

  return undefined
}

// Anthropic rejects root combinators. This widens provider-facing guidance only;
// tool execution still validates calls against the original registry schema.
const flattenTopLevelCombinatorToolSchema = (
  schema: Schema.JsonObject,
  combinator: TopLevelJsonSchemaCombinator
) => {
  const base = withoutTopLevelJsonSchemaCombinators(schema)
  const objectVariants = combinator.items.filter(isJsonObject)

  const hasUnconstrainedUnion =
    combinator.key !== 'allOf' &&
    combinator.items.some(item => item === true || !isJsonObject(item))

  const additionalProperties = mergeAdditionalProperties(objectVariants)

  const flattened = {
    ...base,
    type: 'object',
    properties: hasUnconstrainedUnion
      ? {}
      : combinator.key === 'allOf'
        ? mergeRightBiasedJsonSchemaObjects(objectVariants.map(jsonSchemaProperties))
        : mergeUnionJsonSchemaObjects(objectVariants.map(jsonSchemaProperties), objectVariants),
    required: hasUnconstrainedUnion ? [] : mergeJsonSchemaRequired(combinator.key, objectVariants),
    $defs: mergeJsonSchemaObjects([
      jsonSchemaDefinitions(schema),
      ...objectVariants.map(jsonSchemaDefinitions)
    ])
  }

  if (hasUnconstrainedUnion || additionalProperties === undefined) {
    return flattened
  }

  return { ...flattened, additionalProperties }
}

const anthropicToolInputSchema = (schema: Schema.Json): Schema.Json => {
  if (!isJsonObject(schema)) {
    return schema === true
      ? { type: 'object', properties: {} }
      : {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false
        }
  }

  const combinator = topLevelJsonSchemaCombinator(schema)

  if (combinator !== undefined) {
    return normalizeAnthropicToolSchema(flattenTopLevelCombinatorToolSchema(schema, combinator))
  }

  if (jsonObjectField(schema, 'type') !== undefined) {
    return normalizeAnthropicToolSchema(schema)
  }

  return normalizeAnthropicToolSchema({ ...schema, type: 'object' })
}

const toAnthropicMessage = (
  message: AgentMessage,
  claudeCompatibility: boolean
): Effect.Effect<AnthropicMessage, LLMError> =>
  Match.value(message).pipe(
    Match.withReturnType<Effect.Effect<AnthropicMessage, LLMError>>(),
    Match.tag('User', current =>
      contentToAnthropicContent(
        prependMessageContextToContent(current.content, messageContextText(current))
      ).pipe(Effect.map(content => ({ role: 'user' as const, content })))
    ),
    Match.tag('Assistant', current =>
      contentToText(
        prependMessageContextToContent(assistantContent(current), messageContextText(current)),
        'Assistant'
      ).pipe(
        Effect.flatMap(text =>
          Effect.forEach(assistantHostToolCalls(current), call =>
            toolCallToAnthropicBlock(call, claudeCompatibility)
          ).pipe(
            Effect.map(toolBlocks => {
              const textBlocks: ReadonlyArray<AnthropicTextBlock> =
                text.length === 0 ? [] : [{ type: 'text', text }]

              return { role: 'assistant' as const, content: [...textBlocks, ...toolBlocks] }
            })
          )
        )
      )
    ),
    Match.tag('ToolResult', current =>
      contentToAnthropicContent(
        prependMessageContextToContent(current.content, messageContextText(current))
      ).pipe(
        Effect.map(content => ({
          role: 'user' as const,
          content: [
            {
              type: 'tool_result' as const,
              tool_use_id: current.toolCallId,
              content,
              is_error: current.isError
            }
          ]
        }))
      )
    ),
    Match.exhaustive
  )

const toAnthropicTool = (
  tool: ToolDef,
  claudeCompatibility: boolean
): Effect.Effect<AnthropicTool, LLMError> =>
  Schema.decodeUnknownEffect(Schema.Json)(tool.parameters).pipe(
    Effect.mapError(
      schemaErrorToLlmError('provider_error', 'Invalid Anthropic Claude tool parameters JSON')
    ),
    Effect.map(parameters => ({
      name: claudeCompatibility ? prefixClaudeToolName(tool.name) : tool.name,
      description: tool.description,
      input_schema: claudeCompatibility ? anthropicToolInputSchema(parameters) : parameters
    }))
  )

export const toAnthropicRequestBody = (
  request: LLMRequest,
  config: {
    readonly maxTokens: number
    readonly stream?: boolean
    readonly claudeCompatibility?: boolean
  }
): Effect.Effect<AnthropicRequestBody, LLMError> =>
  Effect.gen(function* () {
    const claudeCompatibility = config.claudeCompatibility ?? true
    yield* validateProviderTranscript(request.messages)

    const rawMessages = yield* Effect.forEach(request.messages, message =>
      toAnthropicMessage(message, claudeCompatibility)
    )

    const system: ReadonlyArray<AnthropicSystemBlock> = claudeCompatibility
      ? [
          yield* makeAnthropicClaudeBillingSystemBlock(rawMessages),
          anthropicClaudeIdentitySystemBlock
        ]
      : [{ type: 'text', text: request.systemPrompt }]

    const messages = claudeCompatibility
      ? prependSystemPromptToFirstUserMessage(rawMessages, request.systemPrompt)
      : rawMessages

    const outputConfig =
      request.reasoningEffort === undefined || request.reasoningEffort === 'minimal'
        ? undefined
        : { effort: request.reasoningEffort }

    type AnthropicBaseRequestBodyFields = {
      model: string
      system: ReadonlyArray<AnthropicSystemBlock>
      messages: ReadonlyArray<AnthropicMessage>
      max_tokens: number
      output_config?: AnthropicRequestBody['output_config']
    }

    const baseBody: AnthropicBaseRequestBodyFields = {
      model: request.model,
      system,
      messages,
      max_tokens: config.maxTokens
    }

    if (outputConfig !== undefined) {
      baseBody.output_config = outputConfig
    }

    const body: AnthropicRequestBody =
      config.stream === true ? { ...baseBody, stream: true } : baseBody

    if (request.tools.length === 0) {
      return body
    }

    return {
      ...body,
      tools: yield* Effect.forEach(request.tools, tool =>
        toAnthropicTool(tool, claudeCompatibility)
      )
    }
  })

const anthropicClaudeProvider = 'anthropic_claude'

const toHttpClientLlmError =
  (message: string, retryable: boolean, kind: ProviderFailureKind = 'network') =>
  (error: HttpClientError.HttpClientError) =>
    new LLMError({
      cause: 'provider_error',
      message: `${message}: ${error.message}`,
      retryable,
      provider: providerErrorInfo({
        provider: anthropicClaudeProvider,
        kind: retryable ? kind : 'unknown'
      })
    })

const decodeJsonString = (raw: string, message: string) =>
  Schema.decodeUnknownEffect(JsonFromJsonString)(raw).pipe(
    Effect.mapError(schemaErrorToLlmError('invalid_response', message))
  )

const jsonField = (value: Schema.Json | undefined, key: string): Schema.Json | undefined =>
  value !== undefined && isJsonObject(value) ? jsonObjectField(value, key) : undefined

const stringField = (value: Schema.Json | undefined, key: string) => {
  const raw = jsonField(value, key)

  return Predicate.isString(raw) ? raw : undefined
}

type AnthropicHttpErrorInfo = {
  readonly message?: string
  readonly providerCode?: string
}

type AnthropicHttpErrorInfoFields = {
  message?: string
  providerCode?: string
}

const maxAnthropicHttpErrorMessageCharacters = 1_000

const boundedAnthropicHttpErrorMessage = (message: string) =>
  message.length <= maxAnthropicHttpErrorMessageCharacters
    ? message
    : `${message.slice(0, maxAnthropicHttpErrorMessageCharacters)}…`

const decodeAnthropicHttpErrorInfo = (raw: string): Effect.Effect<AnthropicHttpErrorInfo> =>
  Schema.decodeUnknownEffect(JsonFromJsonString)(raw).pipe(
    Effect.map(parsed => {
      const error = jsonField(parsed, 'error')
      const message = stringField(error, 'message')
      const providerCode = stringField(error, 'type') ?? stringField(error, 'code')

      const fields: AnthropicHttpErrorInfoFields = {}

      if (message !== undefined) {
        fields.message = boundedAnthropicHttpErrorMessage(message)
      }

      if (providerCode !== undefined) {
        fields.providerCode = providerCode
      }

      return fields
    }),
    Effect.catch(() => Effect.succeed({}))
  )

type AnthropicProviderSignalClassifyFields = {
  provider: string
  message: string
  providerCode?: string
  fallbackKind?: ProviderFailureKind
}

type AnthropicProviderSignalInputFields = {
  message: string
  providerCode?: string
}

type AnthropicHttpClassifyFields = {
  provider: string
  status: number
  headers: HttpClientResponse.HttpClientResponse['headers']
  body: string
  message?: string
  providerCode?: string
}

const providerSignalError = (input: {
  readonly message: string
  readonly providerCode?: string
  readonly fallbackKind?: ProviderFailureKind
}) => {
  const provider = classifyProviderFailure(
    (() => {
      const fields: AnthropicProviderSignalClassifyFields = {
        provider: anthropicClaudeProvider,
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
    message: input.message,
    retryable: providerFailureRetryable(provider.kind),
    provider
  })
}

const numberField = (value: Schema.Json | undefined, key: string) => {
  const raw = jsonField(value, key)

  return Predicate.isNumber(raw) ? raw : undefined
}

const sseDataFromBlock = (block: string) =>
  block
    .split('\n')
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice('data:'.length).trimStart())
    .join('\n')
    .trim()

const dataFromSseBlock = (block: string) => {
  const data = sseDataFromBlock(block)

  if (data.length === 0 || data === '[DONE]') {
    return undefined
  }

  return data
}

const normalizeNewlines = (text: string) => text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')

const splitCompleteSseBlocks = (buffer: string) => {
  const blocks = buffer.split('\n\n')
  const tail = blocks.at(-1) ?? ''

  return { completeBlocks: blocks.slice(0, -1), tail }
}

const parseToolParams = (raw: string): Effect.Effect<Schema.Json, LLMError> => {
  const trimmed = raw.trim()

  if (trimmed.length === 0) return Effect.succeed({})

  return decodeJsonString(trimmed, 'Invalid Anthropic Claude tool arguments JSON')
}

type AnthropicUsageComponents = {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadInputTokens: number
  readonly cacheCreationInputTokens: number
}

const zeroAnthropicUsageComponents: AnthropicUsageComponents = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0
}

const positiveOrUndefined = (value: number) => (value > 0 ? value : undefined)

const toAgentUsageFromComponents = (usage: AnthropicUsageComponents) =>
  AgentUsage.make({
    input: AgentInputUsage.make({
      total: usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens,
      uncached: positiveOrUndefined(usage.inputTokens),
      cacheRead: positiveOrUndefined(usage.cacheReadInputTokens),
      cacheWrite: positiveOrUndefined(usage.cacheCreationInputTokens)
    }),
    output: AgentOutputUsage.make({
      total: usage.outputTokens,
      text: positiveOrUndefined(usage.outputTokens)
    })
  })

const toAgentUsage = (usage: AnthropicUsageResponse) =>
  toAgentUsageFromComponents({
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0
  })

const nextAnthropicUsageSnapshot = (
  previous: AnthropicUsageComponents,
  usage: AnthropicStreamUsageResponse
): AnthropicUsageComponents => ({
  inputTokens: usage.input_tokens ?? previous.inputTokens,
  outputTokens: usage.output_tokens ?? previous.outputTokens,
  cacheReadInputTokens: usage.cache_read_input_tokens ?? previous.cacheReadInputTokens,
  cacheCreationInputTokens: usage.cache_creation_input_tokens ?? previous.cacheCreationInputTokens
})

const usageComponentDelta = (previous: number, next: number) => Math.max(0, next - previous)

const anthropicUsageDelta = (
  previous: AnthropicUsageComponents,
  next: AnthropicUsageComponents
): AnthropicUsageComponents => ({
  inputTokens: usageComponentDelta(previous.inputTokens, next.inputTokens),
  outputTokens: usageComponentDelta(previous.outputTokens, next.outputTokens),
  cacheReadInputTokens: usageComponentDelta(
    previous.cacheReadInputTokens,
    next.cacheReadInputTokens
  ),
  cacheCreationInputTokens: usageComponentDelta(
    previous.cacheCreationInputTokens,
    next.cacheCreationInputTokens
  )
})

const hasAnthropicUsage = (usage: AnthropicUsageComponents) =>
  usage.inputTokens > 0 ||
  usage.outputTokens > 0 ||
  usage.cacheReadInputTokens > 0 ||
  usage.cacheCreationInputTokens > 0

type AnthropicStreamUsageStep = {
  readonly snapshot: AnthropicUsageComponents
  readonly events: ReadonlyArray<LLMEvent>
}

const usageStepFromResponse = (
  usage: AnthropicStreamUsageResponse,
  previous: AnthropicUsageComponents
): AnthropicStreamUsageStep => {
  const snapshot = nextAnthropicUsageSnapshot(previous, usage)
  const delta = anthropicUsageDelta(previous, snapshot)

  return {
    snapshot,
    events: hasAnthropicUsage(delta)
      ? [LLMUsage.make({ usage: toAgentUsageFromComponents(delta) })]
      : []
  }
}

const emptyUsageStep = (previous: AnthropicUsageComponents): AnthropicStreamUsageStep => ({
  snapshot: previous,
  events: []
})

const toLlmEvents = (
  response: AnthropicMessageResponse,
  decodeToolName: (name: string) => string
): Effect.Effect<ReadonlyArray<LLMEvent>, LLMError> =>
  Effect.gen(function* () {
    if (response.stop_reason === 'max_tokens' || response.stop_reason === 'content_filter') {
      return yield* Effect.fail(anthropicTerminalError(response.stop_reason))
    }

    const events = yield* Effect.forEach(response.content, block => {
      switch (block.type) {
        case 'text':
          return Effect.succeed<LLMEvent>(LLMTextDelta.make({ text: block.text }))
        case 'thinking':
          return Effect.succeed<LLMEvent>(LLMReasoningDelta.make({ text: block.thinking }))
        case 'tool_use':
          return Effect.succeed<LLMEvent>(
            LLMToolCall.make({
              call: ToolCall.make({
                id: block.id,
                name: decodeToolName(block.name),
                params: block.input
              })
            })
          )
      }
    })

    const stopReason = response.stop_reason === 'tool_use' ? 'tool_use' : 'stop'

    const usageEvent =
      response.usage === undefined ? [] : [LLMUsage.make({ usage: toAgentUsage(response.usage) })]

    return [...events, LLMDone.make({ stopReason }), ...usageEvent]
  })

const decodeAnthropicMessageResponse = (json: Schema.Json) =>
  Schema.decodeUnknownEffect(AnthropicMessageResponse)(json).pipe(
    Effect.mapError(schemaErrorToLlmError('invalid_response', 'Invalid Anthropic Claude response'))
  )

const parseAnthropicJsonResponse = (
  raw: string,
  decodeToolName: (name: string) => string,
  allowEofCompletion: boolean
): Effect.Effect<ReadonlyArray<LLMEvent>, LLMError> =>
  Effect.gen(function* () {
    const json = yield* decodeJsonString(raw, 'Could not parse Anthropic Claude response JSON')
    const parsed = yield* decodeAnthropicMessageResponse(json)

    if (
      !allowEofCompletion &&
      (parsed.stop_reason === null || parsed.stop_reason.trim().length === 0)
    ) {
      return yield* Effect.fail(
        new LLMError({
          cause: 'invalid_response',
          message: 'Anthropic Messages JSON response did not include a stop reason',
          retryable: false
        })
      )
    }

    return yield* toLlmEvents(parsed, decodeToolName)
  })

type AnthropicBodyFormat = 'undecided' | 'sse' | 'json'

type AnthropicSseState = {
  readonly hasToolCall: boolean
  readonly hasDone: boolean
  readonly stopReason?: string
  readonly usage: AnthropicUsageComponents
}

type AnthropicSseStateFields = {
  hasToolCall: boolean
  hasDone: boolean
  stopReason?: string
  usage: AnthropicUsageComponents
}

type AnthropicSseStep = {
  readonly state: AnthropicSseState
  readonly events: ReadonlyArray<LLMEvent>
}

type AnthropicBodyState = {
  readonly format: AnthropicBodyFormat
  readonly buffer: string
  readonly sse: AnthropicSseState
}

const initialSseState: AnthropicSseState = {
  hasToolCall: false,
  hasDone: false,
  usage: zeroAnthropicUsageComponents
}

const initialBodyState: AnthropicBodyState = {
  format: 'undecided',
  buffer: '',
  sse: initialSseState
}

const classifyAnthropicBody = (buffer: string): AnthropicBodyFormat => {
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

const invalidToolUseStartError = () =>
  new LLMError({
    cause: 'invalid_response',
    message: 'Invalid Anthropic Claude tool_use stream block',
    retryable: false
  })

const anthropicTerminalError = (reason: 'max_tokens' | 'content_filter') =>
  new LLMError({
    cause: 'invalid_response',
    message:
      reason === 'max_tokens'
        ? 'Anthropic Claude stopped after reaching max_tokens'
        : 'Anthropic Claude response stopped with content_filter',
    retryable: false
  })

const makeAnthropicStreamEmitter = (decodeToolName: (name: string) => string) => {
  const toolBlocks = new Map<number, AnthropicToolBlockState>()

  return (
    state: AnthropicSseState,
    data: Schema.Json
  ): Effect.Effect<AnthropicSseStep, LLMError> => {
    const type = stringField(data, 'type')

    if (state.hasDone) return Effect.succeed({ state, events: [] })

    if (type === 'message_start') {
      const message = jsonField(data, 'message')
      const usageInput = jsonField(message, 'usage')
      const previousUsage = state.usage
      const parsedUsage = Schema.decodeUnknownOption(AnthropicStreamUsageResponse)(usageInput)

      const step = Predicate.isTagged(parsedUsage, 'None')
        ? emptyUsageStep(previousUsage)
        : usageStepFromResponse(parsedUsage.value, previousUsage)

      return Effect.succeed({ state: { ...state, usage: step.snapshot }, events: step.events })
    }

    if (type === 'content_block_start') {
      const index = numberField(data, 'index')
      const block = jsonField(data, 'content_block')

      if (index !== undefined && stringField(block, 'type') === 'tool_use') {
        const id = stringField(block, 'id')
        const name = stringField(block, 'name')

        if (id === undefined || name === undefined) {
          return Effect.fail(invalidToolUseStartError())
        }

        toolBlocks.set(index, {
          id,
          name: decodeToolName(name),
          partialJson: ''
        })
      }

      return Effect.succeed({ state, events: [] })
    }

    if (type === 'content_block_delta') {
      const index = numberField(data, 'index')
      const delta = jsonField(data, 'delta')
      const deltaType = stringField(delta, 'type')
      const text = stringField(delta, 'text')
      const thinking = stringField(delta, 'thinking')
      const partialJson = stringField(delta, 'partial_json')

      if (deltaType === 'text_delta' && text !== undefined) {
        return Effect.succeed({ state, events: [LLMTextDelta.make({ text })] })
      }

      if (deltaType === 'thinking_delta' && thinking !== undefined) {
        return Effect.succeed({ state, events: [LLMReasoningDelta.make({ text: thinking })] })
      }

      if (index !== undefined && deltaType === 'input_json_delta' && partialJson !== undefined) {
        const current = toolBlocks.get(index)

        if (current !== undefined) {
          toolBlocks.set(index, { ...current, partialJson: `${current.partialJson}${partialJson}` })
        }
      }

      return Effect.succeed({ state, events: [] })
    }

    if (type === 'content_block_stop') {
      const index = numberField(data, 'index')
      const toolBlock = index === undefined ? undefined : toolBlocks.get(index)

      if (toolBlock === undefined) return Effect.succeed({ state, events: [] })

      return parseToolParams(toolBlock.partialJson).pipe(
        Effect.map(params => {
          if (index !== undefined) toolBlocks.delete(index)

          return {
            state: { ...state, hasToolCall: true },
            events: [
              LLMToolCall.make({
                call: ToolCall.make({
                  id: toolBlock.id,
                  name: toolBlock.name,
                  params
                })
              })
            ]
          }
        })
      )
    }

    if (type === 'message_delta') {
      const usageInput = jsonField(data, 'usage')
      const previousUsage = state.usage
      const parsedUsage = Schema.decodeUnknownOption(AnthropicStreamUsageResponse)(usageInput)

      const step = Predicate.isTagged(parsedUsage, 'None')
        ? emptyUsageStep(previousUsage)
        : usageStepFromResponse(parsedUsage.value, previousUsage)

      const delta = jsonField(data, 'delta')
      const stopReason = stringField(delta, 'stop_reason')

      return Effect.succeed({
        state: (() => {
          const nextState: AnthropicSseStateFields = {
            ...state,
            usage: step.snapshot
          }

          if (stopReason !== undefined) {
            nextState.stopReason = stopReason
          }

          return nextState
        })(),
        events: step.events
      })
    }

    if (type === 'message_stop') {
      if (state.stopReason === 'max_tokens' || state.stopReason === 'content_filter') {
        return Effect.fail(anthropicTerminalError(state.stopReason))
      }

      return Effect.succeed({
        state: { ...state, hasDone: true },
        events: [LLMDone.make({ stopReason: state.hasToolCall ? 'tool_use' : 'stop' })]
      })
    }

    if (type === 'error') {
      const error = jsonField(data, 'error')
      const providerCode = stringField(error, 'type') ?? stringField(error, 'code')

      return Effect.fail(
        providerSignalError(
          (() => {
            const fields: AnthropicProviderSignalInputFields = {
              message: stringField(error, 'message') ?? 'Anthropic Claude stream error'
            }

            if (providerCode !== undefined) {
              fields.providerCode = providerCode
            }

            return fields
          })()
        )
      )
    }

    return Effect.succeed({ state, events: [] })
  }
}

const processSseData = (
  emitData: ReturnType<typeof makeAnthropicStreamEmitter>,
  state: AnthropicSseState,
  data: string
): Effect.Effect<AnthropicSseStep, LLMError> =>
  state.hasDone
    ? Effect.succeed({ state, events: [] })
    : decodeJsonString(data, 'Could not parse Anthropic Claude stream event JSON').pipe(
        Effect.flatMap(parsed => emitData(state, parsed))
      )

const processSseBlock = (
  emitData: ReturnType<typeof makeAnthropicStreamEmitter>,
  state: AnthropicSseState,
  block: string
): Effect.Effect<AnthropicSseStep, LLMError> => {
  const data = dataFromSseBlock(block)

  if (data === undefined) {
    return Effect.succeed({ state, events: [] })
  }

  return processSseData(emitData, state, data)
}

const processSseBlocks = (
  emitData: ReturnType<typeof makeAnthropicStreamEmitter>,
  state: AnthropicSseState,
  blocks: ReadonlyArray<string>
): Effect.Effect<AnthropicSseStep, LLMError> =>
  Effect.gen(function* () {
    const events: Array<LLMEvent> = []
    let currentState = state

    for (const block of blocks) {
      const step = yield* processSseBlock(emitData, currentState, block)
      currentState = step.state
      events.push(...step.events)
    }

    return { state: currentState, events }
  })

const processBodyChunk = (
  emitData: ReturnType<typeof makeAnthropicStreamEmitter>,
  state: AnthropicBodyState,
  chunk: string
): Effect.Effect<AnthropicSseStep & { readonly bodyState: AnthropicBodyState }, LLMError> =>
  Effect.gen(function* () {
    const buffer = normalizeNewlines(`${state.buffer}${chunk}`)
    const format = state.format === 'undecided' ? classifyAnthropicBody(buffer) : state.format

    if (format !== 'sse') {
      return {
        state: state.sse,
        bodyState: { ...state, format, buffer },
        events: []
      }
    }

    const split = splitCompleteSseBlocks(buffer)
    const step = yield* processSseBlocks(emitData, state.sse, split.completeBlocks)

    return {
      state: step.state,
      bodyState: { format, buffer: split.tail, sse: step.state },
      events: step.events
    }
  })

const finalizeBodyState = (
  emitData: ReturnType<typeof makeAnthropicStreamEmitter>,
  state: AnthropicBodyState,
  decodeToolName: (name: string) => string,
  allowEofCompletion: boolean
): Effect.Effect<ReadonlyArray<LLMEvent>, LLMError> =>
  Effect.gen(function* () {
    const buffer = normalizeNewlines(state.buffer)
    const format = state.format === 'undecided' ? classifyAnthropicBody(buffer) : state.format

    if (format === 'json') {
      return yield* parseAnthropicJsonResponse(buffer, decodeToolName, allowEofCompletion)
    }

    const events: Array<LLMEvent> = []
    let sseState = state.sse

    if (format === 'sse') {
      const split = splitCompleteSseBlocks(buffer)
      const step = yield* processSseBlocks(emitData, sseState, split.completeBlocks)
      sseState = step.state
      events.push(...step.events)

      if (split.tail.trim().length > 0) {
        const tailStep = yield* processSseBlock(emitData, sseState, split.tail)
        sseState = tailStep.state
        events.push(...tailStep.events)
      }
    }

    if (sseState.stopReason === 'max_tokens' || sseState.stopReason === 'content_filter') {
      return yield* Effect.fail(anthropicTerminalError(sseState.stopReason))
    }

    if (!sseState.hasDone) {
      if (!allowEofCompletion) {
        return yield* Effect.fail(
          new LLMError({
            cause: 'invalid_response',
            message: 'Anthropic Messages stream ended without message_stop',
            retryable: false
          })
        )
      }

      events.push(LLMDone.make({ stopReason: sseState.hasToolCall ? 'tool_use' : 'stop' }))
    }

    return events
  })

export const streamAnthropicResponse = (
  response: HttpClientResponse.HttpClientResponse,
  decodeToolName: (name: string) => string = unprefixClaudeToolName,
  allowEofCompletion = true
): Stream.Stream<LLMEvent, LLMError> =>
  Stream.unwrap(
    Ref.make(initialBodyState).pipe(
      Effect.map(bodyStateRef => {
        const emitData = makeAnthropicStreamEmitter(decodeToolName)

        const chunks = response.stream.pipe(
          Stream.mapError(
            toHttpClientLlmError('Could not read Anthropic Claude stream', true, 'stream')
          ),
          Stream.decodeText,
          Stream.mapEffect(chunk =>
            Effect.gen(function* () {
              const state = yield* Ref.get(bodyStateRef)
              const step = yield* processBodyChunk(emitData, state, chunk)
              yield* Ref.set(bodyStateRef, step.bodyState)

              return step.events
            })
          ),
          Stream.flatMap(events => Stream.fromIterable(events))
        )

        const finalEvents = Stream.fromEffect(
          Ref.get(bodyStateRef).pipe(
            Effect.flatMap(state =>
              finalizeBodyState(emitData, state, decodeToolName, allowEofCompletion)
            )
          )
        ).pipe(Stream.flatMap(events => Stream.fromIterable(events)))

        return chunks.pipe(Stream.concat(finalEvents))
      })
    )
  )

const sendAnthropicClaudeRequest = (
  config: AnthropicClaudeProviderConfig,
  request: LLMRequest,
  client: HttpClient.HttpClient,
  sessionId: string
): Effect.Effect<HttpClientResponse.HttpClientResponse, LLMError> =>
  Effect.gen(function* () {
    const body = yield* toAnthropicRequestBody(request, { ...config, stream: true })

    // Replayed transcripts can carry lone surrogates; harden the lowered
    // body so one bad historical string cannot poison every model call.
    const serializedBody = yield* Schema.decodeUnknownEffect(Schema.Json)(
      replaceLoneSurrogatesDeep(body)
    ).pipe(
      Effect.mapError(
        schemaErrorToLlmError('provider_error', 'Could not serialize Anthropic Claude request')
      ),
      Effect.flatMap(json => encodeJsonString(json, 'Could not serialize Anthropic Claude request'))
    )

    const httpRequest = HttpClientRequest.post(
      config.messagesUrl ?? anthropicClaudeMessagesUrl
    ).pipe(
      HttpClientRequest.setHeaders({
        accept: 'text/event-stream',
        ...anthropicClaudeAuthorizationHeaders(config.token),
        'content-type': 'application/json',
        ...makeAnthropicClaudeCompatibilityHeaders({ model: request.model, sessionId }),
        ...config.extraHeaders
      }),
      HttpClientRequest.bodyText(serializedBody, 'application/json')
    )

    const response = yield* client
      .execute(httpRequest)
      .pipe(Effect.mapError(toHttpClientLlmError('Anthropic Claude request failed', true)))

    if (response.status < 200 || response.status >= 300) {
      const errorText = yield* response.text.pipe(
        Effect.mapError(
          error =>
            new LLMError({
              cause: 'provider_error',
              message: `Could not read Anthropic Claude error body: ${error.message}`,
              retryable: false
            })
        )
      )

      const errorInfo = yield* decodeAnthropicHttpErrorInfo(errorText)

      const provider = classifyProviderFailure(
        (() => {
          const fields: AnthropicHttpClassifyFields = {
            provider: anthropicClaudeProvider,
            status: response.status,
            headers: response.headers,
            body: errorText
          }

          if (errorInfo.message !== undefined) {
            fields.message = errorInfo.message
          }

          if (errorInfo.providerCode !== undefined) {
            fields.providerCode = errorInfo.providerCode
          }

          return fields
        })()
      )

      const message =
        errorInfo.message === undefined
          ? `Anthropic Claude returned ${response.status}`
          : `Anthropic Claude returned ${response.status}: ${errorInfo.message}`

      return yield* Effect.fail(
        new LLMError({
          cause: providerFailureCause(provider.kind),
          message,
          retryable: providerFailureRetryable(provider.kind),
          provider
        })
      )
    }

    return response
  }).pipe(Effect.withSpan('AnthropicClaudeProvider.stream'))

export const makeAnthropicClaudeProviderLayer = (config: AnthropicClaudeProviderConfig) =>
  Layer.effect(
    LLMProvider,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const sessionId = makeAnthropicClaudeRequestId()

      return LLMProvider.of({
        stream: request =>
          Stream.fromEffect(sendAnthropicClaudeRequest(config, request, client, sessionId)).pipe(
            Stream.flatMap(response => streamAnthropicResponse(response))
          )
      })
    })
  )
