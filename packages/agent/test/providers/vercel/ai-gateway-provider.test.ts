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
  AgentReasoningEffort,
  DocumentPart,
  ToolCall,
  ToolResult,
  TextPart,
  UserMessage,
  inlineBase64Source,
  type AgentMessage
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

// Streaming cases replay the verified Gateway wire recordings from
// `@yolk-sdk/agent/providers/vercel/conformance` instead of hand-written SSE. Expectations derive
// from the recorded events (text, reasoning, tool arguments, statuses) and fault chunk indexes
// derive from where recorded events land in network chunks, never from recorded wording or chunk
// counts, so a re-recording keeps these tests meaningful.

const SseChunkPayload = Schema.Struct({
  choices: Schema.optional(
    Schema.Array(
      Schema.Struct({
        delta: Schema.optional(
          Schema.Struct({
            content: Schema.optional(Schema.NullOr(Schema.String)),
            reasoning: Schema.optional(Schema.NullOr(Schema.String)),
            reasoning_content: Schema.optional(Schema.NullOr(Schema.String)),
            tool_calls: Schema.optional(
              Schema.Array(
                Schema.Struct({
                  id: Schema.optional(Schema.String),
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

// Recorded chunks are text, or `{ base64 }` when a network chunk is not standalone UTF-8
// (for example a multibyte character split across chunks). Keep the original bytes per chunk.
const fixtureChunkBytes = (fixture: WireFixture): ReadonlyArray<Uint8Array> => {
  const response = fixture.exchanges[0].response

  return isWireStreamResponse(response)
    ? response.chunks.map(chunk =>
        Predicate.isString(chunk)
          ? new TextEncoder().encode(chunk)
          : Uint8Array.from(atob(chunk.base64), char => char.charCodeAt(0))
      )
    : []
}

const concatBytes = (parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const joined = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0

  for (const part of parts) {
    joined.set(part, offset)
    offset += part.length
  }

  return joined
}

// The whole stream decoded from its reassembled bytes.
const fixtureStreamText = (fixture: WireFixture): string =>
  new TextDecoder('utf-8', { fatal: true }).decode(concatBytes(fixtureChunkBytes(fixture)))

const fixtureModel = (fixture: WireFixture): string => {
  if (fixture.model === undefined) {
    return expect.fail(`fixture ${fixture.id} has no model`)
  }

  return fixture.model
}

const fixtureDeltas = (fixture: WireFixture) =>
  Effect.gen(function* () {
    const payloads = fixtureStreamText(fixture)
      .split('\n\n')
      .map(block => block.replace(/^data: ?/, ''))
      .filter(payload => payload.length > 0 && payload !== '[DONE]')

    let content = ''
    let reasoning = ''
    let reasoningContent = ''
    let toolArguments = ''
    const toolCallIds: Array<string> = []
    let toolCallFragments = 0

    for (const payload of payloads) {
      const decoded = yield* decodeSseChunkPayload(payload)

      for (const choice of decoded.choices ?? []) {
        content += choice.delta?.content ?? ''
        reasoning += choice.delta?.reasoning ?? ''
        reasoningContent += choice.delta?.reasoning_content ?? ''

        for (const call of choice.delta?.tool_calls ?? []) {
          toolCallFragments += 1
          toolArguments += call.function?.arguments ?? ''

          if (call.id !== undefined) toolCallIds.push(call.id)
        }
      }
    }

    return { content, reasoning, reasoningContent, toolArguments, toolCallIds, toolCallFragments }
  })

// One recorded server-sent event: its text (with the blank-line terminator), the index of the
// network chunk that completes it, its `data:` payload, and that payload parsed when it is JSON.
type RecordedSseEvent = {
  readonly text: string
  readonly chunkIndex: number
  readonly data: string
  readonly json: unknown
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

// Every recorded event, located in the network chunks. Several events may share a chunk (the live
// Gateway packs them), and an event may span chunks; every recorded byte belongs to an event.
const recordedSseEvents = (fixture: WireFixture): ReadonlyArray<RecordedSseEvent> => {
  const parts = fixtureChunkBytes(fixture)
  const bytes = concatBytes(parts)
  const chunkEnds: Array<number> = []

  for (const part of parts) {
    chunkEnds.push((chunkEnds.at(-1) ?? 0) + part.length)
  }

  const events: Array<RecordedSseEvent> = []
  let start = 0

  for (let index = 0; index + 1 < bytes.length; index += 1) {
    if (bytes[index] === 0x0a && bytes[index + 1] === 0x0a) {
      const end = index + 2
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.slice(start, end))

      const data = text
        .split('\n')
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice('data:'.length).trim())
        .join('\n')

      events.push({
        text,
        chunkIndex: chunkEnds.findIndex(chunkEnd => chunkEnd >= end),
        data,
        json: parseJson(data)
      })
      start = end
      index = end - 1
    }
  }

  expect(start).toBe(bytes.length)

  return events
}

const eventChoices = (event: RecordedSseEvent): ReadonlyArray<unknown> =>
  Predicate.hasProperty(event.json, 'choices') && Array.isArray(event.json.choices)
    ? event.json.choices
    : []

const contentOf = (event: RecordedSseEvent): string =>
  eventChoices(event)
    .map(choice =>
      Predicate.hasProperty(choice, 'delta') &&
      Predicate.hasProperty(choice.delta, 'content') &&
      Predicate.isString(choice.delta.content)
        ? choice.delta.content
        : ''
    )
    .join('')

const hasContent = (event: RecordedSseEvent): boolean => contentOf(event).length > 0

const isFinishEvent = (event: RecordedSseEvent): boolean =>
  eventChoices(event).some(
    choice =>
      Predicate.hasProperty(choice, 'finish_reason') && Predicate.isString(choice.finish_reason)
  )

const hasUsage = (event: RecordedSseEvent): boolean =>
  Predicate.hasProperty(event.json, 'usage') && Predicate.isObject(event.json.usage)

const isDoneEvent = (event: RecordedSseEvent): boolean => event.data === '[DONE]'

// Distinct network chunk indexes that complete an event matching `predicate`, in order.
const chunkIndexesWhere = (
  fixture: WireFixture,
  predicate: (event: RecordedSseEvent) => boolean
): ReadonlyArray<number> => [
  ...new Set(
    recordedSseEvents(fixture)
      .filter(predicate)
      .map(event => event.chunkIndex)
  )
]

// Index of the first network chunk that completes an event matching `predicate`.
const firstChunkIndexWhere = (
  fixture: WireFixture,
  predicate: (event: RecordedSseEvent) => boolean
): number => {
  const [index] = chunkIndexesWhere(fixture, predicate)

  return index ?? expect.fail(`${fixture.id} has no matching event`)
}

const derivedStreamFixture = (
  fixture: WireFixture,
  suffix: string,
  chunks: ReadonlyArray<string>
): WireFixture => {
  const [exchange] = fixture.exchanges
  const response = exchange.response

  if (!isWireStreamResponse(response)) {
    return expect.fail(`${fixture.id} must be a stream`)
  }

  return {
    ...fixture,
    id: `${fixture.id}.${suffix}`,
    exchanges: [{ request: exchange.request, response: { ...response, chunks: [...chunks] } }]
  }
}

// The recording re-split into one network chunk per event, byte for byte: only the chunk
// boundaries move, so every event can be cut at on its own.
const oneEventPerChunkFixture = (fixture: WireFixture): WireFixture => {
  const derived = derivedStreamFixture(
    fixture,
    'one-event-per-chunk',
    recordedSseEvents(fixture).map(event => event.text)
  )

  expect(concatBytes(fixtureChunkBytes(derived))).toEqual(concatBytes(fixtureChunkBytes(fixture)))

  return derived
}

const recordedReasoningEffort = (fixture: WireFixture) =>
  Schema.decodeUnknownEffect(AgentReasoningEffort)(
    Predicate.hasProperty(fixture.exchanges[0].request.body, 'reasoning_effort')
      ? fixture.exchanges[0].request.body.reasoning_effort
      : undefined
  )

const recordedRequestBody = (fixture: WireFixture): unknown => fixture.exchanges[0].request.body

const recordedMaxTokens = (fixture: WireFixture): number => {
  const body = recordedRequestBody(fixture)

  return Predicate.hasProperty(body, 'max_tokens') && Predicate.isNumber(body.max_tokens)
    ? body.max_tokens
    : expect.fail(`${fixture.id} recorded no numeric \`max_tokens\``)
}

// Replay matches requests by method and URL only; these request fields must also equal the
// recording, so a fixture-backed test sends the request its fixture recorded.
const recordedRequestFields = [
  'model',
  'reasoning_effort',
  'thinking',
  'max_tokens',
  'stream',
  'tools'
] as const

// Only the fields present, so a field sent but never recorded (or the reverse) is a mismatch.
const pickRecordedRequestFields = (body: unknown) =>
  recordedRequestFields.flatMap(field =>
    Predicate.hasProperty(body, field) ? [{ field, value: body[field] }] : []
  )

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

// A Gateway config sending the output limit the fixture recorded.
const recordedGatewayConfig = (
  config: Parameters<typeof makeVercelAiGatewayProviderLayer>[0],
  fixture: WireFixture
): Parameters<typeof makeVercelAiGatewayProviderLayer>[0] => ({
  ...config,
  maxCompletionTokens: recordedMaxTokens(fixture)
})

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
  it.effect('ship as valid, secret-free fixtures', () =>
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

    expect(fixtureStreamText(vercelAiGatewayPlainTextFixture)).toContain('"prompt_tokens":')
    expect(fixtureStreamText(vercelAiGatewayDeepSeekReasoningFixture)).toContain(
      '"reasoning_tokens":'
    )
  })
})

// Derive a lossless recording where a multibyte character in a content delta is split across two
// network chunks, as the recorder stores it: the halves become `{ base64 }` chunks. The character
// is prepended to the first recorded content delta.
const multibyteChar = '\u00e9'

const splitMultibyteFixture = (): WireFixture => {
  const base = vercelAiGatewayPlainTextFixture
  const [exchange] = base.exchanges
  const response = exchange.response

  if (!isWireStreamResponse(response)) {
    return expect.fail('plain-text fixture must be a stream')
  }

  const target = firstChunkIndexWhere(base, hasContent)
  const source = response.chunks[target]

  if (!Predicate.isString(source)) {
    return expect.fail('plain-text fixture must record its first content delta as text')
  }

  const marker = '"delta":{"content":"'
  const at = source.indexOf(marker)

  expect(at).toBeGreaterThanOrEqual(0)

  const bytes = new TextEncoder().encode(
    `${source.slice(0, at + marker.length)}${multibyteChar}${source.slice(at + marker.length)}`
  )

  // U+00E9 is 0xC3 0xA9; cut between the two bytes.
  const cut = bytes.indexOf(0xc3) + 1
  const toBase64 = (part: Uint8Array) => btoa(String.fromCharCode(...part))

  const chunks = [
    ...response.chunks.slice(0, target),
    { base64: toBase64(bytes.slice(0, cut)) },
    { base64: toBase64(bytes.slice(cut)) },
    ...response.chunks.slice(target + 1)
  ]

  return {
    ...base,
    id: `${base.id}.split-multibyte`,
    exchanges: [{ request: exchange.request, response: { ...response, chunks } }]
  }
}

describe('Vercel AI Gateway streaming over replayed fixtures', () => {
  it.effect('streams a multibyte character split across lossless base64 chunks', () =>
    Effect.gen(function* () {
      const fixture = splitMultibyteFixture()

      expect(scanFixtureForSecrets(fixture)).toEqual([])
      expect((yield* decodeWireFixture(fixture)).id).toBe(fixture.id)

      const events = Array.from(
        yield* gatewayStream({ model: fixtureModel(fixture) }).pipe(Stream.runCollect)
      )

      const expected = yield* fixtureDeltas(fixture)
      const recorded = yield* fixtureDeltas(vercelAiGatewayPlainTextFixture)

      expect(expected.content).toBe(`${multibyteChar}${recorded.content}`)
      expect(textOf(events)).toBe(expected.content)
    }).pipe(Effect.provide(replayGatewayLayer(streamingGatewayConfig, [splitMultibyteFixture()])))
  )

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
          max_tokens: recordedMaxTokens(fixture)
        }
      })
      expect(pickRecordedRequestFields(entry?.bodyJson)).toEqual(
        pickRecordedRequestFields(recordedRequestBody(fixture))
      )
      expect(entry?.bodyJson).not.toHaveProperty('reasoning_effort')
    }).pipe(
      Effect.provide(
        replayGatewayLayer(
          recordedGatewayConfig(streamingGatewayConfig, vercelAiGatewayPlainTextFixture),
          [vercelAiGatewayPlainTextFixture]
        )
      )
    )
  )

  it.effect('delivers the first text delta before the fixture stream ends', () =>
    Effect.gen(function* () {
      const fixture = vercelAiGatewayPlainTextFixture
      const release = yield* Deferred.make<void>()
      const firstText = yield* Deferred.make<string>()
      const done = yield* Ref.make(false)

      // Progressive delivery needs content in at least two network chunks: hold right after the
      // first one, so later content (and the finish) is still unsent when the first delta lands.
      const contentChunks = chunkIndexesWhere(fixture, hasContent)
      const holdAfter = firstChunkIndexWhere(fixture, hasContent) + 1

      expect(contentChunks.length).toBeGreaterThanOrEqual(2)
      expect(contentChunks.some(index => index >= holdAfter)).toBe(true)

      const firstRecordedEvent =
        recordedSseEvents(fixture).find(hasContent) ?? expect.fail('no recorded content event')

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
        expect(first).toBe(contentOf(firstRecordedEvent))
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
    'sends DeepSeek effort and thinking and surfaces delta.reasoning as reasoning deltas',
    () =>
      Effect.gen(function* () {
        const fixture = vercelAiGatewayDeepSeekReasoningFixture
        const model = fixtureModel(fixture)
        const reasoningEffort = yield* recordedReasoningEffort(fixture)

        const events = Array.from(
          yield* gatewayStream({ model, reasoningEffort }).pipe(Stream.runCollect)
        )

        const expected = yield* fixtureDeltas(fixture)

        // The live Gateway streams DeepSeek reasoning as `delta.reasoning` (with
        // `delta.reasoning_details`), not `delta.reasoning_content`, so this covers that field.
        expect(expected.reasoningContent).toBe('')
        expect(expected.reasoning.length).toBeGreaterThan(0)
        expect(reasoningOf(events)).toBe(expected.reasoning)
        expect(expected.content.length).toBeGreaterThan(0)
        expect(textOf(events)).toBe(expected.content)

        const firstText = events.findIndex(event => event instanceof LLMTextDelta)
        const lastReasoning = events.findLastIndex(event => event instanceof LLMReasoningDelta)

        expect(lastReasoning).toBeLessThan(firstText)

        const [entry] = yield* (yield* ReplayLedger).entries

        expect(entry?.bodyJson).toMatchObject({
          model,
          stream: true,
          reasoning_effort: reasoningEffort,
          thinking: { type: 'enabled' }
        })
        expect(pickRecordedRequestFields(entry?.bodyJson)).toEqual(
          pickRecordedRequestFields(recordedRequestBody(fixture))
        )
        expect(entry?.bodyJson).not.toHaveProperty('reasoning')
      }).pipe(
        Effect.provide(
          replayGatewayLayer(
            recordedGatewayConfig(deepSeekGatewayConfig, vercelAiGatewayDeepSeekReasoningFixture),
            [vercelAiGatewayDeepSeekReasoningFixture]
          )
        )
      )
  )

  it.effect('drops recorded reasoning when reasoning content is disabled', () =>
    Effect.gen(function* () {
      const fixture = vercelAiGatewayDeepSeekReasoningFixture
      const expected = yield* fixtureDeltas(fixture)

      const events = Array.from(
        yield* gatewayStream({
          model: fixtureModel(fixture),
          reasoningEffort: yield* recordedReasoningEffort(fixture)
        }).pipe(Stream.runCollect)
      )

      expect(expected.reasoning.length).toBeGreaterThan(0)
      expect(events.some(event => event instanceof LLMReasoningDelta)).toBe(false)
      expect(textOf(events)).toBe(expected.content)
    }).pipe(
      Effect.provide(
        replayGatewayLayer({ ...deepSeekGatewayConfig, reasoningContent: false }, [
          vercelAiGatewayDeepSeekReasoningFixture
        ])
      )
    )
  )

  it.effect('assembles streamed tool-call deltas (header, then arguments) into one tool call', () =>
    Effect.gen(function* () {
      const fixture = vercelAiGatewayToolCallDeltasFixture
      const model = fixtureModel(fixture)

      const events = Array.from(
        yield* gatewayStream({ model, withTool: true }).pipe(Stream.runCollect)
      )

      const expected = yield* fixtureDeltas(fixture)

      // The call arrives as several `delta.tool_calls` fragments (id and name first, arguments
      // after), and exactly one fragment carries the call id.
      expect(expected.toolCallFragments).toBeGreaterThanOrEqual(2)
      expect(expected.toolCallIds).toHaveLength(1)

      const expectedParams = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(Schema.Unknown)
      )(expected.toolArguments)

      const toolCalls = events.filter(event => event instanceof LLMToolCall)

      expect(toolCalls).toHaveLength(1)
      expect(toolCalls[0]).toMatchObject({
        call: { id: expected.toolCallIds[0], name: 'lookup_weather', params: expectedParams }
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
      expect(pickRecordedRequestFields(entry?.bodyJson)).toEqual(
        pickRecordedRequestFields(recordedRequestBody(fixture))
      )
    }).pipe(
      Effect.provide(
        replayGatewayLayer(
          recordedGatewayConfig(streamingGatewayConfig, vercelAiGatewayToolCallDeltasFixture),
          [vercelAiGatewayToolCallDeltasFixture]
        )
      )
    )
  )

  // The recorded unknown-model rejection is a 404 whose envelope has `error.type` but no
  // `error.code`, so the provider code is the `error.type` fallback. A 404 has no dedicated
  // failure kind: it classifies as a non-retryable `unknown` provider error.
  it.effect('maps the recorded error envelope to a sanitized non-retryable LLMError', () =>
    Effect.gen(function* () {
      const fixture = vercelAiGatewayErrorEnvelopeFixture
      const response = fixture.exchanges[0].response

      const body =
        Predicate.hasProperty(response, 'body') && Predicate.isString(response.body)
          ? response.body
          : expect.fail('error fixture must record a text body')

      const envelope = parseJson(body)

      const recorded =
        Predicate.hasProperty(envelope, 'error') &&
        Predicate.hasProperty(envelope.error, 'type') &&
        Predicate.hasProperty(envelope.error, 'message') &&
        Predicate.isString(envelope.error.type) &&
        Predicate.isString(envelope.error.message)
          ? { error: envelope.error, type: envelope.error.type, message: envelope.error.message }
          : expect.fail('error fixture must record an `error` envelope with a type and message')

      expect(recorded.error).not.toHaveProperty('code')

      const error = yield* gatewayStream({ model: fixtureModel(fixture) }).pipe(
        Stream.runCollect,
        Effect.flip
      )

      expect(error._tag).toBe('LLMError')
      expect(error).toMatchObject({
        cause: 'provider_error',
        message: `Vercel AI Gateway returned ${response.status}`,
        retryable: false,
        provider: {
          provider: 'vercel_ai_gateway',
          kind: 'unknown',
          status: response.status,
          providerCode: recorded.type
        }
      })
      expect(error.message).not.toContain(recorded.message)
      expect(error.message).not.toContain(fixtureModel(fixture))

      const [entry] = yield* (yield* ReplayLedger).entries

      expect(entry?.bodyJson).toMatchObject({ model: fixtureModel(fixture), stream: true })
      expect(pickRecordedRequestFields(entry?.bodyJson)).toEqual(
        pickRecordedRequestFields(recordedRequestBody(fixture))
      )
    }).pipe(
      Effect.provide(
        replayGatewayLayer(
          recordedGatewayConfig(streamingGatewayConfig, vercelAiGatewayErrorEnvelopeFixture),
          [vercelAiGatewayErrorEnvelopeFixture]
        )
      )
    )
  )
})

// Semi-synthetic, derived from the plain-text recording: the live Gateway sends `usage` on the
// finish event itself, but OpenAI-compatible APIs with `stream_options.include_usage` may send it
// as a separate usage-only event (`choices: []`) after the finish. This moves the recorded `usage`
// out of the finish event into such an event before `[DONE]`; all other events keep their recorded
// bytes, one per network chunk. It is kept to pin the #109 behaviour where a cut after the finish
// loses that usage.
const usageAfterFinishFixture = (): WireFixture => {
  const base = vercelAiGatewayPlainTextFixture
  const events = recordedSseEvents(base)
  const finish = events.findIndex(isFinishEvent)
  const json = events[finish]?.json

  if (!Predicate.hasProperty(json, 'usage') || !Predicate.isObject(json.usage)) {
    return expect.fail('plain-text recording must carry usage on its finish event')
  }

  const { usage, ...withoutUsage } = json

  // The usage-only event keeps the recorded chunk identity fields of the finish event.
  const recorded: unknown = json

  const identity = (key: 'id' | 'object' | 'created' | 'model') =>
    Predicate.hasProperty(recorded, key) ? { [key]: recorded[key] } : {}

  const usageOnly = {
    ...identity('id'),
    ...identity('object'),
    ...identity('created'),
    ...identity('model'),
    choices: [],
    usage
  }

  return derivedStreamFixture(base, 'usage-after-finish', [
    ...events.slice(0, finish).map(event => event.text),
    `data: ${JSON.stringify(withoutUsage)}\n\n`,
    `data: ${JSON.stringify(usageOnly)}\n\n`,
    ...events.slice(finish + 1).map(event => event.text)
  ])
}

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
      // Cut after the first chunk that carries content, before the finish.
      expect(firstChunkIndexWhere(fixture, hasContent)).toBeLessThan(
        firstChunkIndexWhere(fixture, isFinishEvent)
      )

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
          [WireFault.FailAfterChunks({ chunks: firstChunkIndexWhere(fixture, hasContent) + 1 })]
        )
      )
    )
  )

  it.effect(
    'fails a stream truncated before the finish chunk instead of returning a short answer',
    () =>
      Effect.gen(function* () {
        // The kept chunks carry content (output started) but not the finish event.
        expect(firstChunkIndexWhere(fixture, hasContent)).toBeLessThan(
          firstChunkIndexWhere(fixture, isFinishEvent)
        )

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
                chunks: firstChunkIndexWhere(fixture, isFinishEvent)
              })
            ]
          )
        )
      )
  )

  // Current provider behaviour: a processed finish reason is terminal, so a stream cut after the
  // finish event (before `[DONE]`) completes normally. The live Gateway packs events into shared
  // network chunks, so the recording is re-split one event per chunk to cut exactly there. The
  // recorded finish event carries `usage`, so usage survives the cut.
  it.effect('completes a stream truncated after the finish event, before [DONE]', () => {
    const split = oneEventPerChunkFixture(fixture)
    const events = recordedSseEvents(split)
    const finish = events.findIndex(isFinishEvent)
    const finishEvent = events[finish] ?? expect.fail('no recorded finish event')

    return Effect.gen(function* () {
      // Only `[DONE]` follows the finish, and the finish carries the usage.
      expect(hasUsage(finishEvent)).toBe(true)
      expect(events.slice(finish + 1).map(isDoneEvent)).toEqual([true])

      const streamed = Array.from(
        yield* gatewayStream({ model: fixtureModel(split) }).pipe(Stream.runCollect)
      )

      expect(textOf(streamed)).toBe((yield* fixtureDeltas(fixture)).content)
      expect(streamed.filter(event => event instanceof LLMDone)).toMatchObject([
        LLMDone.make({ stopReason: 'stop' })
      ])
      expect(streamed.some(event => event instanceof LLMUsage)).toBe(true)

      const entries = yield* (yield* ReplayLedger).entries

      expect(entries.map(entry => [entry.match.outcome, entry.fault])).toEqual([
        ['matched', 'TruncateAfterChunks']
      ])
    }).pipe(
      Effect.provide(
        replayGatewayLayer(
          streamingGatewayConfig,
          [split],
          [WireFault.TruncateAfterChunks({ chunks: finishEvent.chunkIndex + 1 })]
        )
      )
    )
  })

  // Pinned current behaviour (follow-up #109): when usage arrives as its own event after the
  // finish, a cut between the two completes with Done(stop) and silently drops the usage. Uses the
  // semi-synthetic `usageAfterFinishFixture` above; the live Gateway recording has no such gap.
  it.effect(
    'completes a stream truncated between the finish and a later usage event without usage',
    () => {
      const derived = usageAfterFinishFixture()
      const events = recordedSseEvents(derived)
      const finish = events.findIndex(isFinishEvent)
      const finishEvent = events[finish] ?? expect.fail('no finish event')

      return Effect.gen(function* () {
        expect(hasUsage(finishEvent)).toBe(false)
        expect(events.findIndex(hasUsage)).toBeGreaterThan(finish)

        const streamed = Array.from(
          yield* gatewayStream({ model: fixtureModel(derived) }).pipe(Stream.runCollect)
        )

        expect(textOf(streamed)).toBe((yield* fixtureDeltas(fixture)).content)
        expect(streamed.filter(event => event instanceof LLMDone)).toMatchObject([
          LLMDone.make({ stopReason: 'stop' })
        ])
        expect(streamed.some(event => event instanceof LLMUsage)).toBe(false)

        const entries = yield* (yield* ReplayLedger).entries

        expect(entries.map(entry => [entry.match.outcome, entry.fault])).toEqual([
          ['matched', 'TruncateAfterChunks']
        ])
      }).pipe(
        Effect.provide(
          replayGatewayLayer(
            streamingGatewayConfig,
            [derived],
            [WireFault.TruncateAfterChunks({ chunks: finishEvent.chunkIndex + 1 })]
          )
        )
      )
    }
  )

  // Without the cut, the semi-synthetic separate usage event is reported, so the test above fails
  // only because of the truncation.
  it.effect('reports usage sent as a separate event after the finish', () =>
    Effect.gen(function* () {
      const streamed = Array.from(
        yield* gatewayStream({ model: fixtureModel(fixture) }).pipe(Stream.runCollect)
      )

      expect(streamed.filter(event => event instanceof LLMDone)).toMatchObject([
        LLMDone.make({ stopReason: 'stop' })
      ])
      expect(streamed.some(event => event instanceof LLMUsage)).toBe(true)
    }).pipe(Effect.provide(replayGatewayLayer(streamingGatewayConfig, [usageAfterFinishFixture()])))
  )
})
