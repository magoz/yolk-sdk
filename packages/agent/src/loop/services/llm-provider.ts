import { Context } from 'effect'
import type { Stream } from 'effect'
import type { AgentMessage, AgentReasoningEffort, ToolDef } from '@yolk-sdk/agent/protocol'
import type { LLMProviderError } from '../error.ts'
import type { LLMEvent } from '../llm-event.ts'

export type LLMRequest = {
  readonly messages: ReadonlyArray<AgentMessage>
  readonly tools: ReadonlyArray<ToolDef>
  readonly model: string
  readonly systemPrompt: string
  readonly reasoningEffort?: AgentReasoningEffort
}

export class LLMProvider extends Context.Service<
  LLMProvider,
  {
    readonly stream: (request: LLMRequest) => Stream.Stream<LLMEvent, LLMProviderError>
  }
>()('@yolk-sdk/agent/loop/LLMProvider') {}
