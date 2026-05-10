import { Context } from 'effect'
import type { Stream } from 'effect'
import type { AgentMessage, ToolDef } from '@yolk/protocol'
import type { HarnessError } from '../error'
import type { LLMEvent } from '../llm-event'

export type LLMRequest = {
  readonly messages: ReadonlyArray<AgentMessage>
  readonly tools: ReadonlyArray<ToolDef>
  readonly model: string
  readonly systemPrompt: string
}

export class LLMProvider extends Context.Service<
  LLMProvider,
  {
    readonly stream: (request: LLMRequest) => Stream.Stream<LLMEvent, HarnessError>
  }
>()('@yolk/harness/LLMProvider') {}
