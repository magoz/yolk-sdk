import { Effect, Layer, Predicate, Ref, Stream } from 'effect'
import * as Schema from 'effect/Schema'
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from 'effect/http'
import { describe, expect, it } from '@effect/vitest'
import {
  AssistantAgentMessage,
  DocumentPart,
  HostToolCallPart,
  ImagePart,
  TextPart,
  ToolCall,
  ToolDef,
  ToolResult,
  ToolResultMessage,
  toolJsonSchemaOmittedNullComment,
  UserMessage,
  inlineBase64Source,
  urlAttachmentSource
} from '@yolk-sdk/agent/protocol'
import { OAuthAccessToken } from '@yolk-sdk/agent/oauth'
import { LLMProvider } from '@yolk-sdk/agent/loop'
import { makeTool, resolveTools } from '@yolk-sdk/agent/tools'
import {
  makeAnthropicClaudeProviderLayer,
  streamAnthropicClaudeResponse,
  toAnthropicClaudeRequestBody as lowerAnthropicClaudeRequestBody
} from '../../../src/providers/anthropic/claude-provider.ts'

const anthropicTestMaxTokens = 123

const toAnthropicClaudeRequestBody = (
  request: Parameters<typeof lowerAnthropicClaudeRequestBody>[0],
  config: Parameters<typeof lowerAnthropicClaudeRequestBody>[1] = {
    maxTokens: anthropicTestMaxTokens
  }
) => lowerAnthropicClaudeRequestBody(request, config)

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

const isJsonObject = (value: Schema.Json): value is Schema.JsonObject =>
  Predicate.isObjectOrArray(value) && !Array.isArray(value)

const collectKeys = (value: Schema.Json): ReadonlyArray<string> => {
  if (Array.isArray(value)) return value.flatMap(collectKeys)

  if (!isJsonObject(value)) return []

  return Object.entries(value).flatMap(([key, child]) => [key, ...collectKeys(child)])
}

const RecurringSchedule = Schema.TaggedStruct('Recurring', {
  cron: Schema.String,
  timezone: Schema.String
})

// `timezone` is required in Recurring and optional (`anyOf: [string, null]`) here.
const OneTimeSchedule = Schema.TaggedStruct('OneTime', {
  runAt: Schema.String,
  timezone: Schema.optional(Schema.String)
})

const ScheduleSpec = Schema.Union([RecurringSchedule, OneTimeSchedule])

const mergedScheduleSpec = {
  type: 'object',
  properties: {
    _tag: { type: 'string', enum: ['Recurring', 'OneTime'] },
    cron: { type: 'string' },
    timezone: { type: 'string' },
    runAt: { type: 'string' }
  },
  required: ['_tag'],
  $defs: {},
  additionalProperties: false
}

/** A registry-derived tool whose `execute` records the decoded params it received. */
const schemaTool = <S extends Schema.Schema<unknown> & { readonly DecodingServices: never }>(
  name: string,
  parameters: S
) => {
  const received: Array<S['Type']> = []

  const tool = makeTool({
    name,
    description: `Probe ${name}.`,
    access: 'read',
    parameters,
    execute: ({ call, params }) => {
      received.push(params)

      return Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'ok' }))
    }
  })

  return { tool, received }
}

const claudeInputSchemas = (tools: ReadonlyArray<ToolDef>) =>
  toAnthropicClaudeRequestBody({
    model: 'claude-sonnet-4-6',
    systemPrompt: '',
    messages: [UserMessage.make({ content: 'hello' })],
    tools
  }).pipe(Effect.map(body => (body.tools ?? []).map(tool => tool.input_schema)))

const runMinimalProviderRequest = (
  input: {
    readonly extraHeaders?: Readonly<Record<string, string>>
    readonly model?: string
    readonly response?: Response
  },
  requests: Array<CapturedRequest>
) =>
  Effect.gen(function* () {
    const providerConfig = {
      token: new OAuthAccessToken({
        provider: 'anthropic-claude',
        accessToken: 'token',
        expiresAt: Date.now() + 60_000
      }),
      maxTokens: anthropicTestMaxTokens
    }

    const providerLayer = makeAnthropicClaudeProviderLayer(
      input.extraHeaders === undefined
        ? providerConfig
        : { ...providerConfig, extraHeaders: input.extraHeaders }
    ).pipe(
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
      }),
      maxTokens: anthropicTestMaxTokens
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

/** Runs one request that must fail; returns its error and how many events preceded it. */
const failedProviderRequest = (response: Response) =>
  Effect.gen(function* () {
    const emitted = yield* Ref.make(0)

    const providerLayer = makeAnthropicClaudeProviderLayer({
      token: new OAuthAccessToken({
        provider: 'anthropic-claude',
        accessToken: 'token',
        expiresAt: Date.now() + 60_000
      }),
      maxTokens: anthropicTestMaxTokens
    }).pipe(Layer.provide(makeHttpClientLayer(response, [])))

    const error = yield* Effect.gen(function* () {
      const provider = yield* LLMProvider

      return yield* provider
        .stream({
          model: 'claude-sonnet-4-6',
          systemPrompt: '',
          messages: [UserMessage.make({ content: 'hello' })],
          tools: []
        })
        .pipe(
          Stream.tap(() => Ref.update(emitted, count => count + 1)),
          Stream.runDrain,
          Effect.flip
        )
    }).pipe(Effect.provide(providerLayer))

    return { error, emitted: yield* Ref.get(emitted) }
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
            /^x-anthropic-billing-header: cc_version=2\.1\.299\.[0-9a-f]{3}; cc_entrypoint=sdk-cli; cch=[0-9a-f]{5};$/
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

  it.effect('omits is_error for successful tool results without the flag', () =>
    Effect.gen(function* () {
      const body = yield* toAnthropicClaudeRequestBody(
        {
          model: 'claude-sonnet-4-6',
          systemPrompt: 'Use tools carefully.',
          messages: [
            UserMessage.make({ content: 'inspect' }),
            AssistantAgentMessage.make({
              parts: [
                HostToolCallPart.make({
                  call: ToolCall.make({ id: 'call-1', name: 'search', params: {} })
                })
              ]
            }),
            ToolResultMessage.make({ toolCallId: 'call-1', content: 'result' })
          ],
          tools: []
        },
        { maxTokens: 123 }
      )

      expect(body.model).toBe('claude-sonnet-4-6')
      expect(body.messages[2]).toStrictEqual({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call-1',
            content: 'result',
            cache_control: { type: 'ephemeral' }
          }
        ]
      })
    })
  )

  it.effect('lowers supported reasoning effort to Anthropic output config', () =>
    Effect.gen(function* () {
      const body = yield* toAnthropicClaudeRequestBody({
        model: 'claude-opus-5',
        systemPrompt: '',
        messages: [UserMessage.make({ content: 'analyze' })],
        tools: [],
        reasoningEffort: 'medium'
      })

      expect(body).toMatchObject({ output_config: { effort: 'medium' } })
    })
  )

  it.effect('omits unsupported minimal effort from Anthropic output config', () =>
    Effect.gen(function* () {
      const body = yield* toAnthropicClaudeRequestBody({
        model: 'claude-opus-5',
        systemPrompt: '',
        messages: [UserMessage.make({ content: 'analyze' })],
        tools: [],
        reasoningEffort: 'minimal'
      })

      expect(body).not.toHaveProperty('output_config')
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
            is_error: true,
            cache_control: { type: 'ephemeral' }
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

      expect(error._tag).toBe('LLMError')
      expect(error).toMatchObject({ cause: 'validation_error', retryable: false })
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
            name: 'root_true',
            description: 'Root true schema.',
            parameters: true
          }),
          ToolDef.make({
            name: 'root_boolean_union',
            description: 'Root boolean union.',
            parameters: {
              anyOf: [true, { type: 'object', properties: { value: { type: 'string' } } }]
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
        properties: {}
      })
      expect(body.tools?.[3]?.input_schema).toEqual({
        type: 'object',
        properties: {},
        required: [],
        $defs: {}
      })
      expect(body.tools?.[4]?.input_schema).toEqual({
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
                nullable: {
                  anyOf: [{ type: 'string' }, { type: 'null' }]
                },
                title: {
                  type: 'string',
                  allOf: [{ minLength: 1 }, { maxLength: 80 }]
                },
                subject: {
                  type: 'string',
                  allOf: [{ maxLength: 2_000 }, { maxLength: 160 }]
                },
                reversedSubject: {
                  type: 'string',
                  allOf: [{ maxLength: 160 }, { maxLength: 2_000 }]
                },
                metadata: {
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
                },
                boundedChoice: {
                  type: 'string',
                  maxLength: 100,
                  oneOf: [{ maxLength: 80 }, { maxLength: 60 }]
                },
                enumVariant: {
                  oneOf: [
                    { type: 'string', enum: ['a'], maxLength: 1 },
                    { type: 'string', enum: ['bb'], minLength: 2 }
                  ]
                },
                conditionalVariant: {
                  if: { anyOf: [{ type: 'number' }, { const: 'x' }] },
                  then: { maxLength: 1 }
                },
                booleanVariant: {
                  anyOf: [true, { type: 'string' }]
                },
                conditionalTuple: {
                  if: {
                    type: 'array',
                    prefixItems: [{ type: 'string' }],
                    items: false
                  },
                  then: { maxItems: 0 }
                },
                keywordProperty: {
                  type: 'object',
                  properties: { not: { type: 'string' } },
                  required: ['not'],
                  additionalProperties: false
                },
                enumData: {
                  enum: [{ if: 'literal' }]
                },
                keywordDefinition: {
                  $ref: '#/$defs/not',
                  $defs: { not: { type: 'string' } }
                },
                legacyDependencies: {
                  type: 'object',
                  dependencies: {
                    enum: { anyOf: [{ type: 'string' }, { type: 'number' }] }
                  }
                },
                patternVariant: {
                  oneOf: [
                    {
                      type: 'object',
                      properties: { x: { type: 'string' } }
                    },
                    {
                      type: 'object',
                      patternProperties: { '^x$': { type: 'number' } },
                      additionalProperties: false
                    }
                  ]
                },
                variant: {
                  oneOf: [
                    {
                      type: 'object',
                      properties: { value: { type: 'string' } },
                      required: ['value'],
                      additionalProperties: false
                    },
                    {
                      type: 'object',
                      properties: { value: { type: 'number' } },
                      required: ['value'],
                      additionalProperties: false
                    }
                  ]
                },
                typelessVariant: {
                  oneOf: [
                    {
                      properties: { first: { type: 'string' } },
                      required: ['first']
                    },
                    {
                      properties: { second: { type: 'number' } },
                      required: ['second']
                    }
                  ]
                },
                openVariant: {
                  oneOf: [
                    {
                      type: 'object',
                      properties: { value: { type: 'string' } },
                      required: ['value']
                    },
                    {
                      type: 'object',
                      properties: { other: { type: 'number' } },
                      required: ['other'],
                      additionalProperties: false
                    }
                  ]
                },
                items: {
                  type: 'array',
                  prefixItems: [{ type: 'string' }],
                  items: { type: 'string' }
                },
                tuple: {
                  type: 'array',
                  prefixItems: [{ type: 'string' }, { type: 'number' }],
                  items: false
                }
              },
              required: ['title']
            }
          })
        ]
      })

      const schema = body.tools?.[0]?.input_schema
      expect(schema).toBeDefined()

      if (schema === undefined) {
        expect.fail('Expected Anthropic tool input schema')
      }

      const keys = collectKeys(schema)

      expect(keys).not.toContain('anyOf')
      expect(keys).not.toContain('oneOf')
      expect(keys).not.toContain('allOf')
      expect(keys).not.toContain('prefixItems')
      expect(schema).toMatchObject({
        properties: {
          count: {},
          nullable: {},
          title: { type: 'string', minLength: 1, maxLength: 80 },
          subject: { type: 'string', maxLength: 160 },
          reversedSubject: { type: 'string', maxLength: 2_000 },
          metadata: {
            type: 'object',
            properties: { first: { type: 'string' }, second: { type: 'number' } },
            required: ['first', 'second']
          },
          boundedChoice: { type: 'string', maxLength: 100 },
          enumVariant: { type: 'string' },
          conditionalVariant: {},
          booleanVariant: {},
          conditionalTuple: {},
          keywordProperty: {
            type: 'object',
            properties: { not: { type: 'string' } },
            required: ['not'],
            additionalProperties: false
          },
          enumData: { enum: [{ if: 'literal' }] },
          keywordDefinition: {
            $ref: '#/$defs/not',
            $defs: { not: { type: 'string' } }
          },
          legacyDependencies: {
            type: 'object',
            dependencies: { enum: {} }
          },
          patternVariant: { type: 'object' },
          variant: {
            type: 'object',
            properties: { value: {} },
            required: ['value'],
            $defs: {},
            additionalProperties: false
          },
          typelessVariant: {},
          openVariant: {
            type: 'object',
            properties: { value: {}, other: {} },
            required: [],
            $defs: {}
          },
          items: { type: 'array', items: {} },
          tuple: { type: 'array', items: {} }
        }
      })
    })
  )

  it.effect('advertises Schema.optional params with their type, not as unconstrained', () =>
    Effect.gen(function* () {
      const schemas = yield* claudeInputSchemas(
        [
          schemaTool(
            'optional_primitive',
            Schema.Struct({
              note: Schema.optional(Schema.String.annotate({ description: 'Free text.' })),
              mode: Schema.optional(Schema.Literals(['read', 'write'])).annotate({
                description: 'Access mode.'
              })
            })
          ),
          schemaTool(
            'optional_struct',
            Schema.Struct({ spec: Schema.optional(RecurringSchedule) })
          ),
          schemaTool('optional_union', Schema.Struct({ spec: Schema.optional(ScheduleSpec) })),
          schemaTool('required_union', Schema.Struct({ spec: ScheduleSpec })),
          schemaTool(
            'meaningful_null',
            Schema.Struct({
              clearable: Schema.optional(Schema.NullOr(Schema.String)),
              // Same JSON as `Schema.optional(Schema.String)`, but `null` means "clear".
              cleared: Schema.optionalKey(Schema.NullOr(Schema.String)),
              nullable: Schema.NullOr(Schema.String),
              items: Schema.Array(Schema.NullOr(Schema.String))
            })
          )
        ].map(({ tool }) => tool.def)
      )

      for (const schema of schemas) {
        expect(collectKeys(schema)).not.toContain('anyOf')
        expect(collectKeys(schema)).not.toContain('$comment')
      }

      expect(schemas[0]).toEqual({
        type: 'object',
        properties: {
          note: { type: 'string', description: 'Free text.' },
          mode: { type: 'string', enum: ['read', 'write'], description: 'Access mode.' }
        },
        additionalProperties: false
      })
      expect(schemas[1]).toEqual({
        type: 'object',
        properties: {
          spec: {
            type: 'object',
            properties: {
              _tag: { type: 'string', enum: ['Recurring'] },
              cron: { type: 'string' },
              timezone: { type: 'string' }
            },
            required: ['_tag', 'cron', 'timezone'],
            additionalProperties: false
          }
        },
        additionalProperties: false
      })
      // Optional stays optional: no `required` is added for `spec`.
      expect(schemas[2]).toEqual({
        type: 'object',
        properties: { spec: mergedScheduleSpec },
        additionalProperties: false
      })
      expect(schemas[3]).toEqual({
        type: 'object',
        properties: { spec: mergedScheduleSpec },
        required: ['spec'],
        additionalProperties: false
      })
      // Where `null` means something other than omission it stays widened.
      expect(schemas[4]).toEqual({
        type: 'object',
        properties: {
          clearable: {},
          cleared: {},
          nullable: {},
          items: { type: 'array', items: {} }
        },
        required: ['nullable', 'items'],
        additionalProperties: false
      })
    })
  )

  it.effect(
    'keeps raw anyOf [X, null] optional params widened, as remote MCP tools send them',
    () =>
      Effect.gen(function* () {
        // e.g. Pydantic `Optional[X] = None`: the server may read `null` as "clear".
        const [schema] = yield* claudeInputSchemas([
          ToolDef.make({
            name: 'remote_update',
            description: 'Remote MCP-like tool.',
            parameters: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                note: { anyOf: [{ type: 'string' }, { type: 'null' }], default: null },
                spec: {
                  anyOf: [
                    { type: 'object', properties: { cron: { type: 'string' } } },
                    { type: 'null' }
                  ]
                },
                // Another tool's `$comment` is not Yolk's marker.
                tagged: { anyOf: [{ type: 'string' }, { type: 'null', $comment: 'nullable' }] }
              },
              required: ['id']
            }
          })
        ])

        expect(schema).toEqual({
          type: 'object',
          properties: { id: { type: 'string' }, note: { default: null }, spec: {}, tagged: {} },
          required: ['id']
        })
      })
  )

  it.effect('advertises named Schema.optional params with their type', () =>
    Effect.gen(function* () {
      const OptionalNote = Schema.optional(Schema.String).annotate({ identifier: 'OptionalNote' })

      const [schema] = yield* claudeInputSchemas([
        schemaTool('named_optional', Schema.Struct({ note: OptionalNote })).tool.def
      ])

      expect(schema).toEqual({
        type: 'object',
        properties: { note: { type: 'string' } },
        additionalProperties: false,
        // The shared definition is not edited; on its own it stays widened.
        $defs: { OptionalNote: {} }
      })
    })
  )

  it.effect('strips a shared marked definition only where the property is optional', () =>
    Effect.gen(function* () {
      const Note = Schema.UndefinedOr(Schema.String).annotate({ identifier: 'Note' })
      const marked = { type: 'null', $comment: toolJsonSchemaOmittedNullComment }

      const [effectSchema, sharedSchema] = yield* claudeInputSchemas([
        schemaTool('effect_named', Schema.Struct({ a: Note, b: Schema.optionalKey(Note) })).tool
          .def,
        // One definition referenced from a required and an optional property.
        ToolDef.make({
          name: 'shared_named',
          description: 'Shared definition.',
          parameters: {
            type: 'object',
            properties: {
              a: { $ref: '#/$defs/Note' },
              b: { $ref: '#/$defs/Note', description: 'Optional note.' }
            },
            required: ['a'],
            $defs: { Note: { anyOf: [{ type: 'string' }, marked] } }
          }
        })
      ])

      // Required context untouched: still the `$ref`, to the definition widened as before.
      expect(effectSchema).toEqual({
        type: 'object',
        properties: { a: { $ref: '#/$defs/Note' }, b: { type: 'string' } },
        required: ['a'],
        additionalProperties: false,
        $defs: { Note: {}, Note_1: {} }
      })
      expect(sharedSchema).toEqual({
        type: 'object',
        properties: {
          a: { $ref: '#/$defs/Note' },
          b: { type: 'string', description: 'Optional note.' }
        },
        required: ['a'],
        $defs: { Note: {} }
      })
    })
  )

  it.effect('inlines a recursive marked definition once per path', () =>
    Effect.gen(function* () {
      const marked = { type: 'null', $comment: toolJsonSchemaOmittedNullComment }

      const [schema] = yield* claudeInputSchemas([
        ToolDef.make({
          name: 'linked',
          description: 'Recursive optional definition.',
          parameters: {
            type: 'object',
            properties: { head: { $ref: '#/$defs/Link' } },
            $defs: {
              Link: {
                anyOf: [
                  {
                    type: 'object',
                    properties: { value: { type: 'string' }, next: { $ref: '#/$defs/Link' } },
                    required: ['value']
                  },
                  marked
                ]
              }
            }
          }
        })
      ])

      expect(schema).toEqual({
        type: 'object',
        properties: {
          head: {
            type: 'object',
            properties: { value: { type: 'string' }, next: { $ref: '#/$defs/Link' } },
            required: ['value']
          }
        },
        // The shared definition is not edited.
        $defs: { Link: {} }
      })
    })
  )

  it.effect('keeps a root union property that one variant requires through a named schema', () =>
    Effect.gen(function* () {
      const marked = { type: 'null', $comment: toolJsonSchemaOmittedNullComment }

      const [schema] = yield* claudeInputSchemas([
        ToolDef.make({
          name: 'variant_named',
          description: 'Root union with a required named property.',
          parameters: {
            anyOf: [
              {
                type: 'object',
                properties: { kind: { enum: ['a'] }, note: { $ref: '#/$defs/Note' } },
                required: ['kind', 'note'],
                additionalProperties: false
              },
              {
                type: 'object',
                properties: { kind: { enum: ['b'] } },
                required: ['kind'],
                additionalProperties: false
              }
            ],
            $defs: { Note: { anyOf: [{ type: 'string' }, marked] } }
          }
        })
      ])

      // Variant `a` requires `note` (its `null` decodes as `undefined`): it keeps its
      // `$ref` to the widened definition, never stripped to `string` although the
      // merged `note` is optional.
      expect(schema).toEqual({
        type: 'object',
        properties: { kind: { enum: ['a', 'b'] }, note: { $ref: '#/$defs/Note' } },
        required: ['kind'],
        additionalProperties: false,
        $defs: { Note: {} }
      })
    })
  )

  it.effect('keeps a nested union property that one variant requires through a named schema', () =>
    Effect.gen(function* () {
      const marked = { type: 'null', $comment: toolJsonSchemaOmittedNullComment }

      // Variant `a` requires `note`; its `null` decodes as `undefined`, so
      // `{ payload: { kind: 'a', note: null } }` is valid and must stay allowed.
      const payload: Schema.Json = {
        anyOf: [
          {
            type: 'object',
            properties: { kind: { enum: ['a'] }, note: { $ref: '#/$defs/Note' } },
            required: ['kind', 'note'],
            additionalProperties: false
          },
          {
            type: 'object',
            properties: { kind: { enum: ['b'] } },
            required: ['kind'],
            additionalProperties: false
          }
        ]
      }

      const [underRootUnion, underRootObject] = yield* claudeInputSchemas([
        ToolDef.make({
          name: 'nested_under_union',
          description: 'Nested union below a root union.',
          parameters: {
            anyOf: [
              {
                type: 'object',
                properties: { op: { enum: ['x'] }, payload },
                required: ['op', 'payload'],
                additionalProperties: false
              },
              {
                type: 'object',
                properties: { op: { enum: ['y'] } },
                required: ['op'],
                additionalProperties: false
              }
            ],
            $defs: { Note: { anyOf: [{ type: 'string' }, marked] } }
          }
        }),
        ToolDef.make({
          name: 'nested_under_object',
          description: 'Nested union below a root object.',
          parameters: {
            type: 'object',
            properties: { payload },
            required: ['payload'],
            $defs: { Note: { anyOf: [{ type: 'string' }, marked] } }
          }
        })
      ])

      // Merged once: `note` keeps its `$ref` to the (widened) shared definition.
      const mergedPayload = {
        type: 'object',
        properties: { kind: { enum: ['a', 'b'] }, note: { $ref: '#/$defs/Note' } },
        required: ['kind'],
        $defs: {},
        additionalProperties: false
      }

      expect(underRootUnion).toEqual({
        type: 'object',
        properties: { op: { enum: ['x', 'y'] }, payload: mergedPayload },
        required: ['op'],
        additionalProperties: false,
        $defs: { Note: {} }
      })
      expect(underRootObject).toEqual({
        type: 'object',
        properties: { payload: mergedPayload },
        required: ['payload'],
        $defs: { Note: {} }
      })
    })
  )

  it.effect('passes null for Schema.optionalKey(Schema.NullOr(X)) through to the tool', () =>
    Effect.gen(function* () {
      const { tool, received } = schemaTool(
        'clear_note',
        Schema.Struct({ id: Schema.String, note: Schema.optionalKey(Schema.NullOr(Schema.String)) })
      )

      const [schema] = yield* claudeInputSchemas([tool.def])
      // Unchanged: `null` stays sendable (widened), never narrowed to `string`.
      expect(schema).toEqual({
        type: 'object',
        properties: { id: { type: 'string' }, note: {} },
        required: ['id'],
        additionalProperties: false
      })

      const response = new Response(
        JSON.stringify({
          content: [
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'mcp_Clear_note',
              input: { id: 'n1', note: null }
            }
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 2, output_tokens: 3 }
        }),
        { status: 200 }
      )

      const events = Array.from(yield* collectProviderEvents(response, []))
      const toolCall = events[0]

      if (toolCall?._tag !== 'ToolCall') {
        return expect.fail('Expected a Claude tool call')
      }

      const toolSet = yield* resolveTools([{ id: 'test', tools: [tool] }], undefined)
      const result = yield* toolSet.execute(toolCall.call)

      expect(result.isError).toBeUndefined()
      expect(received).toEqual([{ id: 'n1', note: null }])
    })
  )

  it.effect('merges root union properties required in one variant and optional in another', () =>
    Effect.gen(function* () {
      const [schedule, conflicting] = yield* claudeInputSchemas([
        schemaTool('schedule', ScheduleSpec).tool.def,
        schemaTool(
          'conflicting',
          Schema.Union([
            Schema.Struct({ kind: Schema.Literal('text'), value: Schema.String }),
            Schema.Struct({ kind: Schema.Literal('count'), value: Schema.optional(Schema.Number) })
          ])
        ).tool.def
      ])

      expect(schedule).toEqual(mergedScheduleSpec)
      // Genuinely different types still widen to an unconstrained schema.
      expect(conflicting).toEqual({
        type: 'object',
        properties: { kind: { type: 'string', enum: ['text', 'count'] }, value: {} },
        required: ['kind'],
        $defs: {},
        additionalProperties: false
      })
    })
  )

  it.effect('decodes null that Claude sends for an optional param as absent', () =>
    Effect.gen(function* () {
      const { tool, received } = schemaTool(
        'schedule',
        Schema.Struct({ label: Schema.String, spec: Schema.optional(ScheduleSpec) })
      )

      const [schema] = yield* claudeInputSchemas([tool.def])
      expect(schema).toMatchObject({ properties: { spec: mergedScheduleSpec } })

      const response = new Response(
        JSON.stringify({
          content: [
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'mcp_Schedule',
              input: { label: 'daily', spec: null }
            }
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 2, output_tokens: 3 }
        }),
        { status: 200 }
      )

      const events = Array.from(yield* collectProviderEvents(response, []))
      const toolCall = events[0]

      if (toolCall?._tag !== 'ToolCall') {
        return expect.fail('Expected a Claude tool call')
      }

      expect(toolCall.call).toMatchObject({ name: 'schedule', params: { spec: null } })

      const toolSet = yield* resolveTools([{ id: 'test', tools: [tool] }], undefined)
      const result = yield* toolSet.execute(toolCall.call)

      expect(result.isError).toBeUndefined()
      expect(received).toEqual([{ label: 'daily' }])
    })
  )

  it.effect('rejects forged non-JSON tool parameter documents at the Anthropic boundary', () =>
    Effect.gen(function* () {
      const parameters = { type: 'object' }

      const tool = ToolDef.make({
        name: 'search',
        description: 'Search docs',
        parameters
      })

      Object.assign(parameters, { extra: () => undefined })

      const error = yield* toAnthropicClaudeRequestBody({
        model: 'claude-sonnet-4-6',
        systemPrompt: '',
        messages: [UserMessage.make({ content: 'hello' })],
        tools: [tool]
      }).pipe(Effect.flip)

      expect(error._tag).toBe('LLMError')
      expect(error).toMatchObject({ cause: 'provider_error', retryable: false })
      expect(error.message).toContain('Invalid Anthropic Claude tool parameters JSON')
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
          {
            type: 'text',
            text: 'Document: company.identity.md\n\n# Identity\n\nSpeldosa docs.',
            cache_control: { type: 'ephemeral' }
          }
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
            source: { type: 'url', url: 'https://cdn.example.com/image.webp' },
            cache_control: { type: 'ephemeral' }
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
            title: 'Brief',
            cache_control: { type: 'ephemeral' }
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
      expect(headers['user-agent']).toBe('claude-cli/2.1.299 (external, sdk-cli)')
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
        content: [
          {
            type: 'text',
            text: 'Environment context you are running in: if the assistant honestly\n\nhello',
            cache_control: { type: 'ephemeral' }
          }
        ]
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

      expect(error._tag).toBe('LLMError')
      expect(error).toMatchObject({
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

  it.effect('reports the quota reset of an exhausted Claude subscription before any event', () =>
    Effect.gen(function* () {
      // The test clock starts at the epoch; the reset is three days after it.
      const resetsAtSeconds = 3 * 86_400

      const response = new Response(
        JSON.stringify({
          type: 'error',
          error: { type: 'rate_limit_error', message: 'This request would exceed your limit' }
        }),
        {
          status: 429,
          headers: {
            'anthropic-ratelimit-unified-status': 'rejected',
            'anthropic-ratelimit-unified-5h-status': 'allowed',
            'anthropic-ratelimit-unified-7d-status': 'rejected',
            'anthropic-ratelimit-unified-7d-reset': String(resetsAtSeconds),
            'anthropic-ratelimit-unified-reset': String(resetsAtSeconds)
          }
        }
      )

      const { error, emitted } = yield* failedProviderRequest(response)

      expect(emitted).toBe(0)
      expect(error._tag).toBe('LLMError')
      expect(error).toMatchObject({
        cause: 'rate_limit',
        retryable: true,
        provider: {
          provider: 'anthropic_claude',
          kind: 'rate_limit',
          status: 429,
          quotaResetsAtMs: resetsAtSeconds * 1000
        }
      })
    })
  )

  it.effect('omits the quota reset on transient Claude rate limits', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []

      const response = new Response(
        JSON.stringify({
          type: 'error',
          error: { type: 'rate_limit_error', message: 'slow down' }
        }),
        { status: 429, headers: { 'retry-after': '20' } }
      )

      const error = yield* collectProviderEvents(response, requests).pipe(Effect.flip)

      expect(error).toMatchObject({
        _tag: 'LLMError',
        provider: { kind: 'rate_limit', retryAfterMs: 20_000 }
      })
      expect(JSON.stringify(error)).not.toContain('quotaResetsAtMs')
    })
  )

  it.effect('reports the specific details.error_code of an Anthropic error', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []

      const response = new Response(
        JSON.stringify({
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message:
              'Claude Code 2.1.112 does not support this model; version 2.1.280 or newer is required.',
            details: { error_code: 'claude_code_version_too_old' }
          }
        }),
        { status: 400 }
      )

      const error = yield* runMinimalProviderRequest({ response }, requests).pipe(Effect.flip)

      expect(error).toMatchObject({
        retryable: false,
        provider: {
          provider: 'anthropic_claude',
          kind: 'unknown',
          status: 400,
          providerCode: 'claude_code_version_too_old'
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
        }),
        maxTokens: anthropicTestMaxTokens
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

      expect(error._tag).toBe('LLMError')
      expect(error).toMatchObject({
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

      expect(error._tag).toBe('LLMError')
      expect(error).toMatchObject({
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

      expect(error._tag).toBe('LLMError')
      expect(error).toMatchObject({
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

  it.effect('reports the details.error_code of an Anthropic stream error', () =>
    Effect.gen(function* () {
      const request = HttpClientRequest.get('https://example.com')

      const response = HttpClientResponse.fromWeb(
        request,
        responseFromChunks([
          'data: {"type":"error","error":{"type":"invalid_request_error","message":"Claude Code 2.1.112 does not support this model.","details":{"error_code":"claude_code_version_too_old"}}}\n\n'
        ])
      )

      const error = yield* streamAnthropicClaudeResponse(response).pipe(
        Stream.runCollect,
        Effect.flip
      )

      expect(error).toMatchObject({
        retryable: false,
        provider: { provider: 'anthropic_claude', providerCode: 'claude_code_version_too_old' }
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

      expect(error._tag).toBe('LLMError')
      expect(error).toMatchObject({
        cause: 'provider_error',
        retryable: true,
        provider: { provider: 'anthropic_claude', kind: 'stream' }
      })
    })
  )
})
