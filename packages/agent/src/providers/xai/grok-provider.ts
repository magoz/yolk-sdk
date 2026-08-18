import type { AgentReasoningEffort } from '@yolk-sdk/agent/protocol'
import type { LLMRequest } from '@yolk-sdk/agent/loop'
import type { OAuthAccessToken } from '@yolk-sdk/agent/oauth'
import type { HttpClientResponse } from 'effect/unstable/http'
import {
  makeOpenAiResponsesProviderLayer,
  streamOpenAiResponsesResponse,
  toOpenAiResponsesRequestBody,
  type OpenAiResponsesReasoningSummary
} from '../openai-responses-provider-internal.ts'
import { xAiGrokAuthorizationHeaders, xAiGrokProviderId, xAiGrokResponsesUrl } from './grok.ts'

export type XAiGrokReasoningSummary = OpenAiResponsesReasoningSummary

export type XAiGrokProviderConfig = {
  readonly token: OAuthAccessToken
  readonly maxOutputTokens: number
  /** Override only with a trusted proxy because the OAuth bearer is sent to this URL. */
  readonly responsesUrl?: string
  readonly extraHeaders?: Readonly<Record<string, string>>
  readonly defaultReasoningEffort?: AgentReasoningEffort
  readonly reasoningSummary?: XAiGrokReasoningSummary
}

const xAiGrokProviderDescriptor = {
  providerId: 'xai_grok',
  providerName: 'xAI Grok subscription',
  allowEofCompletion: false
} as const

export const toXAiGrokRequestBody = (
  request: LLMRequest,
  config: {
    readonly maxOutputTokens: number
    readonly defaultReasoningEffort?: AgentReasoningEffort
    readonly reasoningSummary?: XAiGrokReasoningSummary
  }
) =>
  toOpenAiResponsesRequestBody(request, {
    ...config,
    providerName: xAiGrokProviderDescriptor.providerName,
    alwaysIncludeReasoning: false
  })

export const streamXAiGrokResponse = (response: HttpClientResponse.HttpClientResponse) =>
  streamOpenAiResponsesResponse(xAiGrokProviderDescriptor, response)

export const makeXAiGrokProviderLayer = (config: XAiGrokProviderConfig) =>
  makeOpenAiResponsesProviderLayer({
    ...config,
    providerId: xAiGrokProviderDescriptor.providerId,
    providerName: xAiGrokProviderDescriptor.providerName,
    responsesUrl: config.responsesUrl ?? xAiGrokResponsesUrl,
    authorizationHeaders: xAiGrokAuthorizationHeaders,
    alwaysIncludeReasoning: false,
    allowEofCompletion: false,
    expectedTokenProvider: xAiGrokProviderId
  })
