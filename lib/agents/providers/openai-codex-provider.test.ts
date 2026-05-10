import { Effect, Stream } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { ToolDef, UserMessage } from '@yolk/protocol'
import { LLMProvider } from '@yolk/agent-loop'
import { OPENAI_CODEX_RESPONSES_URL } from '@/lib/services/openai-codex-oauth/live-layer'
import type { OpenAiCodexOAuthToken } from '@/lib/services/openai-codex-oauth/schemas'
import { makeOpenAiCodexProviderLayer } from './openai-codex-provider'

type CapturedRequest = {
  readonly input: RequestInfo | URL
  readonly init?: RequestInit
}

const token: OpenAiCodexOAuthToken = {
  type: 'oauth',
  refresh: 'refresh-token',
  access: 'access-token',
  expires: Date.now() + 60_000,
  accountId: 'acct_test'
}

const makeFetch = (responseBody: unknown, requests: Array<CapturedRequest>, status = 200): typeof fetch =>
  (input, init) => {
    requests.push({ input, init })
    return Promise.resolve(
      new Response(JSON.stringify(responseBody), {
        status,
        headers: { 'content-type': 'application/json' }
      })
    )
  }

const makeRawFetch = (responseBody: string, requests: Array<CapturedRequest>): typeof fetch =>
  (input, init) => {
    requests.push({ input, init })
    return Promise.resolve(
      new Response(responseBody, {
        status: 200,
        headers: { 'content-type': 'text/plain' }
      })
    )
  }

const readCapturedBody = (requests: ReadonlyArray<CapturedRequest>) => {
  const body = requests[0]?.init?.body
  expect(typeof body).toBe('string')

  if (typeof body !== 'string') {
    expect.fail('Expected OpenAI Codex request body to be a string')
  }

  return JSON.parse(body)
}

const readCapturedHeaders = (requests: ReadonlyArray<CapturedRequest>) => {
  const headers = requests[0]?.init?.headers
  expect(headers).toBeInstanceOf(Headers)

  if (!(headers instanceof Headers)) {
    expect.fail('Expected OpenAI Codex request headers to be Headers')
  }

  return headers
}

describe('OpenAiCodexProviderLayer', () => {
  it.effect('maps a text request to OpenAI Codex responses', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      const layer = makeOpenAiCodexProviderLayer({
        token,
        fetch: makeFetch({ output_text: 'ok', output: [] }, requests)
      })

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

      expect(requests[0]?.input).toBe(OPENAI_CODEX_RESPONSES_URL)
      expect(headers.get('authorization')).toBe('Bearer access-token')
      expect(headers.get('ChatGPT-Account-Id')).toBe('acct_test')
      expect(requestBody).toMatchObject({
        model: 'gpt-5.4',
        instructions: 'Be brief.',
        input: [{ role: 'user', content: 'hello' }],
        store: false,
        stream: true
      })
      expect(Array.from(eventsChunk).map(event => event._tag)).toEqual(['TextDelta', 'Done'])
    }))

  it.effect('maps OpenAI Codex function calls to tool call events', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      const layer = makeOpenAiCodexProviderLayer({
        token,
        fetch: makeFetch(
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
      })

      const eventsChunk = yield* Effect.gen(function* () {
        const provider = yield* LLMProvider
        return yield* provider
          .stream({
            messages: [UserMessage.make({ content: 'weather?' })],
            tools: [
              ToolDef.make({ name: 'weather', description: 'Get weather.', parameters: {} })
            ],
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
    }))

  it.effect('parses OpenAI Codex SSE even when content type is not event-stream', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      const layer = makeOpenAiCodexProviderLayer({
        token,
        fetch: makeRawFetch(
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
      })

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
      expect(
        events.map(event => (event._tag === 'TextDelta' ? event.text : event._tag))
      ).toEqual(['oauth ', 'smoke ok', 'Done'])
    }))
})
