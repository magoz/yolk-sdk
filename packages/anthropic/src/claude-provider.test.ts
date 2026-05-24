import { Effect, Layer, Stream } from 'effect'
import { HttpClient, HttpClientResponse, type HttpClientRequest } from 'effect/unstable/http'
import { describe, expect, it } from '@effect/vitest'
import {
  AssistantAgentMessage,
  HostToolCallPart,
  ImagePart,
  TextPart,
  ToolCall,
  ToolDef,
  ToolResultMessage,
  UserMessage
} from '@yolk-sdk/agent/protocol'
import { OAuthAccessToken } from '@yolk-sdk/oauth'
import { LLMProvider } from '@yolk-sdk/agent/loop'
import { makeAnthropicClaudeProviderLayer, toAnthropicClaudeRequestBody } from './claude-provider.ts'

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

const readCapturedHeaders = (requests: ReadonlyArray<CapturedRequest>) => {
  const headers = requests[0]?.request.headers
  expect(headers).toBeDefined()

  if (headers === undefined) {
    expect.fail('Expected Anthropic request headers')
  }

  return headers
}

const runMinimalProviderRequest = (
  input: {
    readonly extraHeaders?: Readonly<Record<string, string>>
  },
  requests: Array<CapturedRequest>
) =>
  Effect.gen(function* () {
    const providerLayer = makeAnthropicClaudeProviderLayer({
      token: new OAuthAccessToken({
        provider: 'anthropic-claude',
        accessToken: 'token',
        expiresAt: Date.now() + 60_000
      }),
      ...(input.extraHeaders === undefined ? {} : { extraHeaders: input.extraHeaders })
    }).pipe(
      Layer.provide(
        makeHttpClientLayer(
          new Response(JSON.stringify({ content: [], stop_reason: 'end_turn' }), { status: 200 }),
          requests
        )
      )
    )

    yield* Effect.gen(function* () {
      const provider = yield* LLMProvider

      yield* provider.stream({
        model: 'claude-sonnet-4-6',
        systemPrompt: '',
        messages: [UserMessage.make({ content: 'hello' })],
        tools: []
      }).pipe(Stream.runCollect)
    }).pipe(Effect.provide(providerLayer))
  })

describe('Anthropic Claude provider', () => {
  it.effect('lowers protocol transcript to Claude Messages input', () =>
    Effect.gen(function* () {
      const body = yield* toAnthropicClaudeRequestBody(
        {
          model: 'claude-sonnet-4-6',
          systemPrompt: 'Use tools carefully.',
          messages: [
            UserMessage.make({
              content: [
                TextPart.make({ text: 'inspect' }),
                ImagePart.make({ data: 'abc', mimeType: 'image/png' })
              ]
            }),
            AssistantAgentMessage.make({
              parts: [
                HostToolCallPart.make({
                  call: ToolCall.make({ id: 'call-1', name: 'search', params: { query: 'yolk' } })
                })
              ]
            }),
            ToolResultMessage.make({ toolCallId: 'call-1', content: 'result', isError: false })
          ],
          tools: [
            ToolDef.make({
              name: 'search',
              description: 'Search docs',
              parameters: { type: 'object' }
            })
          ]
        },
        { maxTokens: 123 }
      )

      expect(body).toEqual({
        model: 'claude-sonnet-4-6',
        system: [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }],
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Use tools carefully.' },
              { type: 'text', text: 'inspect' },
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: 'abc' }
              }
            ]
          },
          {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'call-1', name: 'mcp_Search', input: { query: 'yolk' } }
            ]
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'call-1', content: 'result', is_error: false }
            ]
          }
        ],
        max_tokens: 123,
        tools: [{ name: 'mcp_Search', description: 'Search docs', input_schema: { type: 'object' } }]
      })
    }))

  it.effect('sends required Anthropic version and beta headers by default', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      yield* runMinimalProviderRequest({}, requests)

      const headers = readCapturedHeaders(requests)

      expect(headers['anthropic-version']).toBe('2023-06-01')
      expect(headers['anthropic-beta']).toBe(
        'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14'
      )
    }))

  it.effect('lets extraHeaders override Anthropic default headers', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      yield* runMinimalProviderRequest(
        {
          extraHeaders: {
            'anthropic-beta': 'custom-beta',
            'anthropic-version': 'custom-version',
            'x-app': 'custom-app'
          }
        },
        requests
      )

      const headers = readCapturedHeaders(requests)

      expect(headers['anthropic-beta']).toBe('custom-beta')
      expect(headers['anthropic-version']).toBe('custom-version')
      expect(headers['x-app']).toBe('custom-app')
    }))
})
