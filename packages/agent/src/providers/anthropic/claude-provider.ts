import type { Effect, Layer, Schema, Stream } from 'effect'
import type { HttpClient, HttpClientResponse } from 'effect/http'
import type { LLMError, LLMEvent, LLMProvider, LLMRequest } from '@yolk-sdk/agent/loop'
import type { OAuthAccessToken } from '@yolk-sdk/agent/oauth'
import {
  anthropicClaudeReasoningReplayProvider as claudeReasoningReplayProvider,
  makeAnthropicClaudeProviderLayer as makeClaudeLayer,
  streamAnthropicResponse as streamClaudeResponse,
  toAnthropicRequestBody as toClaudeRequestBody
} from '../anthropic-provider-internal.ts'

/**
 * `AssistantReasoningReplay.provider` of the thinking this provider captures and sends back.
 * Hosts that rewrite history per request must leave those reasoning parts untouched.
 */
export const anthropicClaudeReasoningReplayProvider: string = claudeReasoningReplayProvider

/**
 * Lifetime of the prompt-cache entries a request writes. `5m` is Anthropic's default; `1h` costs
 * more to write but survives idle gaps such as pending approvals.
 */
export type AnthropicPromptCacheTtl = '5m' | '1h'

/**
 * Adaptive thinking (`thinking: { type: 'adaptive' }`). `display: 'summarized'` returns readable
 * thinking summaries; `omitted`, the API default on newer models, returns thinking blocks with
 * empty text. `prefixMismatchBehavior` sets `block_binding.prefix_mismatch_behavior` (with the
 * `thinking-binding-controls-2026-08-01` beta): what Anthropic does with a replayed thinking block
 * whose earlier system prompt, tools or messages changed. `drop_block` drops it (the model thinks
 * again); `error` rejects the request. Absent, Anthropic applies its account default.
 */
export type AnthropicClaudeThinkingConfig = {
  readonly display: 'summarized' | 'omitted'
  readonly prefixMismatchBehavior?: 'error' | 'drop_block'
}

export type AnthropicClaudeProviderConfig = {
  readonly token: OAuthAccessToken
  readonly messagesUrl?: string
  readonly maxTokens: number
  readonly extraHeaders?: Readonly<Record<string, string>>
  /** Default `5m`. */
  readonly promptCacheTtl?: AnthropicPromptCacheTtl
  /**
   * Absent: no `thinking` field, so the model's own default applies. Thinking signatures are kept
   * on reasoning parts and sent back unchanged either way.
   */
  readonly thinking?: AnthropicClaudeThinkingConfig
}

type AnthropicCacheControl = {
  readonly type: 'ephemeral'
  readonly ttl?: '1h'
}

type AnthropicTextBlock = {
  readonly type: 'text'
  readonly text: string
  readonly cache_control?: AnthropicCacheControl
}

type AnthropicImageBlock = {
  readonly type: 'image'
  readonly source:
    | { readonly type: 'base64'; readonly media_type: string; readonly data: string }
    | { readonly type: 'url'; readonly url: string }
  readonly cache_control?: AnthropicCacheControl
}

type AnthropicDocumentBlock = {
  readonly type: 'document'
  readonly source:
    | { readonly type: 'base64'; readonly media_type: 'application/pdf'; readonly data: string }
    | { readonly type: 'url'; readonly url: string }
  readonly title?: string
  readonly cache_control?: AnthropicCacheControl
}

type AnthropicToolUseBlock = {
  readonly type: 'tool_use'
  readonly id: string
  readonly name: string
  readonly input: Schema.Json
  readonly cache_control?: AnthropicCacheControl
}

type AnthropicThinkingBlock = {
  readonly type: 'thinking'
  readonly thinking: string
  readonly signature: string
}

type AnthropicRedactedThinkingBlock = {
  readonly type: 'redacted_thinking'
  readonly data: string
}

type AnthropicToolResultContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicDocumentBlock

type AnthropicToolResultBlock = {
  readonly type: 'tool_result'
  readonly tool_use_id: string
  readonly content: string | ReadonlyArray<AnthropicToolResultContentBlock>
  readonly is_error?: boolean
  readonly cache_control?: AnthropicCacheControl
}

type AnthropicMessage =
  | {
      readonly role: 'user'
      readonly content:
        | string
        | ReadonlyArray<AnthropicToolResultContentBlock | AnthropicToolResultBlock>
    }
  | {
      readonly role: 'assistant'
      readonly content: ReadonlyArray<
        | AnthropicTextBlock
        | AnthropicToolUseBlock
        | AnthropicThinkingBlock
        | AnthropicRedactedThinkingBlock
      >
    }

type AnthropicTool = {
  readonly name: string
  readonly description: string
  readonly input_schema: Schema.Json
  readonly cache_control?: AnthropicCacheControl
}

type AnthropicRequestBody = {
  readonly model: string
  readonly system: ReadonlyArray<AnthropicTextBlock>
  readonly messages: ReadonlyArray<AnthropicMessage>
  readonly max_tokens: number
  readonly output_config?: { readonly effort: 'low' | 'medium' | 'high' | 'xhigh' }
  readonly thinking?: {
    readonly type: 'adaptive'
    readonly display: AnthropicClaudeThinkingConfig['display']
    readonly block_binding?: {
      readonly prefix_mismatch_behavior: NonNullable<
        AnthropicClaudeThinkingConfig['prefixMismatchBehavior']
      >
    }
  }
  readonly stream?: true
  readonly tools?: ReadonlyArray<AnthropicTool>
  readonly tool_choice?: { readonly type: 'none' }
}

export const toAnthropicClaudeRequestBody = (
  request: LLMRequest,
  config: {
    readonly maxTokens: number
    readonly stream?: boolean
    readonly promptCacheTtl?: AnthropicPromptCacheTtl
    readonly thinking?: AnthropicClaudeThinkingConfig
  }
): Effect.Effect<AnthropicRequestBody, LLMError> => toClaudeRequestBody(request, config)

export const streamAnthropicClaudeResponse = (
  response: HttpClientResponse.HttpClientResponse
): Stream.Stream<LLMEvent, LLMError> => streamClaudeResponse(response)

export const makeAnthropicClaudeProviderLayer = (
  config: AnthropicClaudeProviderConfig
): Layer.Layer<LLMProvider, never, HttpClient.HttpClient> => makeClaudeLayer(config)
