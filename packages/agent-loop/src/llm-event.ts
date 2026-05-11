import * as Schema from 'effect/Schema'
import { AgentUsage, ToolCall } from '@yolk/protocol'

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

export class LLMUsage extends Schema.TaggedClass<LLMUsage>()('Usage', {
  usage: AgentUsage
}) {}

export const LLMEvent = Schema.Union([
  LLMTextDelta,
  LLMReasoningDelta,
  LLMDone,
  LLMToolCall,
  LLMUsage
])
export type LLMEvent = typeof LLMEvent.Type
