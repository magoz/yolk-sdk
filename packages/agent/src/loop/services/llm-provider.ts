import { Context } from 'effect'
import type { Stream } from 'effect'
import type { AgentMessage, AgentReasoningEffort, ToolDef } from '@yolk-sdk/agent/protocol'
import type { LLMProviderError } from '../error.ts'
import type { LLMEvent } from '../llm-event.ts'

export type LLMRequest = {
  readonly messages: ReadonlyArray<AgentMessage>
  /** Provider-facing definitions. The loop omits `callableBy: 'codemode'` tools
   * (`providerToolDefs`); hosts calling providers directly must do the same.
   */
  readonly tools: ReadonlyArray<ToolDef>
  readonly model: string
  readonly systemPrompt: string
  readonly reasoningEffort?: AgentReasoningEffort
  /**
   * Stable conversation identity (for example the host session id) that providers use to route
   * requests to their prompt cache. Requests that share a prefix (compaction) should reuse the
   * conversation's key. Sent as an HTTP header value, so keep it printable ASCII; opaque to the
   * SDK, never personal data.
   */
  readonly cacheKey?: string
  /**
   * Per-request context appended after the conversation, so it can change on every request (fresh
   * signed URLs, the current time) without rewriting the cached prefix. Anthropic places it after
   * every breakpoint; Gateway's automatic markers still read the prefix before it. Never part of
   * the transcript; the host owns its wording. Loop hosts set it by decorating `LLMProvider`.
   */
  readonly turnContext?: string
  /**
   * `none` keeps the tool definitions while forbidding tool calls. Default `auto`. On Anthropic a
   * changed `tool_choice` invalidates the cached messages (tools and system stay cached), so a
   * request meant to reuse a conversation's cache should keep `auto` and instruct instead.
   */
  readonly toolChoice?: 'auto' | 'none'
}

export class LLMProvider extends Context.Service<
  LLMProvider,
  {
    readonly stream: (request: LLMRequest) => Stream.Stream<LLMEvent, LLMProviderError>
  }
>()('@yolk-sdk/agent/loop/LLMProvider') {}
