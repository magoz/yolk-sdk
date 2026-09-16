import { Effect, Layer, Predicate, Redacted, Stream } from 'effect'
import type { HttpClient } from 'effect/unstable/http'
import { decorateLLMProvider, LLMError, type LLMProvider } from '@yolk-sdk/agent/loop'
import { makeOpenAiProviderLayer } from '../openai/provider.ts'
import { makeOpenAiResponsesProviderLayer } from '../openai-responses-provider-internal.ts'
import { makeAnthropicMessagesProviderLayer } from '../anthropic-messages-provider-internal.ts'

export const openCodeGoProviderId = 'opencode_go'

export const openCodeGoBaseUrl = 'https://opencode.ai/zen/go/v1'

export type OpenCodeGoProtocol = 'chat-completions' | 'messages' | 'responses'

export type OpenCodeGoReasoningSummary = 'auto' | 'concise' | 'detailed'

export type OpenCodeGoProviderConfig = {
  readonly apiKey: Redacted.Redacted<string>
  /** Select the protocol advertised for the host's chosen Go model. No model-name inference. */
  readonly protocol: OpenCodeGoProtocol
  /** Host-owned output limit, including reasoning tokens where the model supports them. */
  readonly maxOutputTokens: number
  readonly extraHeaders?: Readonly<Record<string, string>>
  /** Responses only; defaults to auto when reasoning effort is supplied. */
  readonly reasoningSummary?: OpenCodeGoReasoningSummary
  /** Override only with a trusted proxy: this URL receives the API key. */
  readonly baseUrl?: string
}

type OpenCodeGoResponsesOptions = {
  reasoningSummary?: OpenCodeGoReasoningSummary
}

/** API-key provider; hosts own model selection, capabilities, credentials, and HTTP transport. */
const makeOpenCodeGoProtocolLayer = (
  config: OpenCodeGoProviderConfig
): Layer.Layer<LLMProvider, LLMError, HttpClient.HttpClient> =>
  Layer.unwrap(
    Effect.gen(function* () {
      if (!Number.isSafeInteger(config.maxOutputTokens) || config.maxOutputTokens <= 0) {
        return yield* Effect.fail(
          new LLMError({
            cause: 'validation_error',
            message: 'OpenCode Go maxOutputTokens must be a positive safe integer',
            retryable: false
          })
        )
      }

      if (Redacted.value(config.apiKey).trim().length === 0) {
        return yield* Effect.fail(
          new LLMError({
            cause: 'validation_error',
            message: 'OpenCode Go API key must not be empty',
            retryable: false
          })
        )
      }

      const baseUrl = (config.baseUrl ?? openCodeGoBaseUrl).replace(/\/+$/, '')

      const extraHeaders = Object.fromEntries(
        Object.entries(config.extraHeaders ?? {}).map(([key, value]) => [key.toLowerCase(), value])
      )

      const identity = { providerId: openCodeGoProviderId, providerName: 'OpenCode Go' }

      switch (config.protocol) {
        case 'chat-completions':
          return makeOpenAiProviderLayer({
            apiKey: config.apiKey,
            chatCompletionsUrl: `${baseUrl}/chat/completions`,
            maxCompletionTokens: config.maxOutputTokens,
            completionTokenField: 'max_tokens',
            reasoningEffortFormat: 'reasoning-effort',
            reasoningContent: true,
            streaming: true,
            providerIdentity: { id: identity.providerId, name: identity.providerName },
            extraHeaders
          })
        case 'messages':
          return makeAnthropicMessagesProviderLayer({
            ...identity,
            messagesUrl: `${baseUrl}/messages`,
            maxTokens: config.maxOutputTokens,
            headers: {
              ...extraHeaders,
              'x-api-key': Redacted.value(config.apiKey),
              'anthropic-version': '2023-06-01',
              accept: 'text/event-stream',
              'content-type': 'application/json'
            }
          })
        case 'responses': {
          const reasoningOptions: OpenCodeGoResponsesOptions = {}

          if (config.reasoningSummary !== undefined) {
            reasoningOptions.reasoningSummary = config.reasoningSummary
          }

          return makeOpenAiResponsesProviderLayer({
            ...identity,
            apiKey: config.apiKey,
            responsesUrl: `${baseUrl}/responses`,
            maxOutputTokens: config.maxOutputTokens,
            alwaysIncludeReasoning: false,
            allowEofCompletion: false,
            requireJsonCompletion: true,
            commentaryPhaseBeforeToolCalls: true,
            extraHeaders,
            ...reasoningOptions
          })
        }

        default:
          return yield* Effect.fail(
            new LLMError({
              cause: 'validation_error',
              message: 'Unsupported OpenCode Go protocol',
              retryable: false
            })
          )
      }
    })
  )

export const makeOpenCodeGoProviderLayer = (
  config: OpenCodeGoProviderConfig
): Layer.Layer<LLMProvider, LLMError, HttpClient.HttpClient> =>
  decorateLLMProvider(provider => ({
    stream: request =>
      provider.stream(request).pipe(
        Stream.mapError(error =>
          Predicate.isTagged(error, 'LLMError') && error.provider !== undefined
            ? new LLMError({
                cause: error.cause,
                message: `OpenCode Go ${error.cause}`,
                retryable: error.retryable,
                provider: error.provider,
                responseIssue: error.responseIssue
              })
            : error
        )
      )
  })).pipe(Layer.provide(makeOpenCodeGoProtocolLayer(config)))
