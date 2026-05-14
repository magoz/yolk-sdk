import * as Schema from 'effect/Schema'
import { AgentUsage, ToolCall, ToolResult } from '@yolk/agent/protocol'

export class LLMTextDelta extends Schema.TaggedClass<LLMTextDelta>()('TextDelta', {
  text: Schema.String
}) {}

export class LLMReasoningDelta extends Schema.TaggedClass<LLMReasoningDelta>()('ReasoningDelta', {
  text: Schema.String
}) {}

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
  LLMDone,
  LLMToolCall,
  LLMToolInputStart,
  LLMToolInputDelta,
  LLMProviderToolResult,
  LLMUsage
])
export type LLMEvent = typeof LLMEvent.Type
