import { Effect, Layer, Stream } from 'effect'
import * as Schema from 'effect/Schema'
import { HttpClient, HttpClientRequest } from 'effect/unstable/http'
import { LLMError, LLMProvider } from '@yolk-sdk/agent/loop'
import { ProviderErrorInfo, replaceLoneSurrogatesDeep } from '@yolk-sdk/agent/protocol'
import { streamAnthropicResponse, toAnthropicRequestBody } from './anthropic-provider-internal.ts'
import {
  classifyProviderFailure,
  providerFailureCause,
  providerFailureRetryable
} from './provider-error.ts'

type AnthropicMessagesProviderConfig = {
  readonly providerId: string
  readonly providerName: string
  readonly messagesUrl: string
  readonly maxTokens: number
  readonly headers: Readonly<Record<string, string>>
}

type AnthropicMessagesErrorFields = {
  cause: LLMError['cause']
  retryable: boolean
  message: string
  provider?: LLMError['provider']
}

export const makeAnthropicMessagesProviderLayer = (config: AnthropicMessagesProviderConfig) =>
  Layer.effect(
    LLMProvider,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient

      const mapError = (error: LLMError) => {
        const fields: AnthropicMessagesErrorFields = {
          cause: error.cause,
          retryable: error.retryable,
          // Vendor stream errors can contain arbitrary text. Keep only classified metadata.
          message:
            error.provider === undefined
              ? error.message
                  .replaceAll('Anthropic Claude', config.providerName)
                  .replaceAll('Anthropic Messages', config.providerName)
              : `${config.providerName} ${error.cause}`
        }

        if (error.provider !== undefined) {
          fields.provider = ProviderErrorInfo.make({
            ...error.provider,
            provider: config.providerId
          })
        }

        return new LLMError(fields)
      }

      return LLMProvider.of({
        stream: request =>
          Stream.fromEffect(
            Effect.gen(function* () {
              const body = yield* toAnthropicRequestBody(request, {
                maxTokens: config.maxTokens,
                stream: true,
                claudeCompatibility: false
              })

              const serialized = yield* Schema.decodeUnknownEffect(Schema.Json)(
                replaceLoneSurrogatesDeep(body)
              ).pipe(
                Effect.flatMap(Schema.encodeEffect(Schema.fromJsonString(Schema.Json))),
                Effect.mapError(
                  () =>
                    new LLMError({
                      cause: 'validation_error',
                      message: `${config.providerName} request could not be serialized`,
                      retryable: false
                    })
                )
              )

              const response = yield* client
                .execute(
                  HttpClientRequest.post(config.messagesUrl).pipe(
                    HttpClientRequest.setHeaders(config.headers),
                    HttpClientRequest.bodyText(serialized, 'application/json')
                  )
                )
                .pipe(
                  Effect.mapError(
                    () =>
                      new LLMError({
                        cause: 'provider_error',
                        message: `${config.providerName} request failed`,
                        retryable: true,
                        provider: ProviderErrorInfo.make({
                          provider: config.providerId,
                          kind: 'network'
                        })
                      })
                  )
                )

              if (response.status < 200 || response.status >= 300) {
                const body = yield* response.text.pipe(
                  Effect.mapError(
                    () =>
                      new LLMError({
                        cause: 'provider_error',
                        message: `${config.providerName} error body could not be read`,
                        retryable: false
                      })
                  )
                )

                const provider = classifyProviderFailure({
                  provider: config.providerId,
                  status: response.status,
                  headers: response.headers,
                  body
                })

                return yield* Effect.fail(
                  new LLMError({
                    cause: providerFailureCause(provider.kind),
                    message: `${config.providerName} returned ${response.status}`,
                    retryable: providerFailureRetryable(provider.kind),
                    provider
                  })
                )
              }

              return response
            })
          ).pipe(
            Stream.flatMap(response => streamAnthropicResponse(response, name => name, false)),
            Stream.mapError(mapError)
          )
      })
    })
  )
