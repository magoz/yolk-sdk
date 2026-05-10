import { Effect, Stream } from 'effect'
import * as Schema from 'effect/Schema'
import { AgentEvent } from '@yolk/protocol'
import type { AgentEvent as AgentEventType } from '@yolk/protocol'

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
  readonly content: string
  readonly signal?: AbortSignal
  readonly fetch?: typeof fetch
}

const defaultEndpoint = '/api/agent'

const unknownToMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

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

const parseAgentEventLine = (line: string) =>
  Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: (): unknown => JSON.parse(line),
      catch: error =>
        new AgentTransportError({
          message: `Invalid NDJSON line: ${unknownToMessage(error)}`,
          cause: error
        })
    })

    return yield* decodeAgentEvent(parsed)
  })

const responseErrorMessage = (response: Response) =>
  Effect.tryPromise({
    try: () => response.text(),
    catch: error =>
      new AgentTransportError({
        message: `Could not read agent error body: ${unknownToMessage(error)}`,
        cause: error
      })
  }).pipe(Effect.map(text => (text.length > 0 ? text : response.statusText)))

const makeRequestInit = (request: StreamAgentEventsRequest): RequestInit => {
  const base = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: request.sessionId, content: request.content })
  }

  if (request.signal === undefined) {
    return base
  }

  return { ...base, signal: request.signal }
}

const fetchAgentResponse = (request: StreamAgentEventsRequest) => {
  const fetcher = request.fetch ?? fetch

  return Effect.tryPromise({
    try: () => fetcher(request.endpoint ?? defaultEndpoint, makeRequestInit(request)),
    catch: error =>
      new AgentTransportError({
        message: `Agent request failed: ${unknownToMessage(error)}`,
        cause: error
      })
  }).pipe(
    Effect.flatMap(response =>
      response.ok
        ? Effect.succeed(response)
        : responseErrorMessage(response).pipe(
            Effect.flatMap(message =>
              Effect.fail(
                new AgentTransportError({
                  message: `Agent request failed (${response.status}): ${message}`,
                  cause: response.status
                })
              )
            )
          )
    )
  )
}

const responseToEventStream = (response: Response) => {
  const body = response.body

  if (body === null) {
    return Stream.fail(
      new AgentTransportError({
        message: 'Agent response body is empty',
        cause: response.status
      })
    )
  }

  return Stream.fromReadableStream({
    evaluate: () => body,
    onError: error =>
      new AgentTransportError({
        message: `Could not read agent response body: ${unknownToMessage(error)}`,
        cause: error
      })
  }).pipe(
    Stream.decodeText,
    Stream.splitLines,
    Stream.map(line => line.trim()),
    Stream.filter(line => line.length > 0),
    Stream.mapEffect(parseAgentEventLine)
  )
}

export const streamAgentEventStream = (request: StreamAgentEventsRequest) =>
  Stream.fromEffect(fetchAgentResponse(request)).pipe(Stream.flatMap(responseToEventStream))

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
