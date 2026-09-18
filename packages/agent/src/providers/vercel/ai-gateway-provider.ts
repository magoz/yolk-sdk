import { Config, Effect, Layer, type Redacted } from 'effect'
import type * as Schema from 'effect/Schema'
import { FetchHttpClient } from 'effect/unstable/http'
import { LLMError } from '@yolk-sdk/agent/loop'
import { makeOpenAiProviderLayer, type OpenAiRequestExtras } from '../openai/provider.ts'

export const vercelAiGatewayProviderId = 'vercel_ai_gateway'

export const vercelAiGatewayChatCompletionsUrl = 'https://ai-gateway.vercel.sh/v1/chat/completions'

export type VercelAiGatewayProviderSort = 'cost' | 'ttft' | 'tps'

export type VercelAiGatewayRoutingOptions = {
  readonly order?: ReadonlyArray<string>
  readonly only?: ReadonlyArray<string>
  readonly sort?: VercelAiGatewayProviderSort
}

export type VercelAiGatewayProviderConfig = {
  /** Accepts either an AI Gateway API key or a Vercel OIDC token. */
  readonly apiKey: Redacted.Redacted<string>
  readonly maxCompletionTokens: number
  readonly fallbackModels?: ReadonlyArray<string>
  readonly routing?: VercelAiGatewayRoutingOptions
  readonly extraHeaders?: Readonly<Record<string, string>>
  /** Override only with a trusted proxy because the bearer credential is sent to this URL. */
  readonly chatCompletionsUrl?: string
  /**
   * Forwarded to the OpenAI-compatible transport: true streams SSE deltas,
   * otherwise the provider resolves a single JSON completion. Defaults to
   * false to preserve existing non-streaming consumers.
   */
  readonly streaming?: boolean
  /**
   * Preserve compatible models' reasoning_content output and assistant
   * replay. When true, streamed reasoning deltas surface as reasoning
   * events (and replay into later requests, which spends input tokens).
   * Defaults to false; reasoning output is otherwise dropped.
   */
  readonly reasoningContent?: boolean
  /**
   * Override the reasoning-effort wire format. Defaults to the Anthropic
   * `reasoning` object; DeepSeek-style hosts expect the literal
   * `reasoning_effort` field instead.
   */
  readonly reasoningEffortFormat?: 'reasoning-object' | 'reasoning-effort'
  /**
   * DeepSeek-style thinking toggle, merged into the request body (e.g.
   * `{ type: 'enabled' }`). Omitted unless a host documents it.
   */
  readonly thinking?: { readonly type: 'enabled' | 'disabled' }
}

const vercelAiGatewayProviderIdentity = {
  id: vercelAiGatewayProviderId,
  name: 'Vercel AI Gateway'
}

const gatewayExtraBody = (config: VercelAiGatewayProviderConfig): OpenAiRequestExtras => {
  const extras: { [key: string]: Schema.Json } = {}

  if (config.thinking !== undefined) {
    extras.thinking = { type: config.thinking.type }
  }

  if (config.fallbackModels !== undefined) {
    extras.models = [...config.fallbackModels]
  }

  if (config.routing !== undefined) {
    const gateway: { [key: string]: Schema.Json } = {}

    if (config.routing.order !== undefined) {
      gateway.order = [...config.routing.order]
    }

    if (config.routing.only !== undefined) {
      gateway.only = [...config.routing.only]
    }

    if (config.routing.sort !== undefined) {
      gateway.sort = config.routing.sort
    }

    extras.providerOptions = { gateway }
  }

  return extras
}

type VercelAiGatewayOpenAiLayerFields = {
  apiKey: VercelAiGatewayProviderConfig['apiKey']
  maxCompletionTokens: number
  completionTokenField: 'max_tokens'
  reasoningEffortFormat: 'reasoning-object' | 'reasoning-effort'
  chatCompletionsUrl: string
  providerIdentity: typeof vercelAiGatewayProviderIdentity
  extraBody: OpenAiRequestExtras
  extraHeaders?: VercelAiGatewayProviderConfig['extraHeaders']
  streaming?: VercelAiGatewayProviderConfig['streaming']
  reasoningContent?: VercelAiGatewayProviderConfig['reasoningContent']
}

export const makeVercelAiGatewayProviderLayer = (config: VercelAiGatewayProviderConfig) =>
  makeOpenAiProviderLayer(
    (() => {
      const fields: VercelAiGatewayOpenAiLayerFields = {
        apiKey: config.apiKey,
        maxCompletionTokens: config.maxCompletionTokens,
        completionTokenField: 'max_tokens',
        reasoningEffortFormat: config.reasoningEffortFormat ?? 'reasoning-object',
        chatCompletionsUrl: config.chatCompletionsUrl ?? vercelAiGatewayChatCompletionsUrl,
        providerIdentity: vercelAiGatewayProviderIdentity,
        extraBody: gatewayExtraBody(config)
      }

      if (config.extraHeaders !== undefined) {
        fields.extraHeaders = config.extraHeaders
      }

      if (config.streaming !== undefined) {
        fields.streaming = config.streaming
      }

      if (config.reasoningContent !== undefined) {
        fields.reasoningContent = config.reasoningContent
      }

      return fields
    })()
  )

const vercelAiGatewayEnvironmentConfig = Effect.gen(function* () {
  const apiKey = yield* Config.Redacted('AI_GATEWAY_API_KEY').pipe(
    Config.orElse(() => Config.Redacted('VERCEL_OIDC_TOKEN'))
  )

  const maxCompletionTokens = yield* Config.Int('AI_GATEWAY_MAX_COMPLETION_TOKENS')

  return { apiKey, maxCompletionTokens }
}).pipe(
  Effect.mapError(
    () =>
      new LLMError({
        cause: 'provider_error',
        message: 'Vercel AI Gateway environment configuration missing',
        retryable: false
      })
  )
)

export const VercelAiGatewayProviderLayer = Layer.unwrap(
  vercelAiGatewayEnvironmentConfig.pipe(Effect.map(makeVercelAiGatewayProviderLayer))
).pipe(Layer.provide(FetchHttpClient.layer))
