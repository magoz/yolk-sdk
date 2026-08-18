import { Config, Effect, Layer, type Redacted } from 'effect'
import { FetchHttpClient } from 'effect/unstable/http'
import { LLMError } from '@yolk-sdk/agent/loop'
import { makeOpenAiProviderLayer } from '../openai/provider.ts'

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
}

const vercelAiGatewayProviderIdentity = {
  id: vercelAiGatewayProviderId,
  name: 'Vercel AI Gateway'
}

const gatewayExtraBody = (config: VercelAiGatewayProviderConfig) => ({
  ...(config.fallbackModels === undefined ? {} : { models: config.fallbackModels }),
  ...(config.routing === undefined ? {} : { providerOptions: { gateway: config.routing } })
})

export const makeVercelAiGatewayProviderLayer = (config: VercelAiGatewayProviderConfig) =>
  makeOpenAiProviderLayer({
    apiKey: config.apiKey,
    maxCompletionTokens: config.maxCompletionTokens,
    completionTokenField: 'max_tokens',
    chatCompletionsUrl: config.chatCompletionsUrl ?? vercelAiGatewayChatCompletionsUrl,
    providerIdentity: vercelAiGatewayProviderIdentity,
    extraBody: gatewayExtraBody(config),
    ...(config.extraHeaders === undefined ? {} : { extraHeaders: config.extraHeaders })
  })

const vercelAiGatewayEnvironmentConfig = Effect.gen(function* () {
  const apiKey = yield* Config.redacted('AI_GATEWAY_API_KEY').pipe(
    Config.orElse(() => Config.redacted('VERCEL_OIDC_TOKEN'))
  )
  const maxCompletionTokens = yield* Config.int('AI_GATEWAY_MAX_COMPLETION_TOKENS')

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
