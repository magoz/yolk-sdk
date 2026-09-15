import { Cause, Effect, Exit, Layer, Predicate, Redacted, Result, Stream } from 'effect'
import * as Schema from 'effect/Schema'
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

const isJson = Schema.is(Schema.Json)

const makeHttpClientLayer = (
  responseBody: Schema.Json,
  requests: Array<CapturedRequest>,
  status = 200
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(request =>
      Effect.sync(() => {
        requests.push({ request })

        if (!isJson(responseBody)) {
          throw new TypeError('JSON fixture requires a finite JSON value')
        }

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
  it.effect('rejects non-finite JSON fixtures when the fake request executes', () =>
    Effect.gen(function* () {
      for (const body of [Infinity, { n: Infinity }]) {
        const requests: Array<CapturedRequest> = []
        const layer = makeHttpClientLayer(body, requests)
        expect(requests).toHaveLength(0)

        const exit = yield* Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient

          return yield* client.get('https://fixture.invalid')
        }).pipe(Effect.provide(layer), Effect.exit)

        if (Exit.isSuccess(exit)) {
          expect.fail('Expected finite JSON fixture rejection')
        }

        expect(Cause.hasFails(exit.cause)).toBe(false)
        expect(Cause.hasInterrupts(exit.cause)).toBe(false)
        expect(exit.cause.reasons).toHaveLength(1)
        expect(Cause.findDefect(exit.cause)).toEqual(
          Result.succeed(new TypeError('JSON fixture requires a finite JSON value'))
        )
        expect(requests).toHaveLength(1)
      }
    })
  )

  it.effect('serializes fixture values at request time with raw own keys intact', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      const body = { ['__proto__']: { owned: true }, constructor: null, enabled: false, count: 0 }
      const layer = makeHttpClientLayer(body, requests, 418)
      body.count = 2
      expect(requests).toHaveLength(0)

      const response = yield* Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient

        return yield* client.get('https://fixture.invalid')
      }).pipe(Effect.provide(layer))

      const text = yield* response.text
      expect(text).toBe('{"__proto__":{"owned":true},"constructor":null,"enabled":false,"count":2}')
      expect(response.status).toBe(418)
      expect(requests).toHaveLength(1)
      expect(requests[0]?.request).toBe(response.request)
    })
  )

  it.effect('puts admitted extraBody extras on the Chat Completions wire', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []

      const layer = makeOpenAiProviderLayer({
        apiKey: Redacted.make('test-key'),
        maxCompletionTokens: 123,
        extraBody: { models: ['fallback'], extra: null, enabled: false, count: 0 }
      }).pipe(
        Layer.provide(makeHttpClientLayer({ choices: [{ message: { content: 'ok' } }] }, requests))
      )

      yield* Effect.gen(function* () {
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

      expect(readCapturedBody(requests)).toEqual({
        models: ['fallback'],
        extra: null,
        enabled: false,
        count: 0,
        model: 'gpt-test',
        messages: [
          { role: 'system', content: 'Be brief.' },
          { role: 'user', content: 'hello' }
        ],
        max_completion_tokens: 123,
        stream: false
      })
    })
  )

  it.effect('rejects invalid extraBody before sending a Chat Completions request', () =>
    Effect.gen(function* () {
      const secret = 'example-extra-body-secret'
      const requests: Array<CapturedRequest> = []

      const config = {
        apiKey: Redacted.make('test-key'),
        maxCompletionTokens: 123
      }

      Object.assign(config, { extraBody: { extra: () => secret } })

      const layer = makeOpenAiProviderLayer(config).pipe(
        Layer.provide(makeHttpClientLayer({ error: { message: 'unused' } }, requests, 429))
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

      expect(Predicate.isTagged(error, 'LLMError')).toBe(true)
      expect(error).toMatchObject({
        cause: 'provider_error',
        retryable: false,
        message: 'Invalid OpenAI extraBody JSON: expected a JSON object'
      })
      expect(error.message.includes(secret)).toBe(false)
      expect(requests).toHaveLength(0)
    })
  )

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

      expect(Predicate.isTagged(error, 'LLMError')).toBe(true)
      expect(error).toMatchObject({
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

      expect(Predicate.isTagged(error, 'LLMError')).toBe(true)
      expect(error).toMatchObject({
        cause: 'invalid_response',
        message: 'OpenAI response contained no choices',
        retryable: false
      })
    })
  )
})
