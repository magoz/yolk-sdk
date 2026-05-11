import { Context } from 'effect'
import type { Stream } from 'effect'
import type { AgentMessage, AgentReasoningEffort, ToolDef } from '@yolk/protocol'
import type { AgentLoopError } from '../error.ts'
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
    readonly stream: (request: LLMRequest) => Stream.Stream<LLMEvent, AgentLoopError>
  }
>()('@yolk/agent-loop/LLMProvider') {}
