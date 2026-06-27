import { Effect, Layer, Option, Ref, Stream } from 'effect'
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
} from './claude.ts'
import type { OAuthAccessToken } from '@yolk-sdk/agent/oauth'
import {
  classifyProviderFailure,
  providerErrorInfo,
  providerFailureCause,
  providerFailureRetryable
} from '../provider-error.ts'
import { validateProviderTranscript } from '../transcript.ts'

export type AnthropicClaudeProviderConfig = {
  readonly token: OAuthAccessToken
  readonly messagesUrl?: string
  readonly maxTokens?: number
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
  readonly input: unknown
}

type AnthropicToolResultBlock = {
  readonly type: 'tool_result'
  readonly tool_use_id: string
  readonly content: string
  readonly is_error?: boolean
}

type AnthropicUserBlock = AnthropicTextBlock | AnthropicImageBlock | AnthropicDocumentBlock | AnthropicToolResultBlock
type AnthropicAssistantBlock = AnthropicTextBlock | AnthropicToolUseBlock

type AnthropicMessage =
  | { readonly role: 'user'; readonly content: string | ReadonlyArray<AnthropicUserBlock> }
  | { readonly role: 'assistant'; readonly content: ReadonlyArray<AnthropicAssistantBlock> }

type JsonObject = Readonly<Record<string, unknown>>
type TopLevelJsonSchemaCombinatorKey = 'anyOf' | 'oneOf' | 'allOf'
type TopLevelJsonSchemaCombinator = {
  readonly key: TopLevelJsonSchemaCombinatorKey
  readonly items: ReadonlyArray<unknown>
}

type AnthropicTool = {
  readonly name: string
  readonly description: string
  readonly input_schema: unknown
}

type AnthropicRequestBody = {
  readonly model: string
  readonly system: ReadonlyArray<AnthropicSystemBlock>
  readonly messages: ReadonlyArray<AnthropicMessage>
  readonly max_tokens: number
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
const anthropicClaudeMaxTokens = 8192
const anthropicClaudeIdentitySystemBlock: AnthropicSystemBlock = {
  type: 'text',
  text: anthropicClaudeSystemIdentity
}

const randomHex = (byteLength: number) => {
  const crypto = globalThis.crypto
  const bytes = new Uint8Array(byteLength)

  if (crypto !== undefined && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes)
  }

  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

const makeAnthropicClaudeRequestId = () => {
  const crypto = globalThis.crypto

  if (crypto !== undefined && typeof crypto.randomUUID === 'function') {
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
        message: `Could not compute Anthropic Claude OAuth billing header: ${unknownToMessage(error)}`,
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

    if (typeof message.content === 'string') {
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

    if (typeof message.content === 'string') {
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
  input: Schema.Unknown
}) {}

const AnthropicContentResponseBlock = Schema.Union([
  AnthropicTextResponseBlock,
  AnthropicThinkingResponseBlock,
  AnthropicToolUseResponseBlock
])

class AnthropicUsageResponse extends Schema.Class<AnthropicUsageResponse>('AnthropicUsageResponse')({
  input_tokens: Schema.Number,
  output_tokens: Schema.Number,
  cache_read_input_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
  cache_creation_input_tokens: Schema.optional(Schema.NullOr(Schema.Number))
}) {}

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

const unsupportedContentError = (contentType: string) =>
  new LLMError({
    cause: 'provider_error',
    message: `${contentType} content is not supported by the Anthropic Claude provider yet`,
    retryable: false
  })

const imageToAnthropicBlock = (
  part: Extract<ContentPart, { readonly _tag: 'Image' }>
): Effect.Effect<AnthropicImageBlock, LLMError> => {
  switch (part.source._tag) {
    case 'InlineBase64':
      return Effect.succeed({
        type: 'image',
        source: {
          type: 'base64',
          media_type: part.mimeType,
          data: part.source.data
        }
      })
    case 'Url':
      return Effect.succeed({
        type: 'image',
        source: {
          type: 'url',
          url: part.source.url
        }
      })
    case 'Ref':
      return Effect.fail(unsupportedContentError('Unresolved image source'))
  }
}

const pdfDocumentToAnthropicBlock = (
  part: Extract<ContentPart, { readonly _tag: 'Document' }>
): Effect.Effect<AnthropicDocumentBlock, LLMError> => {
  switch (part.source._tag) {
    case 'InlineBase64':
      return Effect.succeed({
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: part.source.data
        },
        title: part.title ?? part.filename
      })
    case 'Url':
      return Effect.succeed({
        type: 'document',
        source: {
          type: 'url',
          url: part.source.url
        },
        title: part.title ?? part.filename
      })
    case 'Ref':
      return Effect.fail(unsupportedContentError('Unresolved document source'))
  }
}

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

const contentPartToUserBlock = (part: ContentPart): Effect.Effect<AnthropicUserBlock, LLMError> => {
  switch (part._tag) {
    case 'Text':
      return Effect.succeed({ type: 'text', text: part.text })
    case 'Image':
      return imageToAnthropicBlock(part)
    case 'Document':
      return isTextDocumentMimeType(part.mimeType)
        ? textDocumentToAnthropicBlock(part)
        : part.mimeType === 'application/pdf'
        ? pdfDocumentToAnthropicBlock(part)
        : Effect.fail(unsupportedContentError(`Document ${part.mimeType}`))
    case 'Audio':
      return Effect.fail(unsupportedContentError('Audio'))
  }
}

const contentToUserContent = (
  content: Content
): Effect.Effect<string | ReadonlyArray<AnthropicUserBlock>, LLMError> =>
  typeof content === 'string' ? Effect.succeed(content) : Effect.forEach(content, contentPartToUserBlock)

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

const toolCallToAnthropicBlock = (call: ToolCall): AnthropicToolUseBlock => ({
  type: 'tool_use',
  id: call.id,
  name: prefixClaudeToolName(call.name),
  input: call.params
})

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const jsonObjectField = (value: JsonObject, key: string) =>
  Object.getOwnPropertyDescriptor(value, key)?.value

const topLevelJsonSchemaCombinatorKeys: ReadonlyArray<TopLevelJsonSchemaCombinatorKey> = [
  'anyOf',
  'oneOf',
  'allOf'
]

const isTopLevelJsonSchemaCombinatorKey = (
  key: string
): key is TopLevelJsonSchemaCombinatorKey => key === 'anyOf' || key === 'oneOf' || key === 'allOf'

const topLevelJsonSchemaCombinator = (
  schema: JsonObject
): TopLevelJsonSchemaCombinator | undefined => {
  for (const key of topLevelJsonSchemaCombinatorKeys) {
    const value = jsonObjectField(schema, key)

    if (Array.isArray(value)) {
      return { key, items: value }
    }
  }

  return undefined
}

const withoutTopLevelJsonSchemaCombinators = (schema: JsonObject): JsonObject =>
  Object.fromEntries(
    Object.entries(schema).filter(([key]) => !isTopLevelJsonSchemaCombinatorKey(key))
  )

const jsonSchemaProperties = (schema: JsonObject) => {
  const properties = jsonObjectField(schema, 'properties')

  return isJsonObject(properties) ? properties : {}
}

const jsonSchemaDefinitions = (schema: JsonObject) => {
  const definitions = jsonObjectField(schema, '$defs')

  return isJsonObject(definitions) ? definitions : {}
}

const jsonSchemaRequired = (schema: JsonObject) => {
  const required = jsonObjectField(schema, 'required')

  return Array.isArray(required) ? required.filter(item => typeof item === 'string') : []
}

const jsonValueKey = (value: unknown) => {
  try {
    return JSON.stringify(value)
  } catch {
    return undefined
  }
}

const uniqueUnknownArray = (items: ReadonlyArray<unknown>): ReadonlyArray<unknown> => {
  const seen = new Set<string>()
  const result: Array<unknown> = []

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

const mergeEnumPropertySchemas = (left: unknown, right: unknown): unknown | undefined => {
  if (!isJsonObject(left) || !isJsonObject(right)) {
    return undefined
  }

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

  return { ...left, ...right, enum: uniqueUnknownArray([...leftEnum, ...rightEnum]) }
}

const jsonSchemaAnyOfItems = (schema: unknown) => {
  if (!isJsonObject(schema)) {
    return [schema]
  }

  const anyOf = jsonObjectField(schema, 'anyOf')

  return Array.isArray(anyOf) ? anyOf : [schema]
}

const mergePropertySchemas = (left: unknown, right: unknown): unknown => {
  const leftKey = jsonValueKey(left)

  if (leftKey !== undefined && leftKey === jsonValueKey(right)) {
    return left
  }

  const mergedEnum = mergeEnumPropertySchemas(left, right)

  if (mergedEnum !== undefined) {
    return mergedEnum
  }

  return { anyOf: uniqueUnknownArray([...jsonSchemaAnyOfItems(left), ...jsonSchemaAnyOfItems(right)]) }
}

const mergeJsonSchemaObjects = (objects: ReadonlyArray<JsonObject>): JsonObject => {
  const merged = new Map<string, unknown>()

  for (const object of objects) {
    for (const [key, value] of Object.entries(object)) {
      if (merged.has(key)) {
        merged.set(key, mergePropertySchemas(merged.get(key), value))
      } else {
        merged.set(key, value)
      }
    }
  }

  return Object.fromEntries(merged)
}

const mergeJsonSchemaRequired = (
  combinatorKey: TopLevelJsonSchemaCombinatorKey,
  objects: ReadonlyArray<JsonObject>
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

const mergeAdditionalProperties = (objects: ReadonlyArray<JsonObject>) => {
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
  schema: JsonObject,
  combinator: TopLevelJsonSchemaCombinator
): JsonObject => {
  const base = withoutTopLevelJsonSchemaCombinators(schema)
  const objectVariants = combinator.items.filter(isJsonObject)
  const additionalProperties = mergeAdditionalProperties(objectVariants)
  const flattened = {
    ...base,
    type: 'object',
    properties: mergeJsonSchemaObjects(objectVariants.map(jsonSchemaProperties)),
    required: mergeJsonSchemaRequired(combinator.key, objectVariants),
    $defs: mergeJsonSchemaObjects([jsonSchemaDefinitions(schema), ...objectVariants.map(jsonSchemaDefinitions)])
  }

  if (additionalProperties === undefined) {
    return flattened
  }

  return { ...flattened, additionalProperties }
}

const anthropicToolInputSchema = (schema: unknown): unknown => {
  if (!isJsonObject(schema)) {
    return {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false
    }
  }

  const combinator = topLevelJsonSchemaCombinator(schema)

  if (combinator !== undefined) {
    return flattenTopLevelCombinatorToolSchema(schema, combinator)
  }

  if (jsonObjectField(schema, 'type') !== undefined) {
    return schema
  }

  return { ...schema, type: 'object' }
}

const toAnthropicMessage = (message: AgentMessage): Effect.Effect<AnthropicMessage, LLMError> =>
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
        const text = yield* contentToText(
          prependMessageContextToContent(assistantContent(message), messageContextText(message)),
          'Assistant'
        )
        const textBlocks: ReadonlyArray<AnthropicTextBlock> =
          text.length === 0 ? [] : [{ type: 'text', text }]
        const toolBlocks = assistantHostToolCalls(message).map(toolCallToAnthropicBlock)
        return { role: 'assistant', content: [...textBlocks, ...toolBlocks] }
      }
      case 'ToolResult':
        return {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: message.toolCallId,
              content: yield* contentToText(
                prependMessageContextToContent(message.content, messageContextText(message)),
                'Tool result'
              ),
              is_error: message.isError
            }
          ]
        }
    }
  })

const toAnthropicTool = (tool: ToolDef): AnthropicTool => ({
  name: prefixClaudeToolName(tool.name),
  description: tool.description,
  input_schema: anthropicToolInputSchema(tool.parameters)
})

export const toAnthropicClaudeRequestBody = (
  request: LLMRequest,
  config?: { readonly maxTokens?: number; readonly stream?: boolean }
): Effect.Effect<AnthropicRequestBody, LLMError> =>
  Effect.gen(function* () {
    yield* validateProviderTranscript(request.messages)
    const rawMessages = yield* Effect.forEach(request.messages, toAnthropicMessage)
    const billingSystemBlock = yield* makeAnthropicClaudeBillingSystemBlock(rawMessages)
    const messages = prependSystemPromptToFirstUserMessage(rawMessages, request.systemPrompt)
    const baseBody = {
      model: request.model,
      system: [billingSystemBlock, anthropicClaudeIdentitySystemBlock],
      messages,
      max_tokens: config?.maxTokens ?? anthropicClaudeMaxTokens
    }
    const body: AnthropicRequestBody =
      config?.stream === true ? { ...baseBody, stream: true } : baseBody

    if (request.tools.length === 0) {
      return body
    }

    return {
      ...body,
      tools: request.tools.map(toAnthropicTool)
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

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null

const field = (value: unknown, key: string) =>
  isRecord(value) ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined

const stringField = (value: unknown, key: string) => {
  const raw = field(value, key)
  return typeof raw === 'string' ? raw : undefined
}

const providerSignalError = (input: {
  readonly message: string
  readonly providerCode?: string
  readonly fallbackKind?: ProviderFailureKind
}) => {
  const provider = classifyProviderFailure({
    provider: anthropicClaudeProvider,
    message: input.message,
    ...(input.providerCode === undefined ? {} : { providerCode: input.providerCode }),
    ...(input.fallbackKind === undefined ? {} : { fallbackKind: input.fallbackKind })
  })

  return new LLMError({
    cause: providerFailureCause(provider.kind),
    message: input.message,
    retryable: providerFailureRetryable(provider.kind),
    provider
  })
}

const numberField = (value: unknown, key: string) => {
  const raw = field(value, key)
  return typeof raw === 'number' ? raw : undefined
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

const parseToolParams = (raw: string) => {
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
  cacheCreationInputTokens:
    usage.cache_creation_input_tokens ?? previous.cacheCreationInputTokens
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

const usageStepFromUnknown = (
  usage: unknown,
  previous: AnthropicUsageComponents
): AnthropicStreamUsageStep => {
  const parsed = Schema.decodeUnknownOption(AnthropicStreamUsageResponse)(usage)

  if (parsed._tag === 'None') {
    return { snapshot: previous, events: [] }
  }

  const value = parsed.value
  const snapshot = nextAnthropicUsageSnapshot(previous, value)
  const delta = anthropicUsageDelta(previous, snapshot)

  return {
    snapshot,
    events: hasAnthropicUsage(delta)
      ? [LLMUsage.make({ usage: toAgentUsageFromComponents(delta) })]
      : []
  }
}

const toLlmEvents = (
  response: AnthropicMessageResponse
): Effect.Effect<ReadonlyArray<LLMEvent>, LLMError> =>
  Effect.gen(function* () {
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
                name: unprefixClaudeToolName(block.name),
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

const decodeAnthropicMessageResponse = (json: unknown) =>
  Schema.decodeUnknownEffect(AnthropicMessageResponse)(json).pipe(
    Effect.mapError(
      error =>
        new LLMError({
          cause: 'invalid_response',
          message: `Invalid Anthropic Claude response: ${unknownToMessage(error)}`,
          retryable: false
        })
    )
  )

const parseAnthropicJsonResponse = (raw: string): Effect.Effect<ReadonlyArray<LLMEvent>, LLMError> =>
  Effect.gen(function* () {
    const json = yield* decodeJsonString(raw, 'Could not parse Anthropic Claude response JSON')
    const parsed = yield* decodeAnthropicMessageResponse(json)

    return yield* toLlmEvents(parsed)
  })

type AnthropicBodyFormat = 'undecided' | 'sse' | 'json'

type AnthropicSseState = {
  readonly hasToolCall: boolean
  readonly hasDone: boolean
  readonly usage: AnthropicUsageComponents
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

const makeAnthropicStreamEmitter = () => {
  const toolBlocks = new Map<number, AnthropicToolBlockState>()

  return (state: AnthropicSseState, data: unknown): Effect.Effect<AnthropicSseStep, LLMError> => {
    const type = stringField(data, 'type')

    if (type === 'message_start') {
      const message = field(data, 'message')
      const step = usageStepFromUnknown(field(message, 'usage'), state.usage)

      return Effect.succeed({ state: { ...state, usage: step.snapshot }, events: step.events })
    }

    if (type === 'content_block_start') {
      const index = numberField(data, 'index')
      const block = field(data, 'content_block')

      if (index !== undefined && stringField(block, 'type') === 'tool_use') {
        const id = stringField(block, 'id')
        const name = stringField(block, 'name')

        if (id === undefined || name === undefined) {
          return Effect.fail(invalidToolUseStartError())
        }

        toolBlocks.set(index, {
          id,
          name: unprefixClaudeToolName(name),
          partialJson: ''
        })
      }

      return Effect.succeed({ state, events: [] })
    }

    if (type === 'content_block_delta') {
      const index = numberField(data, 'index')
      const delta = field(data, 'delta')
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
      const step = usageStepFromUnknown(field(data, 'usage'), state.usage)

      return Effect.succeed({ state: { ...state, usage: step.snapshot }, events: step.events })
    }

    if (type === 'message_stop') {
      return Effect.succeed({
        state: { ...state, hasDone: true },
        events: [LLMDone.make({ stopReason: state.hasToolCall ? 'tool_use' : 'stop' })]
      })
    }

    if (type === 'error') {
      const error = field(data, 'error')
      const providerCode = stringField(error, 'type') ?? stringField(error, 'code')

      return Effect.fail(
        providerSignalError({
          message: stringField(error, 'message') ?? 'Anthropic Claude stream error',
          ...(providerCode === undefined ? {} : { providerCode })
        })
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
  decodeJsonString(data, 'Could not parse Anthropic Claude stream event JSON').pipe(
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
  state: AnthropicBodyState
): Effect.Effect<ReadonlyArray<LLMEvent>, LLMError> =>
  Effect.gen(function* () {
    const buffer = normalizeNewlines(state.buffer)
    const format = state.format === 'undecided' ? classifyAnthropicBody(buffer) : state.format

    if (format === 'json') {
      return yield* parseAnthropicJsonResponse(buffer)
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

    if (!sseState.hasDone) {
      events.push(LLMDone.make({ stopReason: sseState.hasToolCall ? 'tool_use' : 'stop' }))
    }

    return events
  })

export const streamAnthropicClaudeResponse = (
  response: HttpClientResponse.HttpClientResponse
): Stream.Stream<LLMEvent, LLMError> =>
  Stream.unwrap(
    Ref.make(initialBodyState).pipe(
      Effect.map(bodyStateRef => {
        const emitData = makeAnthropicStreamEmitter()
        const chunks = response.stream.pipe(
          Stream.mapError(toHttpClientLlmError('Could not read Anthropic Claude stream', true, 'stream')),
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
          Ref.get(bodyStateRef).pipe(Effect.flatMap(state => finalizeBodyState(emitData, state)))
        ).pipe(
          Stream.flatMap(events => Stream.fromIterable(events))
        )

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
    const body = yield* toAnthropicClaudeRequestBody(request, { ...config, stream: true })
    const serializedBody = yield* encodeJsonString(body, 'Could not serialize Anthropic Claude request')
    const httpRequest = HttpClientRequest.post(config.messagesUrl ?? anthropicClaudeMessagesUrl).pipe(
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

      const provider = classifyProviderFailure({
        provider: anthropicClaudeProvider,
        status: response.status,
        headers: response.headers,
        body: errorText
      })

      return yield* Effect.fail(
        new LLMError({
          cause: providerFailureCause(provider.kind),
          message: `Anthropic Claude returned ${response.status}`,
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
            Stream.flatMap(streamAnthropicClaudeResponse)
          )
      })
    })
  )
