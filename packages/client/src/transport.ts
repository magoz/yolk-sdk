import { Effect, Stream, type Layer } from 'effect'
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpClientError,
  type HttpClientResponse
} from 'effect/unstable/http'
import * as Schema from 'effect/Schema'
import { AgentEvent } from '@yolk/protocol'
import type { AgentEvent as AgentEventType, AgentReasoningEffort } from '@yolk/protocol'
import type { AgentTranscript } from './state.ts'

export class AgentTransportError extends Schema.TaggedErrorClass<AgentTransportError>()(
  'AgentTransportError',
  {
    message: Schema.String,
    cause: Schema.Unknown
  }
) {}

export type StreamAgentEventsRequest = {
  readonly endpoint?: string
  readonly sessionId: string
  readonly messages: AgentTranscript
  readonly reasoningEffort?: AgentReasoningEffort
  readonly signal?: AbortSignal
  readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient>
}

const defaultEndpoint = '/api/agent'

const unknownToMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

const toTransportError = (message: string, cause: unknown) =>
  new AgentTransportError({
    message,
    cause
  })

const toHttpClientTransportError = (message: string) => (error: HttpClientError.HttpClientError) =>
  toTransportError(`${message}: ${error.message}`, error)

const decodeAgentEvent = (value: unknown) =>
  Schema.decodeUnknownEffect(AgentEvent)(value).pipe(
    Effect.mapError(
      error =>
        new AgentTransportError({
          message: `Invalid agent event: ${unknownToMessage(error)}`,
          cause: error
        })
    )
  )

const encodeJsonString = (value: unknown, message: string) =>
  Schema.encodeUnknownEffect(Schema.UnknownFromJsonString)(value).pipe(
    Effect.mapError(
      error =>
        new AgentTransportError({
          message: `${message}: ${unknownToMessage(error)}`,
          cause: error
        })
    )
  )

const decodeJsonString = (raw: string, message: string) =>
  Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(raw).pipe(
    Effect.mapError(
      error =>
        new AgentTransportError({
          message: `${message}: ${unknownToMessage(error)}`,
          cause: error
        })
    )
  )

const parseAgentEventLine = (line: string) =>
  Effect.gen(function* () {
    const parsed = yield* decodeJsonString(line, 'Invalid NDJSON line')

    return yield* decodeAgentEvent(parsed)
  })

const responseErrorMessage = (response: HttpClientResponse.HttpClientResponse) =>
  response.text.pipe(
    Effect.mapError(toHttpClientTransportError('Could not read agent error body')),
    Effect.map(text => (text.length > 0 ? text : `Request failed with ${response.status}`))
  )

const makeHttpRequest = (request: StreamAgentEventsRequest) =>
  encodeJsonString(
    request.reasoningEffort === undefined
      ? { sessionId: request.sessionId, messages: request.messages }
      : {
          sessionId: request.sessionId,
          messages: request.messages,
          reasoningEffort: request.reasoningEffort
        },
    'Could not serialize agent request'
  ).pipe(
    Effect.map(body =>
      HttpClientRequest.post(request.endpoint ?? defaultEndpoint).pipe(
        HttpClientRequest.setHeaders({
          accept: 'application/x-ndjson',
          'content-type': 'application/json'
        }),
        HttpClientRequest.bodyText(body, 'application/json')
      )
    )
  )

const requestAgentResponse = (request: StreamAgentEventsRequest) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const httpRequest = yield* makeHttpRequest(request)
    const response = yield* client
      .execute(httpRequest)
      .pipe(Effect.mapError(toHttpClientTransportError('Agent request failed')))

    if (response.status >= 200 && response.status < 300) {
      return response
    }

    const message = yield* responseErrorMessage(response)

    return yield* Effect.fail(
      new AgentTransportError({
        message: `Agent request failed (${response.status}): ${message}`,
        cause: response.status
      })
    )
  })

const responseToEventStream = (response: HttpClientResponse.HttpClientResponse) =>
  response.stream.pipe(
    Stream.mapError(toHttpClientTransportError('Could not read agent response body')),
    Stream.decodeText,
    Stream.splitLines,
    Stream.map(line => line.trim()),
    Stream.filter(line => line.length > 0),
    Stream.mapEffect(parseAgentEventLine)
  )

const abortSignalError = (signal: AbortSignal) =>
  new AgentTransportError({
    message: 'Agent request aborted',
    cause: signal.reason
  })

const abortSignalEffect = (signal: AbortSignal) =>
  Effect.callback<never, AgentTransportError>(resume => {
    if (signal.aborted) {
      resume(Effect.fail(abortSignalError(signal)))
      return Effect.void
    }

    const listener = () => resume(Effect.fail(abortSignalError(signal)))
    signal.addEventListener('abort', listener, { once: true })

    return Effect.sync(() => signal.removeEventListener('abort', listener))
  })

const applyAbortSignal = <A, E, R>(
  stream: Stream.Stream<A, E, R>,
  signal: AbortSignal | undefined
) => (signal === undefined ? stream : stream.pipe(Stream.interruptWhen(abortSignalEffect(signal))))

export const streamAgentEventStream = (request: StreamAgentEventsRequest) =>
  applyAbortSignal(
    Stream.fromEffect(requestAgentResponse(request)).pipe(Stream.flatMap(responseToEventStream)),
    request.signal
  ).pipe(Stream.provide(request.httpClientLayer ?? FetchHttpClient.layer))

export async function* streamAgentEvents(
  request: StreamAgentEventsRequest
): AsyncGenerator<AgentEventType, void, void> {
  for await (const event of Stream.toAsyncIterable(streamAgentEventStream(request))) {
    yield event
  }
}

export const collectAgentEventsEffect = (request: StreamAgentEventsRequest) =>
  streamAgentEventStream(request).pipe(Stream.runCollect)

export const collectAgentEvents = async (request: StreamAgentEventsRequest) => {
  const events: Array<AgentEventType> = []

  for await (const event of streamAgentEvents(request)) {
    events.push(event)
  }

  return events
}
