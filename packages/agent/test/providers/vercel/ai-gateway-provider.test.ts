import { Effect, Layer, Redacted, Schema, Stream } from 'effect'
import { HttpClient, HttpClientResponse, type HttpClientRequest } from 'effect/unstable/http'
import { describe, expect, it } from '@effect/vitest'
import { LLMProvider } from '@yolk-sdk/agent/loop'
import { ToolResult, UserMessage } from '@yolk-sdk/agent/protocol'
import { makeTool } from '@yolk-sdk/agent/tools'
import {
  makeVercelAiGatewayProviderLayer,
  vercelAiGatewayChatCompletionsUrl
} from '../../../src/providers/vercel/ai-gateway-provider.ts'

type CapturedRequest = {
  readonly request: HttpClientRequest.HttpClientRequest
}

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
    expect.fail('Expected Vercel AI Gateway request body')
  }

  return JSON.parse(new TextDecoder().decode(body.body))
}

const runProvider = (
  response: Response,
  requests: Array<CapturedRequest>,
  config: Parameters<typeof makeVercelAiGatewayProviderLayer>[0] = {
    apiKey: Redacted.make('gateway-key'),
    maxCompletionTokens: 2_000
  }
) =>
  Effect.gen(function* () {
    const provider = yield* LLMProvider
    return yield* provider
      .stream({
        model: 'anthropic/claude-sonnet',
        systemPrompt: 'Be concise.',
        messages: [UserMessage.make({ content: 'Hello' })],
        tools: []
      })
      .pipe(Stream.runCollect)
  }).pipe(
    Effect.provide(
      makeVercelAiGatewayProviderLayer(config).pipe(
        Layer.provide(makeHttpClientLayer(response, requests))
      )
    )
  )

describe('Vercel AI Gateway provider', () => {
  it.effect('uses the Gateway endpoint, required auth, routing, and fallback models', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      const events = yield* runProvider(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'Hello from Gateway' } }]
          }),
          { status: 200 }
        ),
        requests,
        {
          apiKey: Redacted.make('gateway-key'),
          maxCompletionTokens: 2_000,
          fallbackModels: ['openai/gpt-fallback'],
          routing: { order: ['vertex', 'anthropic'], sort: 'ttft' },
          extraHeaders: {
            accept: 'text/event-stream',
            authorization: 'Bearer wrong',
            'content-type': 'text/plain',
            'http-referer': 'https://app.example.com',
            'x-title': 'Example App'
          }
        }
      )

      const request = requests[0]?.request
      expect(request?.url).toBe(vercelAiGatewayChatCompletionsUrl)
      expect(request?.headers).toMatchObject({
        accept: 'application/json',
        authorization: 'Bearer gateway-key',
        'content-type': 'application/json',
        'http-referer': 'https://app.example.com',
        'x-title': 'Example App'
      })
      expect(readCapturedBody(requests)).toMatchObject({
        model: 'anthropic/claude-sonnet',
        max_tokens: 2_000,
        stream: false,
        models: ['openai/gpt-fallback'],
        providerOptions: {
          gateway: { order: ['vertex', 'anthropic'], sort: 'ttft' }
        }
      })
      expect(readCapturedBody(requests)).not.toHaveProperty('max_completion_tokens')
      expect(Array.from(events)).toMatchObject([
        { _tag: 'TextDelta', text: 'Hello from Gateway' },
        { _tag: 'Done', stopReason: 'stop' }
      ])
    })
  )

  it.effect('normalizes tool calls and usage', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      const layer = makeVercelAiGatewayProviderLayer({
        apiKey: Redacted.make('gateway-key'),
        maxCompletionTokens: 2_000
      }).pipe(
        Layer.provide(
          makeHttpClientLayer(
            new Response(
              JSON.stringify({
                choices: [
                  {
                    message: {
                      content: null,
                      tool_calls: [
                        {
                          id: 'call-1',
                          type: 'function',
                          function: { name: 'search', arguments: '{"query":"yolk"}' }
                        }
                      ]
                    }
                  }
                ],
                usage: {
                  prompt_tokens: 10,
                  completion_tokens: 5,
                  prompt_tokens_details: { cached_tokens: 2 },
                  completion_tokens_details: { reasoning_tokens: 3 }
                }
              })
            ),
            requests
          )
        )
      )

      const searchTool = makeTool({
        name: 'search',
        description: 'Search docs',
        parameters: Schema.Struct({ query: Schema.String }),
        access: 'read',
        execute: ({ call }) =>
          Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'ok' }))
      })
      const events = yield* Effect.gen(function* () {
        const provider = yield* LLMProvider
        return yield* provider
          .stream({
            model: 'openai/gpt-test',
            systemPrompt: '',
            messages: [UserMessage.make({ content: 'Search' })],
            tools: [searchTool.def]
          })
          .pipe(Stream.runCollect)
      }).pipe(Effect.provide(layer))

      expect(Array.from(events)).toMatchObject([
        {
          _tag: 'ToolCall',
          call: { id: 'call-1', name: 'search', params: { query: 'yolk' } }
        },
        { _tag: 'Done', stopReason: 'tool_use' },
        {
          _tag: 'Usage',
          usage: {
            input: { total: 10, uncached: 8, cacheRead: 2 },
            output: { total: 5, reasoning: 3, text: 2 }
          }
        }
      ])
      expect(readCapturedBody(requests)).toMatchObject({
        tools: [
          {
            type: 'function',
            function: {
              name: 'search',
              parameters: {
                type: 'object',
                properties: { query: { type: 'string' } },
                required: ['query']
              }
            }
          }
        ],
        parallel_tool_calls: true
      })
    })
  )

  it.effect('honors trusted endpoint overrides without allowing required header overrides', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      yield* runProvider(
        new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] })),
        requests,
        {
          apiKey: Redacted.make('gateway-key'),
          maxCompletionTokens: 2_000,
          chatCompletionsUrl: 'https://gateway-proxy.example.com/chat/completions',
          extraHeaders: {
            accept: 'text/event-stream',
            authorization: 'Bearer wrong',
            'content-type': 'text/plain'
          }
        }
      )

      expect(requests[0]?.request).toMatchObject({
        url: 'https://gateway-proxy.example.com/chat/completions',
        headers: {
          accept: 'application/json',
          authorization: 'Bearer gateway-key',
          'content-type': 'application/json'
        }
      })
    })
  )

  it.effect('rejects truncated and filtered completions instead of reporting success', () =>
    Effect.gen(function* () {
      const finishReasons: ReadonlyArray<'length' | 'content_filter'> = ['length', 'content_filter']

      for (const finishReason of finishReasons) {
        const requests: Array<CapturedRequest> = []
        const error = yield* runProvider(
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: { content: 'partial output' },
                  finish_reason: finishReason
                }
              ]
            })
          ),
          requests
        ).pipe(Effect.flip)

        expect(error).toMatchObject({
          _tag: 'LLMError',
          cause: 'invalid_response',
          message: `Vercel AI Gateway response stopped with ${finishReason}`,
          retryable: false,
          provider: {
            provider: 'vercel_ai_gateway',
            kind: 'invalid_response',
            providerCode: finishReason
          }
        })
      }
    })
  )

  it.effect('classifies rate limits with Gateway identity and sanitized errors', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      const error = yield* runProvider(
        new Response(JSON.stringify({ error: { message: 'secret upstream detail' } }), {
          status: 429,
          headers: { 'retry-after-ms': '2500' }
        }),
        requests
      ).pipe(Effect.flip)

      expect(error).toMatchObject({
        _tag: 'LLMError',
        cause: 'rate_limit',
        message: 'Vercel AI Gateway returned 429',
        retryable: true,
        provider: {
          provider: 'vercel_ai_gateway',
          kind: 'rate_limit',
          status: 429,
          retryAfterMs: 2500
        }
      })
      expect(error.message).not.toContain('secret upstream detail')
    })
  )

  it.effect('rejects invalid host output limits before sending a request', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      const error = yield* runProvider(new Response(JSON.stringify({ choices: [] })), requests, {
        apiKey: Redacted.make('gateway-key'),
        maxCompletionTokens: 0
      }).pipe(Effect.flip)

      expect(requests).toHaveLength(0)
      expect(error).toMatchObject({
        _tag: 'LLMError',
        cause: 'validation_error',
        message: 'Vercel AI Gateway maxCompletionTokens must be a positive safe integer',
        retryable: false
      })
    })
  )
})
