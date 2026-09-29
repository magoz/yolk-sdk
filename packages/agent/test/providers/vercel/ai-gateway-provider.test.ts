import { Deferred, Effect, Fiber, Layer, Predicate, Redacted, Ref, Schema, Stream } from 'effect'
import { HttpClient, HttpClientResponse, type HttpClientRequest } from 'effect/unstable/http'
import { describe, expect, it } from '@effect/vitest'
import {
  LLMDone,
  LLMProvider,
  LLMReasoningDelta,
  LLMTextDelta,
  LLMToolCall,
  LLMUsage
} from '@yolk-sdk/agent/loop'
import {
  DocumentPart,
  ToolCall,
  ToolResult,
  TextPart,
  UserMessage,
  inlineBase64Source,
  type AgentMessage,
  type AgentReasoningEffort
} from '@yolk-sdk/agent/protocol'
import { makeTool } from '@yolk-sdk/agent/tools'
import {
  decodeWireFixture,
  isWireStreamResponse,
  scanFixtureForSecrets,
  type WireFixture
} from '@yolk-sdk/conformance/fixture'
import { ReplayHttpClient, ReplayLedger, WireFault } from '@yolk-sdk/conformance/replay'
import {
  makeVercelAiGatewayProviderLayer,
  vercelAiGatewayChatCompletionsUrl
} from '../../../src/providers/vercel/ai-gateway-provider.ts'
import {
  vercelAiGatewayConformanceFixtures,
  vercelAiGatewayDeepSeekReasoningFixture,
  vercelAiGatewayErrorEnvelopeFixture,
  vercelAiGatewayPlainTextFixture,
  vercelAiGatewayToolCallDeltasFixture
} from '../../../src/providers/vercel/conformance/index.ts'

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

const defaultGatewayConfig: Parameters<typeof makeVercelAiGatewayProviderLayer>[0] = {
  apiKey: Redacted.make('gateway-key'),
  maxCompletionTokens: 2_000
}

const runProvider = (
  response: Response,
  requests: Array<CapturedRequest>,
  config: Parameters<typeof makeVercelAiGatewayProviderLayer>[0] = defaultGatewayConfig,
  request: {
    readonly model?: string
    readonly reasoningEffort?: AgentReasoningEffort
    readonly messages?: ReadonlyArray<AgentMessage>
  } = {}
) =>
  Effect.gen(function* () {
    const provider = yield* LLMProvider

    const streamInput = {
      model: request.model ?? 'anthropic/claude-sonnet',
      systemPrompt: 'Be concise.',
      messages: request.messages ?? [UserMessage.make({ content: 'Hello' })],
      tools: []
    }

    return yield* provider
      .stream(
        request.reasoningEffort === undefined
          ? streamInput
          : { ...streamInput, reasoningEffort: request.reasoningEffort }
      )
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
      expect(readCapturedBody(requests)).not.toHaveProperty('reasoning')
      expect(Array.from(events)).toMatchObject([
        LLMTextDelta.make({ text: 'Hello from Gateway' }),
        LLMDone.make({ stopReason: 'stop' })
      ])
    })
  )

  it.effect('lowers PDF documents to Gateway file parts', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []

      yield* runProvider(
        new Response(JSON.stringify({ choices: [{ message: { content: 'summarized' } }] })),
        requests,
        defaultGatewayConfig,
        {
          model: 'anthropic/claude-sonnet-5',
          messages: [
            UserMessage.make({
              content: [
                TextPart.make({ text: 'summarize' }),
                DocumentPart.make({
                  source: inlineBase64Source('JVBERi0='),
                  mimeType: 'application/pdf',
                  filename: 'brief.pdf'
                })
              ]
            })
          ]
        }
      )

      expect(readCapturedBody(requests).messages[1]).toEqual({
        role: 'user',
        content: [
          { type: 'text', text: 'summarize' },
          {
            type: 'file',
            file: {
              filename: 'brief.pdf',
              file_data: 'data:application/pdf;base64,JVBERi0='
            }
          }
        ]
      })
    })
  )

  it.effect('sends DeepSeek-style effort and thinking toggle when configured', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      yield* runProvider(
        new Response(JSON.stringify({ choices: [{ message: { content: 'thoughtful' } }] })),
        requests,
        {
          ...defaultGatewayConfig,
          reasoningEffortFormat: 'reasoning-effort',
          thinking: { type: 'enabled' }
        },
        { model: 'deepseek/deepseek-v4.1-flash', reasoningEffort: 'high' }
      )

      expect(readCapturedBody(requests)).toMatchObject({
        model: 'deepseek/deepseek-v4.1-flash',
        reasoning_effort: 'high',
        thinking: { type: 'enabled' }
      })
      expect(readCapturedBody(requests)).not.toHaveProperty('reasoning')
    })
  )

  it.effect('forwards reasoning effort for any opaque Gateway model id', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      yield* runProvider(
        new Response(JSON.stringify({ choices: [{ message: { content: 'reasoned' } }] })),
        requests,
        defaultGatewayConfig,
        { model: 'provider/opaque-reasoning-model', reasoningEffort: 'xhigh' }
      )

      expect(readCapturedBody(requests)).toMatchObject({
        model: 'provider/opaque-reasoning-model',
        reasoning: { effort: 'xhigh' }
      })
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
        LLMToolCall.make({
          call: ToolCall.make({ id: 'call-1', name: 'search', params: { query: 'yolk' } })
        }),
        LLMDone.make({ stopReason: 'tool_use' }),
        LLMUsage.make({
          usage: {
            input: { total: 10, uncached: 8, cacheRead: 2 },
            output: { total: 5, reasoning: 3, text: 2 }
          }
        })
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

        const expectedErrorFields = {
          cause: 'invalid_response',
          message: `Vercel AI Gateway response stopped with ${finishReason}`,
          retryable: false,
          provider: {
            provider: 'vercel_ai_gateway',
            kind: 'invalid_response',
            providerCode: finishReason
          }
        }

        expect(error._tag).toBe('LLMError')
        expect(error).toMatchObject(expectedErrorFields)
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

      expect(error._tag).toBe('LLMError')
      expect(error).toMatchObject({
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
      expect(error._tag).toBe('LLMError')
      expect(error).toMatchObject({
        cause: 'validation_error',
        message: 'Vercel AI Gateway maxCompletionTokens must be a positive safe integer',
        retryable: false
      })
    })
  )
})

// Streaming cases replay the Gateway wire fixtures from
// `@yolk-sdk/agent/providers/vercel/conformance` instead of hand-written SSE.

const SseChunkPayload = Schema.Struct({
  choices: Schema.optional(
    Schema.Array(
      Schema.Struct({
        delta: Schema.optional(
          Schema.Struct({
            content: Schema.optional(Schema.NullOr(Schema.String)),
            reasoning_content: Schema.optional(Schema.NullOr(Schema.String)),
            tool_calls: Schema.optional(
              Schema.Array(
                Schema.Struct({
                  function: Schema.optional(
                    Schema.Struct({ arguments: Schema.optional(Schema.String) })
                  )
                })
              )
            )
          })
        ),
        finish_reason: Schema.optional(Schema.NullOr(Schema.String))
      })
    )
  )
})

const decodeSseChunkPayload = Schema.decodeUnknownEffect(Schema.fromJsonString(SseChunkPayload))

// Gateway SSE fixtures are recorded as UTF-8 text chunks.
const fixtureChunks = (fixture: WireFixture): ReadonlyArray<string> => {
  const response = fixture.exchanges[0].response

  return isWireStreamResponse(response)
    ? response.chunks.map(chunk =>
        Predicate.isString(chunk) ? chunk : expect.fail(`fixture ${fixture.id} has a base64 chunk`)
      )
    : []
}

const fixtureModel = (fixture: WireFixture): string => {
  if (fixture.model === undefined) {
    return expect.fail(`fixture ${fixture.id} has no model`)
  }

  return fixture.model
}

const fixtureDeltas = (fixture: WireFixture) =>
  Effect.gen(function* () {
    const payloads = fixtureChunks(fixture)
      .join('')
      .split('\n\n')
      .map(block => block.replace(/^data: ?/, ''))
      .filter(payload => payload.length > 0 && payload !== '[DONE]')

    let content = ''
    let reasoning = ''
    let toolArguments = ''

    for (const payload of payloads) {
      const decoded = yield* decodeSseChunkPayload(payload)

      for (const choice of decoded.choices ?? []) {
        content += choice.delta?.content ?? ''
        reasoning += choice.delta?.reasoning_content ?? ''

        for (const call of choice.delta?.tool_calls ?? []) {
          toolArguments += call.function?.arguments ?? ''
        }
      }
    }

    return { content, reasoning, toolArguments }
  })

// Index of the first recorded chunk that completes the event matching `marker`.
const chunkIndexContaining = (fixture: WireFixture, marker: string): number => {
  const index = fixtureChunks(fixture).findIndex(chunk => chunk.includes(marker))

  expect(index).toBeGreaterThanOrEqual(0)

  return index
}

const streamingGatewayConfig: Parameters<typeof makeVercelAiGatewayProviderLayer>[0] = {
  ...defaultGatewayConfig,
  streaming: true
}

const deepSeekGatewayConfig: Parameters<typeof makeVercelAiGatewayProviderLayer>[0] = {
  ...streamingGatewayConfig,
  reasoningContent: true,
  reasoningEffortFormat: 'reasoning-effort',
  thinking: { type: 'enabled' }
}

const replayGatewayLayer = (
  config: Parameters<typeof makeVercelAiGatewayProviderLayer>[0],
  fixtures: ReadonlyArray<WireFixture>,
  faults: ReadonlyArray<WireFault> = []
) =>
  makeVercelAiGatewayProviderLayer(config).pipe(
    Layer.provideMerge(ReplayHttpClient.layer(fixtures, { faults }))
  )

const lookupWeatherTool = makeTool({
  name: 'lookup_weather',
  description: 'Look up the current weather for a city.',
  parameters: Schema.Struct({ city: Schema.String }),
  access: 'read',
  execute: ({ call }) => Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'sunny' }))
})

const gatewayStream = (input: {
  readonly model: string
  readonly reasoningEffort?: AgentReasoningEffort
  readonly withTool?: boolean
}) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const provider = yield* LLMProvider

      const streamInput = {
        model: input.model,
        systemPrompt: 'Reply in one short sentence.',
        messages: [UserMessage.make({ content: 'Say hello.' })],
        tools: input.withTool === true ? [lookupWeatherTool.def] : []
      }

      return provider.stream(
        input.reasoningEffort === undefined
          ? streamInput
          : { ...streamInput, reasoningEffort: input.reasoningEffort }
      )
    })
  )

const textOf = (events: ReadonlyArray<unknown>) =>
  events.flatMap(event => (event instanceof LLMTextDelta ? [event.text] : [])).join('')

const reasoningOf = (events: ReadonlyArray<unknown>) =>
  events.flatMap(event => (event instanceof LLMReasoningDelta ? [event.text] : [])).join('')

describe('Vercel AI Gateway wire fixtures', () => {
  it.effect('ship as valid, synthetic, secret-free fixtures', () =>
    Effect.gen(function* () {
      expect(vercelAiGatewayConformanceFixtures.map(fixture => fixture.caseId)).toEqual([
        'vercel-ai-gateway.stream.plain-text',
        'vercel-ai-gateway.stream.deepseek-reasoning',
        'vercel-ai-gateway.stream.tool-call-deltas',
        'vercel-ai-gateway.stream.error-envelope'
      ])

      for (const fixture of vercelAiGatewayConformanceFixtures) {
        const decoded = yield* decodeWireFixture(fixture)

        expect(decoded.endpoint).toBe(vercelAiGatewayChatCompletionsUrl)
        expect(scanFixtureForSecrets(fixture)).toEqual([])

        if (fixture.evidence === 'unverified') {
          expect(fixture.account).toBe('synthetic')
        }
      }
    })
  )

  // Regression: the secret scan also checks JSON bodies and SSE `data:` payloads for credential
  // fields; numeric usage counters (`max_tokens`, `prompt_tokens`, `reasoning_tokens`, ...) must
  // not be mistaken for credentials.
  it('scan clean under the JSON and SSE credential-field scan despite usage token counters', () => {
    for (const fixture of vercelAiGatewayConformanceFixtures) {
      const exchange = fixture.exchanges[0]

      expect(JSON.stringify(exchange.request.body)).toContain('"max_tokens":')
      expect(scanFixtureForSecrets(fixture)).toEqual([])
    }

    expect(fixtureChunks(vercelAiGatewayPlainTextFixture).join('')).toContain('"prompt_tokens":')
    expect(fixtureChunks(vercelAiGatewayDeepSeekReasoningFixture).join('')).toContain(
      '"reasoning_tokens":'
    )
  })
})

describe('Vercel AI Gateway streaming over replayed fixtures', () => {
  it.effect('streams plain text deltas, done, and usage with a streaming request', () =>
    Effect.gen(function* () {
      const fixture = vercelAiGatewayPlainTextFixture
      const model = fixtureModel(fixture)
      const events = Array.from(yield* gatewayStream({ model }).pipe(Stream.runCollect))
      const expected = yield* fixtureDeltas(fixture)

      expect(expected.content.length).toBeGreaterThan(0)
      expect(textOf(events)).toBe(expected.content)
      expect(events.filter(event => event instanceof LLMDone)).toMatchObject([
        LLMDone.make({ stopReason: 'stop' })
      ])
      expect(events.some(event => event instanceof LLMUsage)).toBe(true)

      const [entry, ...rest] = yield* (yield* ReplayLedger).entries

      expect(rest).toEqual([])
      expect(entry).toMatchObject({
        method: 'POST',
        url: vercelAiGatewayChatCompletionsUrl,
        match: { outcome: 'matched', fixtureId: fixture.id, exchangeIndex: 0 },
        headers: {
          accept: 'text/event-stream',
          authorization: '<redacted>',
          'content-type': 'application/json'
        },
        bodyJson: {
          model,
          stream: true,
          stream_options: { include_usage: true },
          max_tokens: 2_000
        }
      })
      expect(entry?.bodyJson).not.toHaveProperty('reasoning_effort')
    }).pipe(
      Effect.provide(replayGatewayLayer(streamingGatewayConfig, [vercelAiGatewayPlainTextFixture]))
    )
  )

  it.effect('delivers the first text delta before the fixture stream ends', () =>
    Effect.gen(function* () {
      const fixture = vercelAiGatewayPlainTextFixture
      const release = yield* Deferred.make<void>()
      const firstText = yield* Deferred.make<string>()
      const done = yield* Ref.make(false)

      const holdAfter = chunkIndexContaining(fixture, '"delta":{"content":"') + 1

      yield* Effect.gen(function* () {
        const consumer = yield* gatewayStream({ model: fixtureModel(fixture) }).pipe(
          Stream.tap(event =>
            event instanceof LLMTextDelta
              ? Deferred.succeed(firstText, event.text)
              : event instanceof LLMDone
                ? Ref.set(done, true)
                : Effect.void
          ),
          Stream.runCollect,
          Effect.forkChild
        )

        const first = yield* Deferred.await(firstText)

        expect(first.length).toBeGreaterThan(0)
        expect(yield* Ref.get(done)).toBe(false)

        yield* Deferred.succeed(release, undefined)

        const events = Array.from(yield* Fiber.join(consumer))

        expect(textOf(events)).toBe((yield* fixtureDeltas(fixture)).content)
        expect(yield* Ref.get(done)).toBe(true)
      }).pipe(
        Effect.provide(
          replayGatewayLayer(
            streamingGatewayConfig,
            [fixture],
            [WireFault.HoldAfterChunks({ chunks: holdAfter, release: Deferred.await(release) })]
          )
        )
      )
    })
  )

  it.effect(
    'sends DeepSeek effort and thinking and surfaces reasoning_content as reasoning deltas',
    () =>
      Effect.gen(function* () {
        const fixture = vercelAiGatewayDeepSeekReasoningFixture
        const model = fixtureModel(fixture)

        const events = Array.from(
          yield* gatewayStream({ model, reasoningEffort: 'high' }).pipe(Stream.runCollect)
        )

        const expected = yield* fixtureDeltas(fixture)

        expect(expected.reasoning.length).toBeGreaterThan(0)
        expect(reasoningOf(events)).toBe(expected.reasoning)
        expect(textOf(events)).toBe(expected.content)

        const firstText = events.findIndex(event => event instanceof LLMTextDelta)
        const lastReasoning = events.findLastIndex(event => event instanceof LLMReasoningDelta)

        expect(lastReasoning).toBeLessThan(firstText)

        const [entry] = yield* (yield* ReplayLedger).entries

        expect(entry?.bodyJson).toMatchObject({
          model,
          stream: true,
          reasoning_effort: 'high',
          thinking: { type: 'enabled' }
        })
        expect(entry?.bodyJson).not.toHaveProperty('reasoning')
      }).pipe(
        Effect.provide(
          replayGatewayLayer(deepSeekGatewayConfig, [vercelAiGatewayDeepSeekReasoningFixture])
        )
      )
  )

  it.effect('drops reasoning_content when reasoning content is disabled', () =>
    Effect.gen(function* () {
      const fixture = vercelAiGatewayDeepSeekReasoningFixture

      const events = Array.from(
        yield* gatewayStream({ model: fixtureModel(fixture), reasoningEffort: 'high' }).pipe(
          Stream.runCollect
        )
      )

      expect(events.some(event => event instanceof LLMReasoningDelta)).toBe(false)
      expect(textOf(events)).toBe((yield* fixtureDeltas(fixture)).content)
    }).pipe(
      Effect.provide(
        replayGatewayLayer({ ...deepSeekGatewayConfig, reasoningContent: false }, [
          vercelAiGatewayDeepSeekReasoningFixture
        ])
      )
    )
  )

  it.effect('assembles split tool-call argument deltas into one tool call', () =>
    Effect.gen(function* () {
      const fixture = vercelAiGatewayToolCallDeltasFixture
      const model = fixtureModel(fixture)

      const events = Array.from(
        yield* gatewayStream({ model, withTool: true }).pipe(Stream.runCollect)
      )

      const expected = yield* fixtureDeltas(fixture)

      const expectedParams = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(Schema.Unknown)
      )(expected.toolArguments)

      const toolCalls = events.filter(event => event instanceof LLMToolCall)

      expect(toolCalls).toHaveLength(1)
      expect(toolCalls[0]).toMatchObject({
        call: { name: 'lookup_weather', params: expectedParams }
      })
      expect(events.filter(event => event instanceof LLMDone)).toMatchObject([
        LLMDone.make({ stopReason: 'tool_use' })
      ])

      const [entry] = yield* (yield* ReplayLedger).entries

      expect(entry?.bodyJson).toMatchObject({
        model,
        stream: true,
        tools: [{ type: 'function', function: { name: 'lookup_weather' } }],
        parallel_tool_calls: true
      })
    }).pipe(
      Effect.provide(
        replayGatewayLayer(streamingGatewayConfig, [vercelAiGatewayToolCallDeltasFixture])
      )
    )
  )

  it.effect('maps the error envelope to a sanitized non-retryable LLMError', () =>
    Effect.gen(function* () {
      const fixture = vercelAiGatewayErrorEnvelopeFixture

      const error = yield* gatewayStream({ model: fixtureModel(fixture) }).pipe(
        Stream.runCollect,
        Effect.flip
      )

      expect(error._tag).toBe('LLMError')
      expect(error).toMatchObject({
        cause: 'provider_error',
        message: 'Vercel AI Gateway returned 400',
        retryable: false,
        provider: {
          provider: 'vercel_ai_gateway',
          kind: 'unknown',
          status: 400,
          providerCode: 'model_not_found'
        }
      })
      expect(error.message).not.toContain('Synthetic placeholder')

      const [entry] = yield* (yield* ReplayLedger).entries

      expect(entry?.bodyJson).toMatchObject({ model: fixtureModel(fixture), stream: true })
    }).pipe(
      Effect.provide(
        replayGatewayLayer(streamingGatewayConfig, [vercelAiGatewayErrorEnvelopeFixture])
      )
    )
  )
})

describe('Vercel AI Gateway streaming under wire faults', () => {
  const fixture = vercelAiGatewayPlainTextFixture

  const collectUntilFailure = (model: string) =>
    Effect.gen(function* () {
      const seen: Array<unknown> = []

      const error = yield* gatewayStream({ model }).pipe(
        Stream.runForEach(event => Effect.sync(() => seen.push(event))),
        Effect.flip
      )

      return { error, seen }
    })

  it.effect('fails a 500 attempt as retryable, then streams the recording on the same layer', () =>
    Effect.gen(function* () {
      const model = fixtureModel(fixture)
      const first = yield* gatewayStream({ model }).pipe(Stream.runCollect, Effect.flip)

      expect(first._tag).toBe('LLMError')
      expect(first).toMatchObject({
        cause: 'provider_error',
        retryable: true,
        provider: { provider: 'vercel_ai_gateway', kind: 'server_error', status: 500 }
      })

      const second = Array.from(yield* gatewayStream({ model }).pipe(Stream.runCollect))

      expect(textOf(second)).toBe((yield* fixtureDeltas(fixture)).content)

      const entries = yield* (yield* ReplayLedger).entries

      expect(entries.map(entry => [entry.attempt, entry.match.outcome, entry.fault])).toEqual([
        [1, 'injected', 'StatusOnAttempt'],
        [2, 'matched', undefined]
      ])
    }).pipe(
      Effect.provide(
        replayGatewayLayer(
          streamingGatewayConfig,
          [fixture],
          [
            WireFault.StatusOnAttempt({
              attempt: 1,
              status: 500,
              headers: { 'content-type': 'application/json' },
              body: '{"error":{"message":"synthetic upstream failure","type":"server_error"}}'
            })
          ]
        )
      )
    )
  )

  it.effect('classifies 429 with retry-after as a retryable rate limit carrying the delay', () =>
    Effect.gen(function* () {
      const model = fixtureModel(fixture)
      const error = yield* gatewayStream({ model }).pipe(Stream.runCollect, Effect.flip)

      expect(error._tag).toBe('LLMError')
      expect(error).toMatchObject({
        cause: 'rate_limit',
        message: 'Vercel AI Gateway returned 429',
        retryable: true,
        provider: {
          provider: 'vercel_ai_gateway',
          kind: 'rate_limit',
          status: 429,
          retryAfterMs: 2_000
        }
      })

      const retried = Array.from(yield* gatewayStream({ model }).pipe(Stream.runCollect))

      expect(retried.some(event => event instanceof LLMDone)).toBe(true)
    }).pipe(
      Effect.provide(
        replayGatewayLayer(
          streamingGatewayConfig,
          [fixture],
          [
            WireFault.StatusOnAttempt({
              attempt: 1,
              status: 429,
              headers: { 'content-type': 'application/json', 'retry-after': '2' },
              body: '{"error":{"message":"synthetic throttle","type":"rate_limit_exceeded"}}'
            })
          ]
        )
      )
    )
  )

  it.effect('keeps network error metadata when the body stream drops mid-answer', () =>
    Effect.gen(function* () {
      const { error, seen } = yield* collectUntilFailure(fixtureModel(fixture))

      expect(error._tag).toBe('LLMError')
      expect(error).toMatchObject({
        cause: 'provider_error',
        retryable: true,
        provider: { provider: 'vercel_ai_gateway', kind: 'network' }
      })
      expect(error.message).toContain('Vercel AI Gateway request failed')
      expect(textOf(seen).length).toBeGreaterThan(0)
      expect(seen.some(event => event instanceof LLMDone)).toBe(false)
    }).pipe(
      Effect.provide(
        replayGatewayLayer(
          streamingGatewayConfig,
          [fixture],
          [
            WireFault.FailAfterChunks({
              chunks: chunkIndexContaining(fixture, '"delta":{"content":"') + 1
            })
          ]
        )
      )
    )
  )

  it.effect(
    'fails a stream truncated before the finish chunk instead of returning a short answer',
    () =>
      Effect.gen(function* () {
        const { error, seen } = yield* collectUntilFailure(fixtureModel(fixture))

        expect(error._tag).toBe('LLMError')
        expect(error).toMatchObject({
          cause: 'invalid_response',
          retryable: false,
          provider: {
            provider: 'vercel_ai_gateway',
            kind: 'invalid_response',
            providerCode: 'incomplete_stream',
            stream: {
              protocol: 'chat-completions',
              responseFormat: 'sse',
              outputStarted: true,
              terminalSeen: false
            }
          }
        })
        expect(seen.some(event => event instanceof LLMDone)).toBe(false)
      }).pipe(
        Effect.provide(
          replayGatewayLayer(
            streamingGatewayConfig,
            [fixture],
            [
              WireFault.TruncateAfterChunks({
                chunks: chunkIndexContaining(fixture, '"finish_reason":"stop"')
              })
            ]
          )
        )
      )
  )

  // Current provider behaviour: a processed finish reason is terminal, so a stream cut after the
  // finish chunk (before the usage chunk and `[DONE]`) completes normally and usage is absent.
  it.effect('completes a stream truncated after the finish chunk without usage', () =>
    Effect.gen(function* () {
      const events = Array.from(
        yield* gatewayStream({ model: fixtureModel(fixture) }).pipe(Stream.runCollect)
      )

      expect(textOf(events)).toBe((yield* fixtureDeltas(fixture)).content)
      expect(events.filter(event => event instanceof LLMDone)).toMatchObject([
        LLMDone.make({ stopReason: 'stop' })
      ])
      expect(events.some(event => event instanceof LLMUsage)).toBe(false)
    }).pipe(
      Effect.provide(
        replayGatewayLayer(
          streamingGatewayConfig,
          [fixture],
          [
            WireFault.TruncateAfterChunks({
              chunks: chunkIndexContaining(fixture, '"finish_reason":"stop"') + 1
            })
          ]
        )
      )
    )
  )
})
