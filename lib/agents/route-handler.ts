import { Array as Arr, Effect, Option, Stream } from 'effect'
import * as Schema from 'effect/Schema'
import {
  assistantContent,
  contentParts,
  AgentMessage,
  AgentReasoningEffort,
  type AgentEvent,
  type AgentModelCapabilities,
  type ContentPart,
  type ImagePart,
  type AgentReasoningEffort as AgentReasoningEffortType,
  type ToolDef
} from '@yolk/protocol'
import type { AgentLoopError } from '@yolk/agent-loop'
import { runRuntime, runtimeErrorToAgentError, type RuntimeError } from '@yolk/agent-runtime'

export class AgentResponseEncodingError extends Schema.TaggedErrorClass<AgentResponseEncodingError>()(
  'AgentResponseEncodingError',
  {
    message: Schema.String
  }
) {}

export class AgentImageLimitError extends Schema.TaggedErrorClass<AgentImageLimitError>()(
  'AgentImageLimitError',
  {
    message: Schema.String
  }
) {}

const NonEmptyTrimmedString = Schema.Trimmed.pipe(Schema.check(Schema.isNonEmpty()))

const maxImageCount = 4
const maxImageBase64Chars = 5 * 1024 * 1024
const maxTotalImageBase64Chars = 12 * 1024 * 1024
const allowedImageMimeTypes: ReadonlyArray<string> = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

const isAllowedImageMimeType = (mimeType: string) =>
  allowedImageMimeTypes.some(allowedMimeType => allowedMimeType === mimeType)

const isValidBase64 = (data: string) =>
  data.length > 0 && data.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(data)

const messageContentParts = (message: AgentMessage): ReadonlyArray<ContentPart> => {
  switch (message._tag) {
    case 'Assistant':
      return contentParts(assistantContent(message))
    case 'ToolResult':
    case 'User':
      return contentParts(message.content)
  }
}

const requestImageParts = (input: AgentRouteRequest) =>
  Arr.filter(Arr.flatMap(input.messages, messageContentParts), part => part._tag === 'Image')

const imageLimitError = (message: string) => new AgentImageLimitError({ message })

const imagePartLimitError = (image: ImagePart) => {
  if (!isAllowedImageMimeType(image.mimeType)) {
    return Option.some(imageLimitError(`Unsupported image type: ${image.mimeType}`))
  }

  if (image.data.length > maxImageBase64Chars) {
    return Option.some(imageLimitError('Image is too large.'))
  }

  if (!isValidBase64(image.data)) {
    return Option.some(imageLimitError('Invalid image data.'))
  }

  return Option.none<AgentImageLimitError>()
}

const validateAgentRouteImages = (input: AgentRouteRequest) =>
  Effect.gen(function* () {
    const images = requestImageParts(input)
    const totalBase64Chars = Arr.reduce(images, 0, (total, image) => total + image.data.length)

    if (images.length > maxImageCount) {
      return yield* Effect.fail(imageLimitError(`Attach up to ${maxImageCount} images.`))
    }

    if (totalBase64Chars > maxTotalImageBase64Chars) {
      return yield* Effect.fail(imageLimitError('Image payload is too large.'))
    }

    const imageErrors = Arr.flatMap(images, image =>
      Option.match(imagePartLimitError(image), {
        onNone: () => [],
        onSome: error => [error]
      })
    )

    return yield* Option.match(Arr.findFirst(imageErrors, () => true), {
      onNone: () => Effect.void,
      onSome: Effect.fail
    })
  })

export class AgentRouteRequest extends Schema.Class<AgentRouteRequest>('AgentRouteRequest')({
  sessionId: NonEmptyTrimmedString,
  messages: Schema.NonEmptyArray(AgentMessage),
  reasoningEffort: Schema.optional(AgentReasoningEffort)
}) {}

export type AgentRouteConfig = {
  readonly model: string
  readonly systemPrompt: string
  readonly reasoningEffort?: AgentReasoningEffortType
  readonly tools: ReadonlyArray<ToolDef>
  readonly capabilities?: AgentModelCapabilities
}

const ndjsonHeaders = {
  'cache-control': 'no-cache, no-transform',
  'content-type': 'application/x-ndjson; charset=utf-8',
  'x-content-type-options': 'nosniff'
}

const textEncoder = new TextEncoder()

const unknownToMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

type AgentStreamError = AgentLoopError | RuntimeError

const toAgentErrorEvent = (error: AgentStreamError): AgentEvent => runtimeErrorToAgentError(error)

const recoverAgentStreamErrors = <R>(stream: Stream.Stream<AgentEvent, AgentStreamError, R>) =>
  stream.pipe(
    Stream.catchTags({
      LLMError: error => Stream.make(toAgentErrorEvent(error)),
      ToolError: error => Stream.make(toAgentErrorEvent(error)),
      ContextTransformError: error => Stream.make(toAgentErrorEvent(error)),
      AbortError: error => Stream.make(toAgentErrorEvent(error)),
      FauxExhaustedError: error => Stream.make(toAgentErrorEvent(error)),
      SessionNotFoundError: error => Stream.make(toAgentErrorEvent(error)),
      SessionLoadError: error => Stream.make(toAgentErrorEvent(error)),
      SessionSaveError: error => Stream.make(toAgentErrorEvent(error)),
      SessionConflictError: error => Stream.make(toAgentErrorEvent(error))
    })
  )

const encodeNdjsonEvent = (event: AgentEvent) =>
  Schema.encodeUnknownEffect(Schema.UnknownFromJsonString)(event).pipe(
    Effect.mapError(
      error =>
        new AgentResponseEncodingError({
          message: unknownToMessage(error)
        })
    ),
    Effect.map(line => textEncoder.encode(`${line}\n`))
  )

export const makeAgentPostResponse = (input: AgentRouteRequest, config: AgentRouteConfig) =>
  Effect.gen(function* () {
    yield* validateAgentRouteImages(input)

    const body = yield* runRuntime(
      {
        _tag: 'Transcript',
        sessionId: input.sessionId,
        messages: input.messages
      },
      {
        systemPrompt: config.systemPrompt,
        tools: config.tools,
        reasoningEffort: input.reasoningEffort ?? config.reasoningEffort,
        capabilities: config.capabilities,
        model: config.model
      }
    ).pipe(
      recoverAgentStreamErrors,
      Stream.mapEffect(encodeNdjsonEvent),
      Stream.toReadableStreamEffect()
    )

    return new Response(body, { status: 200, headers: ndjsonHeaders })
  }).pipe(Effect.withSpan('AgentRoute.post'))
