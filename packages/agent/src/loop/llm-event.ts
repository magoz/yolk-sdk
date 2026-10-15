import * as Schema from 'effect/Schema'
import {
  AgentUsage,
  AssistantReasoningReplay,
  ToolCall,
  ToolResult
} from '@yolk-sdk/agent/protocol'

export class LLMTextDelta extends Schema.TaggedClass<LLMTextDelta>()('TextDelta', {
  text: Schema.String
}) {}

export class LLMReasoningDelta extends Schema.TaggedClass<LLMReasoningDelta>()('ReasoningDelta', {
  text: Schema.String
}) {}

/**
 * Closes a reasoning block with the provider state that replays it. A `Signed` replay closes the
 * open reasoning part (the preceding `ReasoningDelta` text); a `Redacted` replay is a block of its
 * own. Never surfaced as an agent event: it only reaches the assistant message.
 */
export class LLMReasoningReplay extends Schema.TaggedClass<LLMReasoningReplay>()(
  'ReasoningReplay',
  {
    replay: AssistantReasoningReplay
  }
) {}

export class LLMDone extends Schema.TaggedClass<LLMDone>()('Done', {
  stopReason: Schema.Literals(['stop', 'tool_use'])
}) {}

export class LLMToolCall extends Schema.TaggedClass<LLMToolCall>()('ToolCall', {
  call: ToolCall
}) {}

export class LLMToolInputStart extends Schema.TaggedClass<LLMToolInputStart>()('ToolInputStart', {
  id: Schema.String,
  name: Schema.optional(Schema.String)
}) {}

export class LLMToolInputDelta extends Schema.TaggedClass<LLMToolInputDelta>()('ToolInputDelta', {
  id: Schema.String,
  delta: Schema.String
}) {}

export class LLMProviderToolResult extends Schema.TaggedClass<LLMProviderToolResult>()(
  'ProviderToolResult',
  {
    call: ToolCall,
    result: ToolResult
  }
) {}

export class LLMUsage extends Schema.TaggedClass<LLMUsage>()('Usage', {
  usage: AgentUsage
}) {}

export const LLMEvent = Schema.Union([
  LLMTextDelta,
  LLMReasoningDelta,
  LLMReasoningReplay,
  LLMDone,
  LLMToolCall,
  LLMToolInputStart,
  LLMToolInputDelta,
  LLMProviderToolResult,
  LLMUsage
])

export type LLMEvent = typeof LLMEvent.Type
