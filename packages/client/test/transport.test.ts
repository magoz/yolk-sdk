import { describe, expect, it } from '@effect/vitest'
import { AgentError, AgentStart, LLMTextDelta } from '@yolk/protocol'
import { collectAgentEvents, streamAgentEvents } from '../src'

const encodeEvents = (events: ReadonlyArray<unknown>) =>
  events.map(event => JSON.stringify(event)).join('\n')

describe('collectAgentEvents', () => {
  it('posts a user message and decodes ndjson events', async () => {
    const responseEvents = [AgentStart.make({}), LLMTextDelta.make({ text: 'ok' })]
    const requests: Array<{ readonly input: RequestInfo | URL; readonly init?: RequestInit }> = []
    const fetcher: typeof fetch = (input, init) => {
      requests.push({ input, init })
      return Promise.resolve(new Response(encodeEvents(responseEvents)))
    }

    const events = await collectAgentEvents({
      endpoint: '/api/agent',
      sessionId: 'session_1',
      content: 'hello',
      fetch: fetcher
    })

    expect(requests).toMatchObject([
      {
        input: '/api/agent',
        init: {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: 'session_1', content: 'hello' })
        }
      }
    ])
    expect(events).toEqual(responseEvents)
  })

  it('fails on malformed agent event lines', async () => {
    const fetcher: typeof fetch = () => Promise.resolve(new Response('{"_tag":"Nope"}\n'))

    await expect(
      collectAgentEvents({
        sessionId: 'session_1',
        content: 'hello',
        fetch: fetcher
      })
    ).rejects.toMatchObject({ _tag: 'AgentTransportError' })
  })

  it('decodes in-band agent errors', async () => {
    const responseEvents = [
      AgentError.make({ code: 'provider_error', message: 'Provider failed', retryable: true })
    ]
    const fetcher: typeof fetch = () => Promise.resolve(new Response(encodeEvents(responseEvents)))

    const events = await collectAgentEvents({
      sessionId: 'session_1',
      content: 'hello',
      fetch: fetcher
    })

    expect(events).toEqual(responseEvents)
  })

  it('cancels the response body when event consumption stops', async () => {
    let cancelled = false
    const fetcher: typeof fetch = () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start: controller => {
              controller.enqueue(new TextEncoder().encode(`${JSON.stringify(AgentStart.make({}))}\n`))
            },
            cancel: () => {
              cancelled = true
            }
          })
        )
      )
    const events = streamAgentEvents({ sessionId: 'session_1', content: 'hello', fetch: fetcher })
    const firstEvent = await events.next()

    expect(firstEvent).toMatchObject({ done: false, value: { _tag: 'AgentStart' } })

    await events.return()

    expect(cancelled).toBe(true)
  })
})
