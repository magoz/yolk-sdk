import { Effect, Layer, Stream } from 'effect'
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse
} from 'effect/unstable/http'
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
import { OAuthAccessToken } from '@yolk-sdk/agent/oauth'
import { LLMProvider } from '@yolk-sdk/agent/loop'
import {
  makeAnthropicClaudeProviderLayer,
  streamAnthropicClaudeResponse,
  toAnthropicClaudeRequestBody
} from '../../../src/providers/anthropic/claude-provider.ts'

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

const responseFromChunks = (chunks: ReadonlyArray<string>) => {
  const encoder = new TextEncoder()

  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk))
        }
        controller.close()
      }
    }),
    { status: 200 }
  )
}

const openResponseWithFirstChunk = (chunk: string) => {
  const encoder = new TextEncoder()

  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(chunk))
      }
    }),
    { status: 200 }
  )
}

const streamErrorHttpResponse = () => {
  const request = HttpClientRequest.get('https://example.com')
  const response = HttpClientResponse.fromWeb(request, new Response('', { status: 200 }))

  Object.defineProperty(response, 'stream', {
    value: Stream.fail(
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({
          request,
          description: 'stream broke'
        })
      })
    )
  })

  return response
}

const readCapturedHeaders = (requests: ReadonlyArray<CapturedRequest>) => {
  const headers = requests[0]?.request.headers
  expect(headers).toBeDefined()

  if (headers === undefined) {
    expect.fail('Expected Anthropic request headers')
  }

  return headers
}

const readCapturedBody = (requests: ReadonlyArray<CapturedRequest>) => {
  const body = requests[0]?.request.body
  expect(body?._tag).toBe('Uint8Array')

  if (body?._tag !== 'Uint8Array') {
    expect.fail('Expected Anthropic request body')
  }

  return new TextDecoder().decode(body.body)
}

const collectKeys = (value: unknown): ReadonlyArray<string> => {
  if (Array.isArray(value)) return value.flatMap(collectKeys)
  if (typeof value !== 'object' || value === null) return []

  return Object.entries(value).flatMap(([key, child]) => [key, ...collectKeys(child)])
}

const runMinimalProviderRequest = (
  input: {
    readonly extraHeaders?: Readonly<Record<string, string>>
    readonly model?: string
    readonly response?: Response
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
        makeHttpClientLayer(input.response ?? new Response('', { status: 200 }), requests)
      )
    )

    yield* Effect.gen(function* () {
      const provider = yield* LLMProvider

      yield* provider
        .stream({
          model: input.model ?? 'claude-sonnet-4-6',
          systemPrompt: '',
          messages: [UserMessage.make({ content: 'hello' })],
          tools: []
        })
        .pipe(Stream.runCollect)
    }).pipe(Effect.provide(providerLayer))
  })

const collectProviderEvents = (response: Response, requests: Array<CapturedRequest>) =>
  Effect.gen(function* () {
    const providerLayer = makeAnthropicClaudeProviderLayer({
      token: new OAuthAccessToken({
        provider: 'anthropic-claude',
        accessToken: 'token',
        expiresAt: Date.now() + 60_000
      })
    }).pipe(Layer.provide(makeHttpClientLayer(response, requests)))

    return yield* Effect.gen(function* () {
      const provider = yield* LLMProvider

      return yield* provider
        .stream({
          model: 'claude-sonnet-4-6',
          systemPrompt: '',
          messages: [UserMessage.make({ content: 'hello' })],
          tools: []
        })
        .pipe(Stream.runCollect)
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
                ImagePart.make({ source: inlineBase64Source('abc'), mimeType: 'image/png' }),
                DocumentPart.make({
                  source: inlineBase64Source('JVBERi0='),
                  mimeType: 'application/pdf',
                  filename: 'brief.pdf'
                })
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

      expect(body.system).toEqual([
        {
          type: 'text',
          text: expect.stringMatching(
            /^x-anthropic-billing-header: cc_version=2\.1\.112\.[0-9a-f]{3}; cc_entrypoint=sdk-cli; cch=[0-9a-f]{5};$/
          )
        },
        { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }
      ])
      expect(body).toMatchObject({
        model: 'claude-sonnet-4-6',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Use tools carefully.' },
              { type: 'text', text: 'inspect' },
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: 'abc' }
              },
              {
                type: 'document',
                source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' },
                title: 'brief.pdf'
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
        tools: [
          { name: 'mcp_Search', description: 'Search docs', input_schema: { type: 'object' } }
        ]
      })
    })
  )

  it.effect('lowers rich tool results to nested Claude content blocks', () =>
    Effect.gen(function* () {
      const body = yield* toAnthropicClaudeRequestBody({
        model: 'claude-sonnet-4-6',
        systemPrompt: '',
        messages: [
          UserMessage.make({ content: 'inspect' }),
          AssistantAgentMessage.make({
            parts: [
              HostToolCallPart.make({
                call: ToolCall.make({ id: 'call-1', name: 'screenshot', params: {} })
              })
            ]
          }),
          ToolResultMessage.make({
            toolCallId: 'call-1',
            content: [
              TextPart.make({ text: 'Screenshot:' }),
              ImagePart.make({ source: inlineBase64Source('abc'), mimeType: 'image/png' }),
              DocumentPart.make({
                source: urlAttachmentSource('https://example.com/brief.pdf'),
                mimeType: 'application/pdf',
                filename: 'brief.pdf'
              })
            ],
            isError: true
          })
        ],
        tools: []
      })

      expect(body.messages[2]).toEqual({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call-1',
            content: [
              { type: 'text', text: 'Screenshot:' },
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: 'abc' }
              },
              {
                type: 'document',
                source: { type: 'url', url: 'https://example.com/brief.pdf' },
                title: 'brief.pdf'
              }
            ],
            is_error: true
          }
        ]
      })
    })
  )

  it.effect('lowers image-only URL tool results', () =>
    Effect.gen(function* () {
      const body = yield* toAnthropicClaudeRequestBody({
        model: 'claude-sonnet-4-6',
        systemPrompt: '',
        messages: [
          UserMessage.make({ content: 'inspect' }),
          AssistantAgentMessage.make({
            parts: [
              HostToolCallPart.make({
                call: ToolCall.make({ id: 'call-1', name: 'screenshot', params: {} })
              })
            ]
          }),
          ToolResultMessage.make({
            toolCallId: 'call-1',
            content: [
              ImagePart.make({
                source: urlAttachmentSource('https://example.com/screenshot.png'),
                mimeType: 'image/png'
              })
            ]
          })
        ],
        tools: []
      })

      expect(body.messages[2]).toMatchObject({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call-1',
            content: [
              {
                type: 'image',
                source: { type: 'url', url: 'https://example.com/screenshot.png' }
              }
            ]
          }
        ]
      })
    })
  )

  it.effect('rejects dangling host tool calls before Anthropic request lowering', () =>
    Effect.gen(function* () {
      const error = yield* toAnthropicClaudeRequestBody({
        model: 'claude-sonnet-4-6',
        systemPrompt: '',
        messages: [
          UserMessage.make({ content: 'search' }),
          AssistantAgentMessage.make({
            parts: [
              HostToolCallPart.make({
                call: ToolCall.make({ id: 'call-1', name: 'search', params: { query: 'yolk' } })
              })
            ]
          }),
          UserMessage.make({ content: 'continue' })
        ],
        tools: []
      }).pipe(Effect.flip)

      expect(error).toMatchObject({
        _tag: 'LLMError',
        cause: 'validation_error',
        retryable: false
      })
      expect(error.message).toContain('search (call-1)')
    })
  )

  it.effect('normalizes Anthropic tool input schemas to provider-safe root objects', () =>
    Effect.gen(function* () {
      const body = yield* toAnthropicClaudeRequestBody({
        model: 'claude-sonnet-4-6',
        systemPrompt: '',
        messages: [UserMessage.make({ content: 'hello' })],
        tools: [
          ToolDef.make({
            name: 'missing_type',
            description: 'Missing root type.',
            parameters: {
              properties: { query: { type: 'string' } },
              required: ['query']
            }
          }),
          ToolDef.make({
            name: 'root_union',
            description: 'Root union.',
            parameters: {
              oneOf: [
                {
                  type: 'object',
                  properties: {
                    operation: { type: 'string', enum: ['search'] },
                    query: { type: 'string' }
                  },
                  required: ['operation', 'query'],
                  additionalProperties: false,
                  $defs: { SearchMeta: { type: 'string' } }
                },
                {
                  type: 'object',
                  properties: {
                    operation: { type: 'string', enum: ['list'] },
                    limit: { type: 'number' }
                  },
                  required: ['operation'],
                  additionalProperties: false,
                  $defs: { ListMeta: { type: 'number' } }
                }
              ]
            }
          }),
          ToolDef.make({
            name: 'root_intersection',
            description: 'Root intersection.',
            parameters: {
              allOf: [
                {
                  type: 'object',
                  properties: { first: { type: 'string' } },
                  required: ['first']
                },
                {
                  type: 'object',
                  properties: { second: { type: 'number' } },
                  required: ['second']
                }
              ]
            }
          })
        ]
      })

      expect(body.tools?.[0]?.input_schema).toEqual({
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query']
      })
      expect(body.tools?.[1]?.input_schema).toEqual({
        type: 'object',
        properties: {
          operation: { type: 'string', enum: ['search', 'list'] },
          query: { type: 'string' },
          limit: { type: 'number' }
        },
        required: ['operation'],
        additionalProperties: false,
        $defs: { SearchMeta: { type: 'string' }, ListMeta: { type: 'number' } }
      })
      expect(body.tools?.[2]?.input_schema).toEqual({
        type: 'object',
        properties: { first: { type: 'string' }, second: { type: 'number' } },
        required: ['first', 'second'],
        $defs: {}
      })
    })
  )

  it.effect('normalizes nested Anthropic tool schema combinators', () =>
    Effect.gen(function* () {
      const body = yield* toAnthropicClaudeRequestBody({
        model: 'claude-sonnet-4-6',
        systemPrompt: '',
        messages: [UserMessage.make({ content: 'hello' })],
        tools: [
          ToolDef.make({
            name: 'schema_probe',
            description: 'Probe nested schemas.',
            parameters: {
              type: 'object',
              properties: {
                count: {
                  anyOf: [
                    { anyOf: [{ type: 'number' }, { type: 'string', enum: ['NaN'] }] },
                    { type: 'null' }
                  ]
                },
                title: {
                  type: 'string',
                  allOf: [{ minLength: 1 }, { maxLength: 80 }]
                },
                items: {
                  type: 'array',
                  prefixItems: [{ type: 'string' }],
                  items: { type: 'string' }
                }
              },
              required: ['title']
            }
          })
        ]
      })
      const schema = body.tools?.[0]?.input_schema
      const keys = collectKeys(schema)

      expect(keys).not.toContain('anyOf')
      expect(keys).not.toContain('oneOf')
      expect(keys).not.toContain('allOf')
      expect(keys).not.toContain('prefixItems')
      expect(schema).toMatchObject({
        properties: {
          count: { type: 'number' },
          title: { type: 'string', minLength: 1, maxLength: 80 },
          items: { type: 'array', items: { type: 'string' } }
        }
      })
    })
  )

  it.effect('inlines text documents for Claude Messages input', () =>
    Effect.gen(function* () {
      const body = yield* toAnthropicClaudeRequestBody({
        model: 'claude-sonnet-4-6',
        systemPrompt: '',
        messages: [
          UserMessage.make({
            content: [
              TextPart.make({ text: 'summarize' }),
              DocumentPart.make({
                source: inlineBase64Source(btoa('# Identity\n\nSpeldosa docs.')),
                mimeType: 'text/markdown',
                filename: 'company.identity.md'
              })
            ]
          })
        ],
        tools: []
      })

      expect(body.messages[0]).toEqual({
        role: 'user',
        content: [
          { type: 'text', text: 'summarize' },
          { type: 'text', text: 'Document: company.identity.md\n\n# Identity\n\nSpeldosa docs.' }
        ]
      })
    })
  )

  it.effect('passes image URLs through for Claude Messages input', () =>
    Effect.gen(function* () {
      const body = yield* toAnthropicClaudeRequestBody({
        model: 'claude-sonnet-4-6',
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

      expect(body.messages[0]).toEqual({
        role: 'user',
        content: [
          { type: 'text', text: 'describe' },
          {
            type: 'image',
            source: { type: 'url', url: 'https://cdn.example.com/image.webp' }
          }
        ]
      })
    })
  )

  it.effect('passes PDF URLs through for Claude Messages input', () =>
    Effect.gen(function* () {
      const body = yield* toAnthropicClaudeRequestBody({
        model: 'claude-sonnet-4-6',
        systemPrompt: '',
        messages: [
          UserMessage.make({
            content: [
              TextPart.make({ text: 'summarize' }),
              DocumentPart.make({
                source: urlAttachmentSource('https://cdn.example.com/brief.pdf'),
                mimeType: 'application/pdf',
                filename: 'brief.pdf',
                title: 'Brief'
              })
            ]
          })
        ],
        tools: []
      })

      expect(body.messages[0]).toEqual({
        role: 'user',
        content: [
          { type: 'text', text: 'summarize' },
          {
            type: 'document',
            source: { type: 'url', url: 'https://cdn.example.com/brief.pdf' },
            title: 'Brief'
          }
        ]
      })
    })
  )

  it.effect('sends required Anthropic version and beta headers by default', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      yield* runMinimalProviderRequest({}, requests)

      const headers = readCapturedHeaders(requests)
      const body = readCapturedBody(requests)

      expect(headers['anthropic-version']).toBe('2023-06-01')
      expect(headers['anthropic-beta']).toBe(
        'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,prompt-caching-scope-2026-01-05,context-management-2025-06-27,advisor-tool-2026-03-01,effort-2025-11-24'
      )
      expect(headers['anthropic-dangerous-direct-browser-access']).toBe('true')
      expect(headers['user-agent']).toBe('claude-cli/2.1.112 (external, sdk-cli)')
      expect(headers['x-app']).toBe('cli')
      expect(headers['x-client-request-id']).toBeDefined()
      expect(headers['x-claude-code-session-id']).toBeDefined()
      expect(headers['x-stainless-lang']).toBe('js')
      expect(headers.accept).toBe('text/event-stream')
      expect(body).toContain('"stream":true')
    })
  )

  it.effect('sanitizes known OpenCode prompt fingerprints', () =>
    Effect.gen(function* () {
      const body = yield* toAnthropicClaudeRequestBody(
        {
          model: 'claude-sonnet-4-6',
          systemPrompt:
            'Here is some useful information about the environment you are running in: if OpenCode honestly',
          messages: [UserMessage.make({ content: 'hello' })],
          tools: []
        },
        { maxTokens: 123 }
      )

      expect(body.messages[0]).toMatchObject({
        role: 'user',
        content: 'Environment context you are running in: if the assistant honestly\n\nhello'
      })
    })
  )

  it.effect('omits interleaved thinking beta for Haiku', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      yield* runMinimalProviderRequest({ model: 'claude-haiku-4-5' }, requests)

      const headers = readCapturedHeaders(requests)

      expect(headers['anthropic-beta']).toBe(
        'claude-code-20250219,oauth-2025-04-20,prompt-caching-scope-2026-01-05,context-management-2025-06-27,advisor-tool-2026-03-01'
      )
    })
  )

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
    })
  )

  it.effect('maps Anthropic prompt-too-long HTTP errors to context overflow', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      const response = new Response(
        JSON.stringify({
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: 'prompt is too long: 233153 tokens > 200000 maximum'
          }
        }),
        { status: 400 }
      )
      const error = yield* runMinimalProviderRequest({ response }, requests).pipe(Effect.flip)

      expect(error).toMatchObject({
        _tag: 'LLMError',
        cause: 'context_overflow',
        message:
          'Anthropic Claude returned 400: prompt is too long: 233153 tokens > 200000 maximum',
        retryable: false,
        provider: {
          provider: 'anthropic_claude',
          kind: 'context_overflow',
          status: 400,
          providerCode: 'invalid_request_error'
        }
      })
    })
  )

  it.effect('streams Anthropic text deltas as they arrive', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      const response = openResponseWithFirstChunk(
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hel"}}\n\n'
      )
      const providerLayer = makeAnthropicClaudeProviderLayer({
        token: new OAuthAccessToken({
          provider: 'anthropic-claude',
          accessToken: 'token',
          expiresAt: Date.now() + 60_000
        })
      }).pipe(Layer.provide(makeHttpClientLayer(response, requests)))
      const eventsChunk = yield* Effect.gen(function* () {
        const provider = yield* LLMProvider

        return yield* provider
          .stream({
            model: 'claude-sonnet-4-6',
            systemPrompt: '',
            messages: [UserMessage.make({ content: 'hello' })],
            tools: []
          })
          .pipe(Stream.take(1), Stream.runCollect)
      }).pipe(Effect.provide(providerLayer))
      const events = Array.from(eventsChunk)

      expect(events.map(event => event._tag)).toEqual(['TextDelta'])
      expect(events[0]).toMatchObject({ text: 'hel' })
    })
  )

  it.effect('parses chunked CRLF Anthropic SSE streams', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      const response = responseFromChunks([
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"he',
        'l"}}\r\n\r\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}\r\n\r\n',
        'data: {"type":"message_stop"}\r\n\r\n'
      ])
      const eventsChunk = yield* collectProviderEvents(response, requests)
      const events = Array.from(eventsChunk)

      expect(events.map(event => event._tag)).toEqual(['TextDelta', 'TextDelta', 'Done'])
      expect(events[0]).toMatchObject({ text: 'hel' })
      expect(events[1]).toMatchObject({ text: 'lo' })
    })
  )

  it.effect('supports non-streaming Anthropic JSON responses', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      const response = new Response(
        JSON.stringify({
          content: [{ type: 'text', text: 'hello' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 2, output_tokens: 3 }
        }),
        { status: 200 }
      )
      const eventsChunk = yield* collectProviderEvents(response, requests)
      const events = Array.from(eventsChunk)

      expect(events.map(event => event._tag)).toEqual(['TextDelta', 'Done', 'Usage'])
      expect(events[0]).toMatchObject({ text: 'hello' })
      expect(events[2]).toMatchObject({ usage: { input: { total: 2 }, output: { total: 3 } } })
    })
  )

  it.effect('fails non-streaming responses truncated at max_tokens', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      const response = new Response(
        JSON.stringify({
          content: [{ type: 'text', text: 'I will call the tool next.' }],
          stop_reason: 'max_tokens',
          usage: { input_tokens: 2, output_tokens: 8192 }
        }),
        { status: 200 }
      )
      const error = yield* collectProviderEvents(response, requests).pipe(Effect.flip)

      expect(error).toMatchObject({
        _tag: 'LLMError',
        cause: 'invalid_response',
        message: 'Anthropic Claude stopped after reaching max_tokens',
        retryable: false
      })
    })
  )

  it.effect('maps Anthropic cache usage into total input usage', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      const response = new Response(
        JSON.stringify({
          content: [{ type: 'text', text: 'hello' }],
          stop_reason: 'end_turn',
          usage: {
            input_tokens: 2,
            cache_read_input_tokens: 5,
            cache_creation_input_tokens: 3,
            output_tokens: 4
          }
        }),
        { status: 200 }
      )
      const eventsChunk = yield* collectProviderEvents(response, requests)
      const events = Array.from(eventsChunk)

      expect(events[2]).toMatchObject({
        usage: {
          input: { total: 10, uncached: 2, cacheRead: 5, cacheWrite: 3 },
          output: { total: 4 }
        }
      })
    })
  )

  it.effect('treats null Anthropic cache usage fields as zero', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      const response = new Response(
        JSON.stringify({
          content: [{ type: 'text', text: 'hello' }],
          stop_reason: 'end_turn',
          usage: {
            input_tokens: 2,
            cache_read_input_tokens: null,
            cache_creation_input_tokens: null,
            output_tokens: 4
          }
        }),
        { status: 200 }
      )
      const eventsChunk = yield* collectProviderEvents(response, requests)
      const events = Array.from(eventsChunk)
      const usageEvent = events[2]

      expect(usageEvent).toMatchObject({
        usage: { input: { total: 2, uncached: 2 }, output: { total: 4 } }
      })
      if (usageEvent?._tag !== 'Usage') expect.fail('Expected usage event')
      expect(usageEvent.usage.input.cacheRead).toBeUndefined()
      expect(usageEvent.usage.input.cacheWrite).toBeUndefined()
    })
  )

  it.effect('streams Anthropic tool calls from partial JSON deltas', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      const response = responseFromChunks([
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"mcp_Search"}}\n\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":"}}\n\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"yolk\\"}"}}\n\n',
        'data: {"type":"content_block_stop","index":0}\n\n',
        'data: {"type":"message_stop"}\n\n'
      ])
      const eventsChunk = yield* collectProviderEvents(response, requests)
      const events = Array.from(eventsChunk)

      expect(events.map(event => event._tag)).toEqual(['ToolCall', 'Done'])

      const toolCall = events[0]
      expect(toolCall).toMatchObject({
        call: { id: 'toolu_1', name: 'search', params: { query: 'yolk' } }
      })
      expect(events[1]).toMatchObject({ stopReason: 'tool_use' })
    })
  )

  it.effect('preserves StructuredOutput casing when unprefixing Claude tool calls', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      const response = new Response(
        JSON.stringify({
          content: [
            { type: 'tool_use', id: 'toolu_1', name: 'mcp_StructuredOutput', input: { ok: true } }
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 2, output_tokens: 3 }
        }),
        { status: 200 }
      )
      const eventsChunk = yield* collectProviderEvents(response, requests)
      const events = Array.from(eventsChunk)

      expect(events[0]).toMatchObject({
        call: { id: 'toolu_1', name: 'StructuredOutput', params: { ok: true } }
      })
    })
  )

  it.effect('emits Anthropic streaming usage deltas when output snapshots arrive', () =>
    Effect.gen(function* () {
      const request = HttpClientRequest.get('https://example.com')
      const response = HttpClientResponse.fromWeb(
        request,
        responseFromChunks([
          'data: {"type":"message_start","message":{"usage":{"input_tokens":4,"cache_read_input_tokens":3,"cache_creation_input_tokens":2,"output_tokens":1}}}\n\n',
          'data: {"type":"message_delta","usage":{"output_tokens":7}}\n\n',
          'data: {"type":"message_stop"}\n\n'
        ])
      )
      const eventsChunk = yield* streamAnthropicClaudeResponse(response).pipe(Stream.runCollect)
      const events = Array.from(eventsChunk)

      expect(events.map(event => event._tag)).toEqual(['Usage', 'Usage', 'Done'])
      expect(events[0]).toMatchObject({
        usage: {
          input: { total: 9, uncached: 4, cacheRead: 3, cacheWrite: 2 },
          output: { total: 1 }
        }
      })
      expect(events[1]).toMatchObject({ usage: { input: { total: 0 }, output: { total: 6 } } })
    })
  )

  it.effect('fails streams truncated at max_tokens instead of reporting completion', () =>
    Effect.gen(function* () {
      const request = HttpClientRequest.get('https://example.com')
      const response = HttpClientResponse.fromWeb(
        request,
        responseFromChunks([
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"I will call the tool next."}}\n\n',
          'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens","stop_sequence":null},"usage":{"output_tokens":8192}}\n\n',
          'data: {"type":"message_stop"}\n\n'
        ])
      )
      const error = yield* streamAnthropicClaudeResponse(response).pipe(
        Stream.runCollect,
        Effect.flip
      )

      expect(error).toMatchObject({
        _tag: 'LLMError',
        cause: 'invalid_response',
        message: 'Anthropic Claude stopped after reaching max_tokens',
        retryable: false
      })
    })
  )

  it.effect('parses null Anthropic streaming usage fields without dropping output usage', () =>
    Effect.gen(function* () {
      const request = HttpClientRequest.get('https://example.com')
      const response = HttpClientResponse.fromWeb(
        request,
        responseFromChunks([
          'data: {"type":"message_start","message":{"usage":{"input_tokens":4,"cache_read_input_tokens":null,"cache_creation_input_tokens":null,"output_tokens":1}}}\n\n',
          'data: {"type":"message_delta","usage":{"input_tokens":null,"cache_read_input_tokens":null,"cache_creation_input_tokens":null,"output_tokens":7}}\n\n',
          'data: {"type":"message_stop"}\n\n'
        ])
      )
      const eventsChunk = yield* streamAnthropicClaudeResponse(response).pipe(Stream.runCollect)
      const events = Array.from(eventsChunk)

      expect(events.map(event => event._tag)).toEqual(['Usage', 'Usage', 'Done'])
      expect(events[0]).toMatchObject({ usage: { input: { total: 4 }, output: { total: 1 } } })
      expect(events[1]).toMatchObject({ usage: { input: { total: 0 }, output: { total: 6 } } })
    })
  )

  it.effect('maps Anthropic overloaded stream errors to retryable metadata', () =>
    Effect.gen(function* () {
      const request = HttpClientRequest.get('https://example.com')
      const response = HttpClientResponse.fromWeb(
        request,
        responseFromChunks([
          'data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n'
        ])
      )
      const error = yield* streamAnthropicClaudeResponse(response).pipe(
        Stream.runCollect,
        Effect.flip
      )

      expect(error).toMatchObject({
        _tag: 'LLMError',
        cause: 'overloaded',
        retryable: true,
        provider: {
          provider: 'anthropic_claude',
          kind: 'overloaded',
          providerCode: 'overloaded_error'
        }
      })
    })
  )

  it.effect('marks Anthropic stream read failures retryable', () =>
    Effect.gen(function* () {
      const response = streamErrorHttpResponse()
      const error = yield* streamAnthropicClaudeResponse(response).pipe(
        Stream.runCollect,
        Effect.flip
      )

      expect(error).toMatchObject({
        _tag: 'LLMError',
        cause: 'provider_error',
        retryable: true,
        provider: { provider: 'anthropic_claude', kind: 'stream' }
      })
    })
  )
})
