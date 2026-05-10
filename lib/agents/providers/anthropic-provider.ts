import { Config, Context, Effect, Layer, Redacted, Stream } from 'effect'
import * as Schema from 'effect/Schema'
import { ToolCall, type AgentMessage, type Content, type ContentPart, type ToolDef } from '@yolk/protocol'
import { LLMError, LLMDone, LLMProvider, LLMTextDelta, LLMToolCall, type LLMEvent, type LLMRequest } from '@yolk/agent-loop'

type AnthropicTextBlock = {
  readonly type: 'text'
  readonly text: string
}

type AnthropicImageBlock = {
  readonly type: 'image'
  readonly source: {
    readonly type: 'base64'
    readonly media_type: string
    readonly data: string
  }
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
}

type AnthropicUserContentBlock = AnthropicTextBlock | AnthropicImageBlock | AnthropicToolResultBlock
type AnthropicAssistantContentBlock = AnthropicTextBlock | AnthropicToolUseBlock
type AnthropicContentBlock = AnthropicUserContentBlock | AnthropicAssistantContentBlock

type AnthropicMessage = {
  readonly role: 'user' | 'assistant'
  readonly content: ReadonlyArray<AnthropicContentBlock>
}

type AnthropicTool = {
  readonly name: string
  readonly description: string
  readonly input_schema: unknown
}

type AnthropicRequestBody = {
  readonly model: string
  readonly max_tokens: number
  readonly system: string
  readonly messages: ReadonlyArray<AnthropicMessage>
  readonly tools?: ReadonlyArray<AnthropicTool>
}

class AnthropicTextResponseBlock extends Schema.Class<AnthropicTextResponseBlock>(
  'AnthropicTextResponseBlock'
)({
  type: Schema.Literals(['text']),
  text: Schema.String
}) {}

class AnthropicToolUseResponseBlock extends Schema.Class<AnthropicToolUseResponseBlock>(
  'AnthropicToolUseResponseBlock'
)({
  type: Schema.Literals(['tool_use']),
  id: Schema.String,
  name: Schema.String,
  input: Schema.Unknown
}) {}

const AnthropicResponseContentBlock = Schema.Union([
  AnthropicTextResponseBlock,
  AnthropicToolUseResponseBlock
])

class AnthropicMessageResponse extends Schema.Class<AnthropicMessageResponse>(
  'AnthropicMessageResponse'
)({
  content: Schema.Array(AnthropicResponseContentBlock)
}) {}

class AnthropicConfig extends Context.Service<
  AnthropicConfig,
  {
    readonly apiKey: Redacted.Redacted<string>
  }
>()('@app/AnthropicConfig') {}

type AnthropicConfigShape = {
  readonly apiKey: Redacted.Redacted<string>
}

const AnthropicConfigLayer = Layer.effect(
  AnthropicConfig,
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted('ANTHROPIC_API_KEY')
    return { apiKey }
  }).pipe(
    Effect.mapError(
      () =>
        new LLMError({
          cause: 'provider_error',
          message: 'ANTHROPIC_API_KEY not found',
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
    message: `${contentType} content is not supported by the Anthropic provider yet`,
    retryable: false
  })

const contentPartToUserBlock = (
  part: ContentPart
): Effect.Effect<AnthropicTextBlock | AnthropicImageBlock, LLMError> => {
  switch (part._tag) {
    case 'Text':
      return Effect.succeed({ type: 'text', text: part.text })
    case 'Image':
      return Effect.succeed({
        type: 'image',
        source: {
          type: 'base64',
          media_type: part.mimeType,
          data: part.data
        }
      })
    case 'Audio':
      return Effect.fail(unsupportedContentError('Audio'))
  }
}

const contentToUserBlocks = (
  content: Content
): Effect.Effect<ReadonlyArray<AnthropicTextBlock | AnthropicImageBlock>, LLMError> =>
  Effect.gen(function* () {
    if (typeof content === 'string') {
      return [{ type: 'text', text: content }]
    }

    const blocks: Array<AnthropicTextBlock | AnthropicImageBlock> = []

    for (const part of content) {
      blocks.push(yield* contentPartToUserBlock(part))
    }

    return blocks
  })

const contentToAssistantTextBlocks = (
  content: Content
): Effect.Effect<ReadonlyArray<AnthropicTextBlock>, LLMError> =>
  Effect.gen(function* () {
    if (typeof content === 'string') {
      return content.length === 0 ? [] : [{ type: 'text', text: content }]
    }

    const blocks: Array<AnthropicTextBlock> = []

    for (const part of content) {
      switch (part._tag) {
        case 'Text':
          if (part.text.length > 0) {
            blocks.push({ type: 'text', text: part.text })
          }
          break
        case 'Image':
          return yield* Effect.fail(unsupportedContentError('Assistant image'))
        case 'Audio':
          return yield* Effect.fail(unsupportedContentError('Assistant audio'))
      }
    }

    return blocks
  })

const contentToPlainText = (content: Content): Effect.Effect<string, LLMError> =>
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
          return yield* Effect.fail(unsupportedContentError('Tool result image'))
        case 'Audio':
          return yield* Effect.fail(unsupportedContentError('Tool result audio'))
      }
    }

    return textParts.join('\n')
  })

const toolCallsToBlocks = (
  message: Extract<AgentMessage, { readonly _tag: 'Assistant' }>
): ReadonlyArray<AnthropicToolUseBlock> =>
  message.toolCalls.map(call => ({
    type: 'tool_use',
    id: call.id,
    name: call.name,
    input: call.params
  }))

const toAnthropicMessage = (message: AgentMessage): Effect.Effect<AnthropicMessage, LLMError> =>
  Effect.gen(function* () {
    switch (message._tag) {
      case 'User':
        return {
          role: 'user',
          content: yield* contentToUserBlocks(message.content)
        }
      case 'Assistant':
        return {
          role: 'assistant',
          content: [...(yield* contentToAssistantTextBlocks(message.content)), ...toolCallsToBlocks(message)]
        }
      case 'ToolResult':
        return {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: message.toolCallId,
              content: yield* contentToPlainText(message.content)
            }
          ]
        }
    }
  })

const toAnthropicTool = (tool: ToolDef): AnthropicTool => ({
  name: tool.name,
  description: tool.description,
  input_schema: tool.parameters
})

const toAnthropicRequestBody = (
  request: LLMRequest
): Effect.Effect<AnthropicRequestBody, LLMError> =>
  Effect.gen(function* () {
    const messages: Array<AnthropicMessage> = []

    for (const message of request.messages) {
      messages.push(yield* toAnthropicMessage(message))
    }

    const body = {
      model: request.model,
      max_tokens: 4096,
      system: request.systemPrompt,
      messages
    }

    if (request.tools.length === 0) {
      return body
    }

    return {
      ...body,
      tools: request.tools.map(toAnthropicTool)
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

const toLlmEvents = (
  blocks: ReadonlyArray<typeof AnthropicResponseContentBlock.Type>
): ReadonlyArray<LLMEvent> => {
  const events: Array<LLMEvent> = []
  let stopReason: 'stop' | 'tool_use' = 'stop'

  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        if (block.text.length > 0) {
          events.push(LLMTextDelta.make({ text: block.text }))
        }
        break
      case 'tool_use':
        stopReason = 'tool_use'
        events.push(
          LLMToolCall.make({
            call: ToolCall.make({ id: block.id, name: block.name, params: block.input })
          })
        )
        break
    }
  }

  events.push(LLMDone.make({ stopReason }))

  return events
}

const sendAnthropicRequest = (
  config: AnthropicConfigShape,
  request: LLMRequest
): Effect.Effect<ReadonlyArray<LLMEvent>, LLMError> =>
  Effect.gen(function* () {
    const body = yield* toAnthropicRequestBody(request)
    const serializedBody = yield* Effect.try({
      try: () => JSON.stringify(body),
      catch: error =>
        new LLMError({
          cause: 'provider_error',
          message: `Could not serialize Anthropic request: ${unknownToMessage(error)}`,
          retryable: false
        })
    })

    const response = yield* Effect.tryPromise({
      try: signal =>
        fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
            'x-api-key': Redacted.value(config.apiKey)
          },
          body: serializedBody,
          signal
        }),
      catch: error =>
        new LLMError({
          cause: 'provider_error',
          message: `Anthropic request failed: ${unknownToMessage(error)}`,
          retryable: true
        })
    })

    if (!response.ok) {
      const errorText = yield* Effect.tryPromise({
        try: () => readText(response),
        catch: error =>
          new LLMError({
            cause: 'provider_error',
            message: `Could not read Anthropic error body: ${unknownToMessage(error)}`,
            retryable: false
          })
      })

      return yield* Effect.fail(
        new LLMError({
          cause: responseStatusToCause(response.status),
          message: `Anthropic returned ${response.status}: ${errorText}`,
          retryable: isRetryableStatus(response.status)
        })
      )
    }

    const json = yield* Effect.tryPromise({
      try: () => parseJson(response),
      catch: error =>
        new LLMError({
          cause: 'invalid_response',
          message: `Could not parse Anthropic response JSON: ${unknownToMessage(error)}`,
          retryable: false
        })
    })
    const parsed = yield* Schema.decodeUnknownEffect(AnthropicMessageResponse)(json).pipe(
      Effect.mapError(
        error =>
          new LLMError({
            cause: 'invalid_response',
            message: `Invalid Anthropic response: ${unknownToMessage(error)}`,
            retryable: false
          })
      )
    )

    return toLlmEvents(parsed.content)
  }).pipe(Effect.withSpan('AnthropicProvider.stream'))

export const AnthropicProviderLayer = Layer.effect(
  LLMProvider,
  Effect.gen(function* () {
    const config = yield* AnthropicConfig

    return LLMProvider.of({
      stream: request =>
        Stream.fromEffect(sendAnthropicRequest(config, request)).pipe(
          Stream.flatMap(events => Stream.fromIterable(events))
        )
    })
  })
).pipe(Layer.provide(AnthropicConfigLayer))
