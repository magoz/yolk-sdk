import * as Schema from 'effect/Schema'
import { AssistantAgentMessage, AgentMessage } from './message'
import { ToolCall, ToolResult } from './tool'

export const AgentErrorCode = Schema.Literals([
  'provider_error',
  'rate_limit',
  'context_overflow',
  'invalid_response',
  'tool_error',
  'aborted',
  'session_not_found',
  'unknown'
])
export type AgentErrorCode = typeof AgentErrorCode.Type

export class AgentStart extends Schema.TaggedClass<AgentStart>()('AgentStart', {}) {}

export class AgentError extends Schema.TaggedClass<AgentError>()('AgentError', {
  code: AgentErrorCode,
  message: Schema.String,
  retryable: Schema.Boolean
}) {}

export class AgentEnd extends Schema.TaggedClass<AgentEnd>()('AgentEnd', {
  messages: Schema.Array(AgentMessage),
  turns: Schema.Number,
  usage: Schema.Struct({
    input: Schema.Number,
    output: Schema.Number
  })
}) {}

export class TurnStart extends Schema.TaggedClass<TurnStart>()('TurnStart', {
  turn: Schema.Number
}) {}

export class TurnEnd extends Schema.TaggedClass<TurnEnd>()('TurnEnd', {
  turn: Schema.Number,
  reason: Schema.Literals(['stop', 'tool_use'])
}) {}

export class LLMStreamStart extends Schema.TaggedClass<LLMStreamStart>()('LLMStreamStart', {
  turn: Schema.Number
}) {}

export class LLMTextDelta extends Schema.TaggedClass<LLMTextDelta>()('LLMTextDelta', {
  text: Schema.String
}) {}

export class LLMReasoningDelta extends Schema.TaggedClass<LLMReasoningDelta>()(
  'LLMReasoningDelta',
  {
    text: Schema.String
  }
) {}

export class LLMToolCall extends Schema.TaggedClass<LLMToolCall>()('LLMToolCall', {
  call: ToolCall
}) {}

export class LLMStreamEnd extends Schema.TaggedClass<LLMStreamEnd>()('LLMStreamEnd', {
  turn: Schema.Number
}) {}

export class AssistantMessageEvent extends Schema.TaggedClass<AssistantMessageEvent>()(
  'AssistantMessage',
  {
    message: AssistantAgentMessage
  }
) {}

export class ToolExecutionStart extends Schema.TaggedClass<ToolExecutionStart>()('ToolExecutionStart', {
  call: ToolCall
}) {}

export class ToolExecutionEnd extends Schema.TaggedClass<ToolExecutionEnd>()('ToolExecutionEnd', {
  call: ToolCall,
  result: ToolResult
}) {}

export class ToolResultEvent extends Schema.TaggedClass<ToolResultEvent>()('ToolResult', {
  result: ToolResult
}) {}

export const AgentEvent = Schema.Union([
  AgentStart,
  AgentError,
  AgentEnd,
  TurnStart,
  TurnEnd,
  LLMStreamStart,
  LLMTextDelta,
  LLMReasoningDelta,
  LLMToolCall,
  LLMStreamEnd,
  AssistantMessageEvent,
  ToolExecutionStart,
  ToolExecutionEnd,
  ToolResultEvent
])
export type AgentEvent = typeof AgentEvent.Type
