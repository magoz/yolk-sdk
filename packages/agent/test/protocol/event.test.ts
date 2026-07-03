import { describe, expect, it } from '@effect/vitest'
import {
  AgentAwaitingInput,
  AgentEnd,
  AgentError,
  AgentStart,
  ToolCall,
  ToolApprovalPolicy,
  ToolApprovalRequest,
  UserMessage,
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
})
