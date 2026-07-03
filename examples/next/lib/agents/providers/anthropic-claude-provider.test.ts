import { Effect, Layer, Stream } from 'effect'
import { HttpClient, HttpClientResponse, type HttpClientRequest } from 'effect/unstable/http'
import { describe, expect, it } from '@effect/vitest'
import {
  AssistantAgentMessage,
  AssistantTextPart,
  HostToolCallPart,
  ImagePart,
  TextPart,
  ToolCall,
  ToolDef,
  ToolResultMessage,
  UserMessage,
  inlineBase64Source
} from '@yolk-sdk/agent/protocol'
import { LLMProvider } from '@yolk-sdk/agent/loop'
import { OAuthAccessToken } from '@yolk-sdk/agent/oauth'
import { anthropicClaudeProviderId } from '@yolk-sdk/agent/providers/anthropic/claude'
import { makeAnthropicClaudeProviderLayer } from '@yolk-sdk/agent/providers/anthropic/claude-provider'

type CapturedRequest = {
  readonly request: HttpClientRequest.HttpClientRequest
}

const makeProviderLayer = (httpClientLayer: Layer.Layer<HttpClient.HttpClient>) =>
  makeAnthropicClaudeProviderLayer({
    token: new OAuthAccessToken({
      provider: anthropicClaudeProviderId,
      accessToken: 'test-token',
      expiresAt: 9_999
    })
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

      expect(requests[0]?.request.url).toBe('https://api.anthropic.com/v1/messages?beta=true')
      expect(requestBody).toMatchObject({
        model: 'claude-sonnet-4-6',
        system: [
          {
            type: 'text',
            text: expect.stringMatching(
              /^x-anthropic-billing-header: cc_version=2\.1\.112\.[0-9a-f]{3}; cc_entrypoint=sdk-cli; cch=[0-9a-f]{5};$/
            )
          },
          { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }
        ],
        messages: [{ role: 'user', content: 'Be brief.\n\nhello' }],
        tools: [{ name: 'mcp_Weather', description: 'Get weather.', input_schema: {} }]
      })
      expect(Array.from(eventsChunk).map(event => event._tag)).toEqual([
        'TextDelta',
        'Done',
        'Usage'
      ])
    })
  )

  it.effect('maps multimodal and tool transcript messages to Anthropic blocks', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      const call = ToolCall.make({ id: 'call_1', name: 'weather', params: { city: 'Paris' } })
      const layer = makeProviderLayer(
        makeHttpClientLayer(
          {
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn'
          },
          requests
        )
      )

      yield* Effect.gen(function* () {
        const provider = yield* LLMProvider
        return yield* provider
          .stream({
            messages: [
              UserMessage.make({
                content: [
                  TextPart.make({ text: 'Describe this image' }),
                  ImagePart.make({ source: inlineBase64Source('abc'), mimeType: 'image/png' })
                ]
              }),
              AssistantAgentMessage.make({
                parts: [
                  AssistantTextPart.make({ content: 'Need weather.' }),
                  HostToolCallPart.make({ call })
                ]
              }),
              ToolResultMessage.make({ toolCallId: call.id, content: 'Sunny', isError: true })
            ],
            tools: [],
            model: 'claude-sonnet-4-6',
            systemPrompt: 'Be brief.'
          })
          .pipe(Stream.runCollect)
      }).pipe(Effect.provide(layer))

      expect(readCapturedBody(requests)).toMatchObject({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Be brief.' },
              { type: 'text', text: 'Describe this image' },
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: 'abc' }
              }
            ]
          },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Need weather.' },
              { type: 'tool_use', id: 'call_1', name: 'mcp_Weather', input: { city: 'Paris' } }
            ]
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'call_1',
                content: 'Sunny',
                is_error: true
              }
            ]
          }
        ]
      })
    })
  )

  it.effect('maps Anthropic thinking, tool use, and cache usage events', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      const layer = makeProviderLayer(
        makeHttpClientLayer(
          {
            content: [
              { type: 'thinking', thinking: 'check tool' },
              { type: 'tool_use', id: 'call_1', name: 'mcp_Weather', input: { city: 'Paris' } }
            ],
            stop_reason: 'tool_use',
            usage: {
              input_tokens: 10,
              output_tokens: 4,
              cache_read_input_tokens: 3,
              cache_creation_input_tokens: 2
            }
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
            model: 'claude-sonnet-4-6',
            systemPrompt: 'Use tools.'
          })
          .pipe(Stream.runCollect)
      }).pipe(Effect.provide(layer))

      const events = Array.from(eventsChunk)
      expect(events.map(event => event._tag)).toEqual([
        'ReasoningDelta',
        'ToolCall',
        'Done',
        'Usage'
      ])
      expect(events[0]).toMatchObject({ text: 'check tool' })
      expect(events[1]).toMatchObject({
        call: { id: 'call_1', name: 'weather', params: { city: 'Paris' } }
      })
      expect(events[2]).toMatchObject({ stopReason: 'tool_use' })
      expect(events[3]).toMatchObject({
        usage: {
          input: { total: 15, uncached: 10, cacheRead: 3, cacheWrite: 2 },
          output: { total: 4, text: 4 }
        }
      })
    })
  )

  it.effect('maps non-OK Anthropic responses to retryable LLM errors', () =>
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
            model: 'claude-sonnet-4-6',
            systemPrompt: 'Be brief.'
          })
          .pipe(Stream.runCollect)
      }).pipe(Effect.provide(layer), Effect.flip)

      expect(error).toMatchObject({
        _tag: 'LLMError',
        cause: 'rate_limit',
        retryable: true
      })
      expect(error.message).toContain('Anthropic Claude returned 429')
    })
  )
})
