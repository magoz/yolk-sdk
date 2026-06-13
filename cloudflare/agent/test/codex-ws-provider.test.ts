import { describe, expect, it } from 'vitest'
import { Effect, Layer, Stream } from 'effect'
import { HttpClient, HttpClientResponse, type HttpClientRequest } from 'effect/unstable/http'
import {
  LLMDone,
  LLMError,
  LLMProvider,
  LLMReasoningDelta,
  LLMTextDelta,
  LLMToolCall,
  LLMUsage
} from '@yolk-sdk/agent/loop'
import { UserMessage } from '@yolk-sdk/agent/protocol'

import { TokenBrokerResponse } from '@yolk-sdk/agent/oauth'
import { openAiCodexProviderId } from '@yolk-sdk/agent/providers/openai/codex'
import {
  codexWsHeaders,
  makeCodexWsProviderLayer,
  makePreStreamFallbackProvider,
  mapWsMessage,
  toWsRequestBody,
  type WsResult
} from '../src/codex-ws-provider.ts'

const token = new TokenBrokerResponse({
  provider: openAiCodexProviderId,
  accessToken: 'access',
  expiresAt: Date.now() + 60_000,
  accountId: 'account'
})

const events = (result: WsResult) => (result._tag === 'Events' || result._tag === 'Done' ? result.events : [])
const errorMessage = (result: WsResult) => (result._tag === 'Error' ? result.error.message : undefined)
const errorCause = (result: WsResult) => (result._tag === 'Error' ? result.error.cause : undefined)
const errorRetryable = (result: WsResult) => (result._tag === 'Error' ? result.error.retryable : undefined)

const request = {
  model: 'gpt-5.4',
  systemPrompt: 'Be brief.',
  messages: [UserMessage.make({ content: 'hello' })],
  tools: []
}

type CapturedRequest = {
  readonly request: HttpClientRequest.HttpClientRequest
}

const makeProxyHttpClientLayer = (requests: Array<CapturedRequest>) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(httpRequest =>
      Effect.sync(() => {
        requests.push({ request: httpRequest })

        return HttpClientResponse.fromWeb(
          httpRequest,
          new Response(
            [
              'event: response.output_text.delta',
              'data: {"type":"response.output_text.delta","delta":"proxy ok","item_id":"msg_1"}',
              '',
              'event: response.completed',
              'data: {"type":"response.completed","response":{"output":[{"type":"message","content":[{"type":"output_text","text":"proxy ok"}]}]}}',
              ''
            ].join('\n'),
            { status: 200, headers: { 'content-type': 'text/plain' } }
          )
        )
      })
    )
  )

const directError = new LLMError({
  cause: 'provider_error',
  message: 'direct failed',
  retryable: true
})

describe('Codex WS headers', () => {
  it('includes auth and protocol headers without Upgrade', () => {
    const headers = codexWsHeaders({ token })

    expect(headers.Upgrade).toBeUndefined()
    expect(headers.Authorization).toBe('Bearer access')
    expect(headers['OpenAI-Beta']).toBe('responses_websockets=2026-02-06')
    expect(headers.originator).toBe('opencode')
    expect(headers['User-Agent']).toContain('opencode/')
    expect(headers['x-codex-installation-id']).toBe('yolk-cloudflare-agent')
    expect(headers['x-openai-internal-codex-residency']).toBe('us')
    expect(headers['x-client-request-id']).toBeTypeOf('string')
    expect(headers['ChatGPT-Account-Id']).toBe('account')
  })

  it('includes session_id when provided', () => {
    const headers = codexWsHeaders({ token, sessionId: 'session_1' })

    expect(headers['session_id']).toBe('session_1')
  })

  it('omits session_id and account when absent', () => {
    const noAccount = new TokenBrokerResponse({
      provider: openAiCodexProviderId,
      accessToken: 'access',
      expiresAt: Date.now() + 60_000
    })
    const headers = codexWsHeaders({ token: noAccount })

    expect(headers['ChatGPT-Account-Id']).toBeUndefined()
    expect(headers['session_id']).toBeUndefined()
  })
})

describe('Codex WS request body', () => {
  it('keeps stream true for response.create', async () => {
    const body = await Effect.runPromise(
      toWsRequestBody({
        model: 'gpt-5.4',
        systemPrompt: 'You are a smoke test assistant.',
        messages: [UserMessage.make({ content: 'Reply with exactly: pong' })],
        tools: [],
        reasoningEffort: 'low'
      })
    )

    expect(body.type).toBe('response.create')
    expect(body.stream).toBe(true)
    expect(body.instructions).toBe('You are a smoke test assistant.')
    expect(body.input).toEqual([{ role: 'user', content: 'Reply with exactly: pong' }])
    expect(body.reasoning.effort).toBe('low')
  })
})

describe('Codex WS proxy fallback', () => {
  it('uses proxy first when fallback is configured', async () => {
    const requests: Array<CapturedRequest> = []
    const layer = makeCodexWsProviderLayer({
      token,
      sessionId: 'session_1',
      fallback: {
        endpoint: 'https://app.example.test/api/internal/cloudflare/codex-responses',
        bridgeSecret: 'bridge-secret'
      }
    }).pipe(Layer.provide(makeProxyHttpClientLayer(requests)))

    const chunk = await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* LLMProvider
        return yield* provider.stream(request).pipe(Stream.runCollect)
      }).pipe(Effect.provide(layer))
    )

    const collected = Array.from(chunk)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.request.url).toBe(
      'https://app.example.test/api/internal/cloudflare/codex-responses'
    )
    expect(collected.map(event => event._tag)).toEqual(['TextDelta', 'Done'])
  })

  it('uses fallback when direct fails before events', async () => {
    let fallbackCalls = 0
    const fallbackErrors: Array<LLMError> = []
    const direct = LLMProvider.of({
      stream: () => Stream.fail(directError)
    })
    const fallback = LLMProvider.of({
      stream: () => {
        fallbackCalls += 1
        return Stream.make(LLMTextDelta.make({ text: 'ok' }), LLMDone.make({ stopReason: 'stop' }))
      }
    })
    const provider = makePreStreamFallbackProvider(direct, fallback, error => {
      fallbackErrors.push(error)
    })

    const chunk = await Effect.runPromise(provider.stream(request).pipe(Stream.runCollect))
    const collected = Array.from(chunk)

    expect(fallbackCalls).toBe(1)
    expect(fallbackErrors).toEqual([directError])
    expect(collected.map(event => event._tag)).toEqual(['TextDelta', 'Done'])
  })

  it('does not fallback after direct emitted events', async () => {
    let fallbackCalls = 0
    const direct = LLMProvider.of({
      stream: () =>
        Stream.make(LLMTextDelta.make({ text: 'partial' })).pipe(Stream.concat(Stream.fail(directError)))
    })
    const fallback = LLMProvider.of({
      stream: () => {
        fallbackCalls += 1
        return Stream.make(LLMDone.make({ stopReason: 'stop' }))
      }
    })
    const provider = makePreStreamFallbackProvider(direct, fallback, () => {})

    const result = await Effect.runPromise(provider.stream(request).pipe(Stream.runCollect, Effect.result))

    expect(fallbackCalls).toBe(0)
    expect(result).toMatchObject({
      _tag: 'Failure',
      failure: {
        _tag: 'LLMError',
        message: 'direct failed'
      }
    })
  })
})

describe('Codex WS event mapping', () => {
  it('maps text delta', () => {
    const result = mapWsMessage({ type: 'response.output_text.delta', delta: 'hello' }, 0)

    expect(result._tag).toBe('Events')
    expect(events(result)).toHaveLength(1)
    expect(events(result)[0]).toBeInstanceOf(LLMTextDelta)
  })

  it('maps content_part.delta as text', () => {
    const result = mapWsMessage({ type: 'response.content_part.delta', delta: 'world' }, 0)

    expect(result._tag).toBe('Events')
    expect(events(result)[0]).toBeInstanceOf(LLMTextDelta)
  })

  it('maps reasoning summary delta', () => {
    const result = mapWsMessage(
      { type: 'response.reasoning_summary_text.delta', delta: 'thinking' },
      0
    )

    expect(result._tag).toBe('Events')
    expect(events(result)[0]).toBeInstanceOf(LLMReasoningDelta)
  })

  it('maps tool call from output_item.done', () => {
    const result = mapWsMessage(
      {
        type: 'response.output_item.done',
        item: {
          type: 'function_call',
          call_id: 'call_1',
          name: 'web_search',
          arguments: '{"q":"test"}'
        }
      },
      0
    )

    expect(result._tag).toBe('Events')
    const tc = events(result)[0]
    expect(tc).toBeInstanceOf(LLMToolCall)
  })

  it('maps completed with stop reason and usage', () => {
    const result = mapWsMessage(
      {
        type: 'response.completed',
        response: {
          id: 'resp_1',
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }],
          usage: { input_tokens: 10, output_tokens: 5 }
        }
      },
      0
    )

    expect(result._tag).toBe('Done')
    const evts = events(result)
    expect(evts[0]).toBeInstanceOf(LLMDone)
    expect(evts[1]).toBeInstanceOf(LLMUsage)
  })

  it('returns tool_use stop when tool calls were streamed', () => {
    const result = mapWsMessage(
      {
        type: 'response.completed',
        response: { id: 'resp_1', output: [], usage: { input_tokens: 10, output_tokens: 5 } }
      },
      1
    )

    expect(result._tag).toBe('Done')
    const done = events(result)[0]
    expect(done).toBeInstanceOf(LLMDone)
    expect(done !== undefined && 'stopReason' in done ? done.stopReason : undefined).toBe(
      'tool_use'
    )
  })

  it('returns tool_use stop from completed output even without streamed calls', () => {
    const result = mapWsMessage(
      {
        type: 'response.completed',
        response: {
          id: 'resp_1',
          output: [{ type: 'function_call', call_id: 'c1', name: 'fn', arguments: '{}' }]
        }
      },
      0
    )

    expect(result._tag).toBe('Done')
    const done = events(result)[0]
    expect(done).toBeInstanceOf(LLMDone)
    expect(done !== undefined && 'stopReason' in done ? done.stopReason : undefined).toBe(
      'tool_use'
    )
  })

  it('maps response.failed to error', () => {
    const result = mapWsMessage(
      {
        type: 'response.failed',
        response: { error: { message: 'rate limit exceeded' } }
      },
      0
    )

    expect(result._tag).toBe('Error')
    expect(errorMessage(result)).toBe('rate limit exceeded')
  })

  it('maps connection error event', () => {
    const result = mapWsMessage(
      { type: 'error', error: { code: 'rate_limit', message: 'slow down' } },
      0
    )

    expect(result._tag).toBe('Error')
    expect(errorCause(result)).toBe('rate_limit')
    expect(errorRetryable(result)).toBe(true)
  })

  it('skips unknown event types', () => {
    expect(mapWsMessage({ type: 'response.created' }, 0)._tag).toBe('Skip')
    expect(mapWsMessage({ type: 'response.output_item.added' }, 0)._tag).toBe('Skip')
    expect(mapWsMessage({}, 0)._tag).toBe('Skip')
  })
})
