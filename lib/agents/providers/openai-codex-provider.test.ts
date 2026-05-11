import { Effect, Layer, Option, Stream } from 'effect'
import {
  Headers,
  HttpClient,
  HttpClientResponse,
  type HttpClientRequest
} from 'effect/unstable/http'
import { describe, expect, it } from '@effect/vitest'
import { ImagePart, TextPart, ToolDef, UserMessage } from '@yolk/protocol'
import { LLMProvider } from '@yolk/agent-loop'
import { OPENAI_CODEX_RESPONSES_URL } from '@/lib/services/openai-codex-oauth/live-layer'
import type { OpenAiCodexOAuthToken } from '@/lib/services/openai-codex-oauth/schemas'
import { makeOpenAiCodexProviderLayer } from './openai-codex-provider'

type CapturedRequest = {
  readonly request: HttpClientRequest.HttpClientRequest
}

const token: OpenAiCodexOAuthToken = {
  type: 'oauth',
  refresh: 'refresh-token',
  access: 'access-token',
  expires: Date.now() + 60_000,
  accountId: 'acct_test'
}

const makeProviderLayer = (httpClientLayer: Layer.Layer<HttpClient.HttpClient>) =>
  makeOpenAiCodexProviderLayer({ token }).pipe(Layer.provide(httpClientLayer))

const makeHttpClientLayer = (
  responseBody: unknown,
  requests: Array<CapturedRequest>,
  status = 200
) =>
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

const makeRawHttpClientLayer = (responseBody: string, requests: Array<CapturedRequest>) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(request =>
      Effect.sync(() => {
        requests.push({ request })

        return HttpClientResponse.fromWeb(
          request,
          new Response(responseBody, {
            status: 200,
            headers: { 'content-type': 'text/plain' }
          })
        )
      })
    )
  )

const makeOpenSseHttpClientLayer = (responseChunk: string, requests: Array<CapturedRequest>) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(request =>
      Effect.sync(() => {
        requests.push({ request })

        return HttpClientResponse.fromWeb(
          request,
          new Response(
            new ReadableStream<Uint8Array>({
              start: controller => {
                controller.enqueue(new TextEncoder().encode(responseChunk))
              }
            }),
            {
              status: 200,
              headers: { 'content-type': 'text/plain' }
            }
          )
        )
      })
    )
  )

const makeCancelableOpenSseHttpClientLayer = (input: {
  readonly responseChunk: string
  readonly requests: Array<CapturedRequest>
  readonly onCancel: () => void
}) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(request =>
      Effect.sync(() => {
        input.requests.push({ request })

        return HttpClientResponse.fromWeb(
          request,
          new Response(
            new ReadableStream<Uint8Array>({
              start: controller => {
                controller.enqueue(new TextEncoder().encode(input.responseChunk))
              },
              cancel: () => {
                input.onCancel()
              }
            }),
            {
              status: 200,
              headers: { 'content-type': 'text/plain' }
            }
          )
        )
      })
    )
  )

const readCapturedBody = (requests: ReadonlyArray<CapturedRequest>) => {
  const body = requests[0]?.request.body
  expect(body?._tag).toBe('Uint8Array')

  if (body?._tag !== 'Uint8Array') {
    expect.fail('Expected OpenAI Codex request body to be text')
  }

  return JSON.parse(new TextDecoder().decode(body.body))
}

const readCapturedHeaders = (requests: ReadonlyArray<CapturedRequest>) => {
  const headers = requests[0]?.request.headers
  expect(headers).toBeDefined()

  if (headers === undefined) {
    expect.fail('Expected OpenAI Codex request headers')
  }

  return headers
}

describe('OpenAiCodexProviderLayer', () => {
  it.effect('maps a text request to OpenAI Codex responses', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      const layer = makeProviderLayer(
        makeHttpClientLayer({ output_text: 'ok', output: [] }, requests)
      )

      const eventsChunk = yield* Effect.gen(function* () {
        const provider = yield* LLMProvider
        return yield* provider
          .stream({
            messages: [UserMessage.make({ content: 'hello' })],
            tools: [],
            model: 'gpt-5.4',
            systemPrompt: 'Be brief.'
          })
          .pipe(Stream.runCollect)
      }).pipe(Effect.provide(layer))

      const requestBody = readCapturedBody(requests)
      const headers = readCapturedHeaders(requests)

      expect(requests[0]?.request.url).toBe(OPENAI_CODEX_RESPONSES_URL)
      expect(Option.getOrUndefined(Headers.get(headers, 'authorization'))).toBe(
        'Bearer access-token'
      )
      expect(Option.getOrUndefined(Headers.get(headers, 'ChatGPT-Account-Id'))).toBe('acct_test')
      expect(requestBody).toMatchObject({
        model: 'gpt-5.4',
        instructions: 'Be brief.',
        input: [{ role: 'user', content: 'hello' }],
        store: false,
        stream: true,
        reasoning: { effort: 'low', summary: 'auto' }
      })
      expect(Array.from(eventsChunk).map(event => event._tag)).toEqual(['TextDelta', 'Done'])
    })
  )

  it.effect('maps OpenAI Codex function calls to tool call events', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      const layer = makeProviderLayer(
        makeHttpClientLayer(
          {
            output: [
              {
                type: 'function_call',
                call_id: 'call_1',
                name: 'weather',
                arguments: '{"city":"Paris"}'
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
            model: 'gpt-5.4',
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
            name: 'weather',
            description: 'Get weather.',
            parameters: {}
          }
        ]
      })
      expect(events.map(event => event._tag)).toEqual(['ToolCall', 'Done'])
      expect(events[0]).toMatchObject({
        call: { id: 'call_1', name: 'weather', params: { city: 'Paris' } }
      })
    })
  )

  it.effect('maps image user content to OpenAI Codex responses input', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      const layer = makeProviderLayer(
        makeHttpClientLayer({ output_text: 'ok', output: [] }, requests)
      )

      yield* Effect.gen(function* () {
        const provider = yield* LLMProvider
        return yield* provider
          .stream({
            messages: [
              UserMessage.make({
                content: [
                  TextPart.make({ text: 'Describe this image' }),
                  ImagePart.make({ data: 'abc', mimeType: 'image/png' })
                ]
              })
            ],
            tools: [],
            model: 'gpt-5.5',
            systemPrompt: 'Be brief.'
          })
          .pipe(Stream.runCollect)
      }).pipe(Effect.provide(layer))

      expect(readCapturedBody(requests)).toMatchObject({
        input: [
          {
            role: 'user',
            content: [
              { type: 'input_text', text: 'Describe this image' },
              { type: 'input_image', image_url: 'data:image/png;base64,abc' }
            ]
          }
        ]
      })
    })
  )

  it.effect('parses streamed OpenAI Codex function calls before completion', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      const layer = makeProviderLayer(
        makeRawHttpClientLayer(
          [
            'event: response.output_item.done',
            'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"web_search","arguments":"{\\"query\\":\\"magoz.com\\"}","status":"completed"}}',
            '',
            'event: response.completed',
            'data: {"type":"response.completed","response":{"output":[]}}',
            ''
          ].join('\n'),
          requests
        )
      )

      const eventsChunk = yield* Effect.gen(function* () {
        const provider = yield* LLMProvider
        return yield* provider
          .stream({
            messages: [UserMessage.make({ content: 'what is magoz.com about?' })],
            tools: [
              ToolDef.make({ name: 'web_search', description: 'Search web.', parameters: {} })
            ],
            model: 'gpt-5.4',
            systemPrompt: 'Use tools.'
          })
          .pipe(Stream.runCollect)
      }).pipe(Effect.provide(layer))

      const events = Array.from(eventsChunk)
      expect(events.map(event => event._tag)).toEqual(['ToolCall', 'Done'])
      expect(events[0]).toMatchObject({
        call: { id: 'call_1', name: 'web_search', params: { query: 'magoz.com' } }
      })
    })
  )

  it.effect('passes custom reasoning effort to OpenAI Codex', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      const layer = makeProviderLayer(
        makeHttpClientLayer({ output_text: 'ok', output: [] }, requests)
      )

      yield* Effect.gen(function* () {
        const provider = yield* LLMProvider
        return yield* provider
          .stream({
            messages: [UserMessage.make({ content: 'hello' })],
            tools: [],
            model: 'gpt-5.4',
            reasoningEffort: 'high',
            systemPrompt: 'Be brief.'
          })
          .pipe(Stream.runCollect)
      }).pipe(Effect.provide(layer))

      expect(readCapturedBody(requests)).toMatchObject({
        reasoning: { effort: 'high', summary: 'auto' }
      })
    })
  )

  it.effect('rejects empty OpenAI Codex responses', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      const layer = makeProviderLayer(
        makeHttpClientLayer({ output_text: '', output: [] }, requests)
      )

      const result = yield* Effect.gen(function* () {
        const provider = yield* LLMProvider
        return yield* provider
          .stream({
            messages: [UserMessage.make({ content: 'hello' })],
            tools: [],
            model: 'gpt-5.4',
            systemPrompt: 'Be brief.'
          })
          .pipe(Stream.runCollect)
      }).pipe(Effect.provide(layer), Effect.result)

      expect(result).toMatchObject({
        _tag: 'Failure',
        failure: {
          _tag: 'LLMError',
          cause: 'invalid_response',
          message: 'OpenAI Codex response did not include text or tool calls'
        }
      })
    })
  )

  it.effect('parses OpenAI Codex SSE even when content type is not event-stream', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      const layer = makeProviderLayer(
        makeRawHttpClientLayer(
          [
            'event: response.output_text.delta',
            'data: {"type":"response.output_text.delta","delta":"oauth ","item_id":"msg_1"}',
            '',
            'event: response.output_text.delta',
            'data: {"type":"response.output_text.delta","delta":"smoke ok","item_id":"msg_1"}',
            '',
            'event: response.completed',
            'data: {"type":"response.completed","response":{"output":[{"type":"message","content":[{"type":"output_text","text":"oauth smoke ok"}]}]}}',
            ''
          ].join('\n'),
          requests
        )
      )

      const eventsChunk = yield* Effect.gen(function* () {
        const provider = yield* LLMProvider
        return yield* provider
          .stream({
            messages: [UserMessage.make({ content: 'hello' })],
            tools: [],
            model: 'gpt-5.4',
            systemPrompt: 'Be brief.'
          })
          .pipe(Stream.runCollect)
      }).pipe(Effect.provide(layer))

      const events = Array.from(eventsChunk)
      expect(events.map(event => event._tag)).toEqual(['TextDelta', 'TextDelta', 'Done'])
      expect(events.map(event => (event._tag === 'TextDelta' ? event.text : event._tag))).toEqual([
        'oauth ',
        'smoke ok',
        'Done'
      ])
    })
  )

  it.effect('parses OpenAI Codex reasoning summary deltas', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      const layer = makeProviderLayer(
        makeRawHttpClientLayer(
          [
            'event: response.reasoning_summary_text.delta',
            'data: {"type":"response.reasoning_summary_text.delta","delta":"think","item_id":"rs_1","summary_index":0}',
            '',
            'event: response.output_text.delta',
            'data: {"type":"response.output_text.delta","delta":"ok","item_id":"msg_1"}',
            '',
            'event: response.completed',
            'data: {"type":"response.completed","response":{"output":[{"type":"reasoning","summary":[{"type":"summary_text","text":"think"}]},{"type":"message","content":[{"type":"output_text","text":"ok"}]}]}}',
            ''
          ].join('\n'),
          requests
        )
      )

      const eventsChunk = yield* Effect.gen(function* () {
        const provider = yield* LLMProvider
        return yield* provider
          .stream({
            messages: [UserMessage.make({ content: 'hello' })],
            tools: [],
            model: 'gpt-5.4',
            systemPrompt: 'Be brief.'
          })
          .pipe(Stream.runCollect)
      }).pipe(Effect.provide(layer))

      const events = Array.from(eventsChunk)
      expect(events.map(event => event._tag)).toEqual(['ReasoningDelta', 'TextDelta', 'Done'])
      expect(
        events.map(event => (event._tag === 'ReasoningDelta' ? event.text : event._tag))
      ).toEqual(['think', 'TextDelta', 'Done'])
    })
  )

  it.effect('emits OpenAI Codex SSE deltas before completion', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      const layer = makeProviderLayer(
        makeOpenSseHttpClientLayer(
          [
            'event: response.output_text.delta',
            'data: {"type":"response.output_text.delta","delta":"oauth ","item_id":"msg_1"}',
            '',
            ''
          ].join('\n'),
          requests
        )
      )

      const eventsOption = yield* Effect.gen(function* () {
        const provider = yield* LLMProvider
        return yield* provider
          .stream({
            messages: [UserMessage.make({ content: 'hello' })],
            tools: [],
            model: 'gpt-5.4',
            systemPrompt: 'Be brief.'
          })
          .pipe(Stream.take(1), Stream.runCollect)
      }).pipe(Effect.provide(layer), Effect.timeoutOption('1 second'))

      if (Option.isNone(eventsOption)) {
        expect.fail('Expected OpenAI Codex delta before completion')
      }

      const events = Array.from(eventsOption.value)
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ _tag: 'TextDelta', text: 'oauth ' })
    })
  )

  it.effect('cancels OpenAI Codex response body when stream stops early', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      let cancelled = false
      const layer = makeProviderLayer(
        makeCancelableOpenSseHttpClientLayer({
          responseChunk: [
            'event: response.output_text.delta',
            'data: {"type":"response.output_text.delta","delta":"oauth ","item_id":"msg_1"}',
            '',
            ''
          ].join('\n'),
          requests,
          onCancel: () => {
            cancelled = true
          }
        })
      )

      const eventsChunk = yield* Effect.gen(function* () {
        const provider = yield* LLMProvider
        return yield* provider
          .stream({
            messages: [UserMessage.make({ content: 'hello' })],
            tools: [],
            model: 'gpt-5.4',
            systemPrompt: 'Be brief.'
          })
          .pipe(Stream.take(1), Stream.runCollect)
      }).pipe(Effect.provide(layer))

      const events = Array.from(eventsChunk)
      expect(events).toHaveLength(1)
      expect(cancelled).toBe(true)
    })
  )
})
