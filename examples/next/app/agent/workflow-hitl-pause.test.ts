import { describe, expect, it } from '@effect/vitest'
import {
  AgentAwaitingInput,
  ToolApprovalRequest,
  ToolApprovalResponse,
  ToolCall,
  UsageUpdate,
  zeroAgentUsage
} from '@yolk-sdk/agent/protocol'
import {
  emptyWorkflowHitlPauses,
  rememberWorkflowHitlPause,
  workflowHitlResponseEndpoint
} from './workflow-hitl-pause'

const request = (id: string) =>
  ToolApprovalRequest.make({
    requestId: `approval:${id}`,
    toolCallId: id,
    call: ToolCall.make({ id, name: 'write', params: {} })
  })

const awaiting = (eventId: string, ids: readonly [string, ...string[]]) =>
  AgentAwaitingInput.make({
    eventId,
    requests: [request(ids[0]), ...ids.slice(1).map(request)],
    messages: [],
    turns: 1,
    usage: zeroAgentUsage
  })

const approve = (id: string) =>
  ToolApprovalResponse.make({
    requestId: `approval:${id}`,
    toolCallId: id,
    decision: 'approved',
    source: 'user'
  })

describe('Workflow HITL pause naming', () => {
  it('names the latest pause that asked for each request', () => {
    const pauses = [
      awaiting('workflow:run:1:4', ['a', 'b']),
      UsageUpdate.make({ eventId: 'workflow:run:1:5', usage: zeroAgentUsage }),
      awaiting('workflow:run:1:7', ['b'])
    ].reduce(rememberWorkflowHitlPause, emptyWorkflowHitlPauses)

    expect(workflowHitlResponseEndpoint('run/1', pauses, approve('a'))).toBe(
      '/api/agent/workflow/run%2F1?pause=workflow%3Arun%3A1%3A4'
    )
    expect(workflowHitlResponseEndpoint('run/1', pauses, approve('b'))).toBe(
      '/api/agent/workflow/run%2F1?pause=workflow%3Arun%3A1%3A7'
    )
  })

  it('sends no pause for a request no pause asked for, so the route refuses it', () => {
    expect(workflowHitlResponseEndpoint('run', emptyWorkflowHitlPauses, approve('a'))).toBe(
      '/api/agent/workflow/run'
    )
  })
})
