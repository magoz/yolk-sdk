import { Effect, Layer, Stream } from 'effect'
import { HttpClient, HttpClientResponse, type HttpClientRequest } from 'effect/unstable/http'
import { describe, expect, it } from '@effect/vitest'
import { ToolDef, UserMessage } from '@yolk/agent/protocol'
import { LLMProvider } from '@yolk/agent/loop'
import { makeAnthropicClaudeProviderLayer } from './anthropic-claude-provider'

type CapturedRequest = {
  readonly request: HttpClientRequest.HttpClientRequest
}

const makeProviderLayer = (httpClientLayer: Layer.Layer<HttpClient.HttpClient>) =>
  makeAnthropicClaudeProviderLayer({
    token: { type: 'oauth', access: 'test-token', refresh: '', expires: 9_999 }
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
    expect.fail('Expected Anthropic request body to be text')
  }

  return JSON.parse(new TextDecoder().decode(body.body))
}

describe('AnthropicClaudeProviderLayer', () => {
  it.effect('maps text and tools to Anthropic messages', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      const layer = makeProviderLayer(
        makeHttpClientLayer(
          {
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 5, output_tokens: 2 }
          },
          requests
        )
      )

      const eventsChunk = yield* Effect.gen(function* () {
        const provider = yield* LLMProvider
        return yield* provider
          .stream({
            messages: [UserMessage.make({ content: 'hello' })],
            tools: [ToolDef.make({ name: 'weather', description: 'Get weather.', parameters: {} })],
            model: 'claude-sonnet-4-6',
            systemPrompt: 'Be brief.'
          })
          .pipe(Stream.runCollect)
      }).pipe(Effect.provide(layer))

      const requestBody = readCapturedBody(requests)

      expect(requests[0]?.request.url).toBe('https://api.anthropic.com/v1/messages')
      expect(requestBody).toMatchObject({
        model: 'claude-sonnet-4-6',
        system: 'Be brief.',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [{ name: 'weather', description: 'Get weather.', input_schema: {} }]
      })
      expect(Array.from(eventsChunk).map(event => event._tag)).toEqual(['TextDelta', 'Done', 'Usage'])
    })
  )
})
