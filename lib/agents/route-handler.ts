import { Effect, Stream } from 'effect'
import * as Schema from 'effect/Schema'
import {
  AgentError as AgentErrorEvent,
  AgentMessage,
  AgentReasoningEffort,
  type AgentErrorCode,
  type AgentEvent,
  type AgentModelCapabilities,
  type AgentReasoningEffort as AgentReasoningEffortType,
  type ToolDef
} from '@yolk/protocol'
import { run, type AgentLoopError } from '@yolk/agent-loop'

export class AgentResponseEncodingError extends Schema.TaggedErrorClass<AgentResponseEncodingError>()(
  'AgentResponseEncodingError',
  {
    message: Schema.String
  }
) {}

const NonEmptyTrimmedString = Schema.Trimmed.pipe(Schema.check(Schema.isNonEmpty()))

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

type AgentStreamError = AgentLoopError

const toAgentErrorCode = (error: AgentStreamError): AgentErrorCode => {
  switch (error._tag) {
    case 'LLMError':
      return error.cause
    case 'ToolError':
      return 'tool_error'
    case 'AbortError':
      return 'aborted'
    case 'FauxExhaustedError':
      return 'provider_error'
  }
}

const toAgentErrorMessage = (error: AgentStreamError) => {
  switch (error._tag) {
    case 'LLMError':
    case 'ToolError':
    case 'FauxExhaustedError':
      return error.message
    case 'AbortError':
      return `Agent aborted: ${error.reason}`
  }
}

const isAgentErrorRetryable = (error: AgentStreamError) => {
  switch (error._tag) {
    case 'LLMError':
      return error.retryable
    case 'ToolError':
    case 'AbortError':
    case 'FauxExhaustedError':
      return false
  }
}

const toAgentErrorEvent = (error: AgentStreamError): AgentEvent =>
  AgentErrorEvent.make({
    code: toAgentErrorCode(error),
    message: toAgentErrorMessage(error),
    retryable: isAgentErrorRetryable(error)
  })

const recoverAgentStreamErrors = <R>(stream: Stream.Stream<AgentEvent, AgentStreamError, R>) =>
  stream.pipe(
    Stream.catchTags({
      LLMError: error => Stream.make(toAgentErrorEvent(error)),
      ToolError: error => Stream.make(toAgentErrorEvent(error)),
      AbortError: error => Stream.make(toAgentErrorEvent(error)),
      FauxExhaustedError: error => Stream.make(toAgentErrorEvent(error))
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
    const body = yield* run({
      messages: input.messages,
      systemPrompt: config.systemPrompt,
      tools: config.tools,
      reasoningEffort: input.reasoningEffort ?? config.reasoningEffort,
      capabilities: config.capabilities,
      model: config.model
    }).pipe(
      recoverAgentStreamErrors,
      Stream.mapEffect(encodeNdjsonEvent),
      Stream.toReadableStreamEffect()
    )

    return new Response(body, { status: 200, headers: ndjsonHeaders })
  }).pipe(Effect.withSpan('AgentRoute.post'))
