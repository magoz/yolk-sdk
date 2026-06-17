import { Effect, Layer, Redacted, Stream } from 'effect'
import { HttpClient, HttpClientResponse, type HttpClientRequest } from 'effect/unstable/http'
import { describe, expect, it } from '@effect/vitest'
import {
  DocumentPart,
  TextPart,
  UserMessage,
  inlineBase64Source
} from '@yolk-sdk/agent/protocol'
import { LLMProvider } from '@yolk-sdk/agent/loop'
import { makeOpenAiProviderLayer, toOpenAiRequestBody } from '../../../src/providers/openai/provider.ts'

type CapturedRequest = {
  readonly request: HttpClientRequest.HttpClientRequest
}

const makeProviderLayer = (httpClientLayer: Layer.Layer<HttpClient.HttpClient>) =>
  makeOpenAiProviderLayer({ apiKey: Redacted.make('test-key') }).pipe(Layer.provide(httpClientLayer))

const makeHttpClientLayer = (
  response: Response,
  requests: Array<CapturedRequest>
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(request =>
      Effect.sync(() => {
        requests.push({ request })

        return HttpClientResponse.fromWeb(request, response)
      })
    )
  )

describe('OpenAI provider', () => {
  it.effect('inlines text documents for Chat Completions input', () =>
    Effect.gen(function* () {
      const body = yield* toOpenAiRequestBody({
        model: 'gpt-5.4',
        systemPrompt: '',
        messages: [
          UserMessage.make({
            content: [
              TextPart.make({ text: 'summarize' }),
              DocumentPart.make({
                source: inlineBase64Source(btoa('# Identity\n\nSpeldosa docs.')),
                mimeType: 'text/markdown; charset=utf-8',
                filename: 'company.identity.md'
              })
            ]
          })
        ],
        tools: []
      })

      expect(body.messages[1]).toEqual({
        role: 'user',
        content: [
          { type: 'text', text: 'summarize' },
          { type: 'text', text: 'Document: company.identity.md\n\n# Identity\n\nSpeldosa docs.' }
        ]
      })
    }))

  it.effect('classifies rate limits with retry-after metadata', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      const layer = makeProviderLayer(
        makeHttpClientLayer(
          new Response(JSON.stringify({ error: { message: 'too many requests' } }), {
            status: 429,
            headers: { 'content-type': 'application/json', 'retry-after-ms': '2500' }
          }),
          requests
        )
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

      expect(requests).toHaveLength(1)
      expect(error).toMatchObject({
        _tag: 'LLMError',
        cause: 'rate_limit',
        retryable: true,
        provider: {
          provider: 'openai',
          kind: 'rate_limit',
          status: 429,
          retryAfterMs: 2500
        }
      })
      expect(error.message).toBe('OpenAI returned 429')
    })
  )
})
