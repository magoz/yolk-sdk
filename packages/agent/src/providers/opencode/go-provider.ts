import { Effect, Layer, Predicate, Redacted, Ref, Stream } from 'effect'
import type { HttpClient } from 'effect/http'
import {
  decorateLLMProvider,
  LLMError,
  type LLMEvent,
  type LLMProvider,
  type LLMProviderError,
  type LLMRequest
} from '@yolk-sdk/agent/loop'
import { makeOpenAiProviderLayer, openAiChatResponseIssues } from '../openai/provider.ts'
import { makeOpenAiResponsesProviderLayer } from '../openai-responses-provider-internal.ts'
import { makeAnthropicMessagesProviderLayer } from '../anthropic-messages-provider-internal.ts'

export const openCodeGoProviderId = 'opencode_go'

export const openCodeGoBaseUrl = 'https://opencode.ai/inference/go/v1'

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

      // Go asks clients to send a stable per-conversation id here for routing and prompt caching.
      const cacheKeyHeaders = (cacheKey: string) => ({ 'x-opencode-session': cacheKey })

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
            extraHeaders,
            cacheKeyHeaders
          })
        case 'messages':
          return makeAnthropicMessagesProviderLayer({
            ...identity,
            messagesUrl: `${baseUrl}/messages`,
            maxTokens: config.maxOutputTokens,
            cacheKeyHeaders,
            extraHeaders,
            headers: {
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
            cacheKeyHeaders,
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

/**
 * Malformed-response codes that earn one re-routed attempt: the parser rejected what an upstream
 * sent, or the stream ended before its terminal event. Model decisions (`length`,
 * `content_filter`, `max_tokens`) and provider-reported errors are never re-routed.
 */
const reroutableResponseCodes: ReadonlySet<string> = new Set<string>([
  ...openAiChatResponseIssues,
  'incomplete_stream',
  'unexpected_content_type'
])

/** The malformed-response code of a reroutable failure, else `undefined`. */
const reroutableCodeOf = (error: LLMProviderError): string | undefined => {
  if (!Predicate.isTagged(error, 'LLMError') || error.cause !== 'invalid_response') return undefined

  const code = error.provider?.providerCode

  return code !== undefined && reroutableResponseCodes.has(code) ? code : undefined
}

// Last case variant wins, matching the lowercased extras the protocol layer sends.
const sessionHeaderOf = (headers: Readonly<Record<string, string>> | undefined) => {
  let session: string | undefined

  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === 'x-opencode-session') session = value
  }

  return session
}

/**
 * Go pins a session (`x-opencode-session`) to one upstream server for routing and prompt caching,
 * so a retry under the same session reaches the server that just sent a malformed response. A
 * stream that fails with a reroutable code before emitting any event is sent once more under
 * `<session>.reroute`, which routes it afresh at the cost of that request's cached prefix. A
 * request without a session is sent once more unchanged. Errors after the first event, and the
 * second attempt's errors, propagate.
 */
const streamWithReroute = (
  provider: typeof LLMProvider.Service,
  request: LLMRequest,
  sessionId: string | undefined
): Stream.Stream<LLMEvent, LLMProviderError> =>
  Stream.unwrap(
    Ref.make(false).pipe(
      Effect.map(emitted =>
        provider.stream(request).pipe(
          Stream.tap(() => Ref.set(emitted, true)),
          Stream.catch(error =>
            Stream.unwrap(
              Ref.get(emitted).pipe(
                Effect.map(started => {
                  const code = reroutableCodeOf(error)

                  if (started || code === undefined) return Stream.fail(error)

                  const rerouted =
                    sessionId === undefined
                      ? request
                      : { ...request, cacheKey: `${sessionId}.reroute` }

                  return Stream.fromEffect(
                    Effect.logWarning(
                      `OpenCode Go sent a malformed response (${code}); retrying once on a fresh route`
                    )
                  ).pipe(Stream.drain, Stream.concat(provider.stream(rerouted)))
                })
              )
            )
          )
        )
      )
    )
  )

export const makeOpenCodeGoProviderLayer = (
  config: OpenCodeGoProviderConfig
): Layer.Layer<LLMProvider, LLMError, HttpClient.HttpClient> =>
  decorateLLMProvider(provider => ({
    stream: request =>
      streamWithReroute(
        provider,
        request,
        request.cacheKey ?? sessionHeaderOf(config.extraHeaders)
      ).pipe(
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
