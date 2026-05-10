import { Effect, Layer } from 'effect'
import {
  Headers,
  HttpClient,
  HttpClientResponse,
  type HttpClientRequest
} from 'effect/unstable/http'
import { describe, expect, it } from '@effect/vitest'
import { AgentError, AgentStart, LLMTextDelta, UserMessage } from '@yolk/protocol'
import { appendAgentMessage, collectAgentEvents, streamAgentEvents } from '../src'

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
})
