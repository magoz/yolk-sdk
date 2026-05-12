import { Effect, Layer } from 'effect'
import {
  Headers,
  HttpClient,
  HttpClientResponse,
  type HttpClientRequest
} from 'effect/unstable/http'
import { describe, expect, it } from '@effect/vitest'
import {
  AgentEnd,
  AgentError,
  AgentStart,
  LLMTextDelta,
  SessionSnapshot,
  UserMessage,
  zeroAgentUsage
} from '@yolk/protocol'
import {
  appendAgentMessage,
  collectAgentEvents,
  streamAgentEvents,
  streamCloudflareAgentEvents
} from '../src'

type CapturedRequest = {
  readonly request: HttpClientRequest.HttpClientRequest
}

const encodeEvents = (events: ReadonlyArray<unknown>) =>
  events.map(event => JSON.stringify(event)).join('\n')

const makeHttpClientLayer = (response: Response, requests: Array<CapturedRequest>) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(request =>
      Effect.sync(() => {
        requests.push({ request })

        return HttpClientResponse.fromWeb(request, response)
      })
    )
  )

const readCapturedBody = (requests: ReadonlyArray<CapturedRequest>) => {
  const body = requests[0]?.request.body
  expect(body?._tag).toBe('Uint8Array')

  if (body?._tag !== 'Uint8Array') {
    expect.fail('Expected agent request body to be text')
  }

  return new TextDecoder().decode(body.body)
}

const readCapturedHeaders = (requests: ReadonlyArray<CapturedRequest>) => {
  const headers = requests[0]?.request.headers
  expect(headers).toBeDefined()

  if (headers === undefined) {
    expect.fail('Expected agent request headers')
  }

  return headers
}

describe('collectAgentEvents', () => {
  it('posts a transcript and decodes ndjson events', async () => {
    const responseEvents = [AgentStart.make({}), LLMTextDelta.make({ text: 'ok' })]
    const messages = appendAgentMessage([], UserMessage.make({ content: 'hello' }))
    const requests: Array<CapturedRequest> = []

    const events = await collectAgentEvents({
      endpoint: '/api/agent',
      sessionId: 'session_1',
      messages,
      reasoningEffort: 'high',
      httpClientLayer: makeHttpClientLayer(new Response(encodeEvents(responseEvents)), requests)
    })

    const headers = readCapturedHeaders(requests)
    expect(requests[0]?.request.url).toBe('/api/agent')
    expect(requests[0]?.request.method).toBe('POST')
    expect(Headers.get(headers, 'content-type')).toMatchObject({
      _tag: 'Some',
      value: 'application/json'
    })
    expect(readCapturedBody(requests)).toBe(
      JSON.stringify({ sessionId: 'session_1', messages, reasoningEffort: 'high' })
    )
    expect(events).toEqual(responseEvents)
  })

  it('fails on malformed agent event lines', async () => {
    const requests: Array<CapturedRequest> = []

    await expect(
      collectAgentEvents({
        sessionId: 'session_1',
        messages: appendAgentMessage([], UserMessage.make({ content: 'hello' })),
        httpClientLayer: makeHttpClientLayer(new Response('{"_tag":"Nope"}\n'), requests)
      })
    ).rejects.toMatchObject({ _tag: 'AgentTransportError' })
  })

  it('decodes in-band agent errors', async () => {
    const responseEvents = [
      AgentError.make({ code: 'provider_error', message: 'Provider failed', retryable: true })
    ]
    const requests: Array<CapturedRequest> = []

    const events = await collectAgentEvents({
      sessionId: 'session_1',
      messages: appendAgentMessage([], UserMessage.make({ content: 'hello' })),
      httpClientLayer: makeHttpClientLayer(new Response(encodeEvents(responseEvents)), requests)
    })

    expect(events).toEqual(responseEvents)
  })

  it('cancels the response body when event consumption stops', async () => {
    let cancelled = false
    const requests: Array<CapturedRequest> = []
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start: controller => {
          controller.enqueue(new TextEncoder().encode(`${JSON.stringify(AgentStart.make({}))}\n`))
        },
        cancel: () => {
          cancelled = true
        }
      })
    )
    const events = streamAgentEvents({
      sessionId: 'session_1',
      messages: appendAgentMessage([], UserMessage.make({ content: 'hello' })),
      httpClientLayer: makeHttpClientLayer(response, requests)
    })
    const firstEvent = await events.next()

    expect(firstEvent).toMatchObject({ done: false, value: { _tag: 'AgentStart' } })

    await events.return()

    expect(cancelled).toBe(true)
  })

  it('streams Cloudflare WebSocket events after sending user input with snapshot revision', async () => {
    const originalWebSocket = globalThis.WebSocket
    FakeWebSocket.instances = []
    Object.defineProperty(globalThis, 'WebSocket', { value: FakeWebSocket, configurable: true })

    try {
      const messages = appendAgentMessage([], UserMessage.make({ content: 'hello' }))
      const eventsPromise = collectAsync(
        streamCloudflareAgentEvents({ webSocketUrl: 'wss://worker.example/connect/session_1', messages })
      )

      await waitForSocket()

      const socket = firstSocket()
      socket.emitMessage(SessionSnapshot.make({ revision: 7, messages: [] }))

      await waitForSent(socket)

      socket.emitMessage(AgentStart.make({}))
      socket.emitMessage(
        AgentEnd.make({
          messages: [],
          turns: 1,
          usage: zeroAgentUsage
        })
      )

      const events = await eventsPromise

      expect(socket.sent).toEqual([
        JSON.stringify({
          message: { _tag: 'User', content: 'hello' },
          expectedRevision: 7,
          _tag: 'UserInput'
        })
      ])
      expect(events.map(event => event._tag)).toEqual(['AgentStart', 'AgentEnd'])
      expect(socket.closeCalls).toEqual([{ code: 1000, reason: 'done' }])
    } finally {
      Object.defineProperty(globalThis, 'WebSocket', { value: originalWebSocket, configurable: true })
    }
  })
})

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1

  static instances: Array<FakeWebSocket> = []

  readonly sent: Array<string> = []
  readonly closeCalls: Array<{ readonly code: number | undefined; readonly reason: string | undefined }> = []
  readyState = FakeWebSocket.OPEN
  private readonly listeners = new Map<string, Array<EventListenerOrEventListenerObject>>()

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter(current => current !== listener)
    )
  }

  send(data: string) {
    this.sent.push(data)
  }

  close(code?: number, reason?: string) {
    this.readyState = 3
    this.closeCalls.push({ code, reason })
  }

  emitMessage(value: unknown) {
    this.dispatch(new MessageEvent('message', { data: JSON.stringify(value) }))
  }

  private dispatch(event: Event) {
    for (const listener of this.listeners.get(event.type) ?? []) {
      if (typeof listener === 'function') {
        listener(event)
      } else {
        listener.handleEvent(event)
      }
    }
  }
}

const collectAsync = async <A>(items: AsyncIterable<A>) => {
  const collected: Array<A> = []

  for await (const item of items) {
    collected.push(item)
  }

  return collected
}

const wait = () => new Promise(resolve => setTimeout(resolve, 0))

const waitForSocket = async () => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const socket = FakeWebSocket.instances[0]
    if (socket !== undefined) {
      return socket
    }
    await wait()
  }

  throw new Error('Expected WebSocket instance')
}

const firstSocket = () => {
  const socket = FakeWebSocket.instances[0]
  if (socket === undefined) {
    throw new Error('Expected WebSocket instance')
  }

  return socket
}

const waitForSent = async (socket: FakeWebSocket) => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (socket.sent.length > 0) {
      return
    }
    await wait()
  }

  throw new Error('Expected WebSocket send')
}
