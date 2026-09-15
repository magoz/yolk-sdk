import { describe, expect, it } from '@effect/vitest'
import {
  AgentAwaitingInput,
  AgentEnd,
  AgentError,
  AgentStart,
  QuestionAnswer,
  QuestionAnswered,
  QuestionResponse,
  ToolApprovalDenied,
  ToolApprovalGranted,
  ToolApprovalResponse,
  ToolCall,
  ToolApprovalPolicy,
  ToolApprovalRequest,
  UserMessage,
  hitlResponseEvent,
  isTerminalAgentEvent,
  zeroAgentUsage
} from '@yolk-sdk/agent/protocol'

describe('agent protocol events', () => {
  it('identifies protocol-terminal events', () => {
    const messages = [UserMessage.make({ content: 'hello' })]

    const request = ToolApprovalRequest.make({
      requestId: 'request-1',
      toolCallId: 'call-1',
      call: ToolCall.make({ id: 'call-1', name: 'approve', params: {} }),
      policy: ToolApprovalPolicy.make({ mode: 'manual', reason: 'Approve?' })
    })

    expect(isTerminalAgentEvent(AgentEnd.make({ messages, turns: 1, usage: zeroAgentUsage }))).toBe(
      true
    )
    expect(
      isTerminalAgentEvent(
        AgentAwaitingInput.make({ requests: [request], messages, turns: 1, usage: zeroAgentUsage })
      )
    ).toBe(true)
    expect(
      isTerminalAgentEvent(AgentError.make({ code: 'unknown', message: 'Nope', retryable: false }))
    ).toBe(true)
    expect(isTerminalAgentEvent(AgentStart.make({}))).toBe(false)
  })

  it('copies HITL answers and omits absent optionIds, answers, and reason', () => {
    const omitted = hitlResponseEvent(
      QuestionResponse.make({
        requestId: 'req',
        toolCallId: 'call',
        outcome: 'answered',
        source: 'user'
      })
    )

    expect(omitted).toBeInstanceOf(QuestionAnswered)

    if (!(omitted instanceof QuestionAnswered)) {
      throw new Error('expected QuestionAnswered')
    }

    expect(JSON.stringify(omitted)).toBe(
      '{"_tag":"QuestionAnswered","response":{"_tag":"QuestionResponse","requestId":"req","toolCallId":"call","outcome":"answered","source":"user"}}'
    )
    expect(Object.keys(omitted.response)).toEqual([
      '_tag',
      'requestId',
      'toolCallId',
      'outcome',
      'source'
    ])

    const optionIds = ['a', 'b']

    const present = hitlResponseEvent(
      QuestionResponse.make({
        requestId: 'req',
        toolCallId: 'call',
        outcome: 'answered',
        source: 'user',
        reason: 'because',
        answers: [
          QuestionAnswer.make({
            questionId: 'q1',
            optionIds,
            customAnswer: 'other'
          })
        ]
      })
    )

    expect(present).toBeInstanceOf(QuestionAnswered)

    if (!(present instanceof QuestionAnswered)) {
      throw new Error('expected QuestionAnswered')
    }

    const response = present.response

    expect(Object.keys(response)).toEqual([
      '_tag',
      'requestId',
      'toolCallId',
      'outcome',
      'source',
      'answers',
      'reason'
    ])
    expect(JSON.stringify(response)).toBe(
      '{"_tag":"QuestionResponse","requestId":"req","toolCallId":"call","outcome":"answered","source":"user","answers":[{"questionId":"q1","optionIds":["a","b"],"customAnswer":"other"}],"reason":"because"}'
    )
    expect(response.answers?.[0]?.optionIds).toEqual(optionIds)
    expect(response.answers?.[0]?.optionIds).not.toBe(optionIds)
  })

  it('copies approval responses and omits absent reason', () => {
    const omitted = hitlResponseEvent(
      ToolApprovalResponse.make({
        requestId: 'req',
        toolCallId: 'call',
        decision: 'approved',
        source: 'user'
      })
    )

    expect(omitted).toBeInstanceOf(ToolApprovalGranted)

    if (!(omitted instanceof ToolApprovalGranted)) {
      throw new Error('expected ToolApprovalGranted')
    }

    expect(JSON.stringify(omitted.response)).toBe(
      '{"_tag":"ToolApprovalResponse","requestId":"req","toolCallId":"call","decision":"approved","source":"user"}'
    )

    const present = hitlResponseEvent(
      ToolApprovalResponse.make({
        requestId: 'req',
        toolCallId: 'call',
        decision: 'denied',
        source: 'user',
        reason: 'no'
      })
    )

    expect(present).toBeInstanceOf(ToolApprovalDenied)

    if (!(present instanceof ToolApprovalDenied)) {
      throw new Error('expected ToolApprovalDenied')
    }

    const deniedResponse = present.response

    if (deniedResponse === undefined) {
      throw new Error('expected ToolApprovalDenied.response')
    }

    expect(Object.keys(deniedResponse)).toEqual([
      '_tag',
      'requestId',
      'toolCallId',
      'decision',
      'source',
      'reason'
    ])
    expect(JSON.stringify(deniedResponse)).toBe(
      '{"_tag":"ToolApprovalResponse","requestId":"req","toolCallId":"call","decision":"denied","source":"user","reason":"no"}'
    )
  })
})
