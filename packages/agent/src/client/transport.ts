import {
  Cause,
  Channel,
  Effect,
  Exit,
  Pull,
  Queue,
  Ref,
  Result,
  Scope,
  Stream,
  type Layer
} from 'effect'
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpClientError,
  type HttpClientResponse
} from 'effect/unstable/http'
import * as Schema from 'effect/Schema'
import {
  AgentEvent,
  AgentWebSocketServerMessage,
  QuestionResponseInput,
  ToolApprovalResponseInput,
  UserInput,
  isTerminalAgentEvent
} from '@yolk-sdk/agent/protocol'
import type {
  AgentEvent as AgentEventType,
  AgentMessage,
  AgentReasoningEffort,
  AgentWebSocketServerMessage as AgentWebSocketServerMessageType,
  HitlResponse,
  QuestionResponse,
  ToolApprovalResponse,
  UserMessage
} from '@yolk-sdk/agent/protocol'
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
  readonly hitlResponses?: ReadonlyArray<HitlResponse>
  readonly model?: string
  readonly reasoningEffort?: AgentReasoningEffort
  readonly signal?: AbortSignal
  readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient>
  readonly onResponse?: (response: AgentHttpResponseInfo) => void
}

export type StreamAgentRunEventsRequest = {
  readonly endpoint: string
  readonly startIndex?: number
  readonly signal?: AbortSignal
  readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient>
  readonly onResponse?: (response: AgentHttpResponseInfo) => void
}

export type StreamAgentRunHitlResponseEventsRequest = {
  readonly endpoint: string
  readonly hitlResponses: ReadonlyArray<HitlResponse>
  readonly signal?: AbortSignal
  readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient>
  readonly onResponse?: (response: AgentHttpResponseInfo) => void
}

export type StreamAgentEventHandler = (event: AgentEventType, count: number) => void

export type AgentRunIdleReconnectOptions = {
  readonly idleTimeoutMs: number
  readonly maxAttempts?: number
}

export type AgentRunContinuationOptions = {
  readonly continuationLimit?: number
  readonly idleReconnect?: AgentRunIdleReconnectOptions
  readonly onEvent?: StreamAgentEventHandler
}

export type StreamAgentEventsUntilTerminalRequest = StreamAgentEventsRequest &
  AgentRunContinuationOptions & {
    readonly runEndpoint?: (runId: string) => string
    readonly onRunId?: (runId: string) => void
  }

export type StreamAgentRunEventsUntilTerminalRequest = StreamAgentRunEventsRequest &
  AgentRunContinuationOptions

export type StreamAgentRunHitlResponseEventsUntilTerminalRequest =
  StreamAgentRunHitlResponseEventsRequest & AgentRunContinuationOptions

export type CancelAgentRunRequest = {
  readonly endpoint: string
  readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient>
}

export type SubmitToolApprovalResponseRequest = StreamAgentEventsRequest & {
  readonly response: ToolApprovalResponse
}

export type SubmitQuestionResponseRequest = StreamAgentEventsRequest & {
  readonly response: QuestionResponse
}

export type AgentHttpResponseInfo = {
  readonly status: number
  readonly headers: Readonly<Record<string, string | undefined>>
}

export type StreamCloudflareAgentEventsRequest = {
  readonly webSocketUrl: string
  readonly messages: AgentTranscript
  readonly hitlResponses?: ReadonlyArray<HitlResponse>
  readonly model?: string
  readonly reasoningEffort?: AgentReasoningEffort
  readonly signal?: AbortSignal
}

const defaultEndpoint = '/api/agent'
const defaultRunContinuationLimit = 120
const defaultIdleReconnectMaxAttempts = 12
const relativeEndpointBase = 'http://yolk.local'

const headerValue = (headers: Readonly<Record<string, string | undefined>>, name: string) => {
  const direct = headers[name]

  if (direct !== undefined) {
    return direct
  }

  const normalizedName = name.toLowerCase()

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === normalizedName) {
      return value
    }
  }

  return undefined
}

const nonEmptyHeaderValue = (
  headers: Readonly<Record<string, string | undefined>>,
  name: string
) => {
  const value = headerValue(headers, name)?.trim()

  return value === undefined || value.length === 0 ? undefined : value
}

const safeIntegerPattern = /^-?(0|[1-9]\d*)$/

const parseSafeInteger = (raw: string) => {
  const value = raw.trim()

  if (!safeIntegerPattern.test(value)) {
    return undefined
  }

  const parsed = Number.parseInt(value, 10)

  return Number.isSafeInteger(parsed) ? parsed : undefined
}

export const agentRunIdFromHeaders = (headers: Readonly<Record<string, string | undefined>>) =>
  nonEmptyHeaderValue(headers, 'x-workflow-run-id')

export const agentRunStreamTailIndexFromHeaders = (
  headers: Readonly<Record<string, string | undefined>>
) => {
  const raw = nonEmptyHeaderValue(headers, 'x-workflow-stream-tail-index')
  if (raw === undefined) return undefined

  const parsed = parseSafeInteger(raw)

  return parsed !== undefined && parsed >= -1 ? parsed : undefined
}

export const agentRunStreamStartIndexFromHeaders = (
  headers: Readonly<Record<string, string | undefined>>
) => {
  const tailIndex = agentRunStreamTailIndexFromHeaders(headers)

  return tailIndex === undefined ? undefined : tailIndex + 1
}

export const agentRunEndpointWithStartIndex = (endpoint: string, startIndex?: number) => {
  if (startIndex === undefined) return endpoint

  validateAgentRunStartIndex(startIndex)

  const parsed = parseEndpointOrThrow(endpoint)
  parsed.url.searchParams.set('startIndex', String(startIndex))

  return serializeEndpoint(parsed)
}

type ParsedEndpoint = {
  readonly url: URL
  readonly absolute: boolean
  readonly leadingSlash: boolean
}

const absoluteUrlPattern = /^[A-Za-z][A-Za-z\d+.-]*:/

const invalidAgentRunEndpointError = (endpoint: string) =>
  new AgentTransportError({
    message: 'Invalid agent run endpoint',
    cause: endpoint
  })

const parseEndpoint = (endpoint: string): ParsedEndpoint | undefined =>
  Result.try(() => ({
    url: new URL(endpoint, relativeEndpointBase),
    absolute: absoluteUrlPattern.test(endpoint),
    leadingSlash: endpoint.startsWith('/')
  })).pipe(
    Result.match({
      onFailure: () => undefined,
      onSuccess: parsed => parsed
    })
  )

const parseEndpointOrThrow = (endpoint: string) => {
  const parsed = parseEndpoint(endpoint)

  if (parsed !== undefined) {
    return parsed
  }

  throw invalidAgentRunEndpointError(endpoint)
}

const parseEndpointEffect = (endpoint: string) => {
  const parsed = parseEndpoint(endpoint)

  return parsed === undefined
    ? Effect.fail(invalidAgentRunEndpointError(endpoint))
    : Effect.succeed(parsed)
}

const serializeEndpoint = (endpoint: ParsedEndpoint) => {
  if (endpoint.absolute) {
    return endpoint.url.toString()
  }

  const serialized = `${endpoint.url.pathname}${endpoint.url.search}${endpoint.url.hash}`

  return endpoint.leadingSlash ? serialized : serialized.slice(1)
}

const appendEncodedPathSegment = (endpoint: string, segment: string) => {
  const parsed = parseEndpointOrThrow(endpoint)

  const basePath = parsed.url.pathname.endsWith('/')
    ? parsed.url.pathname.slice(0, -1)
    : parsed.url.pathname

  parsed.url.pathname = `${basePath}/${encodeURIComponent(segment)}`

  return serializeEndpoint(parsed)
}

const defaultAgentRunEndpoint = (endpoint: string | undefined, runId: string) =>
  appendEncodedPathSegment(endpoint ?? defaultEndpoint, runId)

const invalidAgentRunContinuationLimitError = (limit: number | undefined) =>
  new AgentTransportError({
    message: 'Invalid agent run continuation limit',
    cause: limit
  })

const agentRunContinuationLimitEffect = (limit: number | undefined) => {
  if (limit === undefined) return Effect.succeed(defaultRunContinuationLimit)

  return Number.isSafeInteger(limit) && limit >= 0
    ? Effect.succeed(limit)
    : Effect.fail(invalidAgentRunContinuationLimitError(limit))
}

const invalidIdleReconnectMaxAttemptsError = (limit: number | undefined) =>
  new AgentTransportError({
    message: 'Invalid agent run idle reconnect max attempts',
    cause: limit
  })

const idleReconnectMaxAttemptsEffect = (limit: number | undefined) => {
  if (limit === undefined) return Effect.succeed(defaultIdleReconnectMaxAttempts)

  return Number.isSafeInteger(limit) && limit >= 0
    ? Effect.succeed(limit)
    : Effect.fail(invalidIdleReconnectMaxAttemptsError(limit))
}

const validateAgentRunIdleReconnectEffect = (
  options: AgentRunIdleReconnectOptions | undefined
) => {
  if (options === undefined) return Effect.void

  if (!Number.isSafeInteger(options.idleTimeoutMs) || options.idleTimeoutMs <= 0) {
    return Effect.fail(
      new AgentTransportError({
        message: 'Invalid agent run idle reconnect timeout',
        cause: options.idleTimeoutMs
      })
    )
  }

  return idleReconnectMaxAttemptsEffect(options.maxAttempts).pipe(Effect.asVoid)
}

const validateAgentRunStartIndex = (startIndex: number | undefined) => {
  if (startIndex === undefined || (Number.isSafeInteger(startIndex) && startIndex >= 0)) {
    return
  }

  throw invalidAgentRunStartIndexError(startIndex)
}

const invalidAgentRunStartIndexError = (startIndex: number | undefined) =>
  new AgentTransportError({
    message: 'Invalid agent run stream start index',
    cause: startIndex
  })

const validateAgentRunStartIndexEffect = (startIndex: number | undefined) =>
  startIndex === undefined || (Number.isSafeInteger(startIndex) && startIndex >= 0)
    ? Effect.void
    : Effect.fail(invalidAgentRunStartIndexError(startIndex))

const agentRunEndpointWithStartIndexEffect = (endpoint: string, startIndex: number | undefined) =>
  Effect.gen(function* () {
    if (startIndex === undefined) return endpoint

    yield* validateAgentRunStartIndexEffect(startIndex)

    const parsed = yield* parseEndpointEffect(endpoint)
    parsed.url.searchParams.set('startIndex', String(startIndex))

    return serializeEndpoint(parsed)
  })

const nextAgentRunStartIndex = (startIndex: number | undefined, count: number) =>
  (startIndex ?? 0) + count

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

const makeClientInputJson = (
  request: StreamCloudflareAgentEventsRequest,
  expectedRevision: number
): Effect.Effect<string, AgentTransportError> =>
  Effect.gen(function* () {
    const hitlResponse = request.hitlResponses?.[0]

    if (request.hitlResponses !== undefined && request.hitlResponses.length > 1) {
      return yield* Effect.fail(
        new AgentTransportError({
          message: 'Cloudflare WebSocket transport supports one HITL response at a time',
          cause: request.hitlResponses
        })
      )
    }

    if (hitlResponse === undefined) {
      const message = yield* lastUserMessage(request.messages)

      return yield* encodeJsonString(
        UserInput.make({
          message,
          expectedRevision,
          model: request.model,
          reasoningEffort: request.reasoningEffort
        }),
        'Could not serialize WebSocket user input'
      )
    }

    return yield* encodeJsonString(
      hitlResponse._tag === 'ToolApprovalResponse'
        ? ToolApprovalResponseInput.make({
            response: hitlResponse,
            expectedRevision,
            model: request.model,
            reasoningEffort: request.reasoningEffort
          })
        : QuestionResponseInput.make({
            response: hitlResponse,
            expectedRevision,
            model: request.model,
            reasoningEffort: request.reasoningEffort
          }),
      'Could not serialize WebSocket HITL response'
    )
  })

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
      hitlResponses: request.hitlResponses,
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

const makeHttpRunHitlResponseRequest = (request: StreamAgentRunHitlResponseEventsRequest) =>
  encodeJsonString(
    { hitlResponses: request.hitlResponses },
    'Could not serialize agent run HITL response'
  ).pipe(
    Effect.map(body =>
      HttpClientRequest.post(request.endpoint).pipe(
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
      yield* Effect.sync(() =>
        request.onResponse?.({ status: response.status, headers: response.headers })
      )
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
    const endpoint = yield* agentRunEndpointWithStartIndexEffect(request.endpoint, request.startIndex)

    const client = yield* HttpClient.HttpClient
    const response = yield* client
      .execute(
        HttpClientRequest.get(endpoint).pipe(
          HttpClientRequest.setHeaders({ accept: 'application/x-ndjson' })
        )
      )
      .pipe(Effect.mapError(toHttpClientTransportError('Agent run request failed')))

    if (response.status >= 200 && response.status < 300) {
      yield* Effect.sync(() =>
        request.onResponse?.({ status: response.status, headers: response.headers })
      )
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

const requestAgentRunHitlResponse = (request: StreamAgentRunHitlResponseEventsRequest) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const httpRequest = yield* makeHttpRunHitlResponseRequest(request)
    const response = yield* client
      .execute(httpRequest)
      .pipe(Effect.mapError(toHttpClientTransportError('Agent run HITL request failed')))

    if (response.status >= 200 && response.status < 300) {
      yield* Effect.sync(() =>
        request.onResponse?.({ status: response.status, headers: response.headers })
      )
      return response
    }

    const message = yield* responseErrorMessage(response)

    return yield* Effect.fail(
      new AgentTransportError({
        message: `Agent run HITL request failed (${response.status}): ${message}`,
        cause: response.status
      })
    )
  })

export const cancelAgentRunEffect = (request: CancelAgentRunRequest) =>
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

const responseToLineStream = (response: HttpClientResponse.HttpClientResponse) =>
  response.stream.pipe(
    Stream.mapError(toHttpClientTransportError('Could not read agent response body')),
    Stream.decodeText,
    Stream.splitLines,
    Stream.map(line => line.trim()),
    Stream.filter(line => line.length > 0)
  )

const closeScope = (scope: Scope.Scope) => Scope.close(scope, Exit.succeed(undefined))

// Protocol-terminal events finish the consumer stream, but HTTP bodies must still
// drain to EOF so server runtimes do not observe client-side response aborts.
const responseToEventStream = (response: HttpClientResponse.HttpClientResponse) =>
  Stream.callback<AgentEventType, AgentTransportError>(queue =>
    Effect.gen(function* () {
      const callbackScope = yield* Scope.Scope
      // Own the response stream in a scope that can outlive the consumer after a
      // terminal event; before terminal, consumer cancellation closes it.
      const responseScope = yield* Scope.make()
      const responseScopeClosed = yield* Ref.make(false)
      const terminalReached = yield* Ref.make(false)
      const pull = yield* Channel.toPullScoped(
        Stream.toChannel(responseToLineStream(response)),
        responseScope
      )
      const closeResponseScope = Effect.gen(function* () {
        const closed = yield* Ref.get(responseScopeClosed)

        if (!closed) {
          yield* Ref.set(responseScopeClosed, true)
          yield* closeScope(responseScope)
        }
      })
      const endQueue = Queue.end(queue).pipe(Effect.asVoid)
      const failQueue = (cause: Cause.Cause<AgentTransportError>) =>
        Queue.failCause(queue, cause).pipe(Effect.andThen(closeResponseScope), Effect.asVoid)
      const drainResponse = (): Effect.Effect<void, AgentTransportError> =>
        Pull.matchEffect(pull, {
          onSuccess: () => drainResponse(),
          onFailure: cause => Effect.failCause(cause),
          onDone: () => Effect.void
        })
      const startTerminalDrain = Effect.gen(function* () {
        yield* Ref.set(terminalReached, true)
        yield* endQueue
        yield* drainResponse().pipe(
          Effect.catch(() => Effect.void),
          Effect.ensuring(closeResponseScope),
          Effect.forkDetach({ startImmediately: true }),
          Effect.asVoid
        )
      })
      const emitLines = (lines: ReadonlyArray<string>): Effect.Effect<void, AgentTransportError> =>
        Effect.gen(function* () {
          for (const line of lines) {
            const event = yield* parseAgentEventLine(line)

            yield* Queue.offer(queue, event)

            if (isTerminalAgentEvent(event)) {
              yield* startTerminalDrain
              return
            }
          }

          yield* run()
        })
      const run = (): Effect.Effect<void, AgentTransportError> =>
        Pull.matchEffect(pull, {
          onSuccess: emitLines,
          onFailure: failQueue,
          onDone: () => endQueue.pipe(Effect.andThen(closeResponseScope))
        })

      yield* Scope.addFinalizer(
        callbackScope,
        Effect.gen(function* () {
          const terminal = yield* Ref.get(terminalReached)

          if (!terminal) {
            yield* closeResponseScope
          }
        })
      )

      yield* run().pipe(
        Effect.catch(error => Queue.failCause(queue, Cause.fail(error)).pipe(Effect.asVoid))
      )
    })
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

export const streamAgentRunHitlResponseEventStream = (
  request: StreamAgentRunHitlResponseEventsRequest
) =>
  applyAbortSignal(
    Stream.fromEffect(requestAgentRunHitlResponse(request)).pipe(
      Stream.flatMap(responseToEventStream)
    ),
    request.signal
  ).pipe(Stream.provide(request.httpClientLayer ?? FetchHttpClient.layer))

export const streamToolApprovalResponseEventStream = (request: SubmitToolApprovalResponseRequest) =>
  streamAgentEventStream({ ...request, hitlResponses: [request.response] })

export const streamQuestionResponseEventStream = (request: SubmitQuestionResponseRequest) =>
  streamAgentEventStream({ ...request, hitlResponses: [request.response] })

type AgentEventChunkResult = {
  readonly count: number
  readonly terminal: boolean
  readonly idle: boolean
}

type AgentEventPullResult =
  | { readonly _tag: 'Events'; readonly events: Iterable<AgentEventType> }
  | { readonly _tag: 'Done' }
  | { readonly _tag: 'Idle' }

type AgentRunContinuationInput = AgentRunContinuationOptions & {
  readonly endpoint: string | undefined
  readonly startIndex: number | undefined
  readonly countOffset: number
  readonly terminal: boolean
  readonly signal?: AbortSignal
  readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient>
  readonly onResponse?: (response: AgentHttpResponseInfo) => void
}

const missingAgentRunContinuationEndpointError = () =>
  new AgentTransportError({
    message: 'Agent run continuation failed: missing x-workflow-run-id',
    cause: 'missing_run_id'
  })

const exhaustedAgentRunContinuationLimitError = (limit: number) =>
  new AgentTransportError({
    message: 'Agent run continuation limit reached before a terminal event',
    cause: { limit }
  })

const noProgressAgentRunContinuationError = (endpoint: string, startIndex: number | undefined) =>
  new AgentTransportError({
    message: 'Agent run continuation made no progress before a terminal event',
    cause: { endpoint, startIndex }
  })

const noProgressAgentRunContinuationDelayMs = 250

const idleReconnectLimitReachedError = (limit: number) =>
  new AgentTransportError({
    message: 'Agent run idle reconnect limit reached before a terminal event',
    cause: { limit }
  })

const missingIdleReconnectRunEndpointError = () =>
  new AgentTransportError({
    message: 'Agent run idle reconnect failed: missing x-workflow-run-id',
    cause: 'missing_run_id'
  })

const waitForAgentRunContinuationProgress = (signal: AbortSignal | undefined) => {
  const sleep = Effect.sleep(`${noProgressAgentRunContinuationDelayMs} millis`)

  return signal === undefined ? sleep : sleep.pipe(Effect.raceFirst(abortSignalEffect(signal)))
}

const missingAgentRunTailIndexError = () =>
  new AgentTransportError({
    message: 'Agent run HITL response missing x-workflow-stream-tail-index',
    cause: 'missing_tail_index'
  })

const pullAgentEventChunk = <A extends Iterable<AgentEventType>>(
  pull: Pull.Pull<A, AgentTransportError, void, never>,
  idleReconnect: AgentRunIdleReconnectOptions | undefined
) => {
  const pullEvents: Effect.Effect<AgentEventPullResult, AgentTransportError, never> =
    Pull.matchEffect(pull, {
      onSuccess: events => Effect.succeed({ _tag: 'Events', events }),
      onFailure: cause => Effect.failCause(cause),
      onDone: () => Effect.succeed({ _tag: 'Done' })
    })

  if (idleReconnect === undefined) return pullEvents

  return pullEvents.pipe(
    Effect.raceFirst(
      Effect.sleep(`${idleReconnect.idleTimeoutMs} millis`).pipe(
        Effect.map((): AgentEventPullResult => ({ _tag: 'Idle' }))
      )
    )
  )
}

const drainAgentEventStream = (input: {
  readonly queue: Queue.Enqueue<AgentEventType>
  readonly stream: Stream.Stream<AgentEventType, AgentTransportError, never>
  readonly countOffset: number
  readonly idleReconnect?: AgentRunIdleReconnectOptions
  readonly onEvent?: StreamAgentEventHandler
}): Effect.Effect<AgentEventChunkResult, AgentTransportError, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Scope.make()
    const pull = yield* Channel.toPullScoped(Stream.toChannel(input.stream), scope)
    const run = (state: {
      readonly count: number
      readonly terminal: boolean
    }): Effect.Effect<AgentEventChunkResult, AgentTransportError, never> =>
      Effect.gen(function* () {
        const pulled = yield* pullAgentEventChunk(pull, input.idleReconnect)

        switch (pulled._tag) {
          case 'Idle':
            return { count: state.count, terminal: state.terminal, idle: true }
          case 'Done':
            return { count: state.count, terminal: state.terminal, idle: false }
          case 'Events': {
            let count = state.count
            let terminal = state.terminal

            for (const event of pulled.events) {
              count += 1
              terminal = terminal || isTerminalAgentEvent(event)
              yield* Effect.sync(() => input.onEvent?.(event, input.countOffset + count))
              yield* Queue.offer(input.queue, event)

              if (terminal) return { count, terminal, idle: false }
            }

            return yield* run({ count, terminal })
          }
        }
      })

    return yield* run({ count: 0, terminal: false }).pipe(Effect.ensuring(closeScope(scope)))
  })

const streamAgentRunContinuationChunk = (input: {
  readonly queue: Queue.Enqueue<AgentEventType>
  readonly endpoint: string
  readonly startIndex: number | undefined
  readonly countOffset: number
  readonly signal: AbortSignal | undefined
  readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient>
  readonly onResponse?: (response: AgentHttpResponseInfo) => void
  readonly onEvent?: StreamAgentEventHandler
  readonly idleReconnect?: AgentRunIdleReconnectOptions
}): Effect.Effect<AgentEventChunkResult, AgentTransportError, Scope.Scope> =>
  drainAgentEventStream({
    queue: input.queue,
    stream: streamAgentRunEventStream({
      endpoint: input.endpoint,
      startIndex: input.startIndex,
      signal: input.signal,
      httpClientLayer: input.httpClientLayer,
      onResponse: input.onResponse
    }),
    countOffset: input.countOffset,
    idleReconnect: input.idleReconnect,
    onEvent: input.onEvent
  })

const streamAgentRunContinuations = (
  input: AgentRunContinuationInput,
  queue: Queue.Enqueue<AgentEventType>
): Effect.Effect<void, AgentTransportError, Scope.Scope> =>
  Effect.gen(function* () {
    let totalCount = input.countOffset
    let terminal = input.terminal
    let startIndex = input.startIndex
    const limit = yield* agentRunContinuationLimitEffect(input.continuationLimit)
    const idleReconnectLimit =
      input.idleReconnect === undefined
        ? undefined
        : yield* idleReconnectMaxAttemptsEffect(input.idleReconnect.maxAttempts)
    let idleReconnects = 0

    if (terminal) {
      return
    }

    if (input.endpoint === undefined) {
      return yield* Effect.fail(missingAgentRunContinuationEndpointError())
    }

    let continuation = 0
    while (continuation < limit) {
      const endpoint = input.endpoint
      const chunkStartIndex = startIndex

      const chunk = yield* streamAgentRunContinuationChunk({
        queue,
        endpoint,
        startIndex: chunkStartIndex,
        countOffset: totalCount,
        signal: input.signal,
        httpClientLayer: input.httpClientLayer,
        onResponse: input.onResponse,
        idleReconnect: input.idleReconnect,
        onEvent: input.onEvent
      })

      if (chunk.idle) {
        if (idleReconnectLimit !== undefined && idleReconnects >= idleReconnectLimit) {
          return yield* Effect.fail(idleReconnectLimitReachedError(idleReconnectLimit))
        }

        startIndex = nextAgentRunStartIndex(chunkStartIndex, chunk.count)
        totalCount += chunk.count
        idleReconnects += 1
        continue
      }

      continuation += 1

      if (chunk.count === 0 && !chunk.terminal) {
        if (continuation >= limit) {
          return yield* Effect.fail(noProgressAgentRunContinuationError(endpoint, startIndex))
        }

        yield* waitForAgentRunContinuationProgress(input.signal)
        continue
      }

      terminal = chunk.terminal
      startIndex = nextAgentRunStartIndex(chunkStartIndex, chunk.count)
      totalCount += chunk.count

      if (terminal) {
        return
      }
    }

    return yield* Effect.fail(exhaustedAgentRunContinuationLimitError(limit))
  })

export const streamAgentEventStreamUntilTerminal = (
  request: StreamAgentEventsUntilTerminalRequest
) => {
  return Stream.callback<AgentEventType, AgentTransportError>(queue =>
    Effect.gen(function* () {
      yield* agentRunContinuationLimitEffect(request.continuationLimit).pipe(Effect.asVoid)
      yield* validateAgentRunIdleReconnectEffect(request.idleReconnect)
      let runEndpoint: string | undefined
      let startIndex: number | undefined
      const firstChunk = yield* drainAgentEventStream({
        queue,
        stream: streamAgentEventStream({
          ...request,
          onResponse: response => {
            startIndex = agentRunStreamStartIndexFromHeaders(response.headers)
            const runId = agentRunIdFromHeaders(response.headers)
            if (runId !== undefined) {
              runEndpoint =
                request.runEndpoint?.(runId) ?? defaultAgentRunEndpoint(request.endpoint, runId)
              request.onRunId?.(runId)
            }

            request.onResponse?.(response)
          }
        }),
        countOffset: 0,
        idleReconnect: request.idleReconnect,
        onEvent: request.onEvent
      })

      if (firstChunk.idle && runEndpoint === undefined) {
        return yield* Effect.fail(missingIdleReconnectRunEndpointError())
      }

      yield* streamAgentRunContinuations(
        {
          endpoint: runEndpoint,
          startIndex: nextAgentRunStartIndex(startIndex, firstChunk.count),
          countOffset: firstChunk.count,
          terminal: firstChunk.terminal,
          continuationLimit: request.continuationLimit,
          idleReconnect: request.idleReconnect,
          signal: request.signal,
          httpClientLayer: request.httpClientLayer,
          onResponse: request.onResponse,
          onEvent: request.onEvent
        },
        queue
      )
      yield* Queue.end(queue).pipe(Effect.asVoid)
    }).pipe(
      Effect.catch((error: AgentTransportError) =>
        Queue.failCause(queue, Cause.fail(error)).pipe(Effect.asVoid)
      )
    )
  )
}

export const streamAgentRunEventStreamUntilTerminal = (
  request: StreamAgentRunEventsUntilTerminalRequest
) => {
  return Stream.callback<AgentEventType, AgentTransportError>(queue =>
    Effect.gen(function* () {
      yield* agentRunContinuationLimitEffect(request.continuationLimit).pipe(Effect.asVoid)
      yield* validateAgentRunIdleReconnectEffect(request.idleReconnect)
      yield* validateAgentRunStartIndexEffect(request.startIndex)
      const firstChunk = yield* streamAgentRunContinuationChunk({
        queue,
        endpoint: request.endpoint,
        startIndex: request.startIndex,
        countOffset: 0,
        signal: request.signal,
        httpClientLayer: request.httpClientLayer,
        onResponse: request.onResponse,
        idleReconnect: request.idleReconnect,
        onEvent: request.onEvent
      })

      yield* streamAgentRunContinuations(
        {
          endpoint: request.endpoint,
          startIndex: nextAgentRunStartIndex(request.startIndex, firstChunk.count),
          countOffset: firstChunk.count,
          terminal: firstChunk.terminal,
          continuationLimit: request.continuationLimit,
          idleReconnect: request.idleReconnect,
          signal: request.signal,
          httpClientLayer: request.httpClientLayer,
          onResponse: request.onResponse,
          onEvent: request.onEvent
        },
        queue
      )
      yield* Queue.end(queue).pipe(Effect.asVoid)
    }).pipe(
      Effect.catch((error: AgentTransportError) =>
        Queue.failCause(queue, Cause.fail(error)).pipe(Effect.asVoid)
      )
    )
  )
}

const streamAgentRunHitlResponseInitialChunk = (
  request: StreamAgentRunHitlResponseEventsUntilTerminalRequest,
  queue: Queue.Enqueue<AgentEventType>,
  setStartIndex: (startIndex: number | undefined) => void
): Effect.Effect<AgentEventChunkResult, AgentTransportError, Scope.Scope> =>
  drainAgentEventStream({
    queue,
    stream: streamAgentRunHitlResponseEventStream({
        ...request,
        onResponse: response => {
          setStartIndex(agentRunStreamStartIndexFromHeaders(response.headers))
          request.onResponse?.(response)
        }
      }),
    countOffset: 0,
    idleReconnect: request.idleReconnect,
    onEvent: request.onEvent
  })

export const streamAgentRunHitlResponseEventStreamUntilTerminal = (
  request: StreamAgentRunHitlResponseEventsUntilTerminalRequest
) => {
  return Stream.callback<AgentEventType, AgentTransportError>(queue =>
    Effect.gen(function* () {
      yield* agentRunContinuationLimitEffect(request.continuationLimit).pipe(Effect.asVoid)
      yield* validateAgentRunIdleReconnectEffect(request.idleReconnect)
      let startIndex: number | undefined
      const firstChunk = yield* streamAgentRunHitlResponseInitialChunk(
        request,
        queue,
        nextStartIndex => {
          startIndex = nextStartIndex
        }
      )

      if (!firstChunk.terminal && startIndex === undefined) {
        return yield* Effect.fail(missingAgentRunTailIndexError())
      }

      yield* streamAgentRunContinuations(
        {
          endpoint: request.endpoint,
          startIndex: nextAgentRunStartIndex(startIndex, firstChunk.count),
          countOffset: firstChunk.count,
          terminal: firstChunk.terminal,
          continuationLimit: request.continuationLimit,
          idleReconnect: request.idleReconnect,
          signal: request.signal,
          httpClientLayer: request.httpClientLayer,
          onResponse: request.onResponse,
          onEvent: request.onEvent
        },
        queue
      )
      yield* Queue.end(queue).pipe(Effect.asVoid)
    }).pipe(
      Effect.catch((error: AgentTransportError) =>
        Queue.failCause(queue, Cause.fail(error)).pipe(Effect.asVoid)
      )
    )
  )
}

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
          Effect.runFork(Queue.failCause(queue, Cause.fail(error)).pipe(Effect.asVoid))
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
                    : makeClientInputJson(request, message.revision).pipe(
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

                return Effect.gen(function* () {
                  yield* Queue.offer(queue, message)

                  if (isTerminalAgentEvent(message)) {
                    yield* Effect.sync(() => {
                      settled = true
                      socket.close(1000, 'done')
                    })
                    yield* Queue.end(queue).pipe(Effect.asVoid)
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

export const cancelAgentRun = (request: CancelAgentRunRequest) =>
  Effect.runPromise(cancelAgentRunEffect(request))

export const collectAgentEventsEffect = (request: StreamAgentEventsRequest) =>
  streamAgentEventStream(request).pipe(Stream.runCollect)

export const collectAgentEvents = (request: StreamAgentEventsRequest) =>
  Effect.runPromise(collectAgentEventsEffect(request)).then(events => Array.from(events))
