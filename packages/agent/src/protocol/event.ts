import * as Schema from 'effect/Schema'
import { AssistantAgentMessage, AgentMessage } from './message.ts'
import {
  HitlRequest,
  QuestionAnswer,
  QuestionRequest,
  QuestionResponse,
  ToolApprovalRequest,
  ToolApprovalResponse,
  ToolCall,
  ToolResult,
  type HitlResponse
} from './tool.ts'
import { AgentUsage } from './usage.ts'

const NonEmptyTrimmedString = Schema.Trimmed.pipe(Schema.check(Schema.isNonEmpty()))

const EventIdentity = {
  eventId: Schema.optional(NonEmptyTrimmedString),
  createdAtMs: Schema.optional(Schema.Number)
}

export const SubagentStatus = Schema.Literals(['running', 'completed', 'error'])
export type SubagentStatus = typeof SubagentStatus.Type

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

export class AgentAwaitingInput extends Schema.TaggedClass<AgentAwaitingInput>()(
  'AgentAwaitingInput',
  {
    ...EventIdentity,
    requests: Schema.NonEmptyArray(HitlRequest),
    messages: Schema.Array(AgentMessage),
    turns: Schema.Number,
    usage: AgentUsage
  }
) {}

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
    call: ToolCall,
    request: Schema.optional(ToolApprovalRequest)
  }
) {}

export class ToolApprovalGranted extends Schema.TaggedClass<ToolApprovalGranted>()(
  'ToolApprovalGranted',
  {
    ...EventIdentity,
    toolCallId: Schema.String,
    response: Schema.optional(ToolApprovalResponse)
  }
) {}

export class ToolApprovalDenied extends Schema.TaggedClass<ToolApprovalDenied>()(
  'ToolApprovalDenied',
  {
    ...EventIdentity,
    toolCallId: Schema.String,
    reason: Schema.String,
    response: Schema.optional(ToolApprovalResponse)
  }
) {}

export class QuestionRequested extends Schema.TaggedClass<QuestionRequested>()(
  'QuestionRequested',
  {
    ...EventIdentity,
    request: QuestionRequest
  }
) {}

export class QuestionAnswered extends Schema.TaggedClass<QuestionAnswered>()('QuestionAnswered', {
  ...EventIdentity,
  response: QuestionResponse
}) {}

export class QuestionCancelled extends Schema.TaggedClass<QuestionCancelled>()(
  'QuestionCancelled',
  {
    ...EventIdentity,
    response: QuestionResponse
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

export class SubagentStarted extends Schema.TaggedClass<SubagentStarted>()('SubagentStarted', {
  ...EventIdentity,
  parentToolCallId: NonEmptyTrimmedString,
  subagentRunId: NonEmptyTrimmedString,
  subagentType: NonEmptyTrimmedString,
  description: Schema.String,
  model: Schema.String
}) {}

export class SubagentCompleted extends Schema.TaggedClass<SubagentCompleted>()(
  'SubagentCompleted',
  {
    ...EventIdentity,
    parentToolCallId: NonEmptyTrimmedString,
    subagentRunId: NonEmptyTrimmedString,
    subagentType: NonEmptyTrimmedString,
    description: Schema.String,
    model: Schema.String,
    status: SubagentStatus,
    durationMs: Schema.Number,
    summary: Schema.optional(Schema.String)
  }
) {}

export const makeSubagentRunId = (parentToolCallId: string) => `subagent:${parentToolCallId}`

const questionAnswerValue = (answer: QuestionAnswer) =>
  QuestionAnswer.make({
    questionId: answer.questionId,
    ...(answer.optionIds === undefined ? {} : { optionIds: [...answer.optionIds] }),
    ...(answer.customAnswer === undefined ? {} : { customAnswer: answer.customAnswer })
  })

const questionResponseValue = (response: QuestionResponse) =>
  QuestionResponse.make({
    requestId: response.requestId,
    toolCallId: response.toolCallId,
    outcome: response.outcome,
    source: response.source,
    ...(response.answers === undefined
      ? {}
      : { answers: response.answers.map(answer => questionAnswerValue(answer)) }),
    ...(response.reason === undefined ? {} : { reason: response.reason })
  })

const toolApprovalResponseValue = (response: ToolApprovalResponse) =>
  ToolApprovalResponse.make({
    requestId: response.requestId,
    toolCallId: response.toolCallId,
    decision: response.decision,
    source: response.source,
    ...(response.reason === undefined ? {} : { reason: response.reason })
  })

export const hitlResponseEvent = (response: HitlResponse): AgentEvent => {
  switch (response._tag) {
    case 'QuestionResponse': {
      const responseValue = questionResponseValue(response)

      return response.outcome === 'answered'
        ? QuestionAnswered.make({ response: responseValue })
        : QuestionCancelled.make({ response: responseValue })
    }
    case 'ToolApprovalResponse': {
      const responseValue = toolApprovalResponseValue(response)

      return response.decision === 'approved'
        ? ToolApprovalGranted.make({ toolCallId: response.toolCallId, response: responseValue })
        : ToolApprovalDenied.make({
            toolCallId: response.toolCallId,
            reason: response.reason ?? 'Denied by user',
            response: responseValue
          })
    }
  }
}

export const AgentEvent = Schema.Union([
  AgentStart,
  AgentError,
  AgentEnd,
  AgentAwaitingInput,
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
  QuestionRequested,
  QuestionAnswered,
  QuestionCancelled,
  ToolExecutionStarted,
  ToolExecutionCompleted,
  ToolExecutionError,
  ProviderToolResult,
  SubagentStarted,
  SubagentCompleted
])
export type AgentEvent = typeof AgentEvent.Type
