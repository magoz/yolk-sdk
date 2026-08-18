import { Effect } from 'effect'
import type { AgentReasoningEffort } from '@yolk-sdk/agent/protocol'
import type { LLMRequest } from '@yolk-sdk/agent/loop'
import type { OAuthAccessToken } from '@yolk-sdk/agent/oauth'
import type { HttpClientResponse } from 'effect/unstable/http'
import {
  makeOpenAiResponsesProviderLayer,
  streamOpenAiResponsesResponse,
  toOpenAiResponsesRequestBodyWithReasoning,
  withOpenAiResponsesProviderName,
  type OpenAiResponsesReasoningSummary
} from '../openai-responses-provider-internal.ts'
import { openAiCodexAuthorizationHeaders, openAiCodexResponsesUrl } from './codex.ts'

export type OpenAiCodexReasoningSummary = OpenAiResponsesReasoningSummary

export type OpenAiCodexProviderConfig = {
  readonly token: OAuthAccessToken
  /**
   * @deprecated The ChatGPT Codex endpoint does not accept `max_output_tokens`; this value is
   * retained as an ignored compatibility field for existing hosts.
   */
  readonly maxOutputTokens?: number
  readonly responsesUrl?: string
  readonly extraHeaders?: Readonly<Record<string, string>>
  readonly defaultReasoningEffort?: AgentReasoningEffort
  readonly reasoningSummary?: OpenAiCodexReasoningSummary
}

const openAiCodexProviderDescriptor = {
  providerId: 'openai_codex',
  providerName: 'OpenAI Codex',
  allowEofCompletion: true
} as const

export const toOpenAiCodexRequestBody = (
  request: LLMRequest,
  config: {
    /** @deprecated Ignored by the ChatGPT Codex endpoint. */
    readonly maxOutputTokens?: number
    readonly defaultReasoningEffort?: AgentReasoningEffort
    readonly reasoningSummary?: OpenAiCodexReasoningSummary
  } = {}
) => {
  const { maxOutputTokens: _maxOutputTokens, ...requestConfig } = config

  return toOpenAiResponsesRequestBodyWithReasoning(request, {
    ...requestConfig,
    providerName: openAiCodexProviderDescriptor.providerName,
    unsupportedContentProviderName: 'OpenAI Codex OAuth'
  }).pipe(
    Effect.mapError(error =>
      withOpenAiResponsesProviderName(openAiCodexProviderDescriptor.providerName, error)
    )
  )
}

export const streamOpenAiCodexResponse = (response: HttpClientResponse.HttpClientResponse) =>
  streamOpenAiResponsesResponse(openAiCodexProviderDescriptor, response)

export const makeOpenAiCodexProviderLayer = (config: OpenAiCodexProviderConfig) => {
  // The Codex subscription endpoint rejects max_output_tokens.
  const { maxOutputTokens: _maxOutputTokens, ...sharedConfig } = config

  return makeOpenAiResponsesProviderLayer({
    ...sharedConfig,
    providerId: openAiCodexProviderDescriptor.providerId,
    providerName: openAiCodexProviderDescriptor.providerName,
    responsesUrl: config.responsesUrl ?? openAiCodexResponsesUrl,
    authorizationHeaders: token => openAiCodexAuthorizationHeaders(token),
    alwaysIncludeReasoning: true,
    allowEofCompletion: true,
    unsupportedContentProviderName: 'OpenAI Codex OAuth'
  })
}
