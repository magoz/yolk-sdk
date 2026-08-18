import { Effect } from 'effect'
import type { AgentReasoningEffort } from '@yolk-sdk/agent/protocol'
import type { LLMError, LLMRequest } from '@yolk-sdk/agent/loop'
import type { OAuthAccessToken } from '@yolk-sdk/agent/oauth'
import type { HttpClientResponse } from 'effect/unstable/http'
import {
  makeOpenAiResponsesProviderLayer,
  streamOpenAiResponsesResponse,
  toOpenAiResponsesRequestBodyWithReasoning,
  withOpenAiResponsesProviderName
} from '../openai-responses-provider-internal.ts'
import { openAiCodexAuthorizationHeaders, openAiCodexResponsesUrl } from './codex.ts'

export type OpenAiCodexReasoningSummary = 'auto' | 'concise' | 'detailed'

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

type OpenAiCodexInputTextPart = {
  readonly type: 'input_text'
  readonly text: string
}

type OpenAiCodexInputImagePart = {
  readonly type: 'input_image'
  readonly image_url: string
}

type OpenAiCodexInputFilePart =
  | {
      readonly type: 'input_file'
      readonly filename: string
      readonly file_data: string
    }
  | {
      readonly type: 'input_file'
      readonly file_url: string
    }

type OpenAiCodexInputContentPart =
  | OpenAiCodexInputTextPart
  | OpenAiCodexInputImagePart
  | OpenAiCodexInputFilePart

type OpenAiCodexMessageInput = {
  readonly role: 'user' | 'assistant'
  readonly content: string | ReadonlyArray<OpenAiCodexInputContentPart>
}

type OpenAiCodexFunctionCallInput = {
  readonly type: 'function_call'
  readonly call_id: string
  readonly name: string
  readonly arguments: string
}

type OpenAiCodexFunctionOutputInput = {
  readonly type: 'function_call_output'
  readonly call_id: string
  readonly output: string | ReadonlyArray<OpenAiCodexInputContentPart>
}

type OpenAiCodexInputItem =
  | OpenAiCodexMessageInput
  | OpenAiCodexFunctionCallInput
  | OpenAiCodexFunctionOutputInput

type OpenAiCodexTool = {
  readonly type: 'function'
  readonly name: string
  readonly description: string
  readonly parameters: unknown
}

type OpenAiCodexRequestBody = {
  readonly model: string
  readonly instructions: string
  readonly input: ReadonlyArray<OpenAiCodexInputItem>
  readonly store: false
  readonly stream: true
  readonly reasoning: {
    readonly effort: AgentReasoningEffort
    readonly summary: OpenAiCodexReasoningSummary
  }
  readonly tools?: ReadonlyArray<OpenAiCodexTool>
  readonly parallel_tool_calls?: true
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
): Effect.Effect<OpenAiCodexRequestBody, LLMError> => {
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
