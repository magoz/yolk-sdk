import { Effect, Stream } from 'effect'
import * as Schema from 'effect/Schema'
import {
  AgentError as AgentErrorEvent,
  UserMessage,
  type AgentErrorCode,
  type AgentEvent
} from '@yolk/protocol'
import { runRuntime, type RuntimeError } from '@yolk/agent-runtime'
import type { AgentLoopError } from '@yolk/agent-loop'

export class AgentResponseEncodingError extends Schema.TaggedErrorClass<AgentResponseEncodingError>()(
  'AgentResponseEncodingError',
  {
    message: Schema.String
  }
) {}

const NonEmptyTrimmedString = Schema.Trimmed.pipe(Schema.check(Schema.isNonEmpty()))

export class AgentRouteRequest extends Schema.Class<AgentRouteRequest>('AgentRouteRequest')({
  sessionId: NonEmptyTrimmedString,
  content: NonEmptyTrimmedString
}) {}

export type AgentRouteConfig = {
  readonly model: string
  readonly systemPrompt: string
}

const ndjsonHeaders = {
  'cache-control': 'no-cache, no-transform',
  'content-type': 'application/x-ndjson; charset=utf-8',
  'x-content-type-options': 'nosniff'
}

const textEncoder = new TextEncoder()

type AgentStreamError = AgentLoopError | RuntimeError

const toAgentErrorCode = (error: AgentStreamError): AgentErrorCode => {
  switch (error._tag) {
    case 'LLMError':
      return error.cause
    case 'ToolError':
      return 'tool_error'
    case 'AbortError':
      return 'aborted'
    case 'SessionNotFoundError':
      return 'session_not_found'
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
    case 'SessionNotFoundError':
      return `Session not found: ${error.sessionId}`
  }
}

const isAgentErrorRetryable = (error: AgentStreamError) => {
  switch (error._tag) {
    case 'LLMError':
      return error.retryable
    case 'ToolError':
    case 'AbortError':
    case 'SessionNotFoundError':
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
      SessionNotFoundError: error => Stream.make(toAgentErrorEvent(error)),
      FauxExhaustedError: error => Stream.make(toAgentErrorEvent(error))
    })
  )

const encodeNdjsonEvent = (event: AgentEvent) =>
  Effect.try({
    try: () => textEncoder.encode(`${JSON.stringify(event)}\n`),
    catch: error =>
      new AgentResponseEncodingError({
        message: error instanceof Error ? error.message : String(error)
      })
  })

export const makeAgentPostResponse = (input: AgentRouteRequest, config: AgentRouteConfig) =>
  Effect.gen(function* () {
    const body = yield* runRuntime<void>({
      sessionId: input.sessionId,
      input: UserMessage.make({ content: input.content }),
      context: undefined,
      systemPrompt: config.systemPrompt,
      tools: [],
      model: config.model
    }).pipe(recoverAgentStreamErrors, Stream.mapEffect(encodeNdjsonEvent), Stream.toReadableStreamEffect())

    return new Response(body, { status: 200, headers: ndjsonHeaders })
  }).pipe(Effect.withSpan('AgentRoute.post'))
