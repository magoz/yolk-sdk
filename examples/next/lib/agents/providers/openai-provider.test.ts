import { Effect, Layer, Redacted, Stream } from 'effect'
import { HttpClient, HttpClientResponse, type HttpClientRequest } from 'effect/unstable/http'
import { describe, expect, it } from '@effect/vitest'
import { ToolDef, UserMessage } from '@yolk-sdk/agent/protocol'
import { LLMProvider } from '@yolk-sdk/agent/loop'
import { makeOpenAiProviderLayer } from '@yolk-sdk/agent/providers/openai/provider'

type CapturedRequest = {
  readonly request: HttpClientRequest.HttpClientRequest
}

const makeProviderLayer = (httpClientLayer: Layer.Layer<HttpClient.HttpClient>) =>
  makeOpenAiProviderLayer({
    apiKey: Redacted.make('test-key'),
    maxCompletionTokens: 123
  }).pipe(Layer.provide(httpClientLayer))

const makeHttpClientLayer = (
  responseBody: unknown,
  requests: Array<CapturedRequest>,
  status = 200
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(request =>
      Effect.sync(() => {
        requests.push({ request })

        return HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(responseBody), {
            status,
            headers: { 'content-type': 'application/json' }
          })
        )
      })
    )
  )

const readCapturedBody = (requests: ReadonlyArray<CapturedRequest>) => {
  const body = requests[0]?.request.body
  expect(body?._tag).toBe('Uint8Array')

  if (body?._tag !== 'Uint8Array') {
    expect.fail('Expected OpenAI request body to be text')
  }

  return JSON.parse(new TextDecoder().decode(body.body))
}

describe('OpenAiProviderLayer', () => {
  it.effect('maps a text-only request to OpenAI chat completions', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      const layer = makeProviderLayer(
        makeHttpClientLayer({ choices: [{ message: { content: 'ok' } }] }, requests)
      )

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

      expect(requests[0]?.request.url).toBe('https://api.openai.com/v1/chat/completions')
      expect(requestBody).toMatchObject({
        model: 'gpt-test',
        messages: [
          { role: 'system', content: 'Be brief.' },
          { role: 'user', content: 'hello' }
        ],
        max_completion_tokens: 123
      })
      expect(Array.from(eventsChunk).map(event => event._tag)).toEqual(['TextDelta', 'Done'])
    })
  )

  it.effect('maps OpenAI function calls to tool call events', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      const layer = makeProviderLayer(
        makeHttpClientLayer(
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
      )

      const eventsChunk = yield* Effect.gen(function* () {
        const provider = yield* LLMProvider
        return yield* provider
          .stream({
            messages: [UserMessage.make({ content: 'weather?' })],
            tools: [ToolDef.make({ name: 'weather', description: 'Get weather.', parameters: {} })],
            model: 'gpt-test',
            systemPrompt: 'Use tools.'
          })
          .pipe(Stream.runCollect)
      }).pipe(Effect.provide(layer))

      const requestBody = readCapturedBody(requests)
      const events = Array.from(eventsChunk)

      expect(requestBody).toMatchObject({
        parallel_tool_calls: true,
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
    })
  )

  it.effect('maps OpenAI usage to canonical usage events', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      const layer = makeProviderLayer(
        makeHttpClientLayer(
          {
            choices: [{ message: { content: 'ok' } }],
            usage: {
              prompt_tokens: 12,
              completion_tokens: 5,
              prompt_tokens_details: { cached_tokens: 4 },
              completion_tokens_details: { reasoning_tokens: 2 }
            }
          },
          requests
        )
      )

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

      const events = Array.from(eventsChunk)
      expect(events.map(event => event._tag)).toEqual(['TextDelta', 'Done', 'Usage'])
      expect(events[2]).toMatchObject({
        usage: {
          input: { total: 12, uncached: 8, cacheRead: 4 },
          output: { total: 5, text: 3, reasoning: 2 }
        }
      })
    })
  )

  it.effect('maps non-OK OpenAI responses to LLM errors', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      const layer = makeProviderLayer(
        makeHttpClientLayer({ error: { message: 'too many requests' } }, requests, 429)
      )

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
    })
  )

  it.effect('rejects OpenAI responses with no choices', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      const layer = makeProviderLayer(makeHttpClientLayer({ choices: [] }, requests))

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
    })
  )
})
