/**
 * Provider error classification through the real providers against the emulators (issue #121):
 * retryability comes from structured fields (HTTP status, `error.type`/`code`), request values a
 * provider echoes back (the model id, the Gateway's `param.modelId`) never decide the kind, and
 * the native Messages layer surfaces the envelope `error.type` as `providerCode`. Genuinely
 * retryable failures (429, 5xx, `overloaded_error`) stay retryable. Tests may import SDK
 * packages; the emulator source never does.
 */
import { Effect, Layer, Redacted, Stream } from 'effect'
import type { HttpClient } from 'effect/http'
import type * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import { LLMError, LLMProvider } from '@yolk-sdk/agent/loop'
import { OAuthAccessToken } from '@yolk-sdk/agent/oauth'
import { UserMessage } from '@yolk-sdk/agent/protocol'
import { makeAnthropicClaudeProviderLayer } from '@yolk-sdk/agent/providers/anthropic/claude-provider'
import { anthropicConformanceMessagesUrl } from '@yolk-sdk/agent/providers/anthropic/conformance'
import { makeOpenAiCodexProviderLayer } from '@yolk-sdk/agent/providers/openai/codex-provider'
import { openAiCodexConformanceResponsesUrl } from '@yolk-sdk/agent/providers/openai/conformance'
import { makeOpenAiProviderLayer } from '@yolk-sdk/agent/providers/openai/provider'
import { openCodeGoConformanceDefaultModels } from '@yolk-sdk/agent/providers/opencode/conformance'
import {
  makeOpenCodeGoProviderLayer,
  type OpenCodeGoProtocol
} from '@yolk-sdk/agent/providers/opencode/go-provider'
import {
  makeVercelAiGatewayProviderLayer,
  vercelAiGatewayChatCompletionsUrl
} from '@yolk-sdk/agent/providers/vercel/ai-gateway-provider'
import { xAiGrokConformanceResponsesUrl } from '@yolk-sdk/agent/providers/xai/conformance'
import { makeXAiGrokProviderLayer } from '@yolk-sdk/agent/providers/xai/grok-provider'
import { makeAnthropicEmulator } from '../src/anthropic.ts'
import { makeCodexEmulator } from '../src/codex.ts'
import { makeGatewayEmulator } from '../src/gateway.ts'
import { makeOpenAiEmulator } from '../src/openai.ts'
import { makeOpenCodeGoEmulator } from '../src/opencode.ts'
import { EmulatorRoute, InProcessHttpClient } from '../src/router.ts'
import { makeXAiGrokEmulator } from '../src/xai.ts'

/** A model id that names retryable failures: echoed back, it must never decide the kind. */
const overloadedModel = 'acme/overloaded-rate_limit-preview'

/** A model id that names a context overflow: echoed on a 5xx, it must not make it final. */
const contextLengthModel = 'acme/context_length-preview'

const expiresAt = 4_000_000_000_000

const apiKey = Redacted.make('synthetic-key')

type StatusFault = {
  readonly kind: 'status'
  readonly status: number
  readonly body?: Schema.Json
}

/** One real provider pointed at one emulator that answers with the given status fault. */
type Target = {
  readonly name: string
  readonly providerId: string
  readonly failWith: (fault: StatusFault, model: string) => Effect.Effect<LLMError>
}

const expectLlmError = (error: unknown): LLMError =>
  error instanceof LLMError ? error : expect.fail(`expected an LLMError, got ${String(error)}`)

const streamFailure = <E>(
  provider: Layer.Layer<LLMProvider, E, HttpClient.HttpClient>,
  origin: string,
  fetch: (request: Request) => Promise<Response>,
  model: string
): Effect.Effect<LLMError> =>
  Effect.gen(function* () {
    const llm = yield* LLMProvider

    return yield* llm
      .stream({
        model,
        systemPrompt: 'Reply in one short sentence.',
        messages: [UserMessage.make({ content: 'Say hello.' })],
        tools: []
      })
      .pipe(Stream.runCollect)
  }).pipe(
    Effect.provide(
      provider.pipe(
        Layer.provide(InProcessHttpClient.layer([EmulatorRoute.handler(origin, fetch)]))
      )
    ),
    Effect.flip,
    Effect.map(expectLlmError),
    Effect.orDie
  )

const openAiModelNotFound = (status: number, model: string): StatusFault => ({
  kind: 'status',
  status,
  body: {
    error: {
      message: `The model '${model}' does not exist`,
      type: 'invalid_request_error',
      code: 'model_not_found',
      param: 'model'
    }
  }
})

/** The real Anthropic 404 for an unknown model names it in the message (`model: <id>`). */
const anthropicModelNotFound = (model: string): StatusFault => ({
  kind: 'status',
  status: 404,
  body: { type: 'error', error: { type: 'not_found_error', message: `model: ${model}` } }
})

const gatewayTarget: Target = {
  name: 'Vercel AI Gateway',
  providerId: 'vercel_ai_gateway',
  failWith: (fault, model) => {
    const emulator = makeGatewayEmulator()

    emulator.faults.add(fault)

    return streamFailure(
      makeVercelAiGatewayProviderLayer({ apiKey, maxCompletionTokens: 64, streaming: true }),
      new URL(vercelAiGatewayChatCompletionsUrl).origin,
      emulator.fetch,
      model
    )
  }
}

const openAiTarget: Target = {
  name: 'OpenAI chat',
  providerId: 'openai',
  failWith: (fault, model) => {
    const emulator = makeOpenAiEmulator()

    emulator.faults.add(fault)

    return streamFailure(
      makeOpenAiProviderLayer({ apiKey, maxCompletionTokens: 64, streaming: true }),
      'https://api.openai.com',
      emulator.fetch,
      model
    )
  }
}

const codexTarget: Target = {
  name: 'Codex Responses',
  providerId: 'openai_codex',
  failWith: (fault, model) => {
    const emulator = makeCodexEmulator()

    emulator.faults.add(fault)

    return streamFailure(
      makeOpenAiCodexProviderLayer({
        token: new OAuthAccessToken({
          provider: 'openai-codex',
          accessToken: 'synthetic-codex-oauth-token',
          expiresAt
        })
      }),
      new URL(openAiCodexConformanceResponsesUrl).origin,
      emulator.fetch,
      model
    )
  }
}

const grokTarget: Target = {
  name: 'Grok Responses',
  providerId: 'xai_grok',
  failWith: (fault, model) => {
    const emulator = makeXAiGrokEmulator()

    emulator.faults.add(fault)

    return streamFailure(
      makeXAiGrokProviderLayer({
        token: new OAuthAccessToken({
          provider: 'xai-grok',
          accessToken: 'synthetic-grok-oauth-token',
          expiresAt
        }),
        clientVersion: '0.0.0-synthetic',
        maxOutputTokens: 64
      }),
      new URL(xAiGrokConformanceResponsesUrl).origin,
      emulator.fetch,
      model
    )
  }
}

const claudeTarget: Target = {
  name: 'Claude subscription',
  providerId: 'anthropic_claude',
  failWith: (fault, model) => {
    const emulator = makeAnthropicEmulator()

    emulator.faults.add(fault)

    return streamFailure(
      makeAnthropicClaudeProviderLayer({
        token: new OAuthAccessToken({
          provider: 'anthropic-claude',
          accessToken: 'synthetic-claude-oauth-token',
          expiresAt
        }),
        maxTokens: 64
      }),
      new URL(anthropicConformanceMessagesUrl).origin,
      emulator.fetch,
      model
    )
  }
}

const anthropicOrigin = new URL(anthropicConformanceMessagesUrl).origin

/** Native Messages through OpenCode Go's `messages` protocol, pointed at the Anthropic origin. */
const nativeMessagesProvider = makeOpenCodeGoProviderLayer({
  apiKey,
  protocol: 'messages',
  maxOutputTokens: 64,
  baseUrl: `${anthropicOrigin}/v1`
})

const nativeMessagesTarget: Target = {
  name: 'native Messages (OpenCode Go)',
  providerId: 'opencode_go',
  failWith: (fault, model) => {
    const emulator = makeAnthropicEmulator()

    emulator.faults.add(fault)

    return streamFailure(nativeMessagesProvider, anthropicOrigin, emulator.fetch, model)
  }
}

const openCodeGoModels: Readonly<Record<OpenCodeGoProtocol, string>> = {
  'chat-completions': openCodeGoConformanceDefaultModels.chat,
  messages: openCodeGoConformanceDefaultModels.messages,
  responses: openCodeGoConformanceDefaultModels.responses
}

/**
 * The fixture-only Go emulator answers only recorded request shapes, so these targets always send
 * the recorded model; the fault body still echoes the given one.
 */
const openCodeGoTarget = (protocol: OpenCodeGoProtocol): Target => ({
  name: `OpenCode Go ${protocol}`,
  providerId: 'opencode_go',
  failWith: fault => {
    const emulator = makeOpenCodeGoEmulator()

    const part = {
      'chat-completions': emulator.chat,
      messages: emulator.messages,
      responses: emulator.responses
    }[protocol]

    part.faults.add(fault)

    return streamFailure(
      makeOpenCodeGoProviderLayer({ apiKey, protocol, maxOutputTokens: 64 }),
      'https://opencode.ai',
      emulator.fetch,
      openCodeGoModels[protocol]
    )
  }
})

/** Targets whose error envelope is OpenAI-compatible (`error.code`/`type`, `param`). */
const openAiEnvelopeTargets: ReadonlyArray<Target> = [
  openAiTarget,
  codexTarget,
  grokTarget,
  openCodeGoTarget('chat-completions'),
  openCodeGoTarget('responses')
]

/** Targets whose error envelope is Anthropic's (`{ type: 'error', error: { type, message } }`). */
const anthropicEnvelopeTargets: ReadonlyArray<Target> = [
  claudeTarget,
  nativeMessagesTarget,
  openCodeGoTarget('messages')
]

const allTargets: ReadonlyArray<Target> = [
  gatewayTarget,
  ...openAiEnvelopeTargets,
  ...anthropicEnvelopeTargets
]

describe('a model error that echoes a model id naming a retryable failure', () => {
  it.effect('the Gateway 404 model_not_found (message and param.modelId) stays non-retryable', () =>
    Effect.gen(function* () {
      // The emulator's recorded unknown-model answer: `Model '<id>' not found`, `param.modelId`.
      const emulator = makeGatewayEmulator()

      const error = yield* streamFailure(
        makeVercelAiGatewayProviderLayer({ apiKey, maxCompletionTokens: 64, streaming: true }),
        new URL(vercelAiGatewayChatCompletionsUrl).origin,
        emulator.fetch,
        overloadedModel
      )

      expect(emulator.ledger.entries()[0]?.status).toBe(404)
      expect(error).toMatchObject({
        cause: 'provider_error',
        retryable: false,
        provider: {
          provider: 'vercel_ai_gateway',
          kind: 'unknown',
          status: 404,
          providerCode: 'model_not_found'
        }
      })
    })
  )

  for (const target of openAiEnvelopeTargets) {
    it.effect(`${target.name}: a 404 model_not_found stays non-retryable`, () =>
      Effect.gen(function* () {
        const error = yield* target.failWith(
          openAiModelNotFound(404, overloadedModel),
          overloadedModel
        )

        expect(error).toMatchObject({
          cause: 'provider_error',
          retryable: false,
          provider: {
            provider: target.providerId,
            kind: 'unknown',
            status: 404,
            providerCode: 'model_not_found'
          }
        })
      })
    )
  }

  for (const target of anthropicEnvelopeTargets) {
    it.effect(`${target.name}: a 404 not_found_error stays non-retryable`, () =>
      Effect.gen(function* () {
        const error = yield* target.failWith(
          anthropicModelNotFound(overloadedModel),
          overloadedModel
        )

        expect(error).toMatchObject({
          cause: 'provider_error',
          retryable: false,
          provider: {
            provider: target.providerId,
            kind: 'unknown',
            status: 404,
            providerCode: 'not_found_error'
          }
        })
      })
    )
  }
})

describe('a 5xx that echoes a model id naming a context overflow', () => {
  it.effect('the Gateway 503 with param.modelId stays a retryable server error', () =>
    Effect.gen(function* () {
      const error = yield* gatewayTarget.failWith(
        {
          kind: 'status',
          status: 503,
          body: {
            error: {
              message: `Model '${contextLengthModel}' is temporarily unavailable`,
              type: 'upstream_error',
              param: { modelId: contextLengthModel }
            }
          }
        },
        contextLengthModel
      )

      expect(error).toMatchObject({
        cause: 'provider_error',
        retryable: true,
        provider: { kind: 'server_error', status: 503, providerCode: 'upstream_error' }
      })
    })
  )

  it.effect('the Claude 500 naming the requested model stays a retryable server error', () =>
    Effect.gen(function* () {
      const error = yield* claudeTarget.failWith(
        {
          kind: 'status',
          status: 500,
          body: {
            type: 'error',
            error: { type: 'api_error', message: `model: ${contextLengthModel}` }
          }
        },
        contextLengthModel
      )

      expect(error).toMatchObject({
        retryable: true,
        provider: { kind: 'server_error', status: 500, providerCode: 'api_error' }
      })
    })
  )
})

describe('echoed values are removed from the decoded JSON body', () => {
  // The echo with its slash escaped (`\/`, `\u002f`): removal from the raw text misses it.
  for (const message of [
    'Model acme\\/context_length-preview is temporarily unavailable',
    'Model acme\\u002fcontext_length-preview is temporarily unavailable'
  ]) {
    it.effect(`the Gateway 503 "${message}" stays a retryable server error`, () =>
      Effect.gen(function* () {
        const error = yield* gatewayTarget.failWith(
          {
            kind: 'status',
            status: 503,
            body: `{"error":{"message":"${message}","type":"upstream_error"}}`
          },
          contextLengthModel
        )

        expect(error).toMatchObject({
          retryable: true,
          provider: { kind: 'server_error', status: 503, providerCode: 'upstream_error' }
        })
      })
    )
  }
})

describe('a string param names a parameter, not an echoed value', () => {
  for (const target of openAiEnvelopeTargets) {
    it.effect(
      `${target.name}: a 400 "input is too long" with param input is a context overflow`,
      () =>
        Effect.gen(function* () {
          const error = yield* target.failWith(
            {
              kind: 'status',
              status: 400,
              body: {
                error: {
                  message: 'input is too long',
                  type: 'invalid_request_error',
                  param: 'input'
                }
              }
            },
            'gpt-4.1-nano'
          )

          expect(error).toMatchObject({
            cause: 'context_overflow',
            retryable: false,
            provider: { kind: 'context_overflow', status: 400 }
          })
        })
    )
  }
})

describe('Anthropic errors classify from error.type behind a details.error_code', () => {
  // A guard: the status and text also name this overload. The stream case without a status,
  // where only the type names it, is in `claude-provider.test.ts`.
  for (const target of anthropicEnvelopeTargets) {
    it.effect(`${target.name}: a 500 overloaded_error with an error_code is an overload`, () =>
      Effect.gen(function* () {
        const error = yield* target.failWith(
          {
            kind: 'status',
            status: 500,
            body: {
              type: 'error',
              error: {
                type: 'overloaded_error',
                message: 'Try again soon.',
                details: { error_code: 'capacity_exhausted' }
              }
            }
          },
          'claude-haiku-4-5'
        )

        expect(error).toMatchObject({
          cause: 'overloaded',
          retryable: true,
          provider: { kind: 'overloaded', status: 500, providerCode: 'capacity_exhausted' }
        })
      })
    )
  }
})

describe('an error type that names a kind behind a code that names none', () => {
  for (const target of openAiEnvelopeTargets) {
    it.effect(`${target.name}: a 400 typed rate_limit_exceeded is a retryable rate limit`, () =>
      Effect.gen(function* () {
        const error = yield* target.failWith(
          {
            kind: 'status',
            status: 400,
            body: { error: { message: 'Slow down.', type: 'rate_limit_exceeded', code: '1302' } }
          },
          'gpt-4.1-nano'
        )

        expect(error).toMatchObject({
          cause: 'rate_limit',
          retryable: true,
          provider: { kind: 'rate_limit', status: 400, providerCode: '1302' }
        })
      })
    )
  }
})

// Every target reads such a body twice: its vendor envelope decoder (the full body through
// `Schema.fromJsonString(Schema.Json)`, which is stack-safe at any depth) and the shared
// classifier's bounded scan. Neither may turn the failure into a defect.
describe('pathological error bodies classify by status', () => {
  const bodies: ReadonlyArray<readonly [string, string]> = [
    ['arrays nested 10,000 levels deep', `${'['.repeat(10_000)}${']'.repeat(10_000)}`],
    ['objects nested 10,000 levels deep', `${'{"error":'.repeat(10_000)}null${'}'.repeat(10_000)}`],
    ['of 1 MB of text', `${'x'.repeat(1024 * 1024)} prompt is too long`],
    ['of 1 MB nested 524,288 levels deep', `${'['.repeat(512 * 1024)}${']'.repeat(512 * 1024)}`],
    [
      'of a 1 MB JSON envelope',
      JSON.stringify({
        type: 'error',
        error: { type: 'api_error', message: `${'x'.repeat(1024 * 1024)} prompt is too long` }
      })
    ]
  ]

  for (const target of allTargets) {
    for (const [name, body] of bodies) {
      it.effect(`${target.name}: a 503 with a body ${name} stays a retryable server error`, () =>
        Effect.gen(function* () {
          const error = yield* target.failWith({ kind: 'status', status: 503, body }, 'x-model')

          expect(error).toMatchObject({
            retryable: true,
            provider: { kind: 'server_error', status: 503 }
          })
        })
      )
    }
  }
})

describe('the native Messages layer surfaces the envelope error.type', () => {
  it.effect('an unknown model is a non-retryable 404 with providerCode not_found_error', () =>
    Effect.gen(function* () {
      // The emulator's own unknown-model answer, not a fault.
      const emulator = makeAnthropicEmulator()

      const error = yield* streamFailure(
        nativeMessagesProvider,
        anthropicOrigin,
        emulator.fetch,
        'yolk-model-does-not-exist'
      )

      expect(emulator.ledger.entries()[0]?.status).toBe(404)
      expect(error).toMatchObject({
        cause: 'provider_error',
        retryable: false,
        message: 'OpenCode Go provider_error',
        provider: {
          provider: 'opencode_go',
          kind: 'unknown',
          status: 404,
          providerCode: 'not_found_error'
        }
      })
    })
  )
})

describe('genuinely retryable failures stay retryable', () => {
  for (const target of allTargets) {
    it.effect(`${target.name}: 429, 408, 500, and 503 are retryable`, () =>
      Effect.gen(function* () {
        const rateLimited = yield* target.failWith({ kind: 'status', status: 429 }, overloadedModel)

        expect(rateLimited, '429').toMatchObject({
          cause: 'rate_limit',
          retryable: true,
          provider: { kind: 'rate_limit', status: 429 }
        })

        const timedOut = yield* target.failWith({ kind: 'status', status: 408 }, overloadedModel)

        expect(timedOut, '408').toMatchObject({
          retryable: true,
          provider: { kind: 'network', status: 408 }
        })

        for (const status of [500, 503]) {
          const failed = yield* target.failWith({ kind: 'status', status }, overloadedModel)

          expect(failed.retryable, String(status)).toBe(true)
          expect(failed.provider?.status, String(status)).toBe(status)
        }
      })
    )
  }

  for (const target of anthropicEnvelopeTargets) {
    it.effect(`${target.name}: a 529 overloaded_error is a retryable overload`, () =>
      Effect.gen(function* () {
        const error = yield* target.failWith(
          {
            kind: 'status',
            status: 529,
            body: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }
          },
          'claude-haiku-4-5'
        )

        expect(error).toMatchObject({
          cause: 'overloaded',
          retryable: true,
          provider: { kind: 'overloaded', status: 529, providerCode: 'overloaded_error' }
        })
      })
    )
  }

  it.effect('a 503 without a code whose text says service unavailable is still an overload', () =>
    Effect.gen(function* () {
      const error = yield* openAiTarget.failWith(
        { kind: 'status', status: 503, body: 'Service Unavailable' },
        'gpt-4.1-nano'
      )

      expect(error).toMatchObject({
        cause: 'overloaded',
        retryable: true,
        provider: { kind: 'overloaded', status: 503 }
      })
    })
  )
})
