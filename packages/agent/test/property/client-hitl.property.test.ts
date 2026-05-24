import { Schema } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import {
  AgentStart,
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
  ToolApprovalRequest
} from '@yolk-sdk/agent/protocol'
import { reduceAgentEvents } from '../../src/client'
import { propertyOptions } from './property-options'

const terminalKind = Schema.Literals(['approvalDenied', 'questionAnswered', 'questionCancelled'])
const terminalKindArbitrary = Schema.toArbitrary(terminalKind)

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
})
