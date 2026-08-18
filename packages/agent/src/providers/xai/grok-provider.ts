import type { AgentReasoningEffort } from '@yolk-sdk/agent/protocol'
import { Effect } from 'effect'
import type { LLMError, LLMRequest } from '@yolk-sdk/agent/loop'
import type { OAuthAccessToken } from '@yolk-sdk/agent/oauth'
import type { HttpClientResponse } from 'effect/unstable/http'
import {
  makeOpenAiResponsesProviderLayer,
  streamOpenAiResponsesResponse,
  toOpenAiResponsesRequestBody,
  withOpenAiResponsesProviderName
} from '../openai-responses-provider-internal.ts'
import { xAiGrokAuthorizationHeaders, xAiGrokProviderId, xAiGrokResponsesUrl } from './grok.ts'

export type XAiGrokReasoningSummary = 'auto' | 'concise' | 'detailed'

export type XAiGrokProviderConfig = {
  readonly token: OAuthAccessToken
  readonly maxOutputTokens: number
  /** Override only with a trusted proxy because the OAuth bearer is sent to this URL. */
  readonly responsesUrl?: string
  readonly extraHeaders?: Readonly<Record<string, string>>
  readonly defaultReasoningEffort?: AgentReasoningEffort
  readonly reasoningSummary?: XAiGrokReasoningSummary
}

type XAiGrokInputTextPart = {
  readonly type: 'input_text'
  readonly text: string
}

type XAiGrokInputImagePart = {
  readonly type: 'input_image'
  readonly image_url: string
}

type XAiGrokInputFilePart =
  | {
      readonly type: 'input_file'
      readonly filename: string
      readonly file_data: string
    }
  | {
      readonly type: 'input_file'
      readonly file_url: string
    }

type XAiGrokInputContentPart = XAiGrokInputTextPart | XAiGrokInputImagePart | XAiGrokInputFilePart

type XAiGrokMessageInput = {
  readonly role: 'user' | 'assistant'
  readonly content: string | ReadonlyArray<XAiGrokInputContentPart>
}

type XAiGrokFunctionCallInput = {
  readonly type: 'function_call'
  readonly call_id: string
  readonly name: string
  readonly arguments: string
}

type XAiGrokFunctionOutputInput = {
  readonly type: 'function_call_output'
  readonly call_id: string
  readonly output: string | ReadonlyArray<XAiGrokInputContentPart>
}

type XAiGrokInputItem = XAiGrokMessageInput | XAiGrokFunctionCallInput | XAiGrokFunctionOutputInput

type XAiGrokTool = {
  readonly type: 'function'
  readonly name: string
  readonly description: string
  readonly parameters: unknown
}

type XAiGrokRequestBody = {
  readonly model: string
  readonly instructions: string
  readonly input: ReadonlyArray<XAiGrokInputItem>
  readonly store: false
  readonly stream: true
  readonly max_output_tokens: number
  readonly reasoning?: {
    readonly effort: AgentReasoningEffort
    readonly summary: XAiGrokReasoningSummary
  }
  readonly tools?: ReadonlyArray<XAiGrokTool>
  readonly parallel_tool_calls?: true
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
): Effect.Effect<XAiGrokRequestBody, LLMError> =>
  toOpenAiResponsesRequestBody(request, {
    ...config,
    providerName: xAiGrokProviderDescriptor.providerName,
    alwaysIncludeReasoning: false
  }).pipe(
    Effect.map(body => ({ ...body, max_output_tokens: config.maxOutputTokens })),
    Effect.mapError(error =>
      withOpenAiResponsesProviderName(xAiGrokProviderDescriptor.providerName, error)
    )
  )

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
