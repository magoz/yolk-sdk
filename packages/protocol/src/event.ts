import * as Schema from 'effect/Schema'
import { AssistantAgentMessage, AgentMessage } from './message.ts'
import { ToolCall, ToolResult } from './tool.ts'
import { AgentUsage } from './usage.ts'

const NonEmptyTrimmedString = Schema.Trimmed.pipe(Schema.check(Schema.isNonEmpty()))

const EventIdentity = {
  eventId: Schema.optional(NonEmptyTrimmedString)
}

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

export class AgentStart extends Schema.TaggedClass<AgentStart>()('AgentStart', {
  ...EventIdentity
}) {}

export class AgentError extends Schema.TaggedClass<AgentError>()('AgentError', {
  ...EventIdentity,
  code: AgentErrorCode,
  message: Schema.String,
  retryable: Schema.Boolean
}) {}

export class AgentEnd extends Schema.TaggedClass<AgentEnd>()('AgentEnd', {
  ...EventIdentity,
  messages: Schema.Array(AgentMessage),
  turns: Schema.Number,
  usage: AgentUsage
}) {}

export class UsageUpdate extends Schema.TaggedClass<UsageUpdate>()('UsageUpdate', {
  ...EventIdentity,
  usage: AgentUsage
}) {}

export class AgentRetry extends Schema.TaggedClass<AgentRetry>()('AgentRetry', {
  ...EventIdentity,
  attempt: Schema.Number,
  reason: AgentErrorCode,
  delayMs: Schema.Number,
  message: Schema.String
}) {}

export class CompactionStart extends Schema.TaggedClass<CompactionStart>()('CompactionStart', {
  ...EventIdentity,
  strategy: Schema.String
}) {}

export class CompactionEnd extends Schema.TaggedClass<CompactionEnd>()('CompactionEnd', {
  ...EventIdentity,
  strategy: Schema.String,
  beforeTokens: Schema.optional(Schema.Number),
  afterTokens: Schema.optional(Schema.Number)
}) {}

export class TurnStart extends Schema.TaggedClass<TurnStart>()('TurnStart', {
  ...EventIdentity,
  turn: Schema.Number
}) {}

export class TurnEnd extends Schema.TaggedClass<TurnEnd>()('TurnEnd', {
  ...EventIdentity,
  turn: Schema.Number,
  reason: Schema.Literals(['stop', 'tool_use'])
}) {}

export class LLMStreamStart extends Schema.TaggedClass<LLMStreamStart>()('LLMStreamStart', {
  ...EventIdentity,
  turn: Schema.Number
}) {}

export class LLMTextDelta extends Schema.TaggedClass<LLMTextDelta>()('LLMTextDelta', {
  ...EventIdentity,
  text: Schema.String
}) {}

export class LLMReasoningDelta extends Schema.TaggedClass<LLMReasoningDelta>()(
  'LLMReasoningDelta',
  {
    ...EventIdentity,
    text: Schema.String
  }
) {}

export class ToolInputStart extends Schema.TaggedClass<ToolInputStart>()('ToolInputStart', {
  ...EventIdentity,
  id: Schema.String,
  name: Schema.optional(Schema.String)
}) {}

export class ToolInputDelta extends Schema.TaggedClass<ToolInputDelta>()('ToolInputDelta', {
  ...EventIdentity,
  id: Schema.String,
  delta: Schema.String
}) {}

export class ToolInputEnd extends Schema.TaggedClass<ToolInputEnd>()('ToolInputEnd', {
  ...EventIdentity,
  call: ToolCall
}) {}

export class ToolApprovalRequested extends Schema.TaggedClass<ToolApprovalRequested>()(
  'ToolApprovalRequested',
  {
    ...EventIdentity,
    call: ToolCall
  }
) {}

export class ToolApprovalGranted extends Schema.TaggedClass<ToolApprovalGranted>()(
  'ToolApprovalGranted',
  {
    ...EventIdentity,
    toolCallId: Schema.String
  }
) {}

export class ToolApprovalDenied extends Schema.TaggedClass<ToolApprovalDenied>()(
  'ToolApprovalDenied',
  {
    ...EventIdentity,
    toolCallId: Schema.String,
    reason: Schema.String
  }
) {}

export class LLMStreamEnd extends Schema.TaggedClass<LLMStreamEnd>()('LLMStreamEnd', {
  ...EventIdentity,
  turn: Schema.Number
}) {}

export class AssistantMessageEvent extends Schema.TaggedClass<AssistantMessageEvent>()(
  'AssistantMessage',
  {
    ...EventIdentity,
    message: AssistantAgentMessage
  }
) {}

export class ToolExecutionStarted extends Schema.TaggedClass<ToolExecutionStarted>()(
  'ToolExecutionStarted',
  {
    ...EventIdentity,
    call: ToolCall
  }
) {}

export class ToolExecutionCompleted extends Schema.TaggedClass<ToolExecutionCompleted>()(
  'ToolExecutionCompleted',
  {
    ...EventIdentity,
    call: ToolCall,
    result: ToolResult
  }
) {}

export class ToolExecutionError extends Schema.TaggedClass<ToolExecutionError>()(
  'ToolExecutionError',
  {
    ...EventIdentity,
    call: ToolCall,
    message: Schema.String,
    code: AgentErrorCode
  }
) {}

export class ProviderToolResult extends Schema.TaggedClass<ProviderToolResult>()(
  'ProviderToolResult',
  {
    ...EventIdentity,
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
