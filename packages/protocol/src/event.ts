import * as Schema from 'effect/Schema'
import { AssistantAgentMessage, AgentMessage } from './message.ts'
import { ToolCall, ToolResult } from './tool.ts'
import { AgentUsage } from './usage.ts'

export const AgentErrorCode = Schema.Literals([
  'validation_error',
  'provider_error',
  'rate_limit',
  'context_overflow',
  'invalid_response',
  'tool_error',
  'tool_denied',
  'tool_timeout',
  'store_error',
  'aborted',
  'session_not_found',
  'conflict',
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
  usage: AgentUsage
}) {}

export class UsageUpdate extends Schema.TaggedClass<UsageUpdate>()('UsageUpdate', {
  usage: AgentUsage
}) {}

export class AgentRetry extends Schema.TaggedClass<AgentRetry>()('AgentRetry', {
  attempt: Schema.Number,
  reason: AgentErrorCode,
  delayMs: Schema.Number,
  message: Schema.String
}) {}

export class CompactionStart extends Schema.TaggedClass<CompactionStart>()('CompactionStart', {
  strategy: Schema.String
}) {}

export class CompactionEnd extends Schema.TaggedClass<CompactionEnd>()('CompactionEnd', {
  strategy: Schema.String,
  beforeTokens: Schema.optional(Schema.Number),
  afterTokens: Schema.optional(Schema.Number)
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

export class ToolInputStart extends Schema.TaggedClass<ToolInputStart>()('ToolInputStart', {
  id: Schema.String,
  name: Schema.optional(Schema.String)
}) {}

export class ToolInputDelta extends Schema.TaggedClass<ToolInputDelta>()('ToolInputDelta', {
  id: Schema.String,
  delta: Schema.String
}) {}

export class ToolInputEnd extends Schema.TaggedClass<ToolInputEnd>()('ToolInputEnd', {
  call: ToolCall
}) {}

export class ToolApprovalRequested extends Schema.TaggedClass<ToolApprovalRequested>()(
  'ToolApprovalRequested',
  {
    call: ToolCall
  }
) {}

export class ToolApprovalGranted extends Schema.TaggedClass<ToolApprovalGranted>()(
  'ToolApprovalGranted',
  {
    toolCallId: Schema.String
  }
) {}

export class ToolApprovalDenied extends Schema.TaggedClass<ToolApprovalDenied>()(
  'ToolApprovalDenied',
  {
    toolCallId: Schema.String,
    reason: Schema.String
  }
) {}

export class LLMStreamEnd extends Schema.TaggedClass<LLMStreamEnd>()('LLMStreamEnd', {
  turn: Schema.Number
}) {}

export class AssistantMessageEvent extends Schema.TaggedClass<AssistantMessageEvent>()(
  'AssistantMessage',
  {
    message: AssistantAgentMessage
  }
) {}

export class ToolExecutionStarted extends Schema.TaggedClass<ToolExecutionStarted>()(
  'ToolExecutionStarted',
  {
    call: ToolCall
  }
) {}

export class ToolExecutionCompleted extends Schema.TaggedClass<ToolExecutionCompleted>()(
  'ToolExecutionCompleted',
  {
    call: ToolCall,
    result: ToolResult
  }
) {}

export class ToolExecutionError extends Schema.TaggedClass<ToolExecutionError>()(
  'ToolExecutionError',
  {
    call: ToolCall,
    message: Schema.String,
    code: AgentErrorCode
  }
) {}

export class ProviderToolResult extends Schema.TaggedClass<ProviderToolResult>()(
  'ProviderToolResult',
  {
    call: ToolCall,
    result: ToolResult
  }
) {}

export const AgentEvent = Schema.Union([
  AgentStart,
  AgentError,
  AgentEnd,
  UsageUpdate,
  AgentRetry,
  CompactionStart,
  CompactionEnd,
  TurnStart,
  TurnEnd,
  LLMStreamStart,
  LLMTextDelta,
  LLMReasoningDelta,
  ToolInputStart,
  ToolInputDelta,
  ToolInputEnd,
  LLMStreamEnd,
  AssistantMessageEvent,
  ToolApprovalRequested,
  ToolApprovalGranted,
  ToolApprovalDenied,
  ToolExecutionStarted,
  ToolExecutionCompleted,
  ToolExecutionError,
  ProviderToolResult
])
export type AgentEvent = typeof AgentEvent.Type
