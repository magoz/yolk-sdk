import { Effect, Layer, Stream } from 'effect'
import {
  Headers,
  HttpClient,
  HttpClientResponse,
  type HttpClientRequest
} from 'effect/unstable/http'
import { describe, expect, it } from '@effect/vitest'
import {
  AgentAwaitingInput,
  AgentEnd,
  AgentError,
  AgentStart,
  LLMTextDelta,
  SessionSnapshot,
  ToolApprovalRequest,
  ToolApprovalResponse,
  ToolCall,
  UserMessage,
  zeroAgentUsage
} from '@yolk-sdk/agent/protocol'
import {
  agentRunEndpointWithStartIndex,
  agentRunIdFromHeaders,
  agentRunStreamStartIndexFromHeaders,
  agentRunStreamTailIndexFromHeaders,
  appendAgentMessage,
  cancelAgentRun,
  collectAgentEvents,
  streamAgentEventStreamUntilTerminal,
  streamAgentRunHitlResponseEventStreamUntilTerminal,
  streamAgentRunEventStreamUntilTerminal,
  streamAgentRunHitlResponseEventStream,
  streamAgentRunEventStream,
  streamAgentEventStream,
  streamCloudflareAgentEventStream
} from '../../src/client'

type CapturedRequest = {
  readonly request: HttpClientRequest.HttpClientRequest
}

const encodeEvents = (events: ReadonlyArray<unknown>) =>
  events.map(event => JSON.stringify(event)).join('\n')

const hangingEventResponse = (
  events: ReadonlyArray<unknown>,
  init?: ResponseInit
) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start: controller => {
        controller.enqueue(new TextEncoder().encode(`${encodeEvents(events)}\n`))
      }
    }),
    init
  )

const makeHttpClientLayerFromResponses = (
  responses: ReadonlyArray<Response>,
  requests: Array<CapturedRequest>
) => {
  let index = 0

  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(request =>
      Effect.sync(() => {
        requests.push({ request })
        const response = responses[index]
        index += 1

        if (response === undefined) {
          throw new Error(`No response configured for request ${index}`)
        }

        return HttpClientResponse.fromWeb(request, response)
      })
    )
  )
}

const makeHttpClientLayer = (response: Response, requests: Array<CapturedRequest>) =>
  makeHttpClientLayerFromResponses([response], requests)

const readCapturedBody = (requests: ReadonlyArray<CapturedRequest>, index = 0) => {
  const body = requests[index]?.request.body
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

    const events = await Effect.runPromise(
      collectAgentEvents({
        endpoint: '/api/agent',
        sessionId: 'session_1',
        messages,
        reasoningEffort: 'high',
        httpClientLayer: makeHttpClientLayer(new Response(encodeEvents(responseEvents)), requests)
      })
    )

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
    expect(Array.from(events)).toEqual(responseEvents)
  })

  it('fails on malformed agent event lines', async () => {
    const requests: Array<CapturedRequest> = []

    await expect(
      Effect.runPromise(
        collectAgentEvents({
          sessionId: 'session_1',
          messages: appendAgentMessage([], UserMessage.make({ content: 'hello' })),
          httpClientLayer: makeHttpClientLayer(new Response('{"_tag":"Nope"}\n'), requests)
        })
      )
    ).rejects.toMatchObject({ _tag: 'AgentTransportError' })
  })

  it('decodes in-band agent errors', async () => {
    const responseEvents = [
      AgentError.make({ code: 'provider_error', message: 'Provider failed', retryable: true })
    ]
    const requests: Array<CapturedRequest> = []

    const events = await Effect.runPromise(
      collectAgentEvents({
        sessionId: 'session_1',
        messages: appendAgentMessage([], UserMessage.make({ content: 'hello' })),
        httpClientLayer: makeHttpClientLayer(new Response(encodeEvents(responseEvents)), requests)
      })
    )

    expect(Array.from(events)).toEqual(responseEvents)
  })

  it('reports response headers and streams existing runs', async () => {
    const responseEvents = [AgentStart.make({})]
    const requests: Array<CapturedRequest> = []
    const responses: Array<Readonly<Record<string, string | undefined>>> = []

    const events = await collectEventStream(
      streamAgentRunEventStream({
        endpoint: '/api/agent/workflow/run_1',
        onResponse: response => responses.push(response.headers),
        httpClientLayer: makeHttpClientLayer(
          new Response(encodeEvents(responseEvents), {
            headers: { 'x-workflow-run-id': 'run_1' }
          }),
          requests
        )
      })
    )

    expect(requests[0]?.request.url).toBe('/api/agent/workflow/run_1')
    expect(requests[0]?.request.method).toBe('GET')
    expect(responses[0]?.['x-workflow-run-id']).toBe('run_1')
    expect(events).toEqual(responseEvents)
  })

  it('parses durable run headers and start-index endpoints', () => {
    const headers = {
      'X-Workflow-Run-Id': ' run_1 ',
      'X-Workflow-Stream-Tail-Index': ' 41 '
    }

    expect(agentRunIdFromHeaders(headers)).toBe('run_1')
    expect(agentRunStreamTailIndexFromHeaders(headers)).toBe(41)
    expect(agentRunStreamStartIndexFromHeaders(headers)).toBe(42)
    expect(agentRunStreamTailIndexFromHeaders({ 'x-workflow-stream-tail-index': '-1' })).toBe(-1)
    expect(agentRunStreamStartIndexFromHeaders({ 'x-workflow-stream-tail-index': '-1' })).toBe(0)
    expect(
      agentRunStreamTailIndexFromHeaders({ 'x-workflow-stream-tail-index': '41x' })
    ).toBeUndefined()
    expect(
      agentRunStreamTailIndexFromHeaders({ 'x-workflow-stream-tail-index': '1.5' })
    ).toBeUndefined()
    expect(agentRunIdFromHeaders({ 'x-workflow-run-id': '   ' })).toBeUndefined()
    expect(agentRunEndpointWithStartIndex('/api/agent/run_1', 42)).toBe(
      '/api/agent/run_1?startIndex=42'
    )
    expect(agentRunEndpointWithStartIndex('/api/agent/run_1?debug=1', 42)).toBe(
      '/api/agent/run_1?debug=1&startIndex=42'
    )
    expect(agentRunEndpointWithStartIndex('/api/agent/run_1?startIndex=4', 42)).toBe(
      '/api/agent/run_1?startIndex=42'
    )
    expect(agentRunEndpointWithStartIndex('/api/agent/run_1#events', 42)).toBe(
      '/api/agent/run_1?startIndex=42#events'
    )
    expect(() => agentRunEndpointWithStartIndex('/api/agent/run_1', -1)).toThrow(
      'Invalid agent run stream start index'
    )
  })

  it('continues newly started durable runs until a terminal event', async () => {
    const messages = appendAgentMessage([], UserMessage.make({ content: 'hello' }))
    const requests: Array<CapturedRequest> = []
    const runIds: Array<string> = []
    const seen: Array<string> = []
    const events = await collectEventStream(
      streamAgentEventStreamUntilTerminal({
        endpoint: '/api/agent',
        sessionId: 'session_1',
        messages,
        onRunId: runId => runIds.push(runId),
        onEvent: event => seen.push(event._tag),
        httpClientLayer: makeHttpClientLayerFromResponses(
          [
            new Response(encodeEvents([AgentStart.make({})]), {
              headers: { 'x-workflow-run-id': 'run_1' }
            }),
            new Response(
              encodeEvents([AgentEnd.make({ messages: [], turns: 1, usage: zeroAgentUsage })])
            )
          ],
          requests
        )
      })
    )

    expect(requests.map(item => item.request.url)).toEqual([
      '/api/agent',
      '/api/agent/run_1?startIndex=1'
    ])
    expect(requests.map(item => item.request.method)).toEqual(['POST', 'GET'])
    expect(runIds).toEqual(['run_1'])
    expect(seen).toEqual(['AgentStart', 'AgentEnd'])
    expect(events.map(event => event._tag)).toEqual(['AgentStart', 'AgentEnd'])
  })

  it('continues existing durable runs from the requested start index', async () => {
    const requests: Array<CapturedRequest> = []
    const events = await collectEventStream(
      streamAgentRunEventStreamUntilTerminal({
        endpoint: '/api/agent/run_1',
        startIndex: 4,
        httpClientLayer: makeHttpClientLayerFromResponses(
          [
            new Response(encodeEvents([AgentStart.make({})])),
            new Response(
              encodeEvents([AgentEnd.make({ messages: [], turns: 1, usage: zeroAgentUsage })])
            )
          ],
          requests
        )
      })
    )

    expect(requests.map(item => item.request.url)).toEqual([
      '/api/agent/run_1?startIndex=4',
      '/api/agent/run_1?startIndex=5'
    ])
    expect(requests.map(item => item.request.method)).toEqual(['GET', 'GET'])
    expect(events.map(event => event._tag)).toEqual(['AgentStart', 'AgentEnd'])
  })

  it('reconnects idle existing durable runs from the emitted event count', async () => {
    const requests: Array<CapturedRequest> = []

    const events = await collectEventStream(
      streamAgentRunEventStreamUntilTerminal({
        endpoint: '/api/agent/run_1',
        idleReconnect: { idleTimeoutMs: 250, maxAttempts: 1 },
        httpClientLayer: makeHttpClientLayerFromResponses(
          [
            hangingEventResponse([AgentStart.make({})]),
            new Response(encodeEvents([AgentEnd.make({ messages: [], turns: 1, usage: zeroAgentUsage })]))
          ],
          requests
        )
      })
    )

    expect(requests.map(item => item.request.url)).toEqual([
      '/api/agent/run_1',
      '/api/agent/run_1?startIndex=1'
    ])
    expect(events.map(event => event._tag)).toEqual(['AgentStart', 'AgentEnd'])
  })

  it('reconnects idle newly started durable runs by run id', async () => {
    const messages = appendAgentMessage([], UserMessage.make({ content: 'hello' }))
    const requests: Array<CapturedRequest> = []

    const events = await collectEventStream(
      streamAgentEventStreamUntilTerminal({
        endpoint: '/api/agent',
        sessionId: 'session_1',
        messages,
        idleReconnect: { idleTimeoutMs: 250, maxAttempts: 1 },
        httpClientLayer: makeHttpClientLayerFromResponses(
          [
            hangingEventResponse([AgentStart.make({})], {
              headers: { 'x-workflow-run-id': 'run_1' }
            }),
            new Response(encodeEvents([AgentEnd.make({ messages: [], turns: 1, usage: zeroAgentUsage })]))
          ],
          requests
        )
      })
    )

    expect(requests.map(item => item.request.url)).toEqual([
      '/api/agent',
      '/api/agent/run_1?startIndex=1'
    ])
    expect(events.map(event => event._tag)).toEqual(['AgentStart', 'AgentEnd'])
  })

  it('rejects negative durable run stream start indexes before request', async () => {
    const requests: Array<CapturedRequest> = []

    await expect(
      collectEventStream(
        streamAgentRunEventStream({
          endpoint: '/api/agent/run_1',
          startIndex: -2,
          httpClientLayer: makeHttpClientLayer(
            new Response(encodeEvents([AgentStart.make({})])),
            requests
          )
        })
      )
    ).rejects.toMatchObject({ _tag: 'AgentTransportError' })

    expect(requests).toEqual([])
  })

  it('rejects negative durable run start indexes', async () => {
    const requests: Array<CapturedRequest> = []

    await expect(
      collectEventStream(
        streamAgentRunEventStreamUntilTerminal({
          endpoint: '/api/agent/run_1',
          startIndex: -2,
          httpClientLayer: makeHttpClientLayer(
            new Response(encodeEvents([AgentStart.make({})])),
            requests
          )
        })
      )
    ).rejects.toMatchObject({ _tag: 'AgentTransportError' })

    expect(requests).toEqual([])
  })

  it('posts HITL responses to existing durable runs', async () => {
    const response = ToolApprovalResponse.make({
      requestId: 'approval:call_1',
      toolCallId: 'call_1',
      decision: 'approved',
      source: 'user'
    })
    const requests: Array<CapturedRequest> = []
    const events = await collectEventStream(
      streamAgentRunHitlResponseEventStream({
        endpoint: '/api/agent/run_1',
        hitlResponses: [response],
        httpClientLayer: makeHttpClientLayer(
          new Response(encodeEvents([AgentStart.make({})])),
          requests
        )
      })
    )

    expect(requests[0]?.request.url).toBe('/api/agent/run_1')
    expect(requests[0]?.request.method).toBe('POST')
    expect(readCapturedBody(requests)).toBe(JSON.stringify({ hitlResponses: [response] }))
    expect(events.map(event => event._tag)).toEqual(['AgentStart'])
  })

  it('continues durable HITL resumes from the response tail index', async () => {
    const response = ToolApprovalResponse.make({
      requestId: 'approval:call_1',
      toolCallId: 'call_1',
      decision: 'approved',
      source: 'user'
    })
    const requests: Array<CapturedRequest> = []
    const events = await collectEventStream(
      streamAgentRunHitlResponseEventStreamUntilTerminal({
        endpoint: '/api/agent/run_1',
        hitlResponses: [response],
        httpClientLayer: makeHttpClientLayerFromResponses(
          [
            new Response(encodeEvents([LLMTextDelta.make({ text: 'working' })]), {
              headers: { 'x-workflow-stream-tail-index': '3' }
            }),
            new Response(
              encodeEvents([AgentEnd.make({ messages: [], turns: 1, usage: zeroAgentUsage })])
            )
          ],
          requests
        )
      })
    )

    expect(requests.map(item => item.request.url)).toEqual([
      '/api/agent/run_1',
      '/api/agent/run_1?startIndex=5'
    ])
    expect(requests.map(item => item.request.method)).toEqual(['POST', 'GET'])
    expect(readCapturedBody(requests)).toBe(JSON.stringify({ hitlResponses: [response] }))
    expect(events.map(event => event._tag)).toEqual(['LLMTextDelta', 'AgentEnd'])
  })

  it('keeps polling durable HITL resumes after empty continuation chunks', async () => {
    const response = ToolApprovalResponse.make({
      requestId: 'approval:call_1',
      toolCallId: 'call_1',
      decision: 'approved',
      source: 'user'
    })
    const requests: Array<CapturedRequest> = []
    const events = await collectEventStream(
      streamAgentRunHitlResponseEventStreamUntilTerminal({
        endpoint: '/api/agent/run_1',
        hitlResponses: [response],
        continuationLimit: 2,
        httpClientLayer: makeHttpClientLayerFromResponses(
          [
            new Response('', {
              headers: { 'x-workflow-stream-tail-index': '3' }
            }),
            new Response(''),
            new Response(
              encodeEvents([AgentEnd.make({ messages: [], turns: 1, usage: zeroAgentUsage })])
            )
          ],
          requests
        )
      })
    )

    expect(requests.map(item => item.request.url)).toEqual([
      '/api/agent/run_1',
      '/api/agent/run_1?startIndex=4',
      '/api/agent/run_1?startIndex=4'
    ])
    expect(requests.map(item => item.request.method)).toEqual(['POST', 'GET', 'GET'])
    expect(readCapturedBody(requests)).toBe(JSON.stringify({ hitlResponses: [response] }))
    expect(events.map(event => event._tag)).toEqual(['AgentEnd'])
  })

  it('aborts empty continuation waits before polling again', async () => {
    const controller = new AbortController()
    const requests: Array<CapturedRequest> = []
    const eventsPromise = collectEventStream(
      streamAgentRunEventStreamUntilTerminal({
        endpoint: '/api/agent/run_1',
        continuationLimit: 2,
        signal: controller.signal,
        httpClientLayer: makeHttpClientLayerFromResponses(
          [new Response(encodeEvents([AgentStart.make({})])), new Response('')],
          requests
        )
      })
    )

    await waitForRequestCount(requests, 2)
    controller.abort('stop')

    await expect(
      Promise.race([
        eventsPromise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Timed out waiting for abort')), 100)
        )
      ])
    ).rejects.toMatchObject({ _tag: 'AgentTransportError' })

    expect(requests.map(item => item.request.url)).toEqual([
      '/api/agent/run_1',
      '/api/agent/run_1?startIndex=1'
    ])
  })

  it('rejects non-terminal start responses without a durable run id', async () => {
    const messages = appendAgentMessage([], UserMessage.make({ content: 'hello' }))
    const requests: Array<CapturedRequest> = []

    await expect(
      collectEventStream(
        streamAgentEventStreamUntilTerminal({
          endpoint: '/api/agent',
          sessionId: 'session_1',
          messages,
          httpClientLayer: makeHttpClientLayer(
            new Response(encodeEvents([AgentStart.make({})])),
            requests
          )
        })
      )
    ).rejects.toMatchObject({ _tag: 'AgentTransportError' })
  })

  it('rejects when continuation limit is exhausted before terminal', async () => {
    const requests: Array<CapturedRequest> = []

    await expect(
      collectEventStream(
        streamAgentRunEventStreamUntilTerminal({
          endpoint: '/api/agent/run_1',
          continuationLimit: 1,
          httpClientLayer: makeHttpClientLayerFromResponses(
            [
              new Response(encodeEvents([AgentStart.make({})])),
              new Response(encodeEvents([LLMTextDelta.make({ text: 'still working' })]))
            ],
            requests
          )
        })
      )
    ).rejects.toMatchObject({ _tag: 'AgentTransportError' })

    expect(requests.map(item => item.request.url)).toEqual([
      '/api/agent/run_1',
      '/api/agent/run_1?startIndex=1'
    ])
  })

  it('rejects empty non-terminal continuation chunks', async () => {
    const requests: Array<CapturedRequest> = []

    await expect(
      collectEventStream(
        streamAgentRunEventStreamUntilTerminal({
          endpoint: '/api/agent/run_1',
          continuationLimit: 1,
          httpClientLayer: makeHttpClientLayerFromResponses(
            [new Response(encodeEvents([AgentStart.make({})])), new Response('')],
            requests
          )
        })
      )
    ).rejects.toMatchObject({ _tag: 'AgentTransportError' })

    expect(requests.map(item => item.request.url)).toEqual([
      '/api/agent/run_1',
      '/api/agent/run_1?startIndex=1'
    ])
  })

  it('rejects durable HITL continuations without tail index headers', async () => {
    const response = ToolApprovalResponse.make({
      requestId: 'approval:call_1',
      toolCallId: 'call_1',
      decision: 'approved',
      source: 'user'
    })
    const requests: Array<CapturedRequest> = []

    await expect(
      collectEventStream(
        streamAgentRunHitlResponseEventStreamUntilTerminal({
          endpoint: '/api/agent/run_1',
          hitlResponses: [response],
          httpClientLayer: makeHttpClientLayer(
            new Response(encodeEvents([LLMTextDelta.make({ text: 'working' })])),
            requests
          )
        })
      )
    ).rejects.toMatchObject({ _tag: 'AgentTransportError' })
  })

  it('rejects invalid durable continuation options', async () => {
    const requests: Array<CapturedRequest> = []

    await expect(
      collectEventStream(
        streamAgentRunEventStreamUntilTerminal({
          endpoint: '/api/agent/run_1',
          continuationLimit: 1.5,
          httpClientLayer: makeHttpClientLayer(
            new Response(encodeEvents([AgentStart.make({})])),
            requests
          )
        })
      )
    ).rejects.toMatchObject({ _tag: 'AgentTransportError' })

    expect(requests).toEqual([])
  })

  it('cancels existing runs with DELETE', async () => {
    const requests: Array<CapturedRequest> = []

    await Effect.runPromise(
      cancelAgentRun({
        endpoint: '/api/agent/workflow/run_1',
        httpClientLayer: makeHttpClientLayer(new Response(''), requests)
      })
    )

    expect(requests[0]?.request.url).toBe('/api/agent/workflow/run_1')
    expect(requests[0]?.request.method).toBe('DELETE')
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
    const events = Stream.toAsyncIterable(
      streamAgentEventStream({
        sessionId: 'session_1',
        messages: appendAgentMessage([], UserMessage.make({ content: 'hello' })),
        httpClientLayer: makeHttpClientLayer(response, requests)
      })
    )[Symbol.asyncIterator]()
    const firstEvent = await events.next()

    expect(firstEvent).toMatchObject({ done: false, value: { _tag: 'AgentStart' } })

    const returnEvents = events.return
    if (returnEvents === undefined) {
      throw new Error('Expected async iterator return')
    }

    await returnEvents.call(events)

    expect(cancelled).toBe(true)
  })

  it('drains the response body after a protocol terminal event', async () => {
    let cancelled = false
    let closed = false
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    const requests: Array<CapturedRequest> = []
    const awaitingInput = AgentAwaitingInput.make({
      requests: [
        ToolApprovalRequest.make({
          requestId: 'approval:call_1',
          toolCallId: 'call_1',
          call: ToolCall.make({ id: 'call_1', name: 'write_file', params: {} })
        })
      ],
      messages: [],
      turns: 1,
      usage: zeroAgentUsage
    })
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start: streamController => {
          controller = streamController
          streamController.enqueue(
            new TextEncoder().encode(`${JSON.stringify(AgentStart.make({}))}\n`)
          )
          streamController.enqueue(new TextEncoder().encode(`${JSON.stringify(awaitingInput)}\n`))
        },
        cancel: () => {
          cancelled = true
        }
      })
    )
    const closeResponseBody = () => {
      if (controller === undefined || closed) return

      closed = true
      controller.close()
    }
    const eventsPromise = Effect.runPromise(
      collectAgentEvents({
        sessionId: 'session_1',
        messages: appendAgentMessage([], UserMessage.make({ content: 'hello' })),
        httpClientLayer: makeHttpClientLayer(response, requests)
      })
    )

    try {
      const events = await Promise.race([
        eventsPromise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Timed out waiting for terminal event')), 100)
        )
      ])

      expect(Array.from(events).map(event => event._tag)).toEqual(['AgentStart', 'AgentAwaitingInput'])
      expect(cancelled).toBe(false)
      expect(closed).toBe(false)
    } finally {
      closeResponseBody()
      await eventsPromise.catch(() => undefined)
    }

    expect(cancelled).toBe(false)
  })

  it('streams Cloudflare WebSocket events after sending user input with snapshot revision', async () => {
    const originalWebSocket = globalThis.WebSocket
    FakeWebSocket.instances = []
    Object.defineProperty(globalThis, 'WebSocket', { value: FakeWebSocket, configurable: true })

    try {
      const messages = appendAgentMessage([], UserMessage.make({ content: 'hello' }))
      const eventsPromise = collectEventStream(
        streamCloudflareAgentEventStream({
          webSocketUrl: 'wss://worker.example/connect/session_1',
          messages
        })
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
      Object.defineProperty(globalThis, 'WebSocket', {
        value: originalWebSocket,
        configurable: true
      })
    }
  })
})

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1

  static instances: Array<FakeWebSocket> = []

  readonly sent: Array<string> = []
  readonly closeCalls: Array<{
    readonly code: number | undefined
    readonly reason: string | undefined
  }> = []
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

const collectEventStream = async <A, E>(stream: Stream.Stream<A, E, never>) =>
  Array.from(await Effect.runPromise(stream.pipe(Stream.runCollect)))

const wait = () => new Promise(resolve => setTimeout(resolve, 0))

const waitForRequestCount = async (requests: ReadonlyArray<CapturedRequest>, count: number) => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (requests.length >= count) {
      return
    }

    await wait()
  }

  throw new Error('Expected HTTP request count')
}

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
