import { Effect, Layer, Match, Predicate, Redacted, Stream } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { HttpClient, HttpClientResponse, type HttpClientRequest } from 'effect/unstable/http'
import { LLMProvider, type LLMRequest } from '@yolk-sdk/agent/loop'
import {
  AssistantAgentMessage,
  AssistantReasoningPart,
  HostToolCallPart,
  ToolCall,
  ToolDef,
  ToolResultMessage,
  UserMessage
} from '@yolk-sdk/agent/protocol'
import { makeOpenAiProviderLayer } from '@yolk-sdk/agent/providers/openai/provider'
import {
  makeOpenCodeGoProviderLayer,
  openCodeGoBaseUrl,
  openCodeGoProviderId,
  type OpenCodeGoProtocol,
  type OpenCodeGoProviderConfig
} from '@yolk-sdk/agent/providers/opencode/go-provider'

const protocols: ReadonlyArray<OpenCodeGoProtocol> = ['chat-completions', 'messages', 'responses']

const input: LLMRequest = {
  model: 'opaque-model-id',
  systemPrompt: 'Be helpful.',
  messages: [UserMessage.make({ content: 'Hello' })],
  tools: []
}

const sse = (events: ReadonlyArray<unknown>) =>
  new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''))

const success = (protocol: OpenCodeGoProtocol) => {
  switch (protocol) {
    case 'chat-completions':
      return Response.json({ choices: [{ message: { content: 'Hello' }, finish_reason: 'stop' }] })
    case 'messages':
      return sse([
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
        { type: 'message_stop' }
      ])
    case 'responses':
      return sse([
        { type: 'response.output_text.delta', delta: 'Hello' },
        { type: 'response.completed', response: { output: [] } }
      ])
  }
}

const run = (
  protocol: OpenCodeGoProtocol,
  response: Response,
  requests: Array<HttpClientRequest.HttpClientRequest>,
  request: LLMRequest = input,
  overrides: Partial<OpenCodeGoProviderConfig> = {}
) =>
  Effect.gen(function* () {
    const provider = yield* LLMProvider

    return yield* provider.stream(request).pipe(Stream.runCollect)
  }).pipe(
    Effect.provide(
      makeOpenCodeGoProviderLayer({
        apiKey: Redacted.make('go-key'),
        protocol,
        maxOutputTokens: 2048,
        ...overrides
      }).pipe(
        Layer.provide(
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make(request =>
              Effect.sync(() => {
                requests.push(request)

                return HttpClientResponse.fromWeb(request, response)
              })
            )
          )
        )
      )
    )
  )

const bodyOf = (requests: ReadonlyArray<HttpClientRequest.HttpClientRequest>) => {
  const body = requests[0]?.body

  if (body?._tag !== 'Uint8Array') expect.fail('Expected JSON request body')

  return JSON.parse(new TextDecoder().decode(body.body))
}

const tool = ToolDef.make({
  name: 'mcp_Search',
  description: 'Search',
  parameters: {
    type: 'object',
    properties: { query: { anyOf: [{ type: 'string' }, { type: 'null' }] } }
  }
})

const call = ToolCall.make({ id: 'call-1', name: tool.name, params: { query: 'yolk' } })

const replay: LLMRequest = {
  ...input,
  tools: [tool],
  messages: [
    ...input.messages,
    AssistantAgentMessage.make({
      parts: [
        AssistantReasoningPart.make({ text: 'Search first.' }),
        HostToolCallPart.make({ call })
      ]
    }),
    ToolResultMessage.make({ toolCallId: call.id, content: 'Found it', isError: false })
  ]
}

describe('OpenCode Go', () => {
  for (const protocol of protocols) {
    it.effect(`${protocol}: uses Go endpoint, opaque model, required headers and host limit`, () =>
      Effect.gen(function* () {
        const requests: Array<HttpClientRequest.HttpClientRequest> = []

        const events = yield* run(
          protocol,
          success(protocol),
          requests,
          { ...input, reasoningEffort: 'high' },
          {
            extraHeaders: {
              Authorization: 'wrong',
              'X-Api-Key': 'wrong',
              Accept: 'wrong',
              'Content-Type': 'wrong',
              'Anthropic-Version': 'wrong',
              'x-host': 'host'
            }
          }
        )

        const endpoint = protocol === 'chat-completions' ? 'chat/completions' : protocol
        expect(requests[0]?.url).toBe(`${openCodeGoBaseUrl}/${endpoint}`)
        expect(requests[0]?.headers).toMatchObject({
          'content-type': 'application/json',
          'x-host': 'host',
          ...(protocol === 'messages'
            ? {
                'x-api-key': 'go-key',
                'anthropic-version': '2023-06-01',
                accept: 'text/event-stream'
              }
            : {
                authorization: 'Bearer go-key',
                accept: protocol === 'responses' ? 'text/event-stream' : 'application/json'
              })
        })
        const body = bodyOf(requests)
        expect(body.model).toBe('opaque-model-id')
        expect(body).not.toHaveProperty('max_completion_tokens')
        expect(body).toMatchObject(
          Match.value(protocol).pipe(
            Match.when('responses', () => ({
              instructions: input.systemPrompt,
              max_output_tokens: 2048,
              stream: true,
              store: false,
              reasoning: { effort: 'high', summary: 'auto' }
            })),
            Match.when('messages', () => ({
              system: [{ type: 'text', text: input.systemPrompt }],
              max_tokens: 2048,
              stream: true,
              output_config: { effort: 'high' }
            })),
            Match.when('chat-completions', () => ({
              messages: [
                { role: 'system', content: input.systemPrompt },
                { role: 'user', content: 'Hello' }
              ],
              max_tokens: 2048,
              stream: false,
              reasoning_effort: 'high'
            })),
            Match.exhaustive
          )
        )
        expect(events).toMatchObject([
          { _tag: 'TextDelta', text: 'Hello' },
          { _tag: 'Done', stopReason: 'stop' }
        ])
        expect(JSON.stringify(body)).not.toContain('Claude Code')
        expect(requests[0]?.headers).not.toHaveProperty('originator')
        expect(requests[0]?.headers).not.toHaveProperty('anthropic-beta')
      })
    )

    it.effect(`${protocol}: supports trusted proxy and omits unselected reasoning`, () =>
      Effect.gen(function* () {
        const requests: Array<HttpClientRequest.HttpClientRequest> = []
        yield* run(protocol, success(protocol), requests, input, {
          baseUrl: 'https://proxy.example/go///'
        })
        expect(requests[0]?.url).toBe(
          `https://proxy.example/go/${protocol === 'chat-completions' ? 'chat/completions' : protocol}`
        )
        const body = bodyOf(requests)
        expect(body).not.toHaveProperty('reasoning')
        expect(body).not.toHaveProperty('reasoning_effort')
        expect(body).not.toHaveProperty('output_config')
      })
    )

    for (const status of [401, 429, 503]) {
      it.effect(`${protocol}: classifies HTTP ${status} without leaking error bodies`, () =>
        Effect.gen(function* () {
          const error = yield* run(
            protocol,
            Response.json(
              { error: { message: 'private-upstream-text' } },
              {
                status,
                headers: { 'retry-after': '2' }
              }
            ),
            []
          ).pipe(Effect.flip)

          expect(error).toMatchObject({
            _tag: 'LLMError',
            retryable: status !== 401,
            provider: {
              provider: openCodeGoProviderId,
              status,
              kind: Match.value(status).pipe(
                Match.when(401, () => 'auth'),
                Match.when(429, () => 'rate_limit'),
                Match.orElse(() => 'server_error')
              ),
              retryAfterMs: 2000
            }
          })
          expect(error.message).not.toContain('private-upstream-text')
          expect(error.message).not.toContain('go-key')
        })
      )
    }

    it.effect(`${protocol}: validates credentials and limits before HTTP`, () =>
      Effect.gen(function* () {
        for (const maxOutputTokens of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
          const requests: Array<HttpClientRequest.HttpClientRequest> = []

          const error = yield* run(protocol, success(protocol), requests, input, {
            maxOutputTokens
          }).pipe(Effect.flip)

          expect(error.cause).toBe('validation_error')
          expect(requests).toHaveLength(0)
        }

        const requests: Array<HttpClientRequest.HttpClientRequest> = []

        const error = yield* run(protocol, success(protocol), requests, input, {
          apiKey: Redacted.make(' ')
        }).pipe(Effect.flip)

        expect(error.cause).toBe('validation_error')
        expect(requests).toHaveLength(0)
      })
    )

    it.effect(`${protocol}: preserves tool names and transcript replay`, () =>
      Effect.gen(function* () {
        const requests: Array<HttpClientRequest.HttpClientRequest> = []
        yield* run(protocol, success(protocol), requests, replay)
        const body = bodyOf(requests)
        expect(JSON.stringify(body)).toContain('mcp_Search')
        expect(JSON.stringify(body)).not.toContain('mcp_Mcp_Search')

        if (protocol === 'messages') {
          expect(body.tools).toEqual([
            { name: tool.name, description: tool.description, input_schema: tool.parameters }
          ])
          expect(body.messages[1]).toMatchObject({
            role: 'assistant',
            content: [{ type: 'tool_use', id: call.id, name: tool.name, input: call.params }]
          })
          expect(body.messages[2]).toMatchObject({
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: call.id, content: 'Found it' }]
          })
        } else if (protocol === 'chat-completions') {
          expect(body.messages[2]).toMatchObject({
            role: 'assistant',
            reasoning_content: 'Search first.',
            tool_calls: [
              { id: call.id, function: { name: tool.name, arguments: '{"query":"yolk"}' } }
            ]
          })
          expect(body.messages[3]).toMatchObject({
            role: 'tool',
            tool_call_id: call.id,
            content: 'Found it'
          })
        } else {
          expect(body.input[1]).toMatchObject({
            type: 'function_call',
            call_id: call.id,
            name: tool.name,
            arguments: '{"query":"yolk"}'
          })
          expect(body.input[2]).toMatchObject({
            type: 'function_call_output',
            call_id: call.id,
            output: 'Found it'
          })
        }
      })
    )

    it.effect(`${protocol}: rejects malformed response JSON`, () =>
      Effect.gen(function* () {
        const error = yield* run(protocol, new Response('{broken'), []).pipe(Effect.flip)
        expect(error).toMatchObject({ cause: 'invalid_response', retryable: false })
      })
    )
  }

  it.effect('chat: validates reasoning only when the compatible extension is enabled', () =>
    Effect.gen(function* () {
      const json = { choices: [{ message: { content: 'Hello', reasoning_content: 123 } }] }
      const error = yield* run('chat-completions', Response.json(json), []).pipe(Effect.flip)
      expect(error).toMatchObject({ cause: 'invalid_response', retryable: false })

      const events = yield* Effect.gen(function* () {
        const provider = yield* LLMProvider

        return yield* provider.stream(input).pipe(Stream.runCollect)
      }).pipe(
        Effect.provide(
          makeOpenAiProviderLayer({
            apiKey: Redacted.make('key'),
            maxCompletionTokens: 2048
          }).pipe(
            Layer.provide(
              Layer.succeed(
                HttpClient.HttpClient,
                HttpClient.make(request =>
                  Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(json)))
                )
              )
            )
          )
        )
      )

      expect(events).toMatchObject([{ _tag: 'TextDelta', text: 'Hello' }, { _tag: 'Done' }])
    })
  )

  it.effect('chat: preserves provider reasoning, tool calls and usage', () =>
    Effect.gen(function* () {
      const events = yield* run(
        'chat-completions',
        Response.json({
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                content: null,
                reasoning_content: 'Search first.',
                tool_calls: [
                  {
                    id: call.id,
                    type: 'function',
                    function: { name: tool.name, arguments: '{"query":"yolk"}' }
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
        }),
        []
      )

      expect(events).toMatchObject([
        { _tag: 'ReasoningDelta', text: 'Search first.' },
        { _tag: 'ToolCall', call },
        { _tag: 'Done', stopReason: 'tool_use' },
        {
          _tag: 'Usage',
          usage: {
            input: { total: 10, uncached: 8, cacheRead: 2 },
            output: { total: 5, reasoning: 3, text: 2 }
          }
        }
      ])
    })
  )

  it.effect('messages: parses native JSON tool names, reasoning and usage', () =>
    Effect.gen(function* () {
      const events = yield* run(
        'messages',
        Response.json({
          content: [
            { type: 'thinking', thinking: 'Search first.' },
            { type: 'tool_use', id: call.id, name: tool.name, input: call.params }
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 }
        }),
        []
      )

      expect(events).toMatchObject([
        { _tag: 'ReasoningDelta', text: 'Search first.' },
        { _tag: 'ToolCall', call },
        { _tag: 'Done', stopReason: 'tool_use' },
        {
          _tag: 'Usage',
          usage: { input: { total: 12, uncached: 10, cacheRead: 2 }, output: { total: 5 } }
        }
      ])
    })
  )

  it.effect(
    'messages: streams split tool arguments and additive usage, ignoring terminal replays',
    () =>
      Effect.gen(function* () {
        const events = yield* run(
          'messages',
          sse([
            { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } },
            {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'tool_use', id: call.id, name: tool.name }
            },
            {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'input_json_delta', partial_json: '{"query":' }
            },
            {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'input_json_delta', partial_json: '"yolk"}' }
            },
            { type: 'content_block_stop', index: 0 },
            {
              type: 'message_delta',
              delta: { stop_reason: 'tool_use' },
              usage: { output_tokens: 5 }
            },
            { type: 'message_stop' },
            { type: 'message_stop' }
          ]),
          []
        )

        expect(events.filter(Predicate.isTagged('ToolCall'))).toMatchObject([{ call }])
        expect(events.filter(Predicate.isTagged('Done'))).toHaveLength(1)
        expect(events.filter(Predicate.isTagged('Usage'))).toMatchObject([
          { usage: { input: { total: 10 }, output: { total: 1 } } },
          { usage: { input: { total: 0 }, output: { total: 4 } } }
        ])
      })
  )

  it.effect('responses: streams reasoning, tools, and usage without Codex auth', () =>
    Effect.gen(function* () {
      const events = yield* run(
        'responses',
        sse([
          { type: 'response.reasoning_summary_text.delta', delta: 'Search first.' },
          {
            type: 'response.output_item.done',
            item: {
              type: 'function_call',
              call_id: call.id,
              name: tool.name,
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
        ]),
        []
      )

      expect(events).toMatchObject([
        { _tag: 'ReasoningDelta', text: 'Search first.' },
        { _tag: 'ToolCall', call },
        { _tag: 'Done', stopReason: 'tool_use' },
        {
          _tag: 'Usage',
          usage: { input: { total: 10, cacheRead: 2 }, output: { total: 5, reasoning: 3 } }
        }
      ])
    })
  )

  it.effect('messages: rejects filtered output in JSON and SSE', () =>
    Effect.gen(function* () {
      for (const response of [
        Response.json({
          content: [{ type: 'text', text: 'filtered' }],
          stop_reason: 'content_filter'
        }),
        sse([
          { type: 'message_delta', delta: { stop_reason: 'content_filter' } },
          { type: 'message_stop' }
        ])
      ]) {
        const error = yield* run('messages', response, []).pipe(Effect.flip)
        expect(error).toMatchObject({ cause: 'invalid_response', retryable: false })
      }
    })
  )

  it.effect('responses: sanitizes streamed errors that echo credentials', () =>
    Effect.gen(function* () {
      const error = yield* run(
        'responses',
        sse([
          {
            type: 'response.failed',
            response: {
              error: { code: 'invalid_api_key', message: 'Rejected go-key private-upstream-text' }
            }
          }
        ]),
        []
      ).pipe(Effect.flip)

      expect(error).toMatchObject({ provider: { provider: openCodeGoProviderId } })
      expect(error.message).not.toContain('go-key')
      expect(error.message).not.toContain('private-upstream-text')
    })
  )

  it.effect('messages: ignores malformed trailing frames in the same or separate chunks', () =>
    Effect.gen(function* () {
      const terminal = 'data: {"type":"message_stop"}\n\n'
      const malformed = 'data: {broken\n\n'

      for (const chunks of [[terminal + malformed], [terminal, malformed]]) {
        const response = new Response(
          new ReadableStream({
            start(controller) {
              for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
              controller.close()
            }
          })
        )

        const events = yield* run('messages', response, [])
        expect(events).toMatchObject([{ _tag: 'Done', stopReason: 'stop' }])
      }
    })
  )

  it.effect('never reports truncated output as completion', () =>
    Effect.gen(function* () {
      for (const protocol of protocols) {
        const response = Match.value(protocol).pipe(
          Match.when('chat-completions', () =>
            Response.json({
              choices: [{ message: { content: 'partial' }, finish_reason: 'length' }]
            })
          ),
          Match.when('messages', () =>
            sse([
              { type: 'message_delta', delta: { stop_reason: 'max_tokens' } },
              { type: 'message_stop' }
            ])
          ),
          Match.when('responses', () =>
            sse([
              {
                type: 'response.incomplete',
                response: { incomplete_details: { reason: 'max_output_tokens' } }
              }
            ])
          ),
          Match.exhaustive
        )

        const error = yield* run(protocol, response, []).pipe(Effect.flip)
        expect(error).toMatchObject({ cause: 'invalid_response', retryable: false })
      }
    })
  )

  it.effect('messages: rejects EOF without a terminal frame and classifies streamed errors', () =>
    Effect.gen(function* () {
      const eofError = yield* run(
        'messages',
        sse([
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } }
        ]),
        []
      ).pipe(Effect.flip)

      expect(eofError).toMatchObject({ cause: 'invalid_response', retryable: false })

      const error = yield* run(
        'messages',
        sse([
          { type: 'error', error: { type: 'overloaded_error', message: 'private-upstream-text' } }
        ]),
        []
      ).pipe(Effect.flip)

      expect(error).toMatchObject({
        retryable: true,
        provider: { provider: openCodeGoProviderId, kind: 'overloaded' }
      })
      expect(error.message).not.toContain('private-upstream-text')
    })
  )
})
