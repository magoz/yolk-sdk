import { Schema } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import {
  AgentEnd,
  AgentStart,
  AssistantAgentMessage,
  AssistantTextPart,
  LLMReasoningDelta,
  LLMTextDelta,
  QuestionAnswer,
  QuestionAnswered,
  QuestionCancelled,
  QuestionPrompt,
  QuestionRequested,
  QuestionRequest,
  QuestionResponse,
  ToolApprovalDenied,
  ToolApprovalPolicy,
  ToolApprovalRequested,
  ToolCall,
  ToolApprovalRequest,
  ToolExecutionCompleted,
  ToolExecutionError,
  ToolExecutionStarted,
  ToolResult,
  zeroAgentUsage,
  type AgentEvent
} from '@yolk-sdk/agent/protocol'
import { isActiveToolRun, reduceAgentEvents } from '../../src/client'
import { propertyOptions } from './property-options'

const terminalKind = Schema.Literals(['approvalDenied', 'questionAnswered', 'questionCancelled'])
const terminalKindArbitrary = Schema.toArbitrary(terminalKind)

const clientEventKind = Schema.Literals([
  'text',
  'reasoning',
  'approvalRequested',
  'approvalDenied',
  'questionRequested',
  'questionAnswered',
  'questionCancelled',
  'toolStarted',
  'toolCompleted',
  'toolErrored',
  'agentEnd'
])

const clientEventCase = Schema.Struct({
  kinds: Schema.Array(clientEventKind)
})

const clientEventCaseArbitrary = Schema.toArbitrary(clientEventCase)

const call = ToolCall.make({ id: 'call_1', name: 'question', params: {} })

const approvalRequest = ToolApprovalRequest.make({
  requestId: 'approval:call_1',
  toolCallId: call.id,
  call,
  policy: ToolApprovalPolicy.make({ mode: 'manual' })
})

const questionRequest = QuestionRequest.make({
  requestId: 'question:call_1',
  toolCallId: call.id,
  call,
  questions: [QuestionPrompt.make({ id: 'choice', prompt: 'Pick one' })]
})

const answeredResponse = QuestionResponse.make({
  requestId: questionRequest.requestId,
  toolCallId: call.id,
  outcome: 'answered',
  source: 'user',
  answers: [QuestionAnswer.make({ questionId: 'choice', customAnswer: 'A' })]
})

const cancelledResponse = QuestionResponse.make({
  requestId: questionRequest.requestId,
  toolCallId: call.id,
  outcome: 'cancelled',
  source: 'user',
  reason: 'skip'
})

const terminalEvent = (kind: typeof terminalKind.Type) => {
  switch (kind) {
    case 'approvalDenied':
      return ToolApprovalDenied.make({ toolCallId: call.id, reason: 'denied' })
    case 'questionAnswered':
      return QuestionAnswered.make({ response: answeredResponse })
    case 'questionCancelled':
      return QuestionCancelled.make({ response: cancelledResponse })
  }
}

const toolResult = ToolResult.make({ toolCallId: call.id, content: 'ok' })
const assistantMessage = AssistantAgentMessage.make({
  parts: [AssistantTextPart.make({ content: 'done' })]
})

const clientEvent = (kind: typeof clientEventKind.Type, index: number): AgentEvent => {
  switch (kind) {
    case 'text':
      return LLMTextDelta.make({ eventId: `event_${index}`, text: 'a' })
    case 'reasoning':
      return LLMReasoningDelta.make({ eventId: `event_${index}`, text: 'r' })
    case 'approvalRequested':
      return ToolApprovalRequested.make({ eventId: `event_${index}`, call, request: approvalRequest })
    case 'approvalDenied':
      return ToolApprovalDenied.make({ eventId: `event_${index}`, toolCallId: call.id, reason: 'denied' })
    case 'questionRequested':
      return QuestionRequested.make({ eventId: `event_${index}`, request: questionRequest })
    case 'questionAnswered':
      return QuestionAnswered.make({ eventId: `event_${index}`, response: answeredResponse })
    case 'questionCancelled':
      return QuestionCancelled.make({ eventId: `event_${index}`, response: cancelledResponse })
    case 'toolStarted':
      return ToolExecutionStarted.make({ eventId: `event_${index}`, call })
    case 'toolCompleted':
      return ToolExecutionCompleted.make({ eventId: `event_${index}`, call, result: toolResult })
    case 'toolErrored':
      return ToolExecutionError.make({ eventId: `event_${index}`, call, message: 'failed', code: 'tool_error' })
    case 'agentEnd':
      return AgentEnd.make({ eventId: `event_${index}`, messages: [assistantMessage], turns: 1, usage: zeroAgentUsage })
  }
}

const eventSequence = (kinds: ReadonlyArray<typeof clientEventKind.Type>) =>
  [AgentStart.make({ eventId: 'event_start' }), ...kinds.map(clientEvent)]

const toolRunIds = (runs: ReturnType<typeof reduceAgentEvents>['toolRuns']) =>
  runs.map(run => {
    switch (run._tag) {
      case 'InputStreaming':
        return run.id
      case 'Denied':
        return run.toolCallId
      case 'QuestionRequested':
        return run.request.toolCallId
      case 'QuestionAnswered':
      case 'QuestionCancelled':
        return run.response.toolCallId
      case 'InputReady':
      case 'ApprovalRequested':
      case 'Executing':
      case 'Completed':
      case 'Errored':
      case 'ProviderCompleted':
        return run.call.id
    }
  })

describe('client HITL property tests', () => {
  it.prop(
    'terminal HITL states are inactive and unique by tool call',
    [terminalKindArbitrary],
    ([kind]) => {
      const state = reduceAgentEvents([
        AgentStart.make({}),
        ToolApprovalRequested.make({ call, request: approvalRequest }),
        QuestionRequested.make({ request: questionRequest }),
        terminalEvent(kind),
        terminalEvent(kind)
      ])

      expect(state.toolRuns).toHaveLength(1)
      expect(state.toolRuns[0]?._tag).toBe(
        kind === 'approvalDenied'
          ? 'Denied'
          : kind === 'questionAnswered'
            ? 'QuestionAnswered'
            : 'QuestionCancelled'
      )
    },
    propertyOptions
  )

  it.prop(
    'generated client event sequences keep tool state legal and dedupe event ids',
    [clientEventCaseArbitrary],
    ([input]) => {
      const events = eventSequence(input.kinds)
      const state = reduceAgentEvents([...events, ...events])
      const ids = toolRunIds(state.toolRuns)
      const activeRuns = state.toolRuns.filter(isActiveToolRun)

      expect(new Set(ids).size).toBe(ids.length)
      expect(activeRuns.length).toBeLessThanOrEqual(1)
      expect(state.seenEventIds).toEqual(events.map(event => event.eventId))

      expect(state.text.length).toBeGreaterThanOrEqual(0)
      expect(state.reasoning.length).toBeGreaterThanOrEqual(0)
    },
    propertyOptions
  )
})
