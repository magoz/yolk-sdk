import { Effect, Redacted, Stream } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { ToolDef, UserMessage } from '@yolk/protocol'
import { LLMProvider } from '@yolk/agent-loop'
import { makeOpenAiProviderLayer } from './openai-provider'

type CapturedRequest = {
  readonly input: RequestInfo | URL
  readonly init?: RequestInit
}

const makeFetch = (
  responseBody: unknown,
  requests: Array<CapturedRequest>,
  status = 200
): typeof fetch =>
  (input, init) => {
    requests.push({ input, init })
    return Promise.resolve(
      new Response(JSON.stringify(responseBody), {
        status,
        headers: { 'content-type': 'application/json' }
      })
    )
  }

const readCapturedBody = (requests: ReadonlyArray<CapturedRequest>) => {
  const body = requests[0]?.init?.body
  expect(typeof body).toBe('string')

  if (typeof body !== 'string') {
    expect.fail('Expected OpenAI request body to be a string')
  }

  return JSON.parse(body)
}

describe('OpenAiProviderLayer', () => {
  it.effect('maps a text-only request to OpenAI chat completions', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      const layer = makeOpenAiProviderLayer({
        apiKey: Redacted.make('test-key'),
        fetch: makeFetch({ choices: [{ message: { content: 'ok' } }] }, requests)
      })

      const eventsChunk = yield* Effect.gen(function* () {
        const provider = yield* LLMProvider
        return yield* provider
          .stream({
            messages: [UserMessage.make({ content: 'hello' })],
            tools: [],
            model: 'gpt-test',
            systemPrompt: 'Be brief.'
          })
          .pipe(Stream.runCollect)
      }).pipe(Effect.provide(layer))

      const requestBody = readCapturedBody(requests)

      expect(requests[0]?.input).toBe('https://api.openai.com/v1/chat/completions')
      expect(requestBody).toMatchObject({
        model: 'gpt-test',
        messages: [
          { role: 'system', content: 'Be brief.' },
          { role: 'user', content: 'hello' }
        ],
        max_completion_tokens: 4096
      })
      expect(Array.from(eventsChunk).map(event => event._tag)).toEqual(['TextDelta', 'Done'])
    }))

  it.effect('maps OpenAI function calls to tool call events', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      const layer = makeOpenAiProviderLayer({
        apiKey: Redacted.make('test-key'),
        fetch: makeFetch(
          {
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: 'call_1',
                      type: 'function',
                      function: { name: 'weather', arguments: '{"city":"Paris"}' }
                    }
                  ]
                }
              }
            ]
          },
          requests
        )
      })

      const eventsChunk = yield* Effect.gen(function* () {
        const provider = yield* LLMProvider
        return yield* provider
          .stream({
            messages: [UserMessage.make({ content: 'weather?' })],
            tools: [
              ToolDef.make({ name: 'weather', description: 'Get weather.', parameters: {} })
            ],
            model: 'gpt-test',
            systemPrompt: 'Use tools.'
          })
          .pipe(Stream.runCollect)
      }).pipe(Effect.provide(layer))

      const requestBody = readCapturedBody(requests)
      const events = Array.from(eventsChunk)

      expect(requestBody).toMatchObject({
        tools: [
          {
            type: 'function',
            function: { name: 'weather', description: 'Get weather.', parameters: {} }
          }
        ]
      })
      expect(events.map(event => event._tag)).toEqual(['ToolCall', 'Done'])
      expect(events[0]).toMatchObject({
        call: { id: 'call_1', name: 'weather', params: { city: 'Paris' } }
      })
    }))

  it.effect('maps non-OK OpenAI responses to LLM errors', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      const layer = makeOpenAiProviderLayer({
        apiKey: Redacted.make('test-key'),
        fetch: makeFetch({ error: { message: 'too many requests' } }, requests, 429)
      })

      const error = yield* Effect.gen(function* () {
        const provider = yield* LLMProvider
        return yield* provider
          .stream({
            messages: [UserMessage.make({ content: 'hello' })],
            tools: [],
            model: 'gpt-test',
            systemPrompt: 'Be brief.'
          })
          .pipe(Stream.runCollect)
      }).pipe(Effect.provide(layer), Effect.flip)

      expect(error).toMatchObject({
        _tag: 'LLMError',
        cause: 'rate_limit',
        retryable: true
      })
      expect(error.message).toContain('OpenAI returned 429')
    }))

  it.effect('rejects OpenAI responses with no choices', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      const layer = makeOpenAiProviderLayer({
        apiKey: Redacted.make('test-key'),
        fetch: makeFetch({ choices: [] }, requests)
      })

      const error = yield* Effect.gen(function* () {
        const provider = yield* LLMProvider
        return yield* provider
          .stream({
            messages: [UserMessage.make({ content: 'hello' })],
            tools: [],
            model: 'gpt-test',
            systemPrompt: 'Be brief.'
          })
          .pipe(Stream.runCollect)
      }).pipe(Effect.provide(layer), Effect.flip)

      expect(error).toMatchObject({
        _tag: 'LLMError',
        cause: 'invalid_response',
        message: 'OpenAI response contained no choices',
        retryable: false
      })
    }))
})
