import { Effect, Layer, Predicate, Redacted, Stream } from 'effect'
import * as Schema from 'effect/Schema'
import { HttpClient, HttpClientResponse, type HttpClientRequest } from 'effect/unstable/http'
import { describe, expect, it } from '@effect/vitest'
import {
  AssistantAgentMessage,
  DocumentPart,
  HostToolCallPart,
  ImagePart,
  TextPart,
  ToolCall,
  ToolDef,
  ToolResultMessage,
  UserMessage,
  inlineBase64Source,
  urlAttachmentSource
} from '@yolk-sdk/agent/protocol'
import { LLMProvider } from '@yolk-sdk/agent/loop'
import {
  makeOpenAiProviderLayer,
  toOpenAiRequestBody as lowerOpenAiRequestBody
} from '../../../src/providers/openai/provider.ts'

const openAiTestMaxOutputTokens = 123

const toOpenAiRequestBody = (request: Parameters<typeof lowerOpenAiRequestBody>[0]) =>
  lowerOpenAiRequestBody(request, { maxCompletionTokens: openAiTestMaxOutputTokens })

type CapturedRequest = {
  readonly request: HttpClientRequest.HttpClientRequest
}

const makeProviderLayer = (httpClientLayer: Layer.Layer<HttpClient.HttpClient>) =>
  makeOpenAiProviderLayer({
    apiKey: Redacted.make('test-key'),
    maxCompletionTokens: openAiTestMaxOutputTokens
  }).pipe(Layer.provide(httpClientLayer))

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
    })
  )

  it.effect('passes image URLs through for Chat Completions input', () =>
    Effect.gen(function* () {
      const body = yield* toOpenAiRequestBody({
        model: 'gpt-5.4',
        systemPrompt: '',
        messages: [
          UserMessage.make({
            content: [
              TextPart.make({ text: 'describe' }),
              ImagePart.make({
                source: urlAttachmentSource('https://cdn.example.com/image.webp'),
                mimeType: 'image/webp'
              })
            ]
          })
        ],
        tools: []
      })

      expect(body.messages[1]).toEqual({
        role: 'user',
        content: [
          { type: 'text', text: 'describe' },
          { type: 'image_url', image_url: { url: 'https://cdn.example.com/image.webp' } }
        ]
      })
    })
  )

  it.effect('lowers opt-in reasoning after compatible endpoint extensions', () =>
    Effect.gen(function* () {
      const body = yield* lowerOpenAiRequestBody(
        {
          model: 'provider/reasoning-model',
          systemPrompt: '',
          reasoningEffort: 'high',
          messages: [UserMessage.make({ content: 'Think carefully' })],
          tools: []
        },
        {
          maxCompletionTokens: openAiTestMaxOutputTokens,
          reasoningEffortFormat: 'reasoning-object',
          extraBody: { reasoning: { effort: 'low' } }
        }
      )

      expect(body.reasoning).toEqual({ effort: 'high' })
    })
  )

  it.effect('rejects non-portable extraBody at lowering before transport', () =>
    Effect.gen(function* () {
      const secret = 'extra-body-secret-token'
      let accessorReads = 0
      const cyclic = {}

      Object.assign(cyclic, { extra: cyclic })

      class ExtraBox {
        extra = 1
      }

      const invalidExtras: ReadonlyArray<unknown> = [
        { extra: () => secret },
        { extra: Infinity },
        { extra: Number.NaN },
        { extra: undefined },
        { extra: Object.defineProperty({}, 'hidden', { value: secret, enumerable: false }) },
        { extra: { [Symbol('nested')]: secret } },
        { extra: Object.assign([1], { extra: secret }) },
        cyclic,
        null,
        ['models'],
        1,
        new Date(),
        new Map(),
        new ExtraBox(),
        {
          extra: {
            get value() {
              accessorReads += 1

              return secret
            }
          }
        }
      ]

      yield* Effect.forEach(invalidExtras, extraBody =>
        Effect.gen(function* () {
          const requests: Array<CapturedRequest> = []

          const config = {
            apiKey: Redacted.make('test-key'),
            maxCompletionTokens: openAiTestMaxOutputTokens
          }

          Object.assign(config, { extraBody })

          const layer = makeOpenAiProviderLayer(config).pipe(
            Layer.provide(makeHttpClientLayer(new Response('{}', { status: 429 }), requests))
          )

          const error = yield* Effect.gen(function* () {
            const provider = yield* LLMProvider
            expect(requests).toHaveLength(0)

            return yield* provider
              .stream({
                model: 'gpt-5.4',
                systemPrompt: '',
                messages: [UserMessage.make({ content: 'hello' })],
                tools: []
              })
              .pipe(Stream.runCollect)
          }).pipe(Effect.provide(layer), Effect.flip)

          expect(error._tag).toBe('LLMError')
          expect(error).toMatchObject({ cause: 'provider_error', retryable: false })
          expect(error.message).toBe('Invalid OpenAI extraBody JSON: expected a JSON object')
          expect(error.message.includes(secret)).toBe(false)
          expect(accessorReads).toBe(0)
          expect(requests).toHaveLength(0)
        })
      )
    })
  )

  it.effect('rejects surviving extraBody accessors without executing them', () =>
    Effect.gen(function* () {
      let reads = 0
      let discardedReads = 0
      const secret = 'surviving-accessor-secret'

      const extraBody = {
        extra: {
          get count() {
            reads += 1

            return secret
          }
        },
        model: {
          get ignored() {
            discardedReads += 1

            return Infinity
          }
        }
      }

      const error = yield* lowerOpenAiRequestBody(
        {
          model: 'gpt-5.4',
          systemPrompt: '',
          messages: [UserMessage.make({ content: 'hello' })],
          tools: []
        },
        {
          maxCompletionTokens: openAiTestMaxOutputTokens,
          extraBody
        }
      ).pipe(Effect.flip)

      expect(error._tag).toBe('LLMError')
      expect(error).toMatchObject({ cause: 'provider_error', retryable: false })
      expect(error.message).toBe('Invalid OpenAI extraBody JSON: expected a JSON object')
      expect(error.message.includes(secret)).toBe(false)
      expect(reads).toBe(0)
      expect(discardedReads).toBe(0)
    })
  )

  it.effect('omits reserved extraBody keys without reading discarded getters', () =>
    Effect.gen(function* () {
      let discardedReads = 0

      const extraBody = {
        extra: 1,
        model: {
          get ignored() {
            discardedReads += 1

            return 'discarded-reserved-model'
          }
        }
      }

      const body = yield* lowerOpenAiRequestBody(
        {
          model: 'gpt-5.4',
          systemPrompt: '',
          messages: [UserMessage.make({ content: 'hello' })],
          tools: []
        },
        {
          maxCompletionTokens: openAiTestMaxOutputTokens,
          extraBody
        }
      )

      expect(discardedReads).toBe(0)
      expect(body.model).toBe('gpt-5.4')
      expect(body).toMatchObject({ extra: 1, stream: false })
    })
  )

  it.effect('snapshots portable extraBody once and preserves DAG aliases', () =>
    Effect.gen(function* () {
      const shared = { n: 1 }
      const extraBody = { a: shared, b: shared, extra: null, enabled: false, count: 0 }
      extraBody.count = 2

      const lowered = yield* lowerOpenAiRequestBody(
        {
          model: 'gpt-5.4',
          systemPrompt: '',
          messages: [UserMessage.make({ content: 'hello' })],
          tools: []
        },
        {
          maxCompletionTokens: openAiTestMaxOutputTokens,
          extraBody
        }
      )

      extraBody.count = 99
      shared.n = 99

      expect(lowered).toMatchObject({
        a: { n: 1 },
        b: { n: 1 },
        extra: null,
        enabled: false,
        count: 2,
        model: 'gpt-5.4',
        stream: false
      })
      const extraA = Object.getOwnPropertyDescriptor(lowered, 'a')?.value
      const extraB = Object.getOwnPropertyDescriptor(lowered, 'b')?.value
      expect(extraA).toEqual({ n: 1 })
      expect(extraA).toBe(extraB)
      expect(extraA).not.toBe(shared)
    })
  )

  it.effect('admits JSON extraBody extras including null/false/0 onto the request wire', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      let ignoredReads = 0

      const extraBody = {
        models: ['fallback'],
        extra: null,
        enabled: false,
        count: 0,
        model: 'should-not-win'
      }

      Object.defineProperty(extraBody, 'hidden', {
        get: () => {
          ignoredReads += 1

          return 'hidden-root-secret'
        },
        enumerable: false
      })
      Object.defineProperty(extraBody, Symbol('root'), {
        get: () => {
          ignoredReads += 1

          return 'symbol-root-secret'
        },
        enumerable: true
      })
      Object.defineProperty(extraBody, '__proto__', {
        value: { owned: true },
        enumerable: true,
        writable: true,
        configurable: true
      })
      Object.defineProperty(extraBody, 'constructor', {
        value: null,
        enumerable: true,
        writable: true,
        configurable: true
      })

      const layer = makeOpenAiProviderLayer({
        apiKey: Redacted.make('test-key'),
        maxCompletionTokens: openAiTestMaxOutputTokens,
        extraBody
      }).pipe(
        Layer.provide(
          makeHttpClientLayer(
            new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
              status: 200
            }),
            requests
          )
        )
      )

      yield* Effect.gen(function* () {
        const provider = yield* LLMProvider

        return yield* provider
          .stream({
            model: 'gpt-5.4',
            systemPrompt: '',
            messages: [UserMessage.make({ content: 'hello' })],
            tools: []
          })
          .pipe(Stream.runCollect)
      }).pipe(Effect.provide(layer))

      expect(requests).toHaveLength(1)
      expect(ignoredReads).toBe(0)

      const body = requests[0]?.request.body

      expect(body?._tag).toBe('Uint8Array')

      if (body?._tag !== 'Uint8Array') return

      expect(new TextDecoder().decode(body.body)).toBe(
        '{"models":["fallback"],"extra":null,"enabled":false,"count":0,"__proto__":{"owned":true},"constructor":null,"model":"gpt-5.4","messages":[{"role":"system","content":""},{"role":"user","content":"hello"}],"max_completion_tokens":123,"stream":false}'
      )
    })
  )

  it.effect(
    'rejects forged non-JSON tool parameter documents at the Chat Completions boundary',
    () =>
      Effect.gen(function* () {
        const parameters = { type: 'object' }

        const tool = ToolDef.make({
          name: 'search',
          description: 'Search docs',
          parameters
        })

        Object.assign(parameters, { extra: () => undefined })

        const error = yield* toOpenAiRequestBody({
          model: 'gpt-5.4',
          systemPrompt: '',
          messages: [UserMessage.make({ content: 'hello' })],
          tools: [tool]
        }).pipe(Effect.flip)

        expect(error._tag).toBe('LLMError')
        expect(error).toMatchObject({ cause: 'provider_error', retryable: false })
        expect(error.message).toContain('Invalid OpenAI tool parameters JSON')
      })
  )

  it.effect('rejects non-JSON tool arguments before Chat Completions transport', () =>
    Effect.gen(function* () {
      const error = yield* toOpenAiRequestBody({
        model: 'gpt-5.4',
        systemPrompt: '',
        messages: [
          UserMessage.make({ content: 'search' }),
          AssistantAgentMessage.make({
            parts: [
              HostToolCallPart.make({
                call: ToolCall.make({
                  id: 'call-1',
                  name: 'search',
                  params: { extra: () => undefined }
                })
              })
            ]
          }),
          ToolResultMessage.make({ toolCallId: 'call-1', content: 'ok' })
        ],
        tools: []
      }).pipe(Effect.flip)

      expect(error._tag).toBe('LLMError')
      expect(error).toMatchObject({ cause: 'provider_error', retryable: false })
      expect(error.message).toContain('Could not serialize OpenAI tool arguments')
    })
  )

  it.effect('rejects non-text documents for Chat Completions input', () =>
    Effect.gen(function* () {
      const unsupportedDocuments = [
        { mimeType: 'application/pdf', filename: 'brief.pdf' },
        {
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          filename: 'brief.docx'
        }
      ]

      const errors = yield* Effect.forEach(unsupportedDocuments, document =>
        toOpenAiRequestBody({
          model: 'gpt-5.4',
          systemPrompt: '',
          messages: [
            UserMessage.make({
              content: [
                TextPart.make({ text: 'summarize' }),
                DocumentPart.make({
                  source: inlineBase64Source('JVBERi0='),
                  mimeType: document.mimeType,
                  filename: document.filename
                })
              ]
            })
          ],
          tools: []
        }).pipe(Effect.flip)
      )

      expect(errors).toHaveLength(2)

      for (const error of errors) {
        expect(error._tag).toBe('LLMError')
        expect(error).toMatchObject({ cause: 'provider_error', retryable: false })
        expect(error.message).toBe('Document content is not supported by the OpenAI provider yet')
      }
    })
  )

  it.effect('rejects dangling host tool calls before Chat Completions request lowering', () =>
    Effect.gen(function* () {
      const error = yield* toOpenAiRequestBody({
        model: 'gpt-5.4',
        systemPrompt: '',
        messages: [
          UserMessage.make({ content: 'search' }),
          AssistantAgentMessage.make({
            parts: [
              HostToolCallPart.make({
                call: ToolCall.make({ id: 'call-1', name: 'search', params: { query: 'yolk' } })
              })
            ]
          })
        ],
        tools: []
      }).pipe(Effect.flip)

      expect(error._tag).toBe('LLMError')
      expect(error).toMatchObject({ cause: 'validation_error', retryable: false })
      expect(error.message).toContain('search (call-1)')
    })
  )

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
      expect(error._tag).toBe('LLMError')
      expect(error).toMatchObject({
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

  it.effect('surfaces machine error codes without leaking upstream detail', () =>
    Effect.gen(function* () {
      const runFailure = (response: Response) =>
        Effect.gen(function* () {
          const provider = yield* LLMProvider

          return yield* provider
            .stream({
              messages: [UserMessage.make({ content: 'hello' })],
              tools: [],
              model: 'gpt-test',
              systemPrompt: 'Be brief.'
            })
            .pipe(Stream.runCollect)
        }).pipe(
          Effect.provide(makeProviderLayer(makeHttpClientLayer(response, []))),
          Effect.flip
        )

      const coded = yield* runFailure(
        Response.json(
          {
            error: {
              code: 'invalid_request_error',
              type: 'invalid_request_error',
              message: 'private upstream detail'
            }
          },
          { status: 400 }
        )
      )

      expect(coded._tag).toBe('LLMError')
      expect(coded).toMatchObject({
        cause: 'provider_error',
        retryable: false,
        provider: {
          provider: 'openai',
          kind: 'unknown',
          status: 400,
          providerCode: 'invalid_request_error'
        }
      })
      expect(coded.message).toBe('OpenAI returned 400')
      expect(coded.message).not.toContain('private upstream detail')

      const typeOnly = yield* runFailure(
        Response.json(
          { error: { type: 'upstream_type', message: 'private upstream detail' } },
          { status: 400 }
        )
      )

      expect(typeOnly._tag).toBe('LLMError')
      expect(typeOnly).toMatchObject({
        provider: {
          provider: 'openai',
          kind: 'unknown',
          status: 400,
          providerCode: 'upstream_type'
        }
      })
      expect(typeOnly.message).not.toContain('private upstream detail')

      const unparsable = yield* runFailure(new Response('<html>nope</html>', { status: 400 }))

      expect(unparsable._tag).toBe('LLMError')
      expect(unparsable).toMatchObject({
        provider: { provider: 'openai', kind: 'unknown', status: 400 }
      })

      if (!Predicate.isTagged(unparsable, 'LLMError')) {
        expect.fail('expected LLMError for unparsable error body')
      }

      expect(
        Object.prototype.hasOwnProperty.call(unparsable.provider ?? {}, 'providerCode')
      ).toBe(false)
    })
  )
})

describe('OpenAI provider streaming', () => {
  const sseStreamResponse = (lines: ReadonlyArray<string>) =>
    new Response(
      new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder()

          for (const line of lines) controller.enqueue(encoder.encode(line))

          controller.close()
        }
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } }
    )

  const chatSse = (payloads: ReadonlyArray<unknown>, done = true) =>
    sseStreamResponse([
      ...payloads.map(payload => `data: ${JSON.stringify(payload)}\n\n`),
      ...(done ? ['data: [DONE]\n\n'] : [])
    ])

  const rawSseStream = (chunks: ReadonlyArray<string>) =>
    new Response(
      new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder()

          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))

          controller.close()
        }
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } }
    )

  const chatChunk = (delta: unknown, finishReason: string | null = null) => ({
    choices: [{ delta, finish_reason: finishReason }]
  })

  const makeStreamingProviderLayer = (
    httpClientLayer: Layer.Layer<HttpClient.HttpClient>,
    reasoningContent = false
  ) =>
    makeOpenAiProviderLayer({
      apiKey: Redacted.make('test-key'),
      maxCompletionTokens: openAiTestMaxOutputTokens,
      reasoningContent,
      streaming: true
    }).pipe(Layer.provide(httpClientLayer))

  const collectStreamEvents = (response: Response, reasoningContent = false) =>
    Effect.gen(function* () {
      const provider = yield* LLMProvider

      return yield* provider
        .stream({
          messages: [UserMessage.make({ content: 'hello' })],
          tools: [],
          model: 'gpt-test',
          systemPrompt: 'Be brief.'
        })
        .pipe(Stream.runCollect)
    }).pipe(Effect.provide(makeStreamingProviderLayer(makeHttpClientLayer(response, []), reasoningContent)))

  it.effect('streams text deltas and usage to completion', () =>
    Effect.gen(function* () {
      const events = yield* collectStreamEvents(
        chatSse([
          chatChunk({ role: 'assistant' }),
          chatChunk({ content: 'Hello' }),
          chatChunk({ content: ' world' }),
          {
            choices: [{ delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5 }
          }
        ])
      )

      expect(Array.from(events)).toMatchObject([
        { _tag: 'TextDelta', text: 'Hello' },
        { _tag: 'TextDelta', text: ' world' },
        { _tag: 'Done', stopReason: 'stop' },
        { _tag: 'Usage', usage: { input: { total: 10 }, output: { total: 5 } } }
      ])
    })
  )

  it.effect('streams reasoning deltas when reasoning content is enabled', () =>
    Effect.gen(function* () {
      const events = yield* collectStreamEvents(
        chatSse([
          chatChunk({ reasoning_content: 'Thinking' }),
          chatChunk({ content: 'ok' }, 'stop')
        ]),
        true
      )

      expect(Array.from(events)).toMatchObject([
        { _tag: 'ReasoningDelta', text: 'Thinking' },
        { _tag: 'TextDelta', text: 'ok' },
        { _tag: 'Done', stopReason: 'stop' }
      ])
    })
  )

  it.effect('accumulates split tool calls across chunks', () =>
    Effect.gen(function* () {
      const events = yield* collectStreamEvents(
        chatSse([
          chatChunk({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'search' } }] }),
          chatChunk({ tool_calls: [{ index: 0, function: { arguments: '{"q' } }] }),
          chatChunk({ tool_calls: [{ index: 0, function: { arguments: 'uery":"x"}' } }] }),
          chatChunk({}, 'tool_calls')
        ])
      )

      expect(Array.from(events)).toMatchObject([
        {
          _tag: 'ToolCall',
          call: { id: 'call_1', name: 'search', params: { query: 'x' } }
        },
        { _tag: 'Done', stopReason: 'tool_use' }
      ])
    })
  )

  it.effect('fails length finishes without completion', () =>
    Effect.gen(function* () {
      const error = yield* collectStreamEvents(chatSse([chatChunk({ content: 'cut' }, 'length')])).pipe(
        Effect.flip
      )

      expect(error._tag).toBe('LLMError')
      expect(error).toMatchObject({ cause: 'invalid_response', retryable: false })
      expect(error.message).toContain('length')
    })
  )

  it.effect('fails unterminated streams without emitting done', () =>
    Effect.gen(function* () {
      const error = yield* collectStreamEvents(
        chatSse([chatChunk({ content: 'dangling' })], false)
      ).pipe(Effect.flip)

      expect(error._tag).toBe('LLMError')
      expect(error).toMatchObject({
        cause: 'invalid_response',
        retryable: false,
        provider: { provider: 'openai', kind: 'invalid_response', providerCode: 'incomplete_stream' }
      })
    })
  )

  it.effect('maps mid-stream error envelopes to coded provider errors', () =>
    Effect.gen(function* () {
      const error = yield* collectStreamEvents(
        chatSse([
          chatChunk({ content: 'partial' }),
          { type: 'error', error: { code: 'upstream_error', message: 'private detail' } }
        ])
      ).pipe(Effect.flip)

      expect(error._tag).toBe('LLMError')
      expect(error).toMatchObject({
        cause: 'provider_error',
        retryable: false,
        provider: { provider: 'openai', providerCode: 'upstream_error' }
      })
      expect(error.message).not.toContain('private detail')
    })
  )

  it.effect('reassembles events split across transport chunks', () =>
    Effect.gen(function* () {
      const payload = JSON.stringify({ choices: [{ delta: { content: 'Hi' } }] })
      const split = Math.floor(payload.length / 2)

      const events = yield* collectStreamEvents(
        rawSseStream([
          `data: ${payload.slice(0, split)}`,
          `${payload.slice(split)}\n\n`,
          'data: {"choices": [{', '"delta": {"content": "!"}}]}\n\n',
          'data: {"choices": [{"delta": {}, "finish_reason": "stop"}]}\n\n',
          'data: [DONE]\n\n'
        ])
      )

      expect(Array.from(events)).toMatchObject([
        { _tag: 'TextDelta', text: 'Hi' },
        { _tag: 'TextDelta', text: '!' },
        { _tag: 'Done', stopReason: 'stop' }
      ])
    })
  )

  it.effect('reassembles split CRLF before multiline continuations', () =>
    Effect.gen(function* () {
      const events = yield* collectStreamEvents(
        rawSseStream([
          'data: {"choices":\r',
          '\ndata: [{"delta": {"content": "Hi"}, "finish_reason": "stop"}]}\r\n\r\n',
          'data: [DONE]\n\n'
        ])
      )

      expect(Array.from(events)).toMatchObject([
        { _tag: 'TextDelta', text: 'Hi' },
        { _tag: 'Done', stopReason: 'stop' }
      ])
    })
  )

  it.effect('keeps usage arriving after the finish chunk', () =>
    Effect.gen(function* () {
      const events = yield* collectStreamEvents(
        chatSse([
          { choices: [{ delta: { content: 'Hi' }, finish_reason: 'stop' }] },
          {
            choices: [],
            usage: { prompt_tokens: 4, completion_tokens: 2 }
          }
        ])
      )

      expect(Array.from(events)).toMatchObject([
        { _tag: 'TextDelta', text: 'Hi' },
        { _tag: 'Done', stopReason: 'stop' },
        { _tag: 'Usage', usage: { input: { total: 4 }, output: { total: 2 } } }
      ])
    })
  )

  it.effect('tolerates split CRLF across transport chunks', () =>
    Effect.gen(function* () {
      const events = yield* collectStreamEvents(
        rawSseStream([
          'data: {"choices": [{"delta": {"content": "Hi"}}]}\r',
          '\n\n',
          'data: {"choices": [{"delta": {}, "finish_reason": "stop"}]}\n\n',
          'data: [DONE]\n\n'
        ])
      )

      expect(Array.from(events)).toMatchObject([
        { _tag: 'TextDelta', text: 'Hi' },
        { _tag: 'Done', stopReason: 'stop' }
      ])
    })
  )

  it.effect('joins multiline data lines into one event', () =>
    Effect.gen(function* () {
      const events = yield* collectStreamEvents(
        rawSseStream([
          'data: {"choices":\ndata: [{"delta": {"content": "Hi"}, "finish_reason": "stop"}]}\n\n',
          'data: [DONE]\n\n'
        ])
      )

      expect(Array.from(events)).toMatchObject([
        { _tag: 'TextDelta', text: 'Hi' },
        { _tag: 'Done', stopReason: 'stop' }
      ])
    })
  )

  it.effect('ignores frames after the terminal marker', () =>
    Effect.gen(function* () {
      const events = yield* collectStreamEvents(
        rawSseStream([
          'data: {"choices": [{"delta": {"content": "Hi"}, "finish_reason": "stop"}]}\n\n',
          'data: [DONE]\n\n',
          'data: {broken\n\n',
          'data: {"choices": [{"delta": {"content": "LATE"}}]}\n\n'
        ])
      )

      expect(Array.from(events)).toMatchObject([
        { _tag: 'TextDelta', text: 'Hi' },
        { _tag: 'Done', stopReason: 'stop' }
      ])
    })
  )

  it.effect('fails tool calls without identities', () =>
    Effect.gen(function* () {
      const error = yield* collectStreamEvents(
        chatSse([
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{}' } }] } }] },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
        ])
      ).pipe(Effect.flip)

      expect(error._tag).toBe('LLMError')
      expect(error).toMatchObject({ cause: 'invalid_response', retryable: false })
      expect(error.message).toBe('Invalid OpenAI streamed tool call')
    })
  )

  it.effect('fails filtered finishes without completion', () =>
    Effect.gen(function* () {
      const error = yield* collectStreamEvents(
        chatSse([{ choices: [{ delta: { content: 'cut' }, finish_reason: 'content_filter' }] }])
      ).pipe(Effect.flip)

      expect(error._tag).toBe('LLMError')
      expect(error).toMatchObject({
        cause: 'invalid_response',
        retryable: false,
        provider: { provider: 'openai', kind: 'invalid_response', providerCode: 'content_filter' }
      })
    })
  )

  it.effect('fails unknown finishes without leaking the reason', () =>
    Effect.gen(function* () {
      const error = yield* collectStreamEvents(
        chatSse([{ choices: [{ delta: {}, finish_reason: 'bogus_reason' }] }])
      ).pipe(Effect.flip)

      expect(error._tag).toBe('LLMError')
      expect(error).toMatchObject({
        cause: 'provider_error',
        retryable: false,
        provider: { provider: 'openai', providerCode: 'bogus_reason' }
      })
      expect(error.message).toBe('OpenAI stream stopped with unrecognized finish reason')
      expect(error.message).not.toContain('bogus_reason')
    })
  )

  it.effect('classifies mid-stream rate limits as retryable', () =>
    Effect.gen(function* () {
      const error = yield* collectStreamEvents(
        chatSse([
          chatChunk({ content: 'partial' }),
          { error: { code: 'rate_limit', message: 'slow down' } }
        ])
      ).pipe(Effect.flip)

      expect(error._tag).toBe('LLMError')
      expect(error).toMatchObject({
        cause: 'rate_limit',
        retryable: true,
        provider: { provider: 'openai', kind: 'rate_limit', providerCode: 'rate_limit' }
      })
      expect(error.message).not.toContain('slow down')
    })
  )

  it.effect('requests deltas with usage options', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []

      const layer = makeStreamingProviderLayer(
        makeHttpClientLayer(chatSse([chatChunk({ content: 'ok' }, 'stop')]), requests)
      )

      yield* Effect.gen(function* () {
        const provider = yield* LLMProvider

        return yield* provider
          .stream({
            messages: [UserMessage.make({ content: 'hello' })],
            tools: [],
            model: 'gpt-test',
            systemPrompt: 'Be brief.'
          })
          .pipe(Stream.runCollect)
      }).pipe(Effect.provide(layer))

      const rawBody = requests[0]?.request.body

      expect(rawBody?._tag).toBe('Uint8Array')

      if (rawBody?._tag !== 'Uint8Array') {
        expect.fail('Expected uint8 request body')
      }

      const body = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(
        new TextDecoder().decode(rawBody.body)
      )

      expect(body).toMatchObject({ stream: true, stream_options: { include_usage: true } })
    })
  )
})
