import { Effect, Layer, Redacted, Stream } from 'effect'
import { HttpClient, HttpClientResponse, type HttpClientRequest } from 'effect/http'
import { describe, expect, it } from '@effect/vitest'
import {
  AssistantAgentMessage,
  AssistantTextPart,
  HostToolCallPart,
  ToolCall,
  ToolDef,
  ToolResultMessage,
  UserMessage,
  type AgentMessage
} from '@yolk-sdk/agent/protocol'
import { LLMProvider, type LLMRequest } from '@yolk-sdk/agent/loop'
import { OAuthAccessToken } from '@yolk-sdk/agent/oauth'
import {
  makeAnthropicClaudeProviderLayer,
  toAnthropicClaudeRequestBody
} from '../../src/providers/anthropic/claude-provider.ts'
import {
  makeOpenAiCodexProviderLayer,
  toOpenAiCodexRequestBody
} from '../../src/providers/openai/codex-provider.ts'
import {
  makeOpenAiProviderLayer,
  toOpenAiRequestBody
} from '../../src/providers/openai/provider.ts'
import { makeXAiGrokProviderLayer } from '../../src/providers/xai/grok-provider.ts'
import { xAiGrokProviderId } from '../../src/providers/xai/grok.ts'
import { makeVercelAiGatewayProviderLayer } from '../../src/providers/vercel/ai-gateway-provider.ts'
import {
  makeOpenCodeGoProviderLayer,
  type OpenCodeGoProtocol
} from '../../src/providers/opencode/go-provider.ts'

const lookup = ToolDef.make({
  name: 'lookup',
  description: 'Look up.',
  parameters: { type: 'object', properties: { query: { type: 'string' } } }
})

const search = ToolDef.make({
  name: 'search',
  description: 'Search.',
  parameters: { type: 'object', properties: { query: { type: 'string' } } }
})

const toolTurn = (id: string): ReadonlyArray<AgentMessage> => [
  AssistantAgentMessage.make({
    parts: [
      HostToolCallPart.make({
        call: ToolCall.make({ id, name: 'lookup', params: { query: id } })
      })
    ]
  }),
  ToolResultMessage.make({ toolCallId: id, content: `result ${id}` })
]

// A tool loop two turns in: the previous request ended with the first tool result.
const toolLoopMessages: ReadonlyArray<AgentMessage> = [
  UserMessage.make({ content: 'first' }),
  ...toolTurn('call-1'),
  ...toolTurn('call-2')
]

const baseRequest: LLMRequest = {
  model: 'test-model',
  systemPrompt: 'Be concise.',
  messages: toolLoopMessages,
  tools: [lookup, search]
}

const decodeJson = (json: string): unknown => JSON.parse(json)

const bodyText = (request: HttpClientRequest.HttpClientRequest | undefined) => {
  const body = request?.body

  if (body?._tag !== 'Uint8Array') {
    return expect.fail('Expected a JSON request body')
  }

  return new TextDecoder().decode(body.body)
}

const markerCount = (json: string) => json.split('"cache_control"').length - 1

const capturingHttpClient = (
  requests: Array<HttpClientRequest.HttpClientRequest>,
  response: () => Response
) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(request =>
      Effect.sync(() => {
        requests.push(request)

        return HttpClientResponse.fromWeb(request, response())
      })
    )
  )

const emptyResponse = () => new Response('', { status: 200 })

const chatResponse = () =>
  new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 })

// Only the outgoing request matters here; the stubbed response may not parse.
const send = <E>(
  layer: Layer.Layer<LLMProvider, E, HttpClient.HttpClient>,
  requests: Array<HttpClientRequest.HttpClientRequest>,
  request: LLMRequest,
  response: () => Response = emptyResponse
) =>
  Effect.gen(function* () {
    const provider = yield* LLMProvider

    yield* provider.stream(request).pipe(Stream.runCollect, Effect.ignore)
  }).pipe(Effect.provide(layer.pipe(Layer.provide(capturingHttpClient(requests, response)))))

const claudeToken = new OAuthAccessToken({
  provider: 'anthropic-claude',
  accessToken: 'token',
  expiresAt: Date.now() + 60_000
})

const goLayer = (protocol: OpenCodeGoProtocol) =>
  makeOpenCodeGoProviderLayer({
    apiKey: Redacted.make('go-key'),
    protocol,
    maxOutputTokens: 100
  })

describe('prompt caching', () => {
  describe('Anthropic', () => {
    it.effect('marks the last tool and both conversation ends, then appends turn context', () =>
      Effect.gen(function* () {
        const body = yield* toAnthropicClaudeRequestBody(
          { ...baseRequest, turnContext: 'Now: 12:00' },
          { maxTokens: 100, promptCacheTtl: '1h' }
        )

        const oneHour = { type: 'ephemeral', ttl: '1h' }

        expect(body.tools?.[0]).not.toHaveProperty('cache_control')
        expect(body.tools?.[1]).toMatchObject({ name: 'mcp_Search', cache_control: oneHour })
        // The subscription's system[] starts with a per-conversation billing block: no marker.
        expect(JSON.stringify(body.system)).not.toContain('cache_control')
        expect(JSON.stringify(body.messages[0])).not.toContain('cache_control')
        // The previous request's end (the result before the latest assistant turn).
        expect(body.messages[2]).toEqual({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call-1',
              content: 'result call-1',
              cache_control: oneHour
            }
          ]
        })
        // This request's end, then the volatile turn context after the breakpoint.
        expect(body.messages[4]).toEqual({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call-2',
              content: 'result call-2',
              cache_control: oneHour
            },
            { type: 'text', text: 'Now: 12:00' }
          ]
        })
        expect(markerCount(JSON.stringify(body))).toBe(3)
      })
    )

    it.effect('defaults to the five-minute lifetime', () =>
      Effect.gen(function* () {
        const body = yield* toAnthropicClaudeRequestBody(baseRequest, { maxTokens: 100 })

        expect(body.tools?.[1]?.cache_control).toEqual({ type: 'ephemeral' })
      })
    )

    it.effect('keeps tool definitions but forbids calls with toolChoice none', () =>
      Effect.gen(function* () {
        const body = yield* toAnthropicClaudeRequestBody(
          { ...baseRequest, toolChoice: 'none' },
          { maxTokens: 100 }
        )

        expect(body.tools).toHaveLength(2)
        expect(body.tool_choice).toEqual({ type: 'none' })
      })
    )

    it.effect('marks an assistant-ending conversation before the turn context', () =>
      Effect.gen(function* () {
        const body = yield* toAnthropicClaudeRequestBody(
          {
            ...baseRequest,
            tools: [],
            messages: [
              UserMessage.make({ content: 'first' }),
              AssistantAgentMessage.make({ parts: [AssistantTextPart.make({ content: 'reply' })] })
            ],
            turnContext: 'Now: 12:00'
          },
          { maxTokens: 100 }
        )

        expect(body.messages[1]).toEqual({
          role: 'assistant',
          content: [{ type: 'text', text: 'reply', cache_control: { type: 'ephemeral' } }]
        })
        expect(body.messages[2]).toEqual({
          role: 'user',
          content: [{ type: 'text', text: 'Now: 12:00' }]
        })
      })
    )

    it.effect('never marks an empty text block', () =>
      Effect.gen(function* () {
        const body = yield* toAnthropicClaudeRequestBody(
          {
            ...baseRequest,
            systemPrompt: '',
            tools: [],
            messages: [
              UserMessage.make({ content: 'first' }),
              AssistantAgentMessage.make({ parts: [AssistantTextPart.make({ content: 'reply' })] }),
              UserMessage.make({ content: '' })
            ]
          },
          { maxTokens: 100 }
        )

        expect(JSON.stringify(body.messages[2])).not.toContain('cache_control')
      })
    )

    it.effect('drops toolChoice none without tools on every transport', () =>
      Effect.gen(function* () {
        const request = { ...baseRequest, tools: [], toolChoice: 'none' as const }
        const anthropic = yield* toAnthropicClaudeRequestBody(request, { maxTokens: 100 })
        const codex = yield* toOpenAiCodexRequestBody(request)
        const chat = yield* toOpenAiRequestBody(request, { maxCompletionTokens: 100 })

        expect(anthropic).not.toHaveProperty('tool_choice')
        expect(codex).not.toHaveProperty('tool_choice')
        expect(chat).not.toHaveProperty('tool_choice')
      })
    )

    it.effect('keeps a random per-layer session header without a cache key', () =>
      Effect.gen(function* () {
        const requests: Array<HttpClientRequest.HttpClientRequest> = []
        const first = makeAnthropicClaudeProviderLayer({ token: claudeToken, maxTokens: 100 })
        const second = makeAnthropicClaudeProviderLayer({ token: claudeToken, maxTokens: 100 })

        yield* Effect.gen(function* () {
          const provider = yield* LLMProvider

          yield* provider.stream(baseRequest).pipe(Stream.runCollect, Effect.ignore)
          yield* provider.stream(baseRequest).pipe(Stream.runCollect, Effect.ignore)
        }).pipe(
          Effect.provide(first.pipe(Layer.provide(capturingHttpClient(requests, emptyResponse))))
        )

        yield* send(second, requests, baseRequest)

        const sessionIds = requests.map(request => request.headers['x-claude-code-session-id'])

        expect(sessionIds[0]).toBeDefined()
        expect(sessionIds[1]).toBe(sessionIds[0])
        expect(sessionIds[2]).not.toBe(sessionIds[0])
      })
    )

    it.effect('derives a stable UUID session header from the cache key', () =>
      Effect.gen(function* () {
        const requests: Array<HttpClientRequest.HttpClientRequest> = []
        const layer = makeAnthropicClaudeProviderLayer({ token: claudeToken, maxTokens: 100 })

        yield* send(layer, requests, { ...baseRequest, cacheKey: 'session-1' })
        yield* send(layer, requests, { ...baseRequest, cacheKey: 'session-1' })
        yield* send(layer, requests, { ...baseRequest, cacheKey: 'session-2' })

        const sessionIds = requests.map(request => request.headers['x-claude-code-session-id'])

        expect(sessionIds[0]).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
        )
        expect(sessionIds[1]).toBe(sessionIds[0])
        expect(sessionIds[2]).not.toBe(sessionIds[0])
      })
    )

    it.effect('native Messages marks the system prompt too, within four breakpoints', () =>
      Effect.gen(function* () {
        const requests: Array<HttpClientRequest.HttpClientRequest> = []

        yield* send(goLayer('messages'), requests, { ...baseRequest, cacheKey: 'session-1' })

        const json = bodyText(requests[0])

        expect(decodeJson(json)).toMatchObject({
          system: [{ type: 'text', text: 'Be concise.', cache_control: { type: 'ephemeral' } }]
        })
        expect(markerCount(json)).toBe(4)
        expect(requests[0]?.headers['x-opencode-session']).toBe('session-1')
      })
    )
  })

  describe('Responses', () => {
    it.effect('Codex sends the cache key as prompt_cache_key and session-id', () =>
      Effect.gen(function* () {
        const requests: Array<HttpClientRequest.HttpClientRequest> = []

        const layer = makeOpenAiCodexProviderLayer({
          token: new OAuthAccessToken({
            provider: 'openai-codex',
            accessToken: 'token',
            expiresAt: Date.now() + 60_000
          })
        })

        yield* send(layer, requests, { ...baseRequest, cacheKey: 'session-1' })
        yield* send(layer, requests, baseRequest)

        expect(decodeJson(bodyText(requests[0]))).toMatchObject({ prompt_cache_key: 'session-1' })
        expect(requests[0]?.headers['session-id']).toBe('session-1')
        expect(bodyText(requests[1])).not.toContain('prompt_cache_key')
        expect(requests[1]?.headers).not.toHaveProperty('session-id')
      })
    )

    it.effect('Grok sends the cache key as prompt_cache_key and x-grok-conv-id', () =>
      Effect.gen(function* () {
        const requests: Array<HttpClientRequest.HttpClientRequest> = []

        const layer = makeXAiGrokProviderLayer({
          token: new OAuthAccessToken({
            provider: xAiGrokProviderId,
            accessToken: 'token',
            expiresAt: Date.now() + 60_000
          }),
          maxOutputTokens: 100,
          clientVersion: '0.2.95'
        })

        yield* send(layer, requests, { ...baseRequest, cacheKey: 'session-1' })

        expect(decodeJson(bodyText(requests[0]))).toMatchObject({ prompt_cache_key: 'session-1' })
        expect(requests[0]?.headers['x-grok-conv-id']).toBe('session-1')
      })
    )

    it.effect('Go Responses sends only the session header and appends turn context last', () =>
      Effect.gen(function* () {
        const requests: Array<HttpClientRequest.HttpClientRequest> = []

        yield* send(goLayer('responses'), requests, {
          ...baseRequest,
          cacheKey: 'session-1',
          turnContext: 'Now: 12:00'
        })

        const json = bodyText(requests[0])

        expect(json).not.toContain('prompt_cache_key')
        expect(requests[0]?.headers['x-opencode-session']).toBe('session-1')
        expect(decodeJson(json)).toMatchObject({
          input: expect.arrayContaining([
            { role: 'user', content: [{ type: 'input_text', text: 'Now: 12:00' }] }
          ])
        })
        expect(json.indexOf('Now: 12:00')).toBeGreaterThan(json.indexOf('result call-2'))
      })
    )
  })

  describe('Chat Completions', () => {
    it.effect('Gateway enables automatic caching and session affinity', () =>
      Effect.gen(function* () {
        const requests: Array<HttpClientRequest.HttpClientRequest> = []

        const layer = makeVercelAiGatewayProviderLayer({
          apiKey: Redacted.make('gateway-key'),
          maxCompletionTokens: 100
        })

        yield* send(
          layer,
          requests,
          { ...baseRequest, cacheKey: 'session-1', turnContext: 'Now: 12:00', toolChoice: 'none' },
          chatResponse
        )

        expect(requests[0]?.headers['x-session-affinity']).toBe('session-1')

        const body = decodeJson(bodyText(requests[0]))

        expect(body).toMatchObject({
          providerOptions: { gateway: { caching: 'auto' } },
          tool_choice: 'none'
        })
      })
    )

    it.effect('Go chat sends the session header without body cache fields', () =>
      Effect.gen(function* () {
        const requests: Array<HttpClientRequest.HttpClientRequest> = []

        yield* send(goLayer('chat-completions'), requests, {
          ...baseRequest,
          cacheKey: 'session-1'
        })

        expect(requests[0]?.headers['x-opencode-session']).toBe('session-1')
        expect(bodyText(requests[0])).not.toContain('prompt_cache_key')
      })
    )

    it.effect('lets required auth win over cache-key headers', () =>
      Effect.gen(function* () {
        const requests: Array<HttpClientRequest.HttpClientRequest> = []

        yield* send(
          makeOpenAiProviderLayer({
            apiKey: Redacted.make('real-key'),
            maxCompletionTokens: 100,
            cacheKeyHeaders: cacheKey => ({
              authorization: 'Bearer stolen',
              'x-session': cacheKey
            })
          }),
          requests,
          { ...baseRequest, cacheKey: 'session-1' },
          chatResponse
        )

        expect(requests[0]?.headers['authorization']).toBe('Bearer real-key')
        expect(requests[0]?.headers['x-session']).toBe('session-1')
      })
    )

    it.effect('orders Go headers the same on every protocol: extras, cache key, auth', () =>
      Effect.gen(function* () {
        for (const protocol of ['chat-completions', 'messages', 'responses'] as const) {
          const requests: Array<HttpClientRequest.HttpClientRequest> = []

          yield* send(
            makeOpenCodeGoProviderLayer({
              apiKey: Redacted.make('go-key'),
              protocol,
              maxOutputTokens: 100,
              extraHeaders: { 'x-opencode-session': 'host-value' }
            }),
            requests,
            { ...baseRequest, cacheKey: 'session-1' }
          )

          expect(requests[0]?.headers['x-opencode-session']).toBe('session-1')
        }
      })
    )

    it.effect('appends turn context as the final message', () =>
      Effect.gen(function* () {
        const requests: Array<HttpClientRequest.HttpClientRequest> = []

        yield* send(
          makeVercelAiGatewayProviderLayer({
            apiKey: Redacted.make('gateway-key'),
            maxCompletionTokens: 100
          }),
          requests,
          { ...baseRequest, turnContext: 'Now: 12:00' },
          chatResponse
        )

        expect(decodeJson(bodyText(requests[0]))).toMatchObject({
          messages: [
            { role: 'system' },
            { role: 'user' },
            { role: 'assistant' },
            { role: 'tool' },
            { role: 'assistant' },
            { role: 'tool', content: 'result call-2' },
            { role: 'user', content: 'Now: 12:00' }
          ]
        })
      })
    )
  })
})
