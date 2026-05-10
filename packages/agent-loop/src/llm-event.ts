import * as Schema from 'effect/Schema'
import { ToolCall } from '@yolk/protocol'

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

export const LLMEvent = Schema.Union([LLMTextDelta, LLMReasoningDelta, LLMDone, LLMToolCall])
export type LLMEvent = typeof LLMEvent.Type
