import { Effect } from 'effect'
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

const splitBufferedLines = (buffer: string) => {
  const lines = buffer.split('\n')
  const tail = lines.at(-1) ?? ''
  return { completeLines: lines.slice(0, -1), tail }
}

const responseErrorMessage = async (response: Response) => {
  const text = await response.text()
  return text.length > 0 ? text : response.statusText
}

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

export async function* streamAgentEvents(
  request: StreamAgentEventsRequest
): AsyncGenerator<AgentEventType, void, void> {
  const fetcher = request.fetch ?? fetch
  const response = await fetcher(request.endpoint ?? defaultEndpoint, makeRequestInit(request))

  if (!response.ok) {
    throw new AgentTransportError({
      message: `Agent request failed (${response.status}): ${await responseErrorMessage(response)}`,
      cause: response.status
    })
  }

  if (response.body === null) {
    throw new AgentTransportError({
      message: 'Agent response body is empty',
      cause: response.status
    })
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let completed = false

  try {
    while (true) {
      const chunk = await reader.read()

      if (chunk.done) {
        completed = true
        break
      }

      buffer = `${buffer}${decoder.decode(chunk.value, { stream: true })}`
      const { completeLines, tail } = splitBufferedLines(buffer)
      buffer = tail

      for (const line of completeLines) {
        const trimmed = line.trim()
        if (trimmed.length > 0) {
          yield await Effect.runPromise(parseAgentEventLine(trimmed))
        }
      }
    }
  } finally {
    if (!completed) {
      await reader.cancel().catch(() => undefined)
    }

    reader.releaseLock()
  }

  const finalLine = `${buffer}${decoder.decode()}`.trim()

  if (finalLine.length > 0) {
    yield await Effect.runPromise(parseAgentEventLine(finalLine))
  }
}

export const collectAgentEvents = async (request: StreamAgentEventsRequest) => {
  const events: Array<AgentEventType> = []

  for await (const event of streamAgentEvents(request)) {
    events.push(event)
  }

  return events
}
