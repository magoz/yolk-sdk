import { describe, expect, it } from '@effect/vitest'
import {
  BackgroundToolAccepted,
  ToolApprovalPolicy,
  ToolApprovalRequest,
  ToolApprovalRequested,
  ToolCall,
  ToolExecutionAccepted,
  ToolExecutionStarted,
  ToolInputStart,
  ToolInputDelta,
  ToolInputEnd,
  makeBackgroundToolAcceptedResult
} from '@yolk-sdk/agent/protocol'
import { applyAgentEvent, initialAgentClientState, isActiveToolRun } from '@yolk-sdk/agent/client'

const call = ToolCall.make({
  id: 'work',
  name: 'work',
  params: { execution: 'background', arguments: {} }
})
const result = makeBackgroundToolAcceptedResult({
  toolCallId: call.id,
  acceptance: BackgroundToolAccepted.make({ version: 1, executionId: 'owner:work' })
})
const started = ToolExecutionStarted.make({ call })
const accepted = ToolExecutionAccepted.make({ call, result })

describe('public client background replay', () => {
  it('keeps Accepted inactive with its original receipt/timing across Started and input replays without event ids', () => {
    const state = applyAgentEvent(applyAgentEvent(initialAgentClientState, started), accepted)
    let replay = state
    for (const event of [
      started,
      ToolInputStart.make({ id: call.id, name: call.name }),
      ToolInputDelta.make({ id: call.id, delta: '{' }),
      ToolInputEnd.make({ call }),
      ToolApprovalRequested.make({
        call,
        request: ToolApprovalRequest.make({
          requestId: 'old-approval',
          toolCallId: call.id,
          call,
          policy: ToolApprovalPolicy.make({ mode: 'manual' })
        })
      })
    ]) {
      replay = applyAgentEvent(replay, event)
      expect(replay.toolRuns).toEqual(state.toolRuns)
      expect(replay.toolRuns.some(isActiveToolRun)).toBe(false)
      expect(replay.toolRuns).toMatchObject([
        { _tag: 'Accepted', result, startedAtMs: 0, endedAtMs: 0 }
      ])
    }
    // Fencing is per call, not a global ban on subsequent tool activity.
    const sibling = applyAgentEvent(replay, ToolInputStart.make({ id: 'next', name: 'work' }))
    expect(sibling.toolRuns.filter(isActiveToolRun)).toMatchObject([
      { _tag: 'InputStreaming', id: 'next' }
    ])
  })
})
