import { Effect, Layer, Stream } from 'effect'
import { HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/unstable/http'
import { describe, expect, it } from '@effect/vitest'
import {
  ImagePart,
  TextPart,
  ToolDef,
  UserMessage,
  inlineBase64Source
} from '@yolk-sdk/agent/protocol'
import { LLMProvider } from '@yolk-sdk/agent/loop'
import { OAuthAccessToken } from '@yolk-sdk/agent/oauth'
import {
  makeXAiGrokProviderLayer,
  streamXAiGrokResponse,
  toXAiGrokRequestBody
} from '../../../src/providers/xai/grok-provider.ts'
import { xAiGrokProviderId, xAiGrokResponsesUrl } from '../../../src/providers/xai/grok.ts'

type CapturedRequest = {
  readonly request: HttpClientRequest.HttpClientRequest
}

const grokToken = new OAuthAccessToken({
  provider: xAiGrokProviderId,
  accessToken: 'subscription-token',
  expiresAt: Date.now() + 60_000
})

const responseFromText = (text: string) => {
  const request = HttpClientRequest.get('https://example.com')

  return HttpClientResponse.fromWeb(request, new Response(text, { status: 200 }))
}

const responseFromSseEvents = (events: ReadonlyArray<unknown>) =>
  responseFromText(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''))

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
    expect.fail('Expected xAI Grok request body')
  }

  return new TextDecoder().decode(body.body)
}

describe('xAI Grok subscription provider', () => {
  it.effect('lowers Responses input with a host-owned output limit', () =>
    Effect.gen(function* () {
      const body = yield* toXAiGrokRequestBody(
        {
          model: 'grok-build',
          systemPrompt: 'Be concise.',
          messages: [
            UserMessage.make({
              content: [
                TextPart.make({ text: 'Describe this' }),
                ImagePart.make({
                  source: inlineBase64Source('abc'),
                  mimeType: 'image/png'
                })
              ]
            })
          ],
          tools: [
            ToolDef.make({
              name: 'search',
              description: 'Search docs',
              parameters: { type: 'object' }
            })
          ]
        },
        { maxOutputTokens: 30_000 }
      )

      expect(body).toEqual({
        model: 'grok-build',
        instructions: 'Be concise.',
        input: [
          {
            role: 'user',
            content: [
              { type: 'input_text', text: 'Describe this' },
              { type: 'input_image', image_url: 'data:image/png;base64,abc' }
            ]
          }
        ],
        store: false,
        stream: true,
        max_output_tokens: 30_000,
        tools: [
          {
            type: 'function',
            name: 'search',
            description: 'Search docs',
            parameters: { type: 'object' }
          }
        ],
        parallel_tool_calls: true
      })
    })
  )

  it.effect('rejects invalid host output limits before request lowering', () =>
    Effect.gen(function* () {
      const error = yield* toXAiGrokRequestBody(
        {
          model: 'grok-build',
          systemPrompt: '',
          messages: [UserMessage.make({ content: 'Hello' })],
          tools: []
        },
        { maxOutputTokens: 0 }
      ).pipe(Effect.flip)

      expect(error).toMatchObject({
        _tag: 'LLMError',
        cause: 'validation_error',
        message: 'xAI Grok subscription maxOutputTokens must be a positive safe integer',
        retryable: false
      })
    })
  )

  it.effect('sends reasoning only when the request or host selects an effort', () =>
    Effect.gen(function* () {
      const body = yield* toXAiGrokRequestBody(
        {
          model: 'grok-4.6',
          systemPrompt: '',
          reasoningEffort: 'high',
          messages: [UserMessage.make({ content: 'Think carefully' })],
          tools: []
        },
        { maxOutputTokens: 1_000, reasoningSummary: 'detailed' }
      )

      expect(body.reasoning).toEqual({ effort: 'high', summary: 'detailed' })
    })
  )

  it.effect('uses the fixed subscription proxy and required headers', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      const completedResponse = [
        'data: {"type":"response.output_text.delta","delta":"Hello"}',
        'data: {"type":"response.completed","response":{"output":[]}}',
        ''
      ].join('\n\n')
      const layer = makeXAiGrokProviderLayer({
        token: grokToken,
        maxOutputTokens: 30_000,
        clientVersion: '0.2.95',
        extraHeaders: {
          authorization: 'Bearer wrong',
          'X-XAI-Token-Auth': 'wrong',
          'x-grok-model-override': 'wrong',
          'x-grok-client-version': 'wrong'
        }
      }).pipe(
        Layer.provide(
          makeHttpClientLayer(new Response(completedResponse, { status: 200 }), requests)
        )
      )

      const events = yield* Effect.gen(function* () {
        const provider = yield* LLMProvider
        return yield* provider
          .stream({
            model: 'grok-build',
            systemPrompt: '',
            messages: [UserMessage.make({ content: 'Hello' })],
            tools: []
          })
          .pipe(Stream.runCollect)
      }).pipe(Effect.provide(layer))

      const request = requests[0]?.request
      expect(request?.url).toBe(xAiGrokResponsesUrl)
      expect(request?.headers).toMatchObject({
        accept: 'text/event-stream',
        authorization: 'Bearer subscription-token',
        'content-type': 'application/json',
        'x-xai-token-auth': 'xai-grok-cli',
        'x-grok-model-override': 'grok-build',
        'x-grok-client-version': '0.2.95'
      })
      expect(JSON.parse(readCapturedBody(requests))).toMatchObject({
        model: 'grok-build',
        max_output_tokens: 30_000,
        stream: true
      })
      expect(Array.from(events).map(event => event._tag)).toEqual(['TextDelta', 'Done'])
    })
  )

  it.effect('rejects mismatched OAuth tokens before sending a request', () =>
    Effect.gen(function* () {
      let called = false
      const httpLayer = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(request => {
          called = true
          return Effect.succeed(HttpClientResponse.fromWeb(request, new Response()))
        })
      )
      const layer = makeXAiGrokProviderLayer({
        token: new OAuthAccessToken({
          provider: 'openai-codex',
          accessToken: 'wrong-provider',
          expiresAt: Date.now() + 60_000
        }),
        maxOutputTokens: 1_000,
        clientVersion: '0.2.95'
      }).pipe(Layer.provide(httpLayer))

      const error = yield* Effect.gen(function* () {
        const provider = yield* LLMProvider
        return yield* provider
          .stream({
            model: 'grok-build',
            systemPrompt: '',
            messages: [UserMessage.make({ content: 'Hello' })],
            tools: []
          })
          .pipe(Stream.runCollect, Effect.flip)
      }).pipe(Effect.provide(layer))

      expect(called).toBe(false)
      expect(error).toMatchObject({
        cause: 'provider_error',
        retryable: false,
        provider: {
          provider: 'xai_grok',
          kind: 'auth',
          providerCode: 'invalid_access_token'
        }
      })
    })
  )

  it.effect('accepts SSE streams that begin with a heartbeat comment', () =>
    Effect.gen(function* () {
      const response = responseFromText(
        [
          ': heartbeat',
          '',
          'data: {"type":"response.output_text.delta","delta":"Hello"}',
          '',
          'data: {"type":"response.completed","response":{"output":[]}}',
          ''
        ].join('\n')
      )

      const events = yield* streamXAiGrokResponse(response).pipe(Stream.runCollect)

      expect(Array.from(events).map(event => event._tag)).toEqual(['TextDelta', 'Done'])
    })
  )

  it.effect('normalizes streamed reasoning, text, tool calls, and usage', () =>
    Effect.gen(function* () {
      const response = responseFromSseEvents([
        { type: 'response.reasoning_summary_text.delta', delta: 'Thinking' },
        { type: 'response.output_text.delta', delta: 'Done' },
        {
          type: 'response.output_item.done',
          item: {
            type: 'function_call',
            call_id: 'call-1',
            name: 'search',
            arguments: '{"query":"yolk"}'
          }
        },
        {
          type: 'response.completed',
          response: {
            output: [],
            usage: {
              input_tokens: 10,
              output_tokens: 5,
              input_tokens_details: { cached_tokens: 2 },
              output_tokens_details: { reasoning_tokens: 3 }
            }
          }
        }
      ])

      const events = yield* streamXAiGrokResponse(response).pipe(Stream.runCollect)

      expect(Array.from(events).map(event => event._tag)).toEqual([
        'ReasoningDelta',
        'TextDelta',
        'ToolCall',
        'Done',
        'Usage'
      ])
      expect(Array.from(events).find(event => event._tag === 'Done')).toMatchObject({
        stopReason: 'tool_use'
      })
      expect(Array.from(events).find(event => event._tag === 'Usage')).toMatchObject({
        usage: {
          input: { total: 10, uncached: 8, cacheRead: 2 },
          output: { total: 5, reasoning: 3, text: 2 }
        }
      })
    })
  )

  it.effect('deduplicates replayed terminal responses and cumulative usage', () =>
    Effect.gen(function* () {
      const completed = {
        type: 'response.completed',
        response: {
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'Done' }] }],
          usage: { input_tokens: 10, output_tokens: 5 }
        }
      }
      const events = yield* streamXAiGrokResponse(
        responseFromSseEvents([completed, completed])
      ).pipe(Stream.runCollect)

      expect(Array.from(events).filter(event => event._tag === 'Done')).toHaveLength(1)
      expect(Array.from(events).filter(event => event._tag === 'Usage')).toHaveLength(1)
    })
  )

  it.effect('ignores provider events after terminal completion', () =>
    Effect.gen(function* () {
      const completed = {
        type: 'response.completed',
        response: {
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'Done' }] }],
          usage: { input_tokens: 10, output_tokens: 5 }
        }
      }
      const events = yield* streamXAiGrokResponse(
        responseFromSseEvents([
          completed,
          { type: 'response.output_text.delta', delta: 'late text' },
          {
            type: 'response.failed',
            response: { error: { code: 'server_error', message: 'late failure' } }
          }
        ])
      ).pipe(Stream.runCollect)

      expect(Array.from(events).map(event => event._tag)).toEqual(['TextDelta', 'Done', 'Usage'])
    })
  )

  it.effect('rejects malformed usage subtotals', () =>
    Effect.gen(function* () {
      const response = responseFromSseEvents([
        {
          type: 'response.completed',
          response: {
            output: [{ type: 'message', content: [{ type: 'output_text', text: 'Done' }] }],
            usage: {
              input_tokens: 10,
              output_tokens: 5,
              input_tokens_details: { cached_tokens: 11 }
            }
          }
        }
      ])

      const error = yield* streamXAiGrokResponse(response).pipe(Stream.runCollect, Effect.flip)

      expect(error).toMatchObject({ cause: 'invalid_response', retryable: false })
    })
  )

  it.effect('rejects a Grok Responses stream that ends without a terminal event', () =>
    Effect.gen(function* () {
      const response = responseFromSseEvents([
        { type: 'response.output_text.delta', delta: 'partial' }
      ])

      const error = yield* streamXAiGrokResponse(response).pipe(Stream.runCollect, Effect.flip)

      expect(error).toMatchObject({
        cause: 'invalid_response',
        retryable: false,
        provider: {
          provider: 'xai_grok',
          kind: 'invalid_response',
          providerCode: 'incomplete_stream'
        }
      })
    })
  )

  it.effect('rejects incomplete Grok responses instead of reporting normal completion', () =>
    Effect.gen(function* () {
      const response = responseFromSseEvents([
        {
          type: 'response.incomplete',
          response: { incomplete_details: { reason: 'max_output_tokens' } }
        }
      ])

      const error = yield* streamXAiGrokResponse(response).pipe(Stream.runCollect, Effect.flip)

      expect(error).toMatchObject({
        _tag: 'LLMError',
        cause: 'invalid_response',
        retryable: false,
        provider: {
          provider: 'xai_grok',
          kind: 'invalid_response',
          providerCode: 'max_output_tokens'
        }
      })
    })
  )

  it.effect('classifies Grok stream failures with provider-safe metadata', () =>
    Effect.gen(function* () {
      const response = responseFromSseEvents([
        {
          type: 'response.failed',
          response: {
            error: {
              code: 'context_window_exceeded',
              message: 'Your input exceeds the context window of this model.'
            }
          }
        }
      ])

      const error = yield* streamXAiGrokResponse(response).pipe(Stream.runCollect, Effect.flip)

      expect(error).toMatchObject({
        _tag: 'LLMError',
        cause: 'context_overflow',
        retryable: false,
        provider: {
          provider: 'xai_grok',
          kind: 'context_overflow',
          providerCode: 'context_window_exceeded'
        }
      })
    })
  )
})
