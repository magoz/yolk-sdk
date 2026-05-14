import { Cause, Effect, Queue, Stream, type Layer } from 'effect'
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpClientError,
  type HttpClientResponse
} from 'effect/unstable/http'
import * as Schema from 'effect/Schema'
import { AgentEvent, AgentWebSocketServerMessage, UserInput } from '@yolk/protocol'
import type {
  AgentEvent as AgentEventType,
  AgentMessage,
  AgentReasoningEffort,
  AgentWebSocketServerMessage as AgentWebSocketServerMessageType,
  UserMessage
} from '@yolk/protocol'
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
  readonly model?: string
  readonly reasoningEffort?: AgentReasoningEffort
  readonly signal?: AbortSignal
  readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient>
  readonly onResponse?: (response: AgentHttpResponseInfo) => void
}

export type StreamAgentRunEventsRequest = {
  readonly endpoint: string
  readonly signal?: AbortSignal
  readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient>
  readonly onResponse?: (response: AgentHttpResponseInfo) => void
}

export type CancelAgentRunRequest = {
  readonly endpoint: string
  readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient>
}

export type AgentHttpResponseInfo = {
  readonly status: number
  readonly headers: Readonly<Record<string, string | undefined>>
}

export type StreamCloudflareAgentEventsRequest = {
  readonly webSocketUrl: string
  readonly messages: AgentTranscript
  readonly model?: string
  readonly reasoningEffort?: AgentReasoningEffort
  readonly signal?: AbortSignal
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

const decodeWebSocketServerMessage = (value: unknown) =>
  Schema.decodeUnknownEffect(AgentWebSocketServerMessage)(value).pipe(
    Effect.mapError(
      error =>
        new AgentTransportError({
          message: `Invalid agent WebSocket message: ${unknownToMessage(error)}`,
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

const parseWebSocketServerMessage = (
  raw: string
): Effect.Effect<AgentWebSocketServerMessageType, AgentTransportError> =>
  Effect.gen(function* () {
    const parsed = yield* decodeJsonString(raw, 'Invalid WebSocket message')

    return yield* decodeWebSocketServerMessage(parsed)
  })

const isUserMessage = (message: AgentMessage): message is UserMessage => message._tag === 'User'

const lastUserMessage = (
  messages: AgentTranscript
): Effect.Effect<UserMessage, AgentTransportError> => {
  const reversed = messages.slice().reverse()
  const message = reversed.find(isUserMessage)

  if (message === undefined) {
    return Effect.fail(
      new AgentTransportError({
        message: 'Cloudflare WebSocket transport requires a user message',
        cause: messages
      })
    )
  }

  return Effect.succeed(message)
}

const makeUserInputJson = (
  request: StreamCloudflareAgentEventsRequest,
  expectedRevision: number
): Effect.Effect<string, AgentTransportError> =>
  lastUserMessage(request.messages).pipe(
    Effect.flatMap(message =>
      encodeJsonString(
        UserInput.make({
          message,
          expectedRevision,
          model: request.model,
          reasoningEffort: request.reasoningEffort
        }),
        'Could not serialize WebSocket user input'
      )
    )
  )

const responseErrorMessage = (response: HttpClientResponse.HttpClientResponse) =>
  response.text.pipe(
    Effect.mapError(toHttpClientTransportError('Could not read agent error body')),
    Effect.map(text => (text.length > 0 ? text : `Request failed with ${response.status}`))
  )

const makeHttpRequest = (request: StreamAgentEventsRequest) =>
  encodeJsonString(
    {
      sessionId: request.sessionId,
      messages: request.messages,
      model: request.model,
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
      yield* Effect.sync(() => request.onResponse?.({ status: response.status, headers: response.headers }))
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

const requestAgentRunResponse = (request: StreamAgentRunEventsRequest) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const response = yield* client
      .execute(
        HttpClientRequest.get(request.endpoint).pipe(
          HttpClientRequest.setHeaders({ accept: 'application/x-ndjson' })
        )
      )
      .pipe(Effect.mapError(toHttpClientTransportError('Agent run request failed')))

    if (response.status >= 200 && response.status < 300) {
      yield* Effect.sync(() => request.onResponse?.({ status: response.status, headers: response.headers }))
      return response
    }

    const message = yield* responseErrorMessage(response)

    return yield* Effect.fail(
      new AgentTransportError({
        message: `Agent run request failed (${response.status}): ${message}`,
        cause: response.status
      })
    )
  })

const cancelAgentRunEffect = (request: CancelAgentRunRequest) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const response = yield* client
      .execute(HttpClientRequest.delete(request.endpoint))
      .pipe(Effect.mapError(toHttpClientTransportError('Agent run cancel failed')))

    if (response.status >= 200 && response.status < 300) {
      return
    }

    const message = yield* responseErrorMessage(response)

    return yield* Effect.fail(
      new AgentTransportError({
        message: `Agent run cancel failed (${response.status}): ${message}`,
        cause: response.status
      })
    )
  }).pipe(Effect.provide(request.httpClientLayer ?? FetchHttpClient.layer))

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

export const streamAgentRunEventStream = (request: StreamAgentRunEventsRequest) =>
  applyAbortSignal(
    Stream.fromEffect(requestAgentRunResponse(request)).pipe(Stream.flatMap(responseToEventStream)),
    request.signal
  ).pipe(Stream.provide(request.httpClientLayer ?? FetchHttpClient.layer))

const isAgentEvent = (message: AgentWebSocketServerMessageType): message is AgentEventType =>
  message._tag !== 'SessionSnapshot'

export const streamCloudflareAgentEventStream = (request: StreamCloudflareAgentEventsRequest) =>
  applyAbortSignal(
    Stream.callback<AgentEventType, AgentTransportError>(queue =>
      Effect.gen(function* () {
        const socket = new WebSocket(request.webSocketUrl)
        let sentInput = false
        let settled = false
        const closeSocket = Effect.sync(() => {
          if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
            socket.close(1000, 'done')
          }
        })
        const failQueue = (error: AgentTransportError) =>
          Queue.failCauseUnsafe(queue, Cause.fail(error))
        const endQueue = () => Queue.endUnsafe(queue)
        const handleMessage = (event: MessageEvent) => {
          if (typeof event.data !== 'string') {
            failQueue(toTransportError('Agent WebSocket returned binary data', event.data))
            return
          }

          Effect.runFork(
            parseWebSocketServerMessage(event.data).pipe(
              Effect.flatMap(message => {
                if (message._tag === 'SessionSnapshot') {
                  return sentInput
                    ? Effect.void
                    : makeUserInputJson(request, message.revision).pipe(
                        Effect.flatMap(body => Effect.sync(() => socket.send(body))),
                        Effect.tap(() =>
                          Effect.sync(() => {
                            sentInput = true
                          })
                        )
                      )
                }

                if (!isAgentEvent(message)) {
                  return Effect.void
                }

                return Effect.sync(() => {
                  Queue.offerUnsafe(queue, message)
                  if (message._tag === 'AgentEnd' || message._tag === 'AgentError') {
                    settled = true
                    endQueue()
                    socket.close(1000, 'done')
                  }
                })
              }),
              Effect.catch(error => Effect.sync(() => failQueue(error)))
            )
          )
        }
        const handleError = () => {
          failQueue(toTransportError('Agent WebSocket failed', request.webSocketUrl))
        }
        const handleClose = () => {
          if (!settled) {
            failQueue(toTransportError('Agent WebSocket closed', request.webSocketUrl))
          }
        }

        yield* Effect.acquireRelease(
          Effect.sync(() => {
            socket.addEventListener('message', handleMessage)
            socket.addEventListener('error', handleError)
            socket.addEventListener('close', handleClose)
          }),
          () =>
            Effect.sync(() => {
              socket.removeEventListener('message', handleMessage)
              socket.removeEventListener('error', handleError)
              socket.removeEventListener('close', handleClose)
            }).pipe(Effect.andThen(closeSocket))
        )
      })
    ),
    request.signal
  )

export async function* streamCloudflareAgentEvents(
  request: StreamCloudflareAgentEventsRequest
): AsyncGenerator<AgentEventType, void, void> {
  for await (const event of Stream.toAsyncIterable(streamCloudflareAgentEventStream(request))) {
    yield event
  }
}

export async function* streamAgentEvents(
  request: StreamAgentEventsRequest
): AsyncGenerator<AgentEventType, void, void> {
  for await (const event of Stream.toAsyncIterable(streamAgentEventStream(request))) {
    yield event
  }
}

export async function* streamAgentRunEvents(
  request: StreamAgentRunEventsRequest
): AsyncGenerator<AgentEventType, void, void> {
  for await (const event of Stream.toAsyncIterable(streamAgentRunEventStream(request))) {
    yield event
  }
}

export const cancelAgentRun = (request: CancelAgentRunRequest) =>
  Effect.runPromise(cancelAgentRunEffect(request))

export const collectAgentEventsEffect = (request: StreamAgentEventsRequest) =>
  streamAgentEventStream(request).pipe(Stream.runCollect)

export const collectAgentEvents = async (request: StreamAgentEventsRequest) =>
  Array.from(await Effect.runPromise(collectAgentEventsEffect(request)))
