import { Effect, Layer, Predicate, Redacted, Stream } from 'effect'
import { HttpClient, HttpClientResponse, type HttpClientRequest } from 'effect/unstable/http'
import { describe, expect, it } from '@effect/vitest'
import { ToolDef, UserMessage } from '@yolk-sdk/agent/protocol'
import { LLMProvider } from '@yolk-sdk/agent/loop'
import { OAuthAccessToken } from '@yolk-sdk/agent/oauth'
import { VoiceSpeechRequest, VoiceSpeechSynthesizer } from '@yolk-sdk/agent/voice'
import { makeAnthropicClaudeProviderLayer } from '../../src/providers/anthropic/claude-provider.ts'
import { backgroundToolDef } from '../../src/tools/background.ts'
import { toAnthropicClaudeRequestBody } from '../../src/providers/anthropic/claude-provider.ts'
import { toOpenAiRequestBody } from '../../src/providers/openai/provider.ts'
import { toOpenAiCodexRequestBody } from '../../src/providers/openai/codex-provider.ts'
import { toXAiGrokRequestBody } from '../../src/providers/xai/grok-provider.ts'
import { makeVercelAiGatewayProviderLayer } from '../../src/providers/vercel/ai-gateway-provider.ts'
import { makeOpenAiSpeechSynthesizerLayer } from '../../src/providers/openai/speech.ts'
import { openAiRealtimeToolParameters } from '../../src/providers/openai/realtime/index.ts'

const goldens = {
  'anthropic-output-config-omitted':
    '{"model":"claude-opus-5","system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.112.e61; cc_entrypoint=sdk-cli; cch=185f8;"},{"type":"text","text":"You are Claude Code, Anthropic\'s official CLI for Claude."}],"messages":[{"role":"user","content":"Be concise.\\n\\nHello"}],"max_tokens":123}',
  'anthropic-output-config-present':
    '{"model":"claude-opus-5","system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.112.e61; cc_entrypoint=sdk-cli; cch=185f8;"},{"type":"text","text":"You are Claude Code, Anthropic\'s official CLI for Claude."}],"messages":[{"role":"user","content":"Be concise.\\n\\nHello"}],"max_tokens":123,"output_config":{"effort":"medium"}}',
  'anthropic-schema-union':
    '{"type":"object","properties":{"operation":{"type":"string","enum":["search","list"],"description":"op"},"query":{"type":"string"},"limit":{"type":"number"}},"required":["operation"],"$defs":{"SearchMeta":{"type":"string"},"ListMeta":{"type":"number"}},"additionalProperties":false}',
  'anthropic-schema-allof-empty': '{"type":"object","properties":{},"required":[],"$defs":{}}',
  'anthropic-schema-allof-required':
    '{"type":"object","properties":{"first":{"type":"string"},"second":{"type":"number"}},"required":["first","second"],"$defs":{}}',
  'codex-body':
    '{"model":"test-model","instructions":"Be concise.","input":[{"role":"user","content":"Hello"}],"store":false,"stream":true,"reasoning":{"effort":"low","summary":"auto"}}',
  'grok-omit-reasoning':
    '{"model":"test-model","instructions":"Be concise.","input":[{"role":"user","content":"Hello"}],"store":false,"stream":true,"max_output_tokens":30000}',
  'grok-reasoning':
    '{"model":"test-model","instructions":"Be concise.","input":[{"role":"user","content":"Hello"}],"store":false,"stream":true,"max_output_tokens":30000,"reasoning":{"effort":"high","summary":"auto"}}',
  'openai-omitted':
    '{"model":"test-model","messages":[{"role":"system","content":"Be concise."},{"role":"user","content":"Hello"}],"max_completion_tokens":123,"stream":false}',
  'openai-extra':
    '{"models":["fallback"],"model":"test-model","messages":[{"role":"system","content":"Be concise."},{"role":"user","content":"Hello"}],"max_tokens":123,"stream":false}',
  'openai-reasoned':
    '{"models":["fallback"],"reasoning":{"effort":"high"},"model":"test-model","messages":[{"role":"system","content":"Be concise."},{"role":"user","content":"Hello"}],"max_tokens":123,"stream":false}',
  'gateway-omitted-http':
    '{"model":"test-model","messages":[{"role":"system","content":"Be concise."},{"role":"user","content":"Hello"}],"max_tokens":2000,"stream":false}',
  'gateway-present-http':
    '{"models":["openai/gpt-fallback"],"providerOptions":{"gateway":{"order":["vertex"],"sort":"ttft"}},"model":"test-model","messages":[{"role":"system","content":"Be concise."},{"role":"user","content":"Hello"}],"max_tokens":2000,"stream":false}',
  'realtime-required-omitted':
    '{"type":"object","properties":{"a":{"type":"string"},"b":{"type":"string"}},"additionalProperties":false}',
  'realtime-required-present':
    '{"type":"object","properties":{"operation":{"type":"string"},"slug":{"type":"string"}},"required":["operation","slug"],"additionalProperties":false}',
  'speech-instructions-omitted':
    '{"model":"gpt-4o-mini-tts","input":"No steering","voice":"alloy","response_format":"mp3"}',
  'speech-instructions-present':
    '{"model":"gpt-4o-mini-tts","input":"Whisper","voice":"alloy","response_format":"mp3","instructions":"Whisper softly."}',
  'background-defs-omitted':
    '{"type":"object","properties":{"execution":{"type":"string","enum":["foreground","background"]},"arguments":{"type":"object","properties":{"n":{"type":"number"}}}},"required":["execution","arguments"],"additionalProperties":false}',
  'background-defs-present':
    '{"type":"object","properties":{"execution":{"type":"string","enum":["foreground","background"]},"arguments":{"type":"object","properties":{"n":{"type":"number"}}}},"required":["execution","arguments"],"additionalProperties":false,"$defs":{"N":{"type":"number"}}}',
  'nested-allof-schema':
    '{"type":"object","properties":{"empty":{"type":"object"},"properties_only":{"type":"object","properties":{"x":{"type":"string"}}},"required_only":{"type":"object","required":["x"]},"defs_only":{"type":"object","$defs":{"X":{"type":"string"}}},"present":{"type":"object","properties":{"first":{"type":"string"},"second":{"type":"number"}},"required":["first","second"],"$defs":{"A":{"type":"string"},"B":{"type":"number"}}}}}',
  'http-error-omitted':
    '{"message":"Anthropic Claude returned 400","providerJson":"{\\"provider\\":\\"anthropic_claude\\",\\"kind\\":\\"unknown\\",\\"status\\":400}","providerKeys":"provider,kind,status","hasProviderCode":false}',
  'http-error-message-only':
    '{"message":"Anthropic Claude returned 400: bad request","providerJson":"{\\"provider\\":\\"anthropic_claude\\",\\"kind\\":\\"unknown\\",\\"status\\":400}","providerKeys":"provider,kind,status","hasProviderCode":false}',
  'http-error-code-only':
    '{"message":"Anthropic Claude returned 400","providerJson":"{\\"provider\\":\\"anthropic_claude\\",\\"kind\\":\\"unknown\\",\\"status\\":400,\\"providerCode\\":\\"invalid_request_error\\"}","providerKeys":"provider,kind,status,providerCode","hasProviderCode":true}',
  'http-error-both':
    '{"message":"Anthropic Claude returned 400: bad request","providerJson":"{\\"provider\\":\\"anthropic_claude\\",\\"kind\\":\\"unknown\\",\\"status\\":400,\\"providerCode\\":\\"invalid_request_error\\"}","providerKeys":"provider,kind,status,providerCode","hasProviderCode":true}'
} as const

const lock = (name: keyof typeof goldens, value: string) => {
  expect(value).toBe(goldens[name])
}

const rawBody = (request: HttpClientRequest.HttpClientRequest | undefined) => {
  const body = request?.body

  expect(body?._tag).toBe('Uint8Array')

  if (body?._tag !== 'Uint8Array') {
    expect.fail('Expected uint8 request body')
  }

  return new TextDecoder().decode(body.body)
}

const httpLayer = (
  response: Response,
  requests: Array<{ request: HttpClientRequest.HttpClientRequest }>
) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(request =>
      Effect.sync(() => {
        requests.push({ request })

        return HttpClientResponse.fromWeb(request, response)
      })
    )
  )

const emptyRequest = {
  model: 'test-model',
  systemPrompt: 'Be concise.',
  messages: [UserMessage.make({ content: 'Hello' })],
  tools: []
}

describe('provider-wire19 raw JSON goldens', () => {
  it.effect('locks Anthropic output_config omission and presence key order', () =>
    Effect.gen(function* () {
      const omitted = yield* toAnthropicClaudeRequestBody(
        { ...emptyRequest, model: 'claude-opus-5' },
        { maxTokens: 123 }
      )

      const present = yield* toAnthropicClaudeRequestBody(
        { ...emptyRequest, model: 'claude-opus-5', reasoningEffort: 'medium' },
        { maxTokens: 123 }
      )

      lock('anthropic-output-config-omitted', JSON.stringify(omitted))
      lock('anthropic-output-config-present', JSON.stringify(present))
      expect(JSON.stringify(omitted).includes('"output_config"')).toBe(false)
    })
  )

  it.effect('locks Anthropic schema keyword order, empty omit, and additionalProperties tail', () =>
    Effect.gen(function* () {
      const body = yield* toAnthropicClaudeRequestBody(
        {
          ...emptyRequest,
          model: 'claude-sonnet-4-6',
          tools: [
            ToolDef.make({
              name: 'root_union',
              description: 'Root union.',
              parameters: {
                oneOf: [
                  {
                    type: 'object',
                    properties: {
                      operation: { type: 'string', enum: ['search'], description: 'op' },
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
              name: 'root_intersection_empty_maps',
              description: 'allOf empty maps.',
              parameters: {
                allOf: [{ type: 'object' }, { type: 'object' }]
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
        },
        { maxTokens: 123 }
      )

      lock('anthropic-schema-union', JSON.stringify(body.tools?.[0]?.input_schema))
      lock('anthropic-schema-allof-empty', JSON.stringify(body.tools?.[1]?.input_schema))
      lock('anthropic-schema-allof-required', JSON.stringify(body.tools?.[2]?.input_schema))
    })
  )

  it.effect(
    'locks Codex omitted max_output_tokens and Grok present max_output_tokens/reasoning omit',
    () =>
      Effect.gen(function* () {
        const codex = yield* toOpenAiCodexRequestBody(emptyRequest)

        const grokOmitReasoning = yield* toXAiGrokRequestBody(emptyRequest, {
          maxOutputTokens: 30_000
        })

        const grokReasoning = yield* toXAiGrokRequestBody(
          { ...emptyRequest, reasoningEffort: 'high' },
          { maxOutputTokens: 30_000 }
        )

        lock('codex-body', JSON.stringify(codex))
        lock('grok-omit-reasoning', JSON.stringify(grokOmitReasoning))
        lock('grok-reasoning', JSON.stringify(grokReasoning))
        expect(JSON.stringify(codex).includes('"max_output_tokens"')).toBe(false)
      })
  )

  it.effect('locks OpenAI extraBody/token-field/reasoning object key order', () =>
    Effect.gen(function* () {
      const omitted = yield* toOpenAiRequestBody(emptyRequest, { maxCompletionTokens: 123 })

      const extra = yield* toOpenAiRequestBody(emptyRequest, {
        maxCompletionTokens: 123,
        completionTokenField: 'max_tokens',
        extraBody: { models: ['fallback'] },
        reasoningEffortFormat: 'reasoning-object'
      })

      const reasoned = yield* toOpenAiRequestBody(
        { ...emptyRequest, reasoningEffort: 'high' },
        {
          maxCompletionTokens: 123,
          completionTokenField: 'max_tokens',
          extraBody: { models: ['fallback'] },
          reasoningEffortFormat: 'reasoning-object'
        }
      )

      lock('openai-omitted', JSON.stringify(omitted))
      lock('openai-extra', JSON.stringify(extra))
      lock('openai-reasoned', JSON.stringify(reasoned))
    })
  )

  it.effect('locks Gateway raw HTTP extraBody omission and models/providerOptions order', () =>
    Effect.gen(function* () {
      const jsonOk = () =>
        new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
          status: 200
        })

      const omitted: Array<{ request: HttpClientRequest.HttpClientRequest }> = []
      const present: Array<{ request: HttpClientRequest.HttpClientRequest }> = []

      const run = (
        requests: Array<{ request: HttpClientRequest.HttpClientRequest }>,
        config: Parameters<typeof makeVercelAiGatewayProviderLayer>[0]
      ) =>
        Effect.gen(function* () {
          const provider = yield* LLMProvider

          yield* provider.stream(emptyRequest).pipe(Stream.runCollect)
        }).pipe(
          Effect.provide(
            makeVercelAiGatewayProviderLayer(config).pipe(
              Layer.provide(httpLayer(jsonOk(), requests))
            )
          )
        )

      yield* run(omitted, {
        apiKey: Redacted.make('gateway-key'),
        maxCompletionTokens: 2000
      })
      yield* run(present, {
        apiKey: Redacted.make('gateway-key'),
        maxCompletionTokens: 2000,
        fallbackModels: ['openai/gpt-fallback'],
        routing: { order: ['vertex'], sort: 'ttft' }
      })

      lock('gateway-omitted-http', rawBody(omitted[0]?.request))
      lock('gateway-present-http', rawBody(present[0]?.request))
    })
  )

  it('locks Realtime required omission versus required-tail before additionalProperties', () => {
    const omitted = openAiRealtimeToolParameters({
      anyOf: [
        { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
        { type: 'object', properties: { b: { type: 'string' } }, required: ['b'] }
      ]
    })

    const present = openAiRealtimeToolParameters({
      anyOf: [
        {
          type: 'object',
          properties: { operation: { type: 'string' }, slug: { type: 'string' } },
          required: ['operation', 'slug']
        },
        {
          type: 'object',
          properties: { operation: { type: 'string' }, slug: { type: 'string' } },
          required: ['operation', 'slug']
        }
      ]
    })

    lock('realtime-required-omitted', JSON.stringify(omitted))
    lock('realtime-required-present', JSON.stringify(present))
  })

  it.effect('locks speech raw HTTP instructions omission versus presence', () =>
    Effect.gen(function* () {
      const requests: Array<{ request: HttpClientRequest.HttpClientRequest }> = []

      const layer = makeOpenAiSpeechSynthesizerLayer({ apiKey: Redacted.make('test-key') }).pipe(
        Layer.provide(
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make(request =>
              Effect.sync(() => {
                requests.push({ request })

                return HttpClientResponse.fromWeb(
                  request,
                  new Response(new Uint8Array([1]).slice().buffer, { status: 200 })
                )
              })
            )
          )
        )
      )

      yield* Effect.gen(function* () {
        const synthesizer = yield* VoiceSpeechSynthesizer

        yield* synthesizer.synthesize(VoiceSpeechRequest.make({ text: 'No steering' }))
        yield* synthesizer.synthesize(
          VoiceSpeechRequest.make({ text: 'Whisper', instructions: 'Whisper softly.' })
        )
      }).pipe(Effect.provide(layer))

      lock('speech-instructions-omitted', rawBody(requests[0]?.request))
      lock('speech-instructions-present', rawBody(requests[1]?.request))
    })
  )

  it('locks background $defs omission versus required-tail then $defs', () => {
    const omitted = backgroundToolDef(
      ToolDef.make({
        name: 'work',
        description: '',
        parameters: { type: 'object', properties: { n: { type: 'number' } } }
      })
    )

    const present = backgroundToolDef(
      ToolDef.make({
        name: 'work',
        description: '',
        parameters: {
          type: 'object',
          properties: { n: { type: 'number' } },
          $defs: { N: { type: 'number' } }
        }
      })
    )

    lock('background-defs-omitted', JSON.stringify(omitted.parameters))
    lock('background-defs-present', JSON.stringify(present.parameters))
  })

  it.effect('locks nested allOf mergeAllOf empty/present properties/required/$defs guards', () =>
    Effect.gen(function* () {
      const body = yield* toAnthropicClaudeRequestBody(
        {
          ...emptyRequest,
          model: 'claude-sonnet-4-6',
          tools: [
            ToolDef.make({
              name: 'nested_allof',
              description: 'Nested allOf mergeAllOf branches.',
              parameters: {
                type: 'object',
                properties: {
                  empty: {
                    allOf: [{ type: 'object' }, { type: 'object' }]
                  },
                  properties_only: {
                    allOf: [{ type: 'object', properties: { x: { type: 'string' } } }]
                  },
                  required_only: {
                    allOf: [{ type: 'object', required: ['x'] }]
                  },
                  defs_only: {
                    allOf: [{ type: 'object', $defs: { X: { type: 'string' } } }]
                  },
                  present: {
                    allOf: [
                      {
                        type: 'object',
                        properties: { first: { type: 'string' } },
                        required: ['first'],
                        $defs: { A: { type: 'string' } }
                      },
                      {
                        type: 'object',
                        properties: { second: { type: 'number' } },
                        required: ['second'],
                        $defs: { B: { type: 'number' } }
                      }
                    ]
                  }
                }
              }
            })
          ]
        },
        { maxTokens: 123 }
      )

      lock('nested-allof-schema', JSON.stringify(body.tools?.[0]?.input_schema))
    })
  )

  it.effect('locks Anthropic HTTP errorInfo message/providerCode omit and present', () =>
    Effect.gen(function* () {
      type AnthropicHttpErrorPayload = {
        error: {
          message?: string
          type?: string
        }
      }

      const fail = (payload: AnthropicHttpErrorPayload) =>
        Effect.gen(function* () {
          const requests: Array<{ request: HttpClientRequest.HttpClientRequest }> = []

          const response = new Response(JSON.stringify(payload), { status: 400 })

          const error = yield* Effect.gen(function* () {
            const provider = yield* LLMProvider

            return yield* provider.stream(emptyRequest).pipe(Stream.runCollect)
          }).pipe(
            Effect.provide(
              makeAnthropicClaudeProviderLayer({
                token: new OAuthAccessToken({
                  provider: 'anthropic-claude',
                  accessToken: 'token',
                  expiresAt: Date.now() + 60_000
                }),
                maxTokens: 123
              }).pipe(Layer.provide(httpLayer(response, requests)))
            ),
            Effect.flip
          )

          if (!Predicate.isTagged(error, 'LLMError')) {
            expect.fail('Expected LLMError')
          }

          const provider = error.provider

          return {
            message: error.message,
            providerJson: JSON.stringify(provider),
            providerKeys: provider === undefined ? '' : Object.keys(provider).join(','),
            hasProviderCode:
              provider !== undefined &&
              Object.prototype.hasOwnProperty.call(provider, 'providerCode')
          }
        })

      const omitted = yield* fail({ error: {} })

      const messageOnly = yield* fail({ error: { message: 'bad request' } })

      const codeOnly = yield* fail({ error: { type: 'invalid_request_error' } })

      const both = yield* fail({
        error: { type: 'invalid_request_error', message: 'bad request' }
      })

      lock('http-error-omitted', JSON.stringify(omitted))
      lock('http-error-message-only', JSON.stringify(messageOnly))
      lock('http-error-code-only', JSON.stringify(codeOnly))
      lock('http-error-both', JSON.stringify(both))
    })
  )
})
